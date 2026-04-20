import { remember } from "./cache.js";
import { round, toNumber } from "./metrics.js";

const HALF_DAY = 12 * 60 * 60 * 1000;
const QUOTE_TTL = 5 * 60 * 1000;
const FMP_BASE_URL = "https://financialmodelingprep.com/stable";
const YAHOO_FINANCE_QUOTE_URL = "https://finance.yahoo.com/quote";
const STOCKANALYSIS_ETF_URL = "https://stockanalysis.com/etf";
const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";
const DIREXION_PRODUCT_URLS = {
  SOXL: "https://www.direxion.com/product/daily-semiconductor-bull-bear-3x-etfs",
  SOXS: "https://www.direxion.com/product/daily-semiconductor-bull-bear-3x-etfs",
};

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

function ensureAlphaVantageKey(env) {
  return env.ALPHA_VANTAGE_API_KEY || null;
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

async function alphaVantageFetch(params, env, ttl = HALF_DAY) {
  const key = ensureAlphaVantageKey(env);
  if (!key) {
    throw new Error("ALPHA_VANTAGE_API_KEY is required for Alpha Vantage ETF fallback.");
  }

  const cacheKey = `alphavantage:${new URLSearchParams(params).toString()}`;
  return remember(cacheKey, ttl, async () => {
    const query = new URLSearchParams({ ...params, apikey: key });
    const response = await fetch(`${ALPHA_VANTAGE_URL}?${query.toString()}`, {
      headers: {
        accept: "application/json, text/plain, */*",
        "user-agent": `Stock Insight PWA ${env.SEC_CONTACT_EMAIL || "admin@example.com"}`,
      },
    });
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`Alpha Vantage request failed: HTTP ${response.status}`);
    }

    if (!text) {
      throw new Error("Alpha Vantage response body is empty.");
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("Alpha Vantage JSON parse failed.");
    }

    if (data?.Information) throw new Error(data.Information);
    if (data?.Note) throw new Error(data.Note);
    if (data?.["Error Message"]) throw new Error(data["Error Message"]);
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

async function fetchStockAnalysisPage(code, suffix = "", env) {
  const response = await fetch(`${STOCKANALYSIS_ETF_URL}/${encodeURIComponent(code.toLowerCase())}${suffix}`, {
    headers: yahooHeaders(env),
  });
  const html = await response.text();

  if (!response.ok) {
    throw new Error(`Stock Analysis ETF page request failed: HTTP ${response.status}`);
  }

  return html;
}

async function fetchDirexionPage(code, env) {
  const url = DIREXION_PRODUCT_URLS[code.toUpperCase()];
  if (!url) {
    throw new Error("No Direxion product page mapping for this ETF.");
  }

  const response = await fetch(url, {
    headers: yahooHeaders(env),
  });
  const html = await response.text();

  if (!response.ok) {
    throw new Error(`Direxion ETF page request failed: HTTP ${response.status}`);
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
    if (value == null) continue;
    if (typeof value === "string") {
      const normalized = value.trim();
      if (!normalized) continue;
      if (["-", "--", "n/a", "na", "null", "undefined"].includes(normalized.toLowerCase())) continue;
      return normalized;
    }
    return value;
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
    latestPrice: toNumber(row.price) ?? toNumber(row.previousClose) ?? null,
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

function getFirstObjectValue(object, keys) {
  for (const key of keys) {
    const value = firstDefined(object?.[key]);
    if (value != null) return value;
  }
  return null;
}

function scaleAlphaRatioToPercent(value) {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.abs(value) <= 1 ? value * 100 : value;
}

function formatPercentLabel(value) {
  if (value == null || !Number.isFinite(value)) return null;
  return `${round(value, 2)}%`;
}

function normalizeAlphaVantageEtfProfile(data) {
  if (!data || typeof data !== "object") return { info: {}, holdings: [], sectorWeights: [] };

  const rawExpenseRatio = toNumber(
    getFirstObjectValue(data, ["expense_ratio", "net_expense_ratio", "expenseRatio", "netExpenseRatio"]),
  );
  const rawDividendYield = toNumber(
    getFirstObjectValue(data, ["dividend_yield", "yield", "dividendYield", "distribution_yield"]),
  );

  const info = {
    expenseRatio: rawExpenseRatio ?? null,
    expenseRatioLabel: rawExpenseRatio != null ? formatPercentLabel(rawExpenseRatio) : null,
    assetsUnderManagement:
      toNumber(getFirstObjectValue(data, ["net_assets", "aum", "assets", "netAssets", "total_net_assets"])) ?? null,
    assetsUnderManagementLabel: null,
    dividendYield: scaleAlphaRatioToPercent(rawDividendYield),
    dividendYieldLabel: rawDividendYield != null ? formatPercentLabel(scaleAlphaRatioToPercent(rawDividendYield)) : null,
    family: getFirstObjectValue(data, ["fund_family", "issuer", "fundFamily", "issuerName"]),
    categoryName: getFirstObjectValue(data, ["asset_class", "category", "assetClass", "fund_category"]),
    legalType: "ETF",
    longName: getFirstObjectValue(data, ["name", "fund_name", "fundName"]),
  };

  const rawHoldings = Array.isArray(data.holdings)
    ? data.holdings
    : Array.isArray(data.top_holdings)
      ? data.top_holdings
      : Array.isArray(data.constituents)
        ? data.constituents
        : [];

  const holdings = rawHoldings
    .map((row) => ({
      name: getFirstObjectValue(row, ["name", "description", "holding", "asset", "symbol"]) || "",
      symbol: getFirstObjectValue(row, ["symbol", "ticker"]) || "",
      weight: scaleAlphaRatioToPercent(
        toNumber(getFirstObjectValue(row, ["weight", "weight_percent", "percentage", "allocation"])),
      ),
    }))
    .filter((row) => row.name)
    .sort((a, b) => (b.weight ?? -1) - (a.weight ?? -1))
    .slice(0, 10);

  const rawSectorWeights = Array.isArray(data.sector_weights)
    ? data.sector_weights
    : Array.isArray(data.sectors)
      ? data.sectors
      : [];

  const sectorWeights = rawSectorWeights
    .map((row) => ({
      name: getFirstObjectValue(row, ["sector", "name"]) || "",
      weight: scaleAlphaRatioToPercent(
        toNumber(getFirstObjectValue(row, ["weight", "weight_percent", "percentage", "allocation"])),
      ),
    }))
    .filter((row) => row.name)
    .sort((a, b) => (b.weight ?? -1) - (a.weight ?? -1))
    .slice(0, 8);

  return { info, holdings, sectorWeights };
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
  const marker = `"${key}":"`;
  const start = text.indexOf(marker);
  if (start === -1) return null;

  let value = "";
  let escaped = false;
  for (let i = start + marker.length; i < text.length; i += 1) {
    const char = text[i];
    if (escaped) {
      value += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      value += char;
      continue;
    }
    if (char === "\"") {
      try {
        return JSON.parse(`"${value}"`);
      } catch {
        return value;
      }
    }
    value += char;
  }
  return null;
}

function extractJsonNumber(text, key) {
  const regex = new RegExp(`"${key}":\\{"raw":(-?\\d+(?:\\.\\d+)?)`);
  const match = text.match(regex);
  return match ? Number(match[1]) : null;
}

function extractJsonFmt(text, key) {
  const keyIndex = text.indexOf(`"${key}":{`);
  if (keyIndex === -1) return null;
  const fmtIndex = text.indexOf(`"fmt":"`, keyIndex);
  if (fmtIndex === -1) return null;

  let value = "";
  let escaped = false;
  for (let i = fmtIndex + 7; i < text.length; i += 1) {
    const char = text[i];
    if (escaped) {
      value += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      value += char;
      continue;
    }
    if (char === "\"") {
      try {
        return JSON.parse(`"${value}"`);
      } catch {
        return value;
      }
    }
    value += char;
  }
  return null;
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

function stripTags(text) {
  return text.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

function extractStockAnalysisCellValue(html, label) {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`${escapedLabel}</td><td[^>]*>([\\s\\S]*?)</td>`, "i");
  const match = html.match(regex);
  return match ? stripTags(match[1]) : null;
}

function extractStockAnalysisTextValue(text, label, nextLabels = []) {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedNext = nextLabels.map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const boundary = escapedNext.length ? `(?=${escapedNext.join("|")}|$)` : "$";
  const regex = new RegExp(`${escapedLabel}\\s*([\\s\\S]*?)\\s*${boundary}`, "i");
  const match = text.match(regex);
  if (!match) return null;
  const value = match[1].replace(/\s+/g, " ").trim();
  return value || null;
}

function parseStockAnalysisSnapshotValue(text) {
  const patterns = [
    /Real-Time Price\s*\S*\s*USD[\s\S]*?Full Chart Watchlist Compare\s*([\d.]+)/i,
    /NYSEARCA:\s*[A-Z]+[\s\S]*?\$([\d.]+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return toNumber(match[1]);
  }

  return null;
}

function parseStockAnalysisOverviewFallback(html) {
  const text = stripTags(html);
  const assetsLabel = extractStockAnalysisTextValue(text, "Assets", ["Expense Ratio", "Dividend Yield", "Prev Close", "Open"]);
  const expenseRatioLabel = extractStockAnalysisTextValue(text, "Expense Ratio", ["Dividend Yield", "Prev Close", "Open"]);
  const dividendYieldLabel = extractStockAnalysisTextValue(text, "Dividend Yield", ["Prev Close", "Open", "AUM"]);
  const previousCloseLabel = extractStockAnalysisTextValue(text, "Prev Close", ["Open", "AUM", "Assets"]);
  const openLabel = extractStockAnalysisTextValue(text, "Open", ["AUM", "Assets", "Category"]);

  return {
    assetsLabel,
    expenseRatioLabel,
    dividendYieldLabel,
    previousCloseLabel,
    openLabel,
    latestPrice: parseStockAnalysisSnapshotValue(text),
  };
}

function parsePercentValue(value) {
  const number = toNumber(String(value || "").replace(/%/g, ""));
  return number == null ? null : number;
}

function parseCompactMoney(value) {
  const match = String(value || "").trim().match(/^\$?([\d,.]+)\s*([KMBT])?$/i);
  if (!match) return null;
  const number = Number(match[1].replace(/,/g, ""));
  const unit = (match[2] || "").toUpperCase();
  const multipliers = { "": 1, K: 1_000, M: 1_000_000, B: 1_000_000_000, T: 1_000_000_000_000 };
  return number * (multipliers[unit] || 1);
}

function normalizeUsDateLabel(value) {
  const match = String(value || "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return value || null;
  return `${match[3]}-${match[1]}-${match[2]}`;
}

function extractDirexionEtfData(html, code) {
  const asOfMatch =
    html.match(/NAV and Market Price information as of\s*(\d{2}\/\d{2}\/\d{4})/i) ||
    html.match(/Pricing & Performance[\s\S]*?as of\s*(\d{2}\/\d{2}\/\d{4})/i);
  const asOf = normalizeUsDateLabel(asOfMatch?.[1] || null);
  const escapedCode = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const priceMatch =
    html.match(new RegExp(`${escapedCode}[\\s\\S]{0,2000}?Daily Market Price\\$([\\d.,]+)`, "i")) ||
    html.match(new RegExp(`${escapedCode}[\\s\\S]{0,2000}?Market Price Closing[\\s\\S]{0,400}?\\$([\\d.,]+)`, "i"));
  const navMatch =
    html.match(new RegExp(`${escapedCode}[\\s\\S]{0,2000}?Daily NAV\\$([\\d.,]+)`, "i")) ||
    html.match(new RegExp(`${escapedCode}[\\s\\S]{0,2000}?Net Asset Value \\(NAV\\)[\\s\\S]{0,400}?\\$([\\d.,]+)`, "i"));

  return {
    info: {
      latestPrice: toNumber(priceMatch?.[1]),
      latestPriceLabel: priceMatch?.[1] ? `$${priceMatch[1]}` : null,
      latestPriceSource: priceMatch?.[1] ? "Direxion" : null,
      latestPriceAsOf: asOf,
      nav: toNumber(navMatch?.[1]),
      navLabel: navMatch?.[1] ? `$${navMatch[1]}` : null,
    },
  };
}

async function fetchDirexionEtfData(code, env) {
  if (!DIREXION_PRODUCT_URLS[code.toUpperCase()]) {
    return null;
  }

  return remember(`direxion:${code.toUpperCase()}`, QUOTE_TTL, async () => {
    const html = await fetchDirexionPage(code, env);
    return extractDirexionEtfData(html, code.toUpperCase());
  });
}

function extractStockAnalysisHoldings(html) {
  const rowPattern = /<tr[^>]*class="[^"]*border-t[^"]*"[^>]*>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/gi;
  const rows = [];
  for (const match of html.matchAll(rowPattern)) {
    const name = stripTags(match[1]);
    const symbol = stripTags(match[2]);
    const weight = parsePercentValue(stripTags(match[3]));
    if (!name || !symbol || weight == null) continue;
    rows.push({ name, symbol, weight });
    if (rows.length >= 10) break;
  }
  return rows;
}

function extractStockAnalysisScriptText(html) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  for (const match of scripts) {
    const content = match[1] || "";
    if (content.includes("type:\"etf\"") || content.includes("holdingsTable") || content.includes("allocationChartData")) {
      return content;
    }
  }
  return "";
}

function extractStockAnalysisQuotedField(text, key) {
  const regex = new RegExp(`${key}:"([^"]*)"`);
  const match = text.match(regex);
  return match ? match[1] : null;
}

function extractStockAnalysisNumericField(text, key) {
  const regex = new RegExp(`${key}:(-?\\d+(?:\\.\\d+)?)`);
  const match = text.match(regex);
  return match ? Number(match[1]) : null;
}

function extractStockAnalysisOverviewData(html) {
  const scriptText = extractStockAnalysisScriptText(html);
  if (!scriptText) return null;

  return {
    assetsLabel: extractStockAnalysisQuotedField(scriptText, "aum"),
    expenseRatioLabel: extractStockAnalysisQuotedField(scriptText, "expenseRatio"),
    dividendYieldLabel: extractStockAnalysisQuotedField(scriptText, "dividendYield"),
    previousCloseLabel: null,
    openLabel: null,
    categoryName:
      extractStockAnalysisQuotedField(scriptText, "category") ||
      extractStockAnalysisQuotedField(scriptText, "assetClass"),
    provider: extractStockAnalysisQuotedField(scriptText, "provider"),
    holdingsCount: extractStockAnalysisNumericField(scriptText, "holdings"),
    latestPrice: extractStockAnalysisNumericField(scriptText, "p"),
  };
}

function extractStockAnalysisHoldingsFromScript(html) {
  const scriptText = extractStockAnalysisScriptText(html);
  if (!scriptText) return { holdings: [], sectorWeights: [] };

  const holdings = [];
  const holdingsBlockMatch = scriptText.match(/holdings:\[(.*?)\],(?:asset_allocation|allocationChartData|sectors:)/s);
  if (holdingsBlockMatch) {
    const entryPattern = /n:"([^"]+)"(?:,s:"\$?([^"]+)")?,as:"([^"]+)"/g;
    for (const match of holdingsBlockMatch[1].matchAll(entryPattern)) {
      holdings.push({
        name: match[1],
        symbol: match[2] || "",
        weight: parsePercentValue(match[3]),
      });
      if (holdings.length >= 10) break;
    }
  }

  const sectorWeights = [];
  const sectorsBlockMatch = scriptText.match(/sectors:\[(.*?)\],countries:/s);
  if (sectorsBlockMatch) {
    const sectorPattern = /n:"([^"]+)",w:([0-9.]+)/g;
    for (const match of sectorsBlockMatch[1].matchAll(sectorPattern)) {
      sectorWeights.push({
        name: match[1],
        weight: toNumber(match[2]),
      });
      if (sectorWeights.length >= 8) break;
    }
  }

  if (!sectorWeights.length) {
    const chartSectorsBlockMatch = scriptText.match(/allocationChartData:\{[\s\S]*?sectors:\[(.*?)\](?:,assets:|,countries:)/s);
    if (chartSectorsBlockMatch) {
      const chartSectorPattern = /name:"([^"]+)",y:([0-9.]+)/g;
      for (const match of chartSectorsBlockMatch[1].matchAll(chartSectorPattern)) {
        sectorWeights.push({
          name: match[1],
          weight: toNumber(match[2]),
        });
        if (sectorWeights.length >= 8) break;
      }
    }
  }

  return { holdings, sectorWeights };
}

async function fetchStockAnalysisEtfData(code, env) {
  const [overviewHtml, holdingsHtml] = await Promise.all([
    fetchStockAnalysisPage(code, "/", env),
    fetchStockAnalysisPage(code, "/holdings/", env),
  ]);

  const overviewFallback = {
    ...parseStockAnalysisOverviewFallback(overviewHtml),
    ...extractStockAnalysisOverviewData(overviewHtml),
  };
  const assetsLabel = extractStockAnalysisCellValue(overviewHtml, "Assets") || overviewFallback.assetsLabel;
  const expenseRatioLabel = extractStockAnalysisCellValue(overviewHtml, "Expense Ratio") || overviewFallback.expenseRatioLabel;
  const dividendYieldLabel = extractStockAnalysisCellValue(overviewHtml, "Dividend Yield") || overviewFallback.dividendYieldLabel;
  const lastPriceLabel =
    extractStockAnalysisCellValue(overviewHtml, "Previous Close") ||
    extractStockAnalysisCellValue(overviewHtml, "Open") ||
    overviewFallback.previousCloseLabel ||
    overviewFallback.openLabel;
  const holdingsCount = extractStockAnalysisCellValue(overviewHtml, "Holdings") || overviewFallback.holdingsCount;
  const categoryName =
    extractStockAnalysisCellValue(overviewHtml, "Category") ||
    extractStockAnalysisCellValue(overviewHtml, "Asset Class") ||
    overviewFallback.categoryName;
  const provider = extractStockAnalysisCellValue(overviewHtml, "ETF Provider") || overviewFallback.provider;

  const scriptBreakdown = extractStockAnalysisHoldingsFromScript(holdingsHtml);
  const tableHoldings = extractStockAnalysisHoldings(holdingsHtml);
  const holdings = tableHoldings.length ? tableHoldings : scriptBreakdown.holdings;

  return {
    info: {
      expenseRatio: parsePercentValue(expenseRatioLabel),
      expenseRatioLabel,
      assetsUnderManagement: parseCompactMoney(assetsLabel),
      assetsUnderManagementLabel: assetsLabel,
      dividendYield: parsePercentValue(dividendYieldLabel),
      dividendYieldLabel,
      nav: parseCompactMoney(lastPriceLabel),
      navLabel: lastPriceLabel,
      latestPrice: firstDefined(overviewFallback.latestPrice, parseCompactMoney(lastPriceLabel)),
      latestPriceLabel: overviewFallback.latestPrice != null ? `$${round(overviewFallback.latestPrice, 2)}` : lastPriceLabel,
      family: provider,
      categoryName,
      legalType: "ETF",
      longName: null,
      holdingsCount,
      latestPriceSource: overviewFallback.latestPrice != null ? "Stock Analysis" : lastPriceLabel ? "Stock Analysis (fallback)" : null,
    },
    holdings,
    sectorWeights: scriptBreakdown.sectorWeights,
    summary: null,
  };
}

async function fetchYahooEtfData(code, env) {
  const html = await fetchYahooQuotePage(code, env);

  const structuredSummary = extractYahooEmbeddedSummary(html, code) || extractYahooSummaryFromHtml(html);
  if (structuredSummary) {
    return {
      info: {
        ...normalizeYahooEtfInfo(structuredSummary),
        latestPriceSource: "Yahoo Finance",
      },
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
    regexFallback.info.latestPriceSource = "Yahoo Finance (regex fallback)";
    return regexFallback;
  }

  throw new Error("Unable to extract ETF summary data from Yahoo Finance page.");
}

function buildEtfDetailCards(info) {
  return [
    {
      key: "expenseRatio",
      label: "운용보수",
      value: firstDefined(info.expenseRatioLabel, info.expenseRatio != null ? formatPercentLabel(info.expenseRatio) : null, "-"),
      rawValue: info.expenseRatio,
      kind: "percent",
      description: "ETF가 매년 부담하는 총 보수 비율입니다.",
    },
    {
      key: "dividendYield",
      label: "배당수익률",
      value: firstDefined(info.dividendYieldLabel, info.dividendYield != null ? formatPercentLabel(info.dividendYield) : null, "-"),
      rawValue: info.dividendYield,
      kind: "percent",
      description: "최근 기준 trailing 배당수익률입니다.",
    },
    {
      key: "assetsUnderManagement",
      label: "순자산 규모",
      value: firstDefined(formatCompactCurrency(info.assetsUnderManagement), info.assetsUnderManagementLabel, "-"),
      rawValue: info.assetsUnderManagement,
      kind: "money",
      description: "ETF 전체 운용 자산 규모입니다.",
    },
    {
      key: "lastPrice",
      label: "최근 가격",
      value: firstDefined(info.latestPriceLabel, info.latestPrice != null ? `$${round(info.latestPrice, 2)}` : null, info.navLabel, "-"),
      rawValue: info.latestPrice,
      kind: "money",
      description: "최근 시장 가격 기준입니다.",
    },
  ];
}

function buildSourceList(code) {
  const sources = [
    { label: "Yahoo Finance ETF Quote Page", url: `${YAHOO_FINANCE_QUOTE_URL}/${encodeURIComponent(code)}` },
    { label: "FMP Quote API", url: "https://site.financialmodelingprep.com/developer/docs/stable/quotes" },
    { label: "FMP ETF Information API", url: "https://site.financialmodelingprep.com/developer/docs/stable/information" },
  ];

  const direxionUrl = DIREXION_PRODUCT_URLS[code.toUpperCase()];
  if (direxionUrl) {
    sources.push({ label: "Direxion Product Page", url: direxionUrl });
  }

  return sources;
}

function summarizeSourceError(error) {
  if (!error) return "ok";
  const message = String(error.message || error);
  if (message.includes("Thank you for using Alpha Vantage")) return "Alpha Vantage rate limit";
  if (message.includes("HTTP 402")) return "plan limit (402)";
  if (message.includes("HTTP 403")) return "access denied (403)";
  if (message.length > 120) return `${message.slice(0, 117)}...`;
  return message;
}

export async function getUSEtfData(code, env, selectedName = "") {
  let direxionData = null;
  let direxionError = null;
  try {
    direxionData = await fetchDirexionEtfData(code, env);
  } catch (error) {
    direxionData = null;
    direxionError = error;
  }

  let alphaVantageData = null;
  let alphaVantageError = null;
  try {
    alphaVantageData = normalizeAlphaVantageEtfProfile(
      await alphaVantageFetch({ function: "ETF_PROFILE", symbol: code }, env),
    );
  } catch (error) {
    alphaVantageData = null;
    alphaVantageError = error;
  }

  let stockAnalysisData = null;
  let stockAnalysisError = null;
  try {
    stockAnalysisData = await fetchStockAnalysisEtfData(code, env);
  } catch (error) {
    stockAnalysisData = null;
    stockAnalysisError = error;
  }

  let yahooData = null;
  let yahooError = null;
  try {
    yahooData = await fetchYahooEtfData(code, env);
  } catch (error) {
    yahooData = null;
    yahooError = error;
  }

  const [quoteResult, profileResult, infoResult, holdingsResult, sectorResult] = await Promise.allSettled([
    fmpFetch("/quote", { symbol: code }, env, QUOTE_TTL),
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
  const fmpInfoError = infoResult.status === "rejected" ? infoResult.reason : null;
  const fmpHoldingsError = holdingsResult.status === "rejected" ? holdingsResult.reason : null;
  const fmpSectorsError = sectorResult.status === "rejected" ? sectorResult.reason : null;

  const quote = Array.isArray(quoteData) ? quoteData[0] ?? {} : quoteData ?? {};
  const profile = Array.isArray(profileData) ? profileData[0] ?? {} : profileData ?? {};
  const fmpInfo = normalizeFmpInfoRow(Array.isArray(infoData) ? infoData[0] ?? {} : infoData ?? {});
  const direxionInfo = direxionData?.info ?? {};
  const alphaInfo = alphaVantageData?.info ?? {};
  const yahooInfo = yahooData?.info ?? {};
  const stockAnalysisInfo = stockAnalysisData?.info ?? {};

  const quotePrice = toNumber(quote.price);
  const latestPrice = firstDefined(
    stockAnalysisInfo.latestPrice,
    yahooInfo.latestPrice,
    yahooInfo.nav,
    direxionInfo.latestPrice,
    quotePrice,
    fmpInfo.latestPrice,
  );
  const latestPriceLabel = latestPrice != null ? `$${round(latestPrice, 2)}` : null;
  const latestPriceSource = firstDefined(
    stockAnalysisInfo.latestPrice != null ? stockAnalysisInfo.latestPriceSource || "Stock Analysis" : null,
    yahooInfo.latestPrice != null || yahooInfo.nav != null ? yahooInfo.latestPriceSource || "Yahoo Finance" : null,
    direxionInfo.latestPrice != null ? direxionInfo.latestPriceSource || "Direxion" : null,
    quotePrice != null ? "FMP Quote" : null,
    fmpInfo.latestPrice != null ? "FMP ETF Info" : null,
  );
  const latestPriceAsOf = firstDefined(
    stockAnalysisInfo.latestPriceAsOf,
    yahooInfo.latestPriceAsOf,
    direxionInfo.latestPriceAsOf,
  );
  const mergedInfo = {
    expenseRatio: firstDefined(stockAnalysisInfo.expenseRatio, alphaInfo.expenseRatio, yahooInfo.expenseRatio, fmpInfo.expenseRatio),
    expenseRatioLabel: firstDefined(stockAnalysisInfo.expenseRatioLabel, alphaInfo.expenseRatioLabel, yahooInfo.expenseRatioLabel),
    dividendYield: firstDefined(stockAnalysisInfo.dividendYield, alphaInfo.dividendYield, yahooInfo.dividendYield, fmpInfo.dividendYield),
    dividendYieldLabel: firstDefined(stockAnalysisInfo.dividendYieldLabel, alphaInfo.dividendYieldLabel, yahooInfo.dividendYieldLabel),
    assetsUnderManagement: firstDefined(stockAnalysisInfo.assetsUnderManagement, alphaInfo.assetsUnderManagement, yahooInfo.assetsUnderManagement, fmpInfo.assetsUnderManagement),
    assetsUnderManagementLabel: firstDefined(stockAnalysisInfo.assetsUnderManagementLabel, alphaInfo.assetsUnderManagementLabel, yahooInfo.assetsUnderManagementLabel),
    nav: firstDefined(direxionInfo.nav, fmpInfo.nav, stockAnalysisInfo.nav, yahooInfo.nav, latestPrice),
    navLabel: firstDefined(direxionInfo.navLabel, latestPriceLabel, stockAnalysisInfo.navLabel, yahooInfo.navLabel),
    latestPrice,
    latestPriceLabel,
    latestPriceSource,
    latestPriceAsOf,
  };

  const holdings = alphaVantageData?.holdings?.length
    ? alphaVantageData.holdings
    : stockAnalysisData?.holdings?.length
    ? stockAnalysisData.holdings
    : yahooData?.holdings?.length
      ? yahooData.holdings
      : normalizeFmpHoldings(holdingsData);
  const sectorWeights = alphaVantageData?.sectorWeights?.length
    ? alphaVantageData.sectorWeights
    : yahooData?.sectorWeights?.length
      ? yahooData.sectorWeights
      : normalizeFmpSectorWeights(sectorData);
  const category = firstDefined(
    stockAnalysisInfo.categoryName,
    alphaInfo.categoryName,
    yahooData?.summary?.fundProfile?.categoryName,
    yahooInfo.categoryName,
    yahooData?.summary?.fundProfile?.legalType,
    yahooInfo.legalType,
    profile.industry,
    profile.sector,
    "ETF",
  );
  const provider = firstDefined(
    stockAnalysisInfo.family,
    alphaInfo.family,
    yahooData?.summary?.fundProfile?.family,
    yahooInfo.family,
    profile.companyName,
  );
  const displayName = firstDefined(
    selectedName,
    alphaInfo.longName,
    yahooData?.summary?.price?.longName,
    stockAnalysisInfo.longName,
    yahooInfo.longName,
    yahooData?.summary?.price?.shortName,
    profile.companyName,
    code,
  );

  const sourceStatus = [
    `Direxion ETF page: ${direxionData ? "ok" : summarizeSourceError(direxionError || "unavailable")}`,
    `Alpha Vantage ETF_PROFILE: ${alphaVantageData ? "ok" : summarizeSourceError(alphaVantageError || "unavailable")}`,
    `Stock Analysis overview/holdings: ${stockAnalysisData ? "ok" : summarizeSourceError(stockAnalysisError || "unavailable")}`,
    `Yahoo ETF page: ${yahooData ? "ok" : summarizeSourceError(yahooError || "unavailable")}`,
    `FMP ETF info: ${fmpInfoError ? summarizeSourceError(fmpInfoError) : "ok"}`,
    `FMP ETF holdings: ${fmpHoldingsError ? summarizeSourceError(fmpHoldingsError) : "ok"}`,
    `FMP ETF sector weights: ${fmpSectorsError ? summarizeSourceError(fmpSectorsError) : "ok"}`,
  ];

  const hasSparseEtfData =
    mergedInfo.expenseRatio == null &&
    mergedInfo.dividendYield == null &&
    mergedInfo.assetsUnderManagement == null &&
    holdings.length === 0 &&
    sectorWeights.length === 0;

  return {
    stock: {
      code,
      name: displayName,
      market: "US",
      marketLabel: "미국 시장",
      industry: category,
      assetType: "ETF",
      description: `${category}${provider ? ` · ${provider}` : ""}${latestPrice != null ? ` · 최근 가격 $${round(latestPrice, 2)}` : ""}`,
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
    summaryNote: "ETF는 개별 기업 재무제표보다 펀드 구조가 더 중요합니다. 운용보수, 배당수익률, 순자산 규모, 상위 보유 종목, 섹터 비중을 함께 읽는 것이 핵심입니다.",
    notes: [
      "레버리지 ETF는 복리 효과와 변동성 드래그 때문에 장기 보유 시 기초지수 단순 배수와 다른 성과가 나올 수 있습니다.",
      "운용보수와 배당수익률은 데이터 제공처와 업데이트 시점에 따라 조금씩 다를 수 있습니다.",
      "상위 보유 종목과 섹터 비중을 같이 보면 ETF가 실제로 어떤 테마와 집중 위험을 담고 있는지 파악하기 쉽습니다.",
      ...(latestPriceSource
        ? [`최근 가격 소스: ${latestPriceSource}${latestPriceAsOf ? ` · 기준일 ${latestPriceAsOf}` : ""}`]
        : []),
      ...(hasSparseEtfData
        ? ["ETF 상세 소스 진단: " + sourceStatus.join(" | ")]
        : []),
    ],
    sources: [
      { label: "Stock Analysis ETF Overview", url: `${STOCKANALYSIS_ETF_URL}/${encodeURIComponent(code.toLowerCase())}/` },
      { label: "Stock Analysis ETF Holdings", url: `${STOCKANALYSIS_ETF_URL}/${encodeURIComponent(code.toLowerCase())}/holdings/` },
      ...buildSourceList(code),
    ],
  };
}
