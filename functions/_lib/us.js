import { remember } from "./cache.js";
import { metricDefinitions, percent, round, toNumber } from "./metrics.js";

const ONE_DAY = 24 * 60 * 60 * 1000;
const HALF_DAY = 12 * 60 * 60 * 1000;
const SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers_exchange.json";
const FMP_BASE_URL = "https://financialmodelingprep.com/stable";
const STOCKANALYSIS_STOCK_URL = "https://stockanalysis.com/stocks";
const ETF_LIST_TTL = 6 * 60 * 60 * 1000;
const NEWS_TTL = 30 * 60 * 1000;
const POPULAR_ETF_FALLBACK = [
  ["QQQ", "Invesco QQQ Trust", "NASDAQ"],
  ["SPY", "SPDR S&P 500 ETF Trust", "NYSE ARCA"],
  ["VOO", "Vanguard S&P 500 ETF", "NYSE ARCA"],
  ["IVV", "iShares Core S&P 500 ETF", "NYSE ARCA"],
  ["DIA", "SPDR Dow Jones Industrial Average ETF Trust", "NYSE ARCA"],
  ["IWM", "iShares Russell 2000 ETF", "NYSE ARCA"],
  ["VTI", "Vanguard Total Stock Market ETF", "NYSE ARCA"],
  ["SOXL", "Direxion Daily Semiconductor Bull 3X Shares", "NYSE ARCA"],
  ["SOXS", "Direxion Daily Semiconductor Bear 3X Shares", "NYSE ARCA"],
  ["TQQQ", "ProShares UltraPro QQQ", "NASDAQ"],
  ["SQQQ", "ProShares UltraPro Short QQQ", "NASDAQ"],
  ["UPRO", "ProShares UltraPro S&P500", "NYSE ARCA"],
  ["SPXL", "Direxion Daily S&P 500 Bull 3X Shares", "NYSE ARCA"],
  ["SPXS", "Direxion Daily S&P 500 Bear 3X Shares", "NYSE ARCA"],
  ["TECL", "Direxion Daily Technology Bull 3X Shares", "NYSE ARCA"],
  ["TECS", "Direxion Daily Technology Bear 3X Shares", "NYSE ARCA"],
];

function secHeaders(env) {
  const contact = env.SEC_CONTACT_EMAIL || "admin@example.com";
  return {
    "user-agent": `Stock Insight PWA ${contact}`,
    "accept-encoding": "gzip, deflate",
  };
}

function fmpHeaders(env) {
  return {
    "user-agent": `Stock Insight PWA ${env.SEC_CONTACT_EMAIL || "admin@example.com"}`,
    accept: "application/json, text/plain, */*",
  };
}

function htmlHeaders(env) {
  return {
    "user-agent": `Mozilla/5.0 Stock Insight PWA ${env.SEC_CONTACT_EMAIL || "admin@example.com"}`,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
  };
}

function ensureFmpKey(env) {
  if (!env.FMP_API_KEY) {
    throw new Error("미국 주식 조회에는 FMP_API_KEY 환경변수가 필요합니다.");
  }
  return env.FMP_API_KEY;
}

function emptyMetrics() {
  return {
    per: null,
    pbr: null,
    roe: null,
    roic: null,
    operatingMargin: null,
    debtRatio: null,
    dividendYield: null,
  };
}

function emptyEtfMetrics() {
  return {
    expenseRatio: null,
    dividendYield: null,
    assetsUnderManagement: null,
    nav: null,
  };
}

function formatCompactCurrency(value) {
  if (value == null || !Number.isFinite(value)) return null;
  if (Math.abs(value) >= 1_000_000_000) return `$${round(value / 1_000_000_000, 2)}B`;
  if (Math.abs(value) >= 1_000_000) return `$${round(value / 1_000_000, 2)}M`;
  if (Math.abs(value) >= 1_000) return `$${round(value / 1_000, 2)}K`;
  return `$${round(value, 2)}`;
}

function getRawNumber(node) {
  if (node == null) return null;
  if (typeof node === "number") return node;
  if (typeof node === "string") return toNumber(node);
  if (typeof node === "object") return toNumber(node.raw) ?? toNumber(node.fmt) ?? null;
  return null;
}

function normalizeEtfInfoRow(row) {
  if (!row || typeof row !== "object") return {};
  return {
    expenseRatio:
      toNumber(row.expenseRatio) ??
      toNumber(row.totalExpenseRatio) ??
      toNumber(row.netExpenseRatio) ??
      null,
    assetsUnderManagement:
      toNumber(row.aum) ??
      toNumber(row.assetsUnderManagement) ??
      toNumber(row.totalAssets) ??
      toNumber(row.netAssets) ??
      null,
    nav: toNumber(row.nav) ?? toNumber(row.navPrice) ?? null,
    dividendYield:
      toNumber(row.dividendYield) ??
      toNumber(row.yield) ??
      toNumber(row.trailingDividendYield) ??
      null,
  };
}

function buildEtfDetailCards(info, quote) {
  const latestPrice = toNumber(quote.price);
  return [
    {
      label: "운용보수",
      value: info.expenseRatio != null ? `${round(info.expenseRatio, 2)}%` : "-",
      description: "총보수 또는 순보수 기준입니다.",
    },
    {
      label: "배당수익률",
      value: info.dividendYield != null ? `${round(info.dividendYield, 2)}%` : "-",
      description: "최근 제공 데이터 기준입니다.",
    },
    {
      label: "순자산",
      value: formatCompactCurrency(info.assetsUnderManagement) ?? "-",
      description: "AUM 또는 순자산 규모입니다.",
    },
    {
      label: "NAV",
      value: info.nav != null ? `$${round(info.nav, 2)}` : latestPrice != null ? `$${round(latestPrice, 2)}` : "-",
      description: "제공 NAV가 없으면 최신 가격을 대체 표시합니다.",
    },
  ];
}

function normalizeEtfHoldings(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      name: row.asset || row.name || row.holding || row.symbol || "",
      symbol: row.symbol || "",
      weight:
        toNumber(row.weightPercentage) ??
        toNumber(row.weight) ??
        toNumber(row.percentage) ??
        toNumber(row.percentAssets) ??
        null,
    }))
    .filter((row) => row.name)
    .sort((a, b) => (b.weight ?? -1) - (a.weight ?? -1))
    .slice(0, 10);
}

function normalizeEtfSectorWeights(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      name: row.sector || row.name || "",
      weight: toNumber(row.weightPercentage) ?? toNumber(row.weight) ?? toNumber(row.percentage) ?? null,
    }))
    .filter((row) => row.name)
    .sort((a, b) => (b.weight ?? -1) - (a.weight ?? -1))
    .slice(0, 8);
}

function mapSearchRow(row) {
  const symbol = String(row.symbol || row.code || "").trim().toUpperCase();
  const name = String(row.name || "").trim();
  const exchange = String(row.exchangeShortName || row.exchange || "").trim();
  const rawType = String(row.type || row.instrumentType || row.assetType || "").toLowerCase();
  const assetType =
    rawType.includes("etf") || rawType.includes("fund") || name.toLowerCase().includes(" etf")
      ? "ETF"
      : "Stock";

  if (!symbol || !name) return null;
  return {
    code: symbol,
    name,
    market: "US",
    marketLabel: "미국 주식",
    exchange,
    assetType,
  };
}

function mergeSearchItems(items) {
  const merged = new Map();
  items.filter(Boolean).forEach((item) => {
    const key = item.code;
    if (!merged.has(key)) {
      merged.set(key, item);
      return;
    }

    const current = merged.get(key);
    if ((current.assetType !== "ETF" && item.assetType === "ETF") || (!current.exchange && item.exchange)) {
      merged.set(key, { ...current, ...item });
    }
  });

  return [...merged.values()];
}

async function loadUSTickers(env) {
  return remember("us-tickers", ONE_DAY, async () => {
    const response = await fetch(SEC_TICKERS_URL, { headers: secHeaders(env) });
    if (!response.ok) {
      throw new Error(`SEC 종목 목록 조회 실패: HTTP ${response.status}`);
    }

    const text = await response.text();
    if (!text) {
      throw new Error("SEC 종목 목록 응답 본문이 비어 있습니다.");
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new Error("SEC 종목 목록 JSON 파싱에 실패했습니다.");
    }

    return (data.data ?? [])
      .map((row) => ({
        code: row[2],
        name: row[1],
        exchange: row[3],
        cik: String(row[0]).padStart(10, "0"),
        market: "US",
        marketLabel: "미국 주식",
      }))
      .filter((item) => item.code && item.exchange)
      .sort((a, b) => a.code.localeCompare(b.code));
  });
}

async function loadUSEtfList(env) {
  const fallbackItems = POPULAR_ETF_FALLBACK.map(([code, name, exchange]) => ({
    code,
    name,
    market: "US",
    marketLabel: "미국 주식",
    exchange,
    assetType: "ETF",
  }));

  if (!env.FMP_API_KEY) return fallbackItems;

  return remember("us-etf-list", ETF_LIST_TTL, async () => {
    const rows = await fmpFetch("/etf-list", {}, env, ETF_LIST_TTL).catch(() => []);
    const fetchedItems = (Array.isArray(rows) ? rows : [])
      .map((row) => ({
        code: String(row.symbol || "").trim().toUpperCase(),
        name: String(row.name || "").trim(),
        market: "US",
        marketLabel: "미국 주식",
        exchange: String(row.exchange || row.exchangeShortName || "").trim(),
        assetType: "ETF",
      }))
      .filter((item) => item.code && item.name);

    return mergeSearchItems([...fallbackItems, ...fetchedItems]);
  });
}

export async function searchUSStocks(query, env) {
  const [tickerResult, etfResult] = await Promise.allSettled([loadUSTickers(env), loadUSEtfList(env)]);
  const list = tickerResult.status === "fulfilled" ? tickerResult.value : [];
  const etfList = etfResult.status === "fulfilled" ? etfResult.value : [];
  const normalized = query.trim().toLowerCase();
  const directSymbol = query.trim().toUpperCase();
  const canDirectLookup = /^[A-Z][A-Z0-9.-]{0,9}$/.test(directSymbol);
  const localStocks = (!normalized
    ? list.slice(0, 20)
    : list.filter(
        (item) =>
          item.code.toLowerCase().includes(normalized) ||
          item.name.toLowerCase().includes(normalized) ||
          item.exchange.toLowerCase().includes(normalized),
      )
  ).map((item) => ({
    code: item.code,
    name: item.name,
    market: "US",
    marketLabel: item.marketLabel,
    exchange: item.exchange,
    assetType: "Stock",
  }));

  const localEtfs = (!normalized
    ? etfList.slice(0, 20)
    : etfList.filter(
        (item) =>
          item.code.toLowerCase().includes(normalized) ||
          item.name.toLowerCase().includes(normalized) ||
          item.exchange.toLowerCase().includes(normalized),
      )
  ).map((item) => ({
    ...item,
    assetType: "ETF",
  }));

  const localMatches = mergeSearchItems([...localEtfs, ...localStocks]);

  const remoteResponses =
    normalized && env.FMP_API_KEY
      ? await Promise.allSettled([
          fmpFetch("/search-symbol", { query: query.trim() }, env),
          fmpFetch("/search-name", { query: query.trim() }, env),
        ])
      : [];

  const remoteMatches = remoteResponses
    .filter((result) => result.status === "fulfilled")
    .flatMap((result) => (Array.isArray(result.value) ? result.value : []))
    .map(mapSearchRow)
    .filter(Boolean);

  const directMatch =
    canDirectLookup && ![...localMatches, ...remoteMatches].some((item) => item.code === directSymbol)
      ? [
          {
            code: directSymbol,
            name: directSymbol,
            market: "US",
            marketLabel: "미국 주식",
            exchange: "",
            assetType: "Stock",
          },
        ]
      : [];

  return mergeSearchItems([...localMatches, ...remoteMatches, ...directMatch]).slice(0, 20);
}

async function fmpFetch(path, params, env, ttl = HALF_DAY) {
  const key = ensureFmpKey(env);
  const cacheKey = `fmp:${path}?${new URLSearchParams(params).toString()}`;

  return remember(cacheKey, ttl, async () => {
    const query = new URLSearchParams({ ...params, apikey: key });
    const response = await fetch(`${FMP_BASE_URL}${path}?${query.toString()}`, {
      headers: fmpHeaders(env),
    });
    const text = await response.text();

    if (!response.ok) {
      if (response.status === 403) {
        throw new Error("FMP 조회 실패: HTTP 403 (API 키가 잘못되었거나 현재 플랜에서 이 요청이 허용되지 않습니다.)");
      }
      throw new Error(`FMP 조회 실패: HTTP ${response.status}`);
    }
    if (!text) {
      throw new Error(`FMP 응답 본문이 비어 있습니다. path=${path}`);
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new Error(`FMP JSON 파싱 실패: path=${path}`);
    }

    if (data?.["Error Message"]) {
      throw new Error(data["Error Message"]);
    }
    if (data?.error) {
      throw new Error(typeof data.error === "string" ? data.error : data.error.message || `FMP 오류: ${path}`);
    }
    if (data?.Error) {
      throw new Error(data.Error);
    }
    if (Array.isArray(data) && data.length === 0) {
      return data;
    }
    if (data == null) {
      throw new Error(`FMP 응답 데이터가 비어 있습니다. path=${path}`);
    }

    return data;
  });
}

function stripTags(text) {
  return String(text || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchStockAnalysisRatiosPage(symbol, env, ttl = HALF_DAY) {
  const cacheKey = `stockanalysis:ratios:${symbol.toLowerCase()}`;

  return remember(cacheKey, ttl, async () => {
    const response = await fetch(
      `${STOCKANALYSIS_STOCK_URL}/${encodeURIComponent(symbol.toLowerCase())}/financials/ratios/?p=quarterly`,
      {
        headers: htmlHeaders(env),
      },
    );
    const html = await response.text();

    if (!response.ok) {
      throw new Error(`Stock Analysis 비율 페이지 조회 실패: HTTP ${response.status}`);
    }
    if (!html) {
      throw new Error(`Stock Analysis 비율 페이지 응답이 비어 있습니다. symbol=${symbol}`);
    }

    return html;
  });
}

function extractStockAnalysisRowValues(html, label) {
  const marker = `>${label}<`;
  const index = html.indexOf(marker);
  if (index === -1) return [];

  const rowStart = html.lastIndexOf("<tr", index);
  const rowEnd = html.indexOf("</tr>", index);
  if (rowStart === -1 || rowEnd === -1) return [];

  const rowHtml = html.slice(rowStart, rowEnd);
  return [...rowHtml.matchAll(/<td[^>]*class="svelte-11zo0q0"[^>]*>([\s\S]*?)<\/td>/g)]
    .map((match) => stripTags(match[1]))
    .filter(Boolean);
}

function extractStockAnalysisFirstValue(html, label) {
  return extractStockAnalysisRowValues(html, label)[0] ?? null;
}

async function fetchStockAnalysisRatioFallback(symbol, env) {
  const html = await fetchStockAnalysisRatiosPage(symbol, env);
  const debtEquity = toNumber(extractStockAnalysisFirstValue(html, "Debt / Equity Ratio"));

  return {
    per: toNumber(extractStockAnalysisFirstValue(html, "PE Ratio")),
    pbr: toNumber(extractStockAnalysisFirstValue(html, "PB Ratio")),
    roe: toNumber(extractStockAnalysisFirstValue(html, "Return on Equity (ROE)")),
    roic: toNumber(extractStockAnalysisFirstValue(html, "Return on Invested Capital (ROIC)")),
    debtRatio: debtEquity != null ? debtEquity * 100 : null,
  };
}

function buildRateLimitedStockFallback({
  selectedMeta,
  selectedName,
  code,
  quote,
  profile,
  priceHistory,
  incomeReports,
  balanceReports,
  scrapedMetrics,
  news = [],
}) {
  const today = new Date().toISOString().slice(0, 10);
  const latestPrice = toNumber(quote.price) ?? findPriceOnOrBefore(priceHistory, today);
  const latestIncome = incomeReports[0] ?? null;
  const latestBalance = balanceReports[0] ?? null;
  const operatingMargin =
    latestIncome && toNumber(latestIncome.operatingIncome) != null && toNumber(latestIncome.revenue) != null
      ? percent(toNumber(latestIncome.operatingIncome), toNumber(latestIncome.revenue))
      : null;
  const computedDebtRatio =
    latestBalance && toNumber(latestBalance.totalLiabilities) != null && toNumber(latestBalance.totalStockholdersEquity) != null
      ? percent(toNumber(latestBalance.totalLiabilities), toNumber(latestBalance.totalStockholdersEquity))
      : latestBalance && toNumber(latestBalance.totalLiabilities) != null && toNumber(latestBalance.totalEquity) != null
        ? percent(toNumber(latestBalance.totalLiabilities), toNumber(latestBalance.totalEquity))
        : null;
  const latestDividendPerShare = toNumber(profile.lastDiv) ?? toNumber(quote.dividend) ?? null;

  return {
    stock: {
      code: selectedMeta.code,
      name: selectedName || selectedMeta.name || code,
      market: "US",
      marketLabel: "미국 주식",
      industry: profile.industry || selectedMeta.exchange,
      assetType: "Stock",
      description: `${selectedMeta.exchange} 상장 · 최신 가격 ${latestPrice != null ? `$${latestPrice.toFixed(2)}` : "조회 불가"}`,
      metrics: {
        per: round(scrapedMetrics?.per ?? toNumber(quote.pe)),
        pbr: round(scrapedMetrics?.pbr),
        roe: round(scrapedMetrics?.roe),
        roic: round(scrapedMetrics?.roic),
        operatingMargin: round(operatingMargin),
        debtRatio: round(scrapedMetrics?.debtRatio ?? computedDebtRatio),
        dividendYield: round(
          latestDividendPerShare != null && latestPrice != null ? (latestDividendPerShare / latestPrice) * 100 : null,
        ),
      },
      metricDefinitions,
    },
    history: [],
    priceChart: buildDailyPriceChart(priceHistory),
    news,
    summaryNote:
      "FMP 분기 재무 호출이 제한되어 현재 시점 기준 보조 소스로 핵심지표를 복구했습니다. 분기 히스토리는 일시적으로 비어 있을 수 있습니다.",
    notes: [
      "현재 응답은 FMP 429 제한 시 보조 소스로 복구한 핵심지표입니다.",
      "PE·PB·ROE·ROIC·부채비율은 Stock Analysis 공개 분기 비율 페이지를 우선 사용합니다.",
      "영업이익률과 배당수익률은 FMP에서 남아 있는 가격·프로필·손익 데이터로 보완 계산합니다.",
      "FMP 호출 제한이 해소되면 최근 1년 분기 흐름이 다시 함께 표시됩니다.",
    ],
    sources: [
      { label: "Stock Analysis Financial Ratios", url: `${STOCKANALYSIS_STOCK_URL}/${encodeURIComponent(code.toLowerCase())}/financials/ratios/?p=quarterly` },
      { label: "SEC Company Tickers Exchange", url: "https://www.sec.gov/file/company-tickers-exchange" },
    ],
  };
}

function parseQuarterDateLabel(dateString) {
  const date = new Date(`${dateString}T00:00:00Z`);
  const quarter = Math.floor(date.getUTCMonth() / 3) + 1;
  return `${date.getUTCFullYear()} Q${quarter}`;
}

function sortDescendingByDate(items) {
  return [...items].sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
}

function findPriceOnOrBefore(history, targetDate) {
  const target = String(targetDate || "");
  for (const row of history) {
    if (String(row.date || "") <= target) {
      return toNumber(row.close) ?? toNumber(row.adjClose) ?? toNumber(row.price) ?? null;
    }
  }
  return null;
}

function trailingDividends(history, targetDate) {
  const target = new Date(`${targetDate}T00:00:00Z`).getTime();
  const floor = target - 365 * 24 * 60 * 60 * 1000;
  let total = 0;

  for (const row of history) {
    const ts = new Date(`${row.date}T00:00:00Z`).getTime();
    if (ts <= target && ts >= floor) {
      total += toNumber(row.dividend) ?? toNumber(row.adjDividend) ?? 0;
    }
  }

  return total;
}

function computeUSRoic(incomeReport, balanceReport) {
  const operatingIncome = toNumber(incomeReport.operatingIncome);
  const incomeBeforeTax = toNumber(incomeReport.incomeBeforeTax);
  const incomeTaxExpense = toNumber(incomeReport.incomeTaxExpense);
  const equity = toNumber(balanceReport.totalStockholdersEquity) ?? toNumber(balanceReport.totalEquity);
  const cash =
    toNumber(balanceReport.cashAndCashEquivalents) ??
    toNumber(balanceReport.cashAndShortTermInvestments) ??
    toNumber(balanceReport.cashAndCashEquivalentsAtCarryingValue);
  const debt =
    toNumber(balanceReport.totalDebt) ??
    (toNumber(balanceReport.shortTermDebt) ?? 0) + (toNumber(balanceReport.longTermDebt) ?? 0);

  if (operatingIncome == null || equity == null) return null;

  const taxRate =
    incomeBeforeTax != null && incomeTaxExpense != null && incomeBeforeTax !== 0
      ? Math.min(Math.max(incomeTaxExpense / incomeBeforeTax, 0), 0.35)
      : 0.21;

  const nopat = operatingIncome * 4 * (1 - taxRate);
  const investedCapital = equity + debt - (cash ?? 0);
  return percent(nopat, investedCapital);
}

function buildQuarterSnapshot(incomeReport, balanceReport, priceHistory, dividendHistory) {
  const date = incomeReport.date;
  const price = findPriceOnOrBefore(priceHistory, date);
  const revenue = toNumber(incomeReport.revenue);
  const operatingIncome = toNumber(incomeReport.operatingIncome);
  const netIncome = toNumber(incomeReport.netIncome);
  const equity = toNumber(balanceReport.totalStockholdersEquity) ?? toNumber(balanceReport.totalEquity);
  const liabilities = toNumber(balanceReport.totalLiabilities);
  const shares =
    toNumber(balanceReport.commonStockSharesOutstanding) ??
    toNumber(balanceReport.numberOfShares) ??
    toNumber(balanceReport.commonStock);
  const dividends = trailingDividends(dividendHistory, date);

  const metrics = {
    per: price != null && shares && netIncome != null && netIncome > 0 ? price / ((netIncome * 4) / shares) : null,
    pbr: price != null && shares && equity != null ? price / (equity / shares) : null,
    roe: netIncome != null && equity != null ? percent(netIncome * 4, equity) : null,
    roic: computeUSRoic(incomeReport, balanceReport),
    operatingMargin: operatingIncome != null && revenue != null ? percent(operatingIncome, revenue) : null,
    debtRatio: liabilities != null && equity != null ? percent(liabilities, equity) : null,
    dividendYield: price != null ? percent(dividends, price) : null,
  };

  return {
    label: parseQuarterDateLabel(date),
    headline: "분기 실적 반영",
    periodEnd: date,
    metrics: {
      per: round(metrics.per),
      pbr: round(metrics.pbr),
      roe: round(metrics.roe),
      roic: round(metrics.roic),
      operatingMargin: round(metrics.operatingMargin),
      debtRatio: round(metrics.debtRatio),
      dividendYield: round(metrics.dividendYield),
    },
  };
}

function summarizeUS(history) {
  const latest = history[history.length - 1];
  return `${latest.label} 기준 분기 재무와 최근 가격 흐름을 조합해 계산했습니다. 미국 종목은 SEC 종목 목록과 FMP 재무/가격 데이터를 함께 사용합니다.`;
}

async function getUSEtfData(code, env, stockMeta = null) {
  const today = new Date();
  const from = new Date(today);
  from.setUTCMonth(from.getUTCMonth() - 4);

  const [quoteResult, profileResult, infoResult, holdingsResult, sectorResult] = await Promise.allSettled([
    fmpFetch("/quote", { symbol: code }, env),
    fmpFetch("/profile", { symbol: code }, env),
    fmpFetch("/etf/info", { symbol: code }, env),
    fmpFetch("/etf/holdings", { symbol: code }, env),
    fmpFetch("/etf/sector-weightings", { symbol: code }, env),
  ]);

  const quoteData = quoteResult.status === "fulfilled" ? quoteResult.value : [];
  const profileData = profileResult.status === "fulfilled" ? profileResult.value : [];
  const infoData = infoResult.status === "fulfilled" ? infoResult.value : [];
  const holdingsData = holdingsResult.status === "fulfilled" ? holdingsResult.value : [];
  const sectorData = sectorResult.status === "fulfilled" ? sectorResult.value : [];
  const [priceData, news] = await Promise.all([
    fmpFetch(
      "/historical-price-eod/full",
      {
        symbol: code,
        serietype: "line",
        from: from.toISOString().slice(0, 10),
        to: today.toISOString().slice(0, 10),
      },
      env,
    ).catch(() => []),
    fetchFmpNews(code, env).catch(() => []),
  ]);
  const quote = Array.isArray(quoteData) ? quoteData[0] ?? {} : quoteData ?? {};
  const profile = Array.isArray(profileData) ? profileData[0] ?? {} : profileData ?? {};
  const priceHistory = Array.isArray(priceData) ? priceData : Array.isArray(priceData?.historical) ? priceData.historical : [];
  const info = normalizeEtfInfoRow(Array.isArray(infoData) ? infoData[0] ?? {} : infoData ?? {});
  const holdings = normalizeEtfHoldings(holdingsData);
  const sectorWeights = normalizeEtfSectorWeights(sectorData);
  const latestPrice = toNumber(quote.price);
  const category = profile.industry || profile.sector || "ETF";
  const provider = profile.companyName || stockMeta?.name || null;

  return {
    stock: {
      code,
      name: stockMeta?.name || profile.companyName || code,
      market: "US",
      marketLabel: "미국 주식",
      industry: category,
      assetType: "ETF",
      description: `${category}${provider ? ` · ${provider}` : ""}${latestPrice != null ? ` · 최신 가격 $${latestPrice.toFixed(2)}` : ""}`,
      metrics: emptyEtfMetrics(),
      metricDefinitions,
      etfDetails: buildEtfDetailCards(info, quote),
      holdings,
      sectorWeights,
    },
    history: [],
    priceChart: buildDailyPriceChart(priceHistory),
    news,
    summaryNote:
      "ETF는 개별 기업 재무제표 기반 7개 지표를 그대로 적용하기 어렵습니다. 이 화면에서는 ETF임을 표시하고, 백테스팅 탭에서 가격 기반 전략 검증에 집중하는 편이 적절합니다.",
    notes: [
      "ETF는 운영 구조가 기업과 달라 PER·PBR·ROE 같은 개별 기업용 재무지표가 비어 있을 수 있습니다.",
      "총보수, 자산규모, 추종지수 같은 ETF 전용 지표를 별도 탭으로 분리하는 것이 더 적합합니다.",
      "SOXL 같은 레버리지 ETF는 장기 보유 시 복리 효과와 변동성 드래그 때문에 기초지수를 단순 배수로 따라가지 않습니다.",
    ],
    sources: [
      { label: "FMP ETF Symbol Search API", url: "https://site.financialmodelingprep.com/developer/docs/etf-list-api" },
      { label: "FMP Stock Symbol Search API", url: "https://site.financialmodelingprep.com/developer/docs/stable/search-symbol" },
      { label: "FMP Company Name Search API", url: "https://site.financialmodelingprep.com/developer/docs/stable/search-name" },
      { label: "FMP Developer Docs", url: "https://site.financialmodelingprep.com/developer/docs/" },
    ],
  };
}

export async function getUSStockData(code, env, selectedName = "") {
  const tickers = await loadUSTickers(env).catch(() => []);
  const etfList = await loadUSEtfList(env).catch(() => []);
  const stockMeta = tickers.find((item) => item.code === code);
  const etfMeta = etfList.find((item) => item.code === code);
  const fallbackMeta = stockMeta || { code, name: selectedName || code, exchange: "ETF" };
  const selectedMeta = stockMeta || fallbackMeta;

  const today = new Date();
  const from = new Date(today);
  from.setUTCFullYear(from.getUTCFullYear() - 2);

  const [profileResult, quoteResult, priceResult] = await Promise.allSettled([
    fmpFetch("/profile", { symbol: code }, env),
    fmpFetch("/quote", { symbol: code }, env),
    fmpFetch(
      "/historical-price-eod/full",
      {
        symbol: code,
        serietype: "line",
        from: from.toISOString().slice(0, 10),
        to: today.toISOString().slice(0, 10),
      },
      env,
    ),
  ]);

  const [incomeResult, balanceResult, dividendResult] = await Promise.allSettled([
    fmpFetch("/income-statement", { symbol: code, period: "quarter", limit: "4" }, env),
    fmpFetch("/balance-sheet-statement", { symbol: code, period: "quarter", limit: "4" }, env),
    fmpFetch("/dividends", { symbol: code }, env),
  ]);

  const profileData = profileResult.status === "fulfilled" ? profileResult.value : [];
  const quoteData = quoteResult.status === "fulfilled" ? quoteResult.value : [];
  const priceData = priceResult.status === "fulfilled" ? priceResult.value : [];
  const profile = Array.isArray(profileData) ? profileData[0] ?? {} : profileData ?? {};
  const quote = Array.isArray(quoteData) ? quoteData[0] ?? {} : quoteData ?? {};
  const incomeData = incomeResult.status === "fulfilled" ? incomeResult.value : [];
  const balanceData = balanceResult.status === "fulfilled" ? balanceResult.value : [];
  const dividendData = dividendResult.status === "fulfilled" ? dividendResult.value : [];
  const incomeReports = sortDescendingByDate(Array.isArray(incomeData) ? incomeData : []);
  const balanceReports = sortDescendingByDate(Array.isArray(balanceData) ? balanceData : []);
  const balanceByDate = new Map(balanceReports.map((row) => [row.date, row]));
  const priceHistory = sortDescendingByDate(
    Array.isArray(priceData) ? priceData : Array.isArray(priceData?.historical) ? priceData.historical : [],
  );
  const news = await fetchFmpNews(code, env).catch(() => []);
  const dividendHistory = sortDescendingByDate(
    Array.isArray(dividendData) ? dividendData : Array.isArray(dividendData?.historical) ? dividendData.historical : [],
  );

  const quarterlyReports = incomeReports.filter((report) => balanceByDate.has(report.date)).slice(0, 4);
  const profileSuggestsEtf =
    String(profile.industry || "").toLowerCase().includes("etf") ||
    String(profile.sector || "").toLowerCase().includes("etf") ||
    String(profile.companyName || "").toLowerCase().includes(" etf");
  const isKnownEtf = Boolean(etfMeta || profileSuggestsEtf);

  if (!quarterlyReports.length && isKnownEtf) {
    return getUSEtfData(code, env, etfMeta || fallbackMeta);
  }

  const hasRateLimit =
    [profileResult, quoteResult, priceResult, incomeResult, balanceResult, dividendResult].some(
      (result) => result.status === "rejected" && result.reason?.message?.includes("HTTP 429"),
    );

  if (!quarterlyReports.length && hasRateLimit) {
    let scrapedMetrics = null;
    try {
      scrapedMetrics = await fetchStockAnalysisRatioFallback(code, env);
    } catch {
      scrapedMetrics = null;
    }

    return buildRateLimitedStockFallback({
      selectedMeta,
      selectedName,
      code,
      quote,
      profile,
      priceHistory,
      incomeReports,
      balanceReports,
      scrapedMetrics,
      news,
    });
  }

  if (!quarterlyReports.length) {
    throw new Error("분기 재무 데이터를 받지 못했습니다. 잠시 후 다시 시도해주세요.");
  }

  if (!quoteData.length && !profileData.length && !priceHistory.length) {
    throw new Error(`FMP 조회 실패: ${code} 종목의 가격/프로필 데이터를 불러오지 못했습니다.`);
  }

  const history = quarterlyReports
    .map((incomeReport) => buildQuarterSnapshot(incomeReport, balanceByDate.get(incomeReport.date), priceHistory, dividendHistory))
    .reverse();

  const latestHistory = history[history.length - 1];
  const latestPrice = toNumber(quote.price) ?? findPriceOnOrBefore(priceHistory, today.toISOString().slice(0, 10));
  const latestDividendPerShare = toNumber(profile.lastDiv) ?? toNumber(quote.dividend) ?? null;

  const latestMetrics = {
    per: round(toNumber(quote.pe) ?? latestHistory.metrics.per),
    pbr: round(latestHistory.metrics.pbr),
    roe: round(latestHistory.metrics.roe),
    roic: round(latestHistory.metrics.roic),
    operatingMargin: round(latestHistory.metrics.operatingMargin),
    debtRatio: round(latestHistory.metrics.debtRatio),
    dividendYield: round(
      latestDividendPerShare != null && latestPrice != null
        ? (latestDividendPerShare / latestPrice) * 100
        : latestHistory.metrics.dividendYield,
    ),
  };

  return {
    stock: {
      code: selectedMeta.code,
      name: selectedMeta.name,
      market: "US",
      marketLabel: "미국 주식",
      industry: profile.industry || selectedMeta.exchange,
      assetType: "Stock",
      description: `${selectedMeta.exchange} 상장 · 최신 가격 ${latestPrice != null ? `$${latestPrice.toFixed(2)}` : "조회 불가"}`,
      metrics: latestMetrics,
      metricDefinitions,
    },
    history,
    priceChart: buildDailyPriceChart(priceHistory),
    news,
    summaryNote: summarizeUS(history),
    notes: [
      "미국 주식 검색은 SEC company_tickers_exchange.json을 사용합니다.",
      "미국 주식 상세 분석은 Financial Modeling Prep(FMP)의 분기 재무제표와 가격 데이터를 사용합니다.",
      "PER·PBR·배당수익률은 최신 가격과 최근 분기 재무값 또는 최신 배당 데이터를 조합한 계산값입니다.",
    ],
    sources: [
      { label: "SEC Company Tickers Exchange", url: "https://www.sec.gov/file/company-tickers-exchange" },
      { label: "FMP Developer Docs", url: "https://site.financialmodelingprep.com/developer/docs/" },
      { label: "FMP Quickstart", url: "https://site.financialmodelingprep.com/developer/docs/quickstart" },
    ],
  };
}

function sortAscendingByDate(items) {
  return [...items].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
}

function buildDailyPriceChart(priceHistory, limit = 60) {
  const rows = sortAscendingByDate(priceHistory)
    .map((row) => ({
      date: row.date,
      close: round(toNumber(row.close) ?? toNumber(row.adjClose) ?? toNumber(row.price)),
      volume: toNumber(row.volume),
    }))
    .filter((row) => row.date && row.close != null)
    .slice(-limit);

  return rows.map((row, index) => {
    const previous = rows[index - 1]?.close ?? null;
    return {
      ...row,
      changePercent: previous ? round(((row.close / previous) - 1) * 100) : null,
    };
  });
}

function normalizeNewsRow(row) {
  if (!row || typeof row !== "object") return null;
  const title = String(row.title || row.headline || "").trim();
  const url = String(row.url || row.link || "").trim();
  if (!title || !url) return null;

  return {
    title,
    url,
    site: String(row.site || row.publisher || row.source || "").trim(),
    publishedAt: String(row.publishedDate || row.date || row.datetime || "").trim(),
    summary: String(row.text || row.summary || row.snippet || "").replace(/\s+/g, " ").trim().slice(0, 220),
  };
}

async function fetchFmpNews(code, env) {
  if (!env.FMP_API_KEY) return [];

  const candidates = [
    ["/news/stock-latest", { symbols: code, limit: "5" }],
    ["/stock-news", { tickers: code, limit: "5" }],
  ];

  for (const [path, params] of candidates) {
    try {
      const rows = await fmpFetch(path, params, env, NEWS_TTL);
      const news = (Array.isArray(rows) ? rows : []).map(normalizeNewsRow).filter(Boolean).slice(0, 5);
      if (news.length) return news;
    } catch {
      // Some FMP plans expose only one of the news endpoints.
    }
  }

  return [];
}

function subtractPeriod(date, years, months) {
  const copy = new Date(date);
  copy.setUTCFullYear(copy.getUTCFullYear() - years);
  copy.setUTCMonth(copy.getUTCMonth() - months);
  return copy;
}

function normalizePriceSeries(rawSeries) {
  return sortAscendingByDate(Array.isArray(rawSeries) ? rawSeries : []).map((row) => ({
    date: row.date,
    close: toNumber(row.close) ?? toNumber(row.adjClose) ?? toNumber(row.price) ?? null,
  }));
}

function findClosestPriceOnOrAfter(series, targetDate) {
  const target = String(targetDate || "");
  return series.find((row) => row.date >= target && row.close != null) || null;
}

function findClosestPriceOnOrBefore(series, targetDate) {
  const target = String(targetDate || "");
  for (let index = series.length - 1; index >= 0; index -= 1) {
    const row = series[index];
    if (row.date <= target && row.close != null) {
      return row;
    }
  }
  return null;
}

function buildBenchmarkLookup(series) {
  let lastKnown = null;
  const lookup = new Map();

  for (const row of series) {
    if (row.close != null) {
      lastKnown = row.close;
    }
    if (lastKnown != null) {
      lookup.set(row.date, lastKnown);
    }
  }

  return lookup;
}

function calculatePerformance(startRow, endRow) {
  if (!startRow?.close || !endRow?.close) {
    throw new Error("백테스트 가격 데이터가 부족합니다.");
  }

  const totalReturn = ((endRow.close / startRow.close) - 1) * 100;
  const days = Math.max(
    1,
    Math.round(
      (new Date(`${endRow.date}T00:00:00Z`).getTime() - new Date(`${startRow.date}T00:00:00Z`).getTime()) /
        (24 * 60 * 60 * 1000),
    ),
  );
  const cagr = (Math.pow(endRow.close / startRow.close, 365 / days) - 1) * 100;

  return {
    startDate: startRow.date,
    endDate: endRow.date,
    startPrice: round(startRow.close),
    endPrice: round(endRow.close),
    totalReturn: round(totalReturn),
    cagr: round(cagr),
  };
}

function buildBacktestChartSeries(stockSeries, benchmarkSeries, startDate, endDate) {
  const filteredStock = stockSeries.filter((row) => row.date >= startDate && row.date <= endDate && row.close != null);
  const filteredBenchmark = benchmarkSeries.filter((row) => row.date >= startDate && row.date <= endDate && row.close != null);

  if (!filteredStock.length || !filteredBenchmark.length) {
    throw new Error("백테스트 차트를 만들 가격 데이터가 부족합니다.");
  }

  const stockStart = filteredStock[0].close;
  const benchmarkLookup = buildBenchmarkLookup(filteredBenchmark);
  const benchmarkStartRow = findClosestPriceOnOrAfter(filteredBenchmark, startDate) || filteredBenchmark[0];
  const benchmarkStart = benchmarkStartRow?.close;
  if (!stockStart || !benchmarkStart) {
    throw new Error("백테스트 기준 가격을 계산하지 못했습니다.");
  }

  return filteredStock
    .map((row) => {
      const benchmarkClose = benchmarkLookup.get(row.date);
      if (benchmarkClose == null) return null;

      return {
        date: row.date,
        stockValue: round((row.close / stockStart) * 100),
        benchmarkValue: round((benchmarkClose / benchmarkStart) * 100),
      };
    })
    .filter(Boolean);
}

function averageClose(series, startIndex, length) {
  if (startIndex - length + 1 < 0) return null;
  let sum = 0;
  for (let index = startIndex; index > startIndex - length; index -= 1) {
    const close = series[index]?.close;
    if (close == null) return null;
    sum += close;
  }
  return sum / length;
}

function computeCagrFromValues(startValue, endValue, startDate, endDate) {
  const days = Math.max(
    1,
    Math.round(
      (new Date(`${endDate}T00:00:00Z`).getTime() - new Date(`${startDate}T00:00:00Z`).getTime()) /
        (24 * 60 * 60 * 1000),
    ),
  );
  return round((Math.pow(endValue / startValue, 365 / days) - 1) * 100);
}

function countPositionChanges(points) {
  let trades = 0;
  let last = points[0]?.position ?? 0;
  for (let index = 1; index < points.length; index += 1) {
    const current = points[index].position ?? 0;
    if (current !== last) {
      trades += 1;
      last = current;
    }
  }
  return trades;
}

function simulateTrendStrategy(stockSeries, startDate, endDate) {
  const points = [];
  let portfolioValue = 100;
  let priorPosition = 0;

  for (let index = 0; index < stockSeries.length; index += 1) {
    const row = stockSeries[index];
    if (row.date < startDate || row.date > endDate || row.close == null) continue;

    if (points.length > 0 && priorPosition === 1) {
      const previousClose = stockSeries[index - 1]?.close;
      if (previousClose != null && previousClose > 0) {
        portfolioValue *= row.close / previousClose;
      }
    }

    const sma50 = averageClose(stockSeries, index - 1, 50);
    const sma200 = averageClose(stockSeries, index - 1, 200);
    const nextPosition = sma50 != null && sma200 != null && sma50 > sma200 ? 1 : 0;

    points.push({
      date: row.date,
      value: round(portfolioValue),
      position: priorPosition,
      signal: nextPosition,
    });

    priorPosition = nextPosition;
  }

  return {
    label: "추세 전환 (50일/200일 이동평균)",
    shortLabel: "추세 전환",
    points,
  };
}

function simulateVixStrategy(stockSeries, vixSeries, startDate, endDate) {
  const vixLookup = new Map(vixSeries.map((row) => [row.date, row.close]));
  const points = [];
  let portfolioValue = 100;
  let priorPosition = 0;
  let regime = 0;

  for (let index = 0; index < stockSeries.length; index += 1) {
    const row = stockSeries[index];
    if (row.date < startDate || row.date > endDate || row.close == null) continue;

    if (points.length > 0 && priorPosition === 1) {
      const previousClose = stockSeries[index - 1]?.close;
      if (previousClose != null && previousClose > 0) {
        portfolioValue *= row.close / previousClose;
      }
    }

    const previousVix = vixLookup.get(stockSeries[index - 1]?.date);
    if (previousVix != null) {
      if (previousVix >= 30) {
        regime = 1;
      } else if (previousVix <= 20) {
        regime = 0;
      }
    }

    points.push({
      date: row.date,
      value: round(portfolioValue),
      position: priorPosition,
      signal: regime,
      vix: previousVix != null ? round(previousVix) : null,
    });

    priorPosition = regime;
  }

  return {
    label: "공포지수 (VIX 30 이상 매수, 20 이하 매도)",
    shortLabel: "공포지수",
    points,
  };
}

function simulateNasdaqBenchmark(benchmarkSeries, startDate, endDate) {
  const filtered = benchmarkSeries.filter((row) => row.date >= startDate && row.date <= endDate && row.close != null);
  if (!filtered.length) {
    throw new Error("NASDAQ 비교용 가격 데이터가 부족합니다.");
  }

  const startValue = filtered[0].close;
  return filtered.map((row) => ({
    date: row.date,
    value: round((row.close / startValue) * 100),
  }));
}

function summarizeStrategyPerformance(strategyResult, benchmarkResult) {
  const strategyStart = strategyResult.points[0];
  const strategyEnd = strategyResult.points[strategyResult.points.length - 1];
  const benchmarkStart = benchmarkResult[0];
  const benchmarkEnd = benchmarkResult[benchmarkResult.length - 1];

  const strategyTotalReturn = round(strategyEnd.value - 100);
  const benchmarkTotalReturn = round(benchmarkEnd.value - 100);
  const strategyCagr = computeCagrFromValues(100, strategyEnd.value, strategyStart.date, strategyEnd.date);
  const benchmarkCagr = computeCagrFromValues(100, benchmarkEnd.value, benchmarkStart.date, benchmarkEnd.date);

  return {
    strategy: {
      startDate: strategyStart.date,
      endDate: strategyEnd.date,
      totalReturn: strategyTotalReturn,
      cagr: strategyCagr,
      endingValue: round(strategyEnd.value),
      trades: countPositionChanges(strategyResult.points),
    },
    benchmark: {
      startDate: benchmarkStart.date,
      endDate: benchmarkEnd.date,
      totalReturn: benchmarkTotalReturn,
      cagr: benchmarkCagr,
      endingValue: round(benchmarkEnd.value),
    },
    excessReturn: round(strategyTotalReturn - benchmarkTotalReturn),
    excessCagr: round(strategyCagr - benchmarkCagr),
  };
}

function buildStrategyChartSeries(strategyPoints, benchmarkPoints) {
  const benchmarkLookup = new Map(benchmarkPoints.map((point) => [point.date, point.value]));
  return strategyPoints
    .map((point) => {
      const benchmarkValue = benchmarkLookup.get(point.date);
      if (benchmarkValue == null) return null;
      return {
        date: point.date,
        stockValue: point.value,
        benchmarkValue: benchmarkValue,
      };
    })
    .filter(Boolean);
}

export async function getUSBacktestData(code, env, years = 0, months = 0, strategy = "trend") {
  const normalizedYears = Number.isFinite(years) ? Math.max(0, Math.trunc(years)) : 0;
  const normalizedMonths = Number.isFinite(months) ? Math.max(0, Math.trunc(months)) : 0;
  const normalizedStrategy = String(strategy || "trend").toLowerCase();

  if (normalizedYears === 0 && normalizedMonths === 0) {
    throw new Error("보유 기간은 최소 1개월 이상이어야 합니다.");
  }
  if (!["trend", "vix"].includes(normalizedStrategy)) {
    throw new Error("strategy 파라미터는 trend 또는 vix 여야 합니다.");
  }

  const tickers = await loadUSTickers(env);
  const stockMeta = tickers.find((item) => item.code === code);
  if (!stockMeta) {
    throw new Error("해당 미국 종목을 찾지 못했습니다.");
  }

  const today = new Date();
  const fromDate = subtractPeriod(today, normalizedYears, normalizedMonths);
  const historyPaddingDate = subtractPeriod(fromDate, 1, 6);
  const from = fromDate.toISOString().slice(0, 10);
  const to = today.toISOString().slice(0, 10);
  const extendedFrom = historyPaddingDate.toISOString().slice(0, 10);

  const requests = [
    fmpFetch("/historical-price-eod/full", { symbol: code, from: extendedFrom, to }, env),
    fmpFetch("/historical-price-eod/full", { symbol: "^IXIC", from: extendedFrom, to }, env),
  ];
  if (normalizedStrategy === "vix") {
    requests.push(fmpFetch("/historical-price-eod/full", { symbol: "^VIX", from: extendedFrom, to }, env));
  }

  const [stockPriceData, benchmarkPriceData, vixPriceData] = await Promise.all(requests);

  const stockSeries = normalizePriceSeries(stockPriceData);
  const benchmarkSeries = normalizePriceSeries(benchmarkPriceData);
  const vixSeries = normalizePriceSeries(vixPriceData);

  const stockStart = findClosestPriceOnOrAfter(stockSeries, from);
  const stockEnd = findClosestPriceOnOrBefore(stockSeries, to);
  if (!stockStart || !stockEnd) {
    throw new Error("백테스트 기간에 필요한 종목 가격 데이터가 부족합니다.");
  }

  const strategyResult =
    normalizedStrategy === "trend"
      ? simulateTrendStrategy(stockSeries, stockStart.date, stockEnd.date)
      : simulateVixStrategy(stockSeries, vixSeries, stockStart.date, stockEnd.date);

  if (!strategyResult.points.length) {
    throw new Error("전략 백테스트를 계산할 데이터가 부족합니다.");
  }

  const benchmarkResult = simulateNasdaqBenchmark(benchmarkSeries, strategyResult.points[0].date, strategyResult.points[strategyResult.points.length - 1].date);
  const summary = summarizeStrategyPerformance(strategyResult, benchmarkResult);
  const chartSeries = buildStrategyChartSeries(strategyResult.points, benchmarkResult);

  return {
    stock: {
      code: stockMeta.code,
      name: stockMeta.name,
    },
    period: {
      years: normalizedYears,
      months: normalizedMonths,
      startDate: summary.strategy.startDate,
      endDate: summary.strategy.endDate,
    },
    result: {
      stock: summary.strategy,
      benchmark: {
        ...summary.benchmark,
        code: "^IXIC",
        name: "NASDAQ Composite",
      },
      excessCagr: summary.excessCagr,
      excessReturn: summary.excessReturn,
    },
    strategy: {
      key: normalizedStrategy,
      label: strategyResult.label,
      shortLabel: strategyResult.shortLabel,
    },
    chartSeries,
    notes: [
      normalizedStrategy === "trend"
        ? "추세 전환 전략은 전일 기준 50일 이동평균이 200일 이동평균을 상향 돌파하면 매수 상태로 전환하고, 반대로 내려가면 현금 상태로 전환합니다."
        : "공포지수 전략은 전일 VIX가 30 이상이면 매수 상태로 전환하고, 20 이하이면 매도 상태로 전환하는 단순 리스크 온/오프 방식입니다.",
      "비교 기준은 같은 기간의 NASDAQ Composite (^IXIC) 단순 보유 성과입니다.",
      "누적수익률은 시작 시점 대비 총수익률이고 CAGR은 해당 기간의 연복리 수익률입니다.",
    ],
  };
}
