import { remember } from "./cache.js";
import { round, toNumber } from "./metrics.js";

const HALF_DAY = 12 * 60 * 60 * 1000;
const FMP_BASE_URL = "https://financialmodelingprep.com/stable";
const YAHOO_FINANCE_QUOTE_URL = "https://finance.yahoo.com/quote";

function fmpHeaders(env) {
  return {
    "user-agent": `Stock Insight PWA ${env.SEC_CONTACT_EMAIL || "admin@example.com"}`,
    accept: "application/json, text/plain, */*",
  };
}

function yahooHeaders(env) {
  return {
    "user-agent": `Mozilla/5.0 Stock Insight PWA ${env.SEC_CONTACT_EMAIL || "admin@example.com"}`,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
  };
}

function ensureFmpKey(env) {
  if (!env.FMP_API_KEY) {
    throw new Error("미국 주식/ETF 조회에는 FMP_API_KEY 환경변수가 필요합니다.");
  }
  return env.FMP_API_KEY;
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
      const error = new Error(`FMP 조회 실패: HTTP ${response.status}`);
      error.status = response.status;
      throw error;
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

    if (data?.["Error Message"]) throw new Error(data["Error Message"]);
    if (data?.error) throw new Error(typeof data.error === "string" ? data.error : data.error.message || `FMP 오류: ${path}`);
    if (data?.Error) throw new Error(data.Error);
    return data;
  });
}

async function fetchYahooQuotePage(code, env) {
  const response = await fetch(`${YAHOO_FINANCE_QUOTE_URL}/${encodeURIComponent(code)}`, {
    headers: yahooHeaders(env),
  });
  const html = await response.text();

  if (!response.ok) {
    throw new Error(`Yahoo Finance ETF 페이지 조회 실패: HTTP ${response.status}`);
  }

  return html;
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function extractYahooEmbeddedJson(html, code) {
  const marker = `quoteSummary/${code.toUpperCase()}?`;
  const scriptMatches = [...html.matchAll(/<script type="application\/json" data-sveltekit-fetched[^>]*>([\s\S]*?)<\/script>/g)];

  for (const match of scriptMatches) {
    const scriptBody = match[1] || "";
    if (!scriptBody.includes(marker)) continue;

    let outer;
    try {
      outer = JSON.parse(scriptBody);
    } catch (error) {
      continue;
    }

    const innerBody = outer?.body;
    if (!innerBody) continue;

    const decoded = decodeHtmlEntities(innerBody);
    const inner = JSON.parse(decoded);
    return inner?.quoteSummary?.result?.[0] ?? null;
  }

  return null;
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

function firstDefined(...values) {
  for (const value of values) {
    if (value != null && value !== "") return value;
  }
  return null;
}

function getRawNumber(node) {
  if (node == null) return null;
  if (typeof node === "number") return node;
  if (typeof node === "string") return toNumber(node);
  if (typeof node === "object") return toNumber(node.raw) ?? toNumber(node.fmt) ?? null;
  return null;
}

function getFmtValue(node) {
  if (node == null) return null;
  if (typeof node === "object") return node.fmt || null;
  return String(node);
}

function normalizeFmpInfoRow(row) {
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

function normalizeYahooEtfInfo(summary) {
  const fundProfile = summary?.fundProfile ?? {};
  const summaryDetail = summary?.summaryDetail ?? {};
  const price = summary?.price ?? {};
  const feeInfo = fundProfile?.feesExpensesInvestment ?? {};

  return {
    expenseRatio: getRawNumber(feeInfo.annualReportExpenseRatio) != null ? getRawNumber(feeInfo.annualReportExpenseRatio) * 100 : null,
    expenseRatioLabel: getFmtValue(feeInfo.annualReportExpenseRatio),
    assetsUnderManagement: getRawNumber(feeInfo.totalNetAssets),
    assetsUnderManagementLabel: getFmtValue(feeInfo.totalNetAssets),
    dividendYield: getRawNumber(summaryDetail.yield) != null ? getRawNumber(summaryDetail.yield) * 100 : null,
    dividendYieldLabel: getFmtValue(summaryDetail.yield),
    nav: getRawNumber(summaryDetail.navPrice) ?? getRawNumber(price.regularMarketPrice),
    navLabel: getFmtValue(summaryDetail.navPrice) ?? getFmtValue(price.regularMarketPrice),
    family: fundProfile.family || null,
    categoryName: fundProfile.categoryName || null,
    legalType: fundProfile.legalType || null,
    longBusinessSummary: summary?.assetProfile?.longBusinessSummary || null,
    longName: price.longName || price.shortName || null,
    latestPrice: getRawNumber(price.regularMarketPrice),
    latestPriceLabel: getFmtValue(price.regularMarketPrice),
  };
}

function buildEtfDetailCards(info) {
  return [
    {
      label: "운용보수",
      value: firstDefined(info.expenseRatioLabel, info.expenseRatio != null ? `${round(info.expenseRatio, 2)}%` : null, "-"),
      description: "ETF 총보수 또는 순보수 기준입니다.",
    },
    {
      label: "배당수익률",
      value: firstDefined(info.dividendYieldLabel, info.dividendYield != null ? `${round(info.dividendYield, 2)}%` : null, "-"),
      description: "최근 제공된 ETF 배당수익률 기준입니다.",
    },
    {
      label: "순자산 규모",
      value: firstDefined(info.assetsUnderManagementLabel, formatCompactCurrency(info.assetsUnderManagement), "-"),
      description: "AUM 또는 총 순자산 규모입니다.",
    },
    {
      label: "최근 가격",
      value: firstDefined(info.latestPriceLabel, info.latestPrice != null ? `$${round(info.latestPrice, 2)}` : null, info.navLabel, "-"),
      description: "ETF 최신 거래 가격 기준입니다.",
    },
  ];
}

function normalizeFmpHoldings(rows) {
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

function normalizeFmpSectorWeights(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      name: row.sector || row.name || "",
      weight: toNumber(row.weightPercentage) ?? toNumber(row.weight) ?? toNumber(row.percentage) ?? null,
    }))
    .filter((row) => row.name)
    .sort((a, b) => (b.weight ?? -1) - (a.weight ?? -1))
    .slice(0, 8);
}

function normalizeYahooHoldings(summary) {
  const holdings = summary?.topHoldings?.holdings ?? [];
  return holdings
    .map((row) => ({
      name: row.holdingName || row.symbol || "",
      symbol: row.symbol || "",
      weight: getRawNumber(row.holdingPercent) != null ? getRawNumber(row.holdingPercent) * 100 : null,
    }))
    .filter((row) => row.name)
    .sort((a, b) => (b.weight ?? -1) - (a.weight ?? -1))
    .slice(0, 10);
}

function normalizeYahooSectorWeights(summary) {
  const sectorRows = summary?.topHoldings?.sectorWeightings ?? [];
  return sectorRows
    .map((row) => {
      const [name, payload] = Object.entries(row || {})[0] ?? [];
      return {
        name: name || "",
        weight: getRawNumber(payload) != null ? getRawNumber(payload) * 100 : null,
      };
    })
    .filter((row) => row.name)
    .sort((a, b) => (b.weight ?? -1) - (a.weight ?? -1))
    .slice(0, 8);
}

async function fetchYahooEtfData(code, env) {
  const html = await fetchYahooQuotePage(code, env);
  const summary = extractYahooEmbeddedJson(html, code);
  if (!summary) {
    throw new Error("Yahoo Finance ETF 페이지에서 요약 데이터를 찾지 못했습니다.");
  }
  return {
    info: normalizeYahooEtfInfo(summary),
    holdings: normalizeYahooHoldings(summary),
    sectorWeights: normalizeYahooSectorWeights(summary),
    summary,
  };
}

export async function getUSEtfData(code, env, selectedName = "") {
  let yahooData = null;
  try {
    yahooData = await fetchYahooEtfData(code, env);
  } catch (error) {
    yahooData = null;
  }

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

  const quote = Array.isArray(quoteData) ? quoteData[0] ?? {} : quoteData ?? {};
  const profile = Array.isArray(profileData) ? profileData[0] ?? {} : profileData ?? {};
  const fmpInfo = normalizeFmpInfoRow(Array.isArray(infoData) ? infoData[0] ?? {} : infoData ?? {});
  const yahooInfo = yahooData?.info ?? {};
  const latestPrice = firstDefined(toNumber(quote.price), yahooInfo.latestPrice, yahooInfo.nav);

  const mergedInfo = {
    expenseRatio: firstDefined(yahooInfo.expenseRatio, fmpInfo.expenseRatio),
    expenseRatioLabel: yahooInfo.expenseRatioLabel || null,
    dividendYield: firstDefined(yahooInfo.dividendYield, fmpInfo.dividendYield),
    dividendYieldLabel: yahooInfo.dividendYieldLabel || null,
    assetsUnderManagement: firstDefined(yahooInfo.assetsUnderManagement, fmpInfo.assetsUnderManagement),
    assetsUnderManagementLabel: yahooInfo.assetsUnderManagementLabel || null,
    nav: firstDefined(yahooInfo.nav, fmpInfo.nav, latestPrice),
    navLabel: yahooInfo.navLabel || null,
    latestPrice,
    latestPriceLabel: yahooInfo.latestPriceLabel || null,
  };

  const holdings = yahooData?.holdings?.length ? yahooData.holdings : normalizeFmpHoldings(holdingsData);
  const sectorWeights = yahooData?.sectorWeights?.length ? yahooData.sectorWeights : normalizeFmpSectorWeights(sectorData);
  const category = firstDefined(
    yahooData?.summary?.fundProfile?.categoryName,
    yahooData?.summary?.fundProfile?.legalType,
    profile.industry,
    profile.sector,
    "ETF",
  );
  const provider = firstDefined(yahooData?.summary?.fundProfile?.family, profile.companyName);
  const displayName = firstDefined(
    selectedName,
    yahooData?.summary?.price?.longName,
    yahooData?.summary?.price?.shortName,
    profile.companyName,
    code,
  );

  return {
    stock: {
      code,
      name: displayName,
      market: "US",
      marketLabel: "미국 주식",
      industry: category,
      assetType: "ETF",
      description: `${category}${provider ? ` · ${provider}` : ""}${latestPrice != null ? ` · 최근 가격 $${round(latestPrice, 2)}` : ""}`,
      metrics: emptyEtfMetrics(),
      metricDefinitions: [],
      etfDetails: buildEtfDetailCards(mergedInfo),
      holdings,
      sectorWeights,
    },
    history: [],
    summaryNote:
      "ETF는 기업 재무제표보다 운용 구조를 보는 자산입니다. 운용보수, 배당수익률, 순자산 규모, 상위 보유종목, 섹터 비중 중심으로 해석하는 편이 맞습니다.",
    notes: [
      "ETF는 개별 기업 재무제표보다 운용보수, 배당수익률, 순자산 규모, 보유종목 구성과 비중을 보는 편이 더 적절합니다.",
      "상위 보유종목과 섹터 비중을 함께 보면 ETF가 어느 방향의 리스크에 노출되는지 빠르게 파악할 수 있습니다.",
      "레버리지 ETF는 장기 보유 시 복리 효과와 변동성 드래그 때문에 기초지수를 단순 배수로 따라가지 않을 수 있습니다.",
    ],
    sources: [
      { label: "Yahoo Finance ETF Quote Page", url: `${YAHOO_FINANCE_QUOTE_URL}/${encodeURIComponent(code)}` },
      { label: "FMP Quote API", url: "https://site.financialmodelingprep.com/developer/docs/stable/quotes" },
      { label: "FMP ETF Information API", url: "https://site.financialmodelingprep.com/developer/docs/stable/information" },
    ],
  };
}
