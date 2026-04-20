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
    throw new Error("FMP_API_KEY is required for US stock and ETF lookups.");
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
      const error = new Error(`FMP request failed: HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }

    if (!text) {
      throw new Error(`FMP response body is empty. path=${path}`);
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`FMP JSON parse failed: path=${path}`);
    }

    if (data?.["Error Message"]) throw new Error(data["Error Message"]);
    if (data?.error) throw new Error(typeof data.error === "string" ? data.error : data.error.message || `FMP error: ${path}`);
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
    throw new Error(`Yahoo Finance ETF page request failed: HTTP ${response.status}`);
  }

  return html;
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&quot;/g, "\"")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
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

function formatCompactCurrency(value) {
  if (value == null || !Number.isFinite(value)) return null;
  if (Math.abs(value) >= 1_000_000_000_000) return `$${round(value / 1_000_000_000_000, 2)}T`;
  if (Math.abs(value) >= 1_000_000_000) return `$${round(value / 1_000_000_000, 2)}B`;
  if (Math.abs(value) >= 1_000_000) return `$${round(value / 1_000_000, 2)}M`;
  if (Math.abs(value) >= 1_000) return `$${round(value / 1_000, 2)}K`;
  return `$${round(value, 2)}`;
}

function convertYahooAssetNumber(raw) {
  const numeric = toNumber(raw);
  if (numeric == null) return null;
  return numeric < 1_000_000 ? numeric * 1_000 : numeric;
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
    assetsUnderManagement: convertYahooAssetNumber(getRawNumber(feeInfo.totalNetAssets)),
    assetsUnderManagementLabel: getFmtValue(feeInfo.totalNetAssets),
    dividendYield: getRawNumber(summaryDetail.yield) != null ? getRawNumber(summaryDetail.yield) * 100 : null,
    dividendYieldLabel: getFmtValue(summaryDetail.yield),
    nav: getRawNumber(summaryDetail.navPrice) ?? getRawNumber(price.regularMarketPrice),
    navLabel: getFmtValue(summaryDetail.navPrice) ?? getFmtValue(price.regularMarketPrice),
    family: fundProfile.family || null,
    categoryName: fundProfile.categoryName || null,
    legalType: fundProfile.legalType || null,
    longName: price.longName || price.shortName || null,
    latestPrice: getRawNumber(price.regularMarketPrice),
    latestPriceLabel: getFmtValue(price.regularMarketPrice),
  };
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

function extractYahooEmbeddedSummary(html, code) {
  const marker = `quoteSummary/${code.toUpperCase()}?`;
  const scripts = [...html.matchAll(/<script type="application\/json" data-sveltekit-fetched[^>]*>([\s\S]*?)<\/script>/g)];

  for (const match of scripts) {
    const raw = match[1] || "";
    if (!raw.includes(marker)) continue;

    try {
      const outer = JSON.parse(raw);
      const innerBody = decodeHtmlEntities(outer?.body || "");
      if (!innerBody) continue;
      const inner = JSON.parse(innerBody);
      const summary = inner?.quoteSummary?.result?.[0];
      if (summary) return summary;
    } catch {
      continue;
    }
  }

  return null;
}

function captureJsonObjectBlock(text, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIndex; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, i + 1);
      }
    }
  }

  return null;
}

function extractYahooSummaryFromHtml(html) {
  const target = "\"quoteSummary\":{\"result\":[{";
  const start = html.indexOf(target);
  if (start === -1) return null;

  const objectStart = html.indexOf("{", start + "\"quoteSummary\":{\"result\":[".length);
  if (objectStart === -1) return null;

  const summaryBlock = captureJsonObjectBlock(html, objectStart);
  if (!summaryBlock) return null;

  try {
    return JSON.parse(summaryBlock);
  } catch {
    return null;
  }
}

function extractJsonStringField(text, key) {
  const regex = new RegExp(`"${key}":"((?:\\\\.|[^"\\\\])*)"`);
  const match = text.match(regex);
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return match[1];
  }
}

function extractJsonNumber(text, key) {
  const regex = new RegExp(`"${key}":\\{"raw":(-?\\d+(?:\\.\\d+)?)`);
  const match = text.match(regex);
  return match ? Number(match[1]) : null;
}

function extractJsonFmt(text, key) {
  const regex = new RegExp(`"${key}":\\{[^}]*"fmt":"((?:\\\\.|[^"\\\\])*)"`);
  const match = text.match(regex);
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return match[1];
  }
}

function extractArrayBlock(text, key) {
  const keyIndex = text.indexOf(`"${key}":[`);
  if (keyIndex === -1) return null;
  const start = text.indexOf("[", keyIndex);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "[") {
      depth += 1;
      continue;
    }

    if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}

function extractYahooRegexFallback(html) {
  const expenseRatio = extractJsonNumber(html, "annualReportExpenseRatio");
  const expenseRatioLabel = extractJsonFmt(html, "annualReportExpenseRatio");
  const totalNetAssets = extractJsonNumber(html, "totalNetAssets");
  const totalNetAssetsLabel = extractJsonFmt(html, "totalNetAssets");
  const dividendYield = extractJsonNumber(html, "yield");
  const dividendYieldLabel = extractJsonFmt(html, "yield");
  const latestPrice = extractJsonNumber(html, "regularMarketPrice");
  const latestPriceLabel = extractJsonFmt(html, "regularMarketPrice");
  const longName = extractJsonStringField(html, "longName") || extractJsonStringField(html, "shortName");
  const family = extractJsonStringField(html, "family");
  const categoryName = extractJsonStringField(html, "categoryName");
  const legalType = extractJsonStringField(html, "legalType");

  let holdings = [];
  const holdingsBlock = extractArrayBlock(html, "holdings");
  if (holdingsBlock) {
    try {
      const rows = JSON.parse(holdingsBlock);
      holdings = rows
        .map((row) => ({
          name: row.holdingName || row.symbol || "",
          symbol: row.symbol || "",
          weight: getRawNumber(row.holdingPercent) != null ? getRawNumber(row.holdingPercent) * 100 : null,
        }))
        .filter((row) => row.name)
        .sort((a, b) => (b.weight ?? -1) - (a.weight ?? -1))
        .slice(0, 10);
    } catch {
      holdings = [];
    }
  }

  let sectorWeights = [];
  const sectorBlock = extractArrayBlock(html, "sectorWeightings");
  if (sectorBlock) {
    try {
      const rows = JSON.parse(sectorBlock);
      sectorWeights = rows
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
    } catch {
      sectorWeights = [];
    }
  }

  return {
    info: {
      expenseRatio: expenseRatio != null ? expenseRatio * 100 : null,
      expenseRatioLabel,
      assetsUnderManagement: convertYahooAssetNumber(totalNetAssets),
      assetsUnderManagementLabel: totalNetAssetsLabel,
      dividendYield: dividendYield != null ? dividendYield * 100 : null,
      dividendYieldLabel,
      nav: latestPrice,
      navLabel: latestPriceLabel,
      latestPrice,
      latestPriceLabel,
      family,
      categoryName,
      legalType,
      longName,
    },
    holdings,
    sectorWeights,
    summary: null,
  };
}

async function fetchYahooEtfData(code, env) {
  const html = await fetchYahooQuotePage(code, env);

  const structuredSummary = extractYahooEmbeddedSummary(html, code) || extractYahooSummaryFromHtml(html);
  if (structuredSummary) {
    return {
      info: normalizeYahooEtfInfo(structuredSummary),
      holdings: normalizeYahooHoldings(structuredSummary),
      sectorWeights: normalizeYahooSectorWeights(structuredSummary),
      summary: structuredSummary,
    };
  }

  const regexFallback = extractYahooRegexFallback(html);
  const hasFallbackData =
    regexFallback.info.expenseRatio != null ||
    regexFallback.info.latestPrice != null ||
    regexFallback.holdings.length > 0 ||
    regexFallback.sectorWeights.length > 0;

  if (hasFallbackData) {
    return regexFallback;
  }

  throw new Error("Unable to extract ETF summary data from Yahoo Finance page.");
}

function buildEtfDetailCards(info) {
  return [
    {
      label: "Expense Ratio",
      value: firstDefined(info.expenseRatioLabel, info.expenseRatio != null ? `${round(info.expenseRatio, 2)}%` : null, "-"),
      description: "Total annual fund expense ratio.",
    },
    {
      label: "Dividend Yield",
      value: firstDefined(info.dividendYieldLabel, info.dividendYield != null ? `${round(info.dividendYield, 2)}%` : null, "-"),
      description: "Most recent trailing dividend yield.",
    },
    {
      label: "Assets",
      value: firstDefined(info.assetsUnderManagementLabel, formatCompactCurrency(info.assetsUnderManagement), "-"),
      description: "Assets under management.",
    },
    {
      label: "Last Price",
      value: firstDefined(info.latestPriceLabel, info.latestPrice != null ? `$${round(info.latestPrice, 2)}` : null, info.navLabel, "-"),
      description: "Latest market price.",
    },
  ];
}

function buildSourceList(code) {
  return [
    { label: "Yahoo Finance ETF Quote Page", url: `${YAHOO_FINANCE_QUOTE_URL}/${encodeURIComponent(code)}` },
    { label: "FMP Quote API", url: "https://site.financialmodelingprep.com/developer/docs/stable/quotes" },
    { label: "FMP ETF Information API", url: "https://site.financialmodelingprep.com/developer/docs/stable/information" },
  ];
}

export async function getUSEtfData(code, env, selectedName = "") {
  let yahooData = null;
  try {
    yahooData = await fetchYahooEtfData(code, env);
  } catch {
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
    yahooInfo.categoryName,
    yahooData?.summary?.fundProfile?.legalType,
    yahooInfo.legalType,
    profile.industry,
    profile.sector,
    "ETF",
  );
  const provider = firstDefined(
    yahooData?.summary?.fundProfile?.family,
    yahooInfo.family,
    profile.companyName,
  );
  const displayName = firstDefined(
    selectedName,
    yahooData?.summary?.price?.longName,
    yahooInfo.longName,
    yahooData?.summary?.price?.shortName,
    profile.companyName,
    code,
  );

  return {
    stock: {
      code,
      name: displayName,
      market: "US",
      marketLabel: "US Stock",
      industry: category,
      assetType: "ETF",
      description: `${category}${provider ? ` · ${provider}` : ""}${latestPrice != null ? ` · Last price $${round(latestPrice, 2)}` : ""}`,
      metrics: {
        expenseRatio: mergedInfo.expenseRatio,
        dividendYield: mergedInfo.dividendYield,
        assetsUnderManagement: mergedInfo.assetsUnderManagement,
        nav: mergedInfo.nav,
      },
      metricDefinitions: [],
      etfDetails: buildEtfDetailCards(mergedInfo),
      holdings,
      sectorWeights,
    },
    history: [],
    summaryNote: "For ETFs, fund structure matters more than company statements. Expense ratio, dividend yield, assets, holdings, and sector weights are the key items to read together.",
    notes: [
      "Leveraged ETFs can diverge from the simple index multiple over longer holding periods because of compounding and volatility drag.",
      "Expense ratio and dividend yield can differ slightly by data vendor and update timing.",
      "Top holdings and sector weights help show which theme and risk concentration the ETF is actually carrying.",
    ],
    sources: buildSourceList(code),
  };
}
