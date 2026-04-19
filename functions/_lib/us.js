import { remember } from "./cache.js";
import { metricDefinitions, percent, round, toNumber } from "./metrics.js";

const ONE_DAY = 24 * 60 * 60 * 1000;
const HALF_DAY = 12 * 60 * 60 * 1000;
const SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers_exchange.json";
const FMP_BASE_URL = "https://financialmodelingprep.com/api/v3";

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

function ensureFmpKey(env) {
  if (!env.FMP_API_KEY) {
    throw new Error("미국 주식 조회에는 FMP_API_KEY 환경변수가 필요합니다.");
  }
  return env.FMP_API_KEY;
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

export async function searchUSStocks(query, env) {
  const list = await loadUSTickers(env);
  const normalized = query.trim().toLowerCase();
  const filtered = !normalized
    ? list.slice(0, 20)
    : list
        .filter(
          (item) =>
            item.code.toLowerCase().includes(normalized) ||
            item.name.toLowerCase().includes(normalized) ||
            item.exchange.toLowerCase().includes(normalized),
        )
        .slice(0, 20);

  return filtered.map((item) => ({
    code: item.code,
    name: item.name,
    market: "US",
    marketLabel: item.marketLabel,
    exchange: item.exchange,
  }));
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

export async function getUSStockData(code, env) {
  const tickers = await loadUSTickers(env);
  const stockMeta = tickers.find((item) => item.code === code);
  if (!stockMeta) {
    throw new Error("해당 미국 종목을 찾지 못했습니다.");
  }

  const today = new Date();
  const from = new Date(today);
  from.setUTCFullYear(from.getUTCFullYear() - 2);

  const [profileData, quoteData, incomeData, balanceData, priceData, dividendData] = await Promise.all([
    fmpFetch(`/profile/${code}`, {}, env),
    fmpFetch(`/quote/${code}`, {}, env),
    fmpFetch(`/income-statement/${code}`, { period: "quarter", limit: "4" }, env),
    fmpFetch(`/balance-sheet-statement/${code}`, { period: "quarter", limit: "4" }, env),
    fmpFetch(
      `/historical-price-full/${code}`,
      {
        serietype: "line",
        from: from.toISOString().slice(0, 10),
        to: today.toISOString().slice(0, 10),
      },
      env,
    ),
    fmpFetch(`/historical-price-full/stock_dividend/${code}`, { limit: "120" }, env),
  ]);

  const profile = Array.isArray(profileData) ? profileData[0] ?? {} : profileData ?? {};
  const quote = Array.isArray(quoteData) ? quoteData[0] ?? {} : quoteData ?? {};
  const incomeReports = sortDescendingByDate(Array.isArray(incomeData) ? incomeData : []);
  const balanceReports = sortDescendingByDate(Array.isArray(balanceData) ? balanceData : []);
  const balanceByDate = new Map(balanceReports.map((row) => [row.date, row]));
  const priceHistory = sortDescendingByDate(Array.isArray(priceData?.historical) ? priceData.historical : []);
  const dividendHistory = sortDescendingByDate(Array.isArray(dividendData?.historical) ? dividendData.historical : []);

  const quarterlyReports = incomeReports.filter((report) => balanceByDate.has(report.date)).slice(0, 4);
  if (!quarterlyReports.length) {
    throw new Error("최근 분기 기준으로 조회 가능한 미국 재무 데이터가 없습니다.");
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
      code: stockMeta.code,
      name: stockMeta.name,
      market: "US",
      marketLabel: "미국 주식",
      industry: profile.industry || stockMeta.exchange,
      description: `${stockMeta.exchange} 상장 · 최신 가격 ${latestPrice != null ? `$${latestPrice.toFixed(2)}` : "조회 불가"}`,
      metrics: latestMetrics,
      metricDefinitions,
    },
    history,
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
