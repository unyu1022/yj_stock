import { remember } from "./cache.js";
import { metricDefinitions, percent, round, toNumber } from "./metrics.js";

const ONE_DAY = 24 * 60 * 60 * 1000;
const HALF_DAY = 12 * 60 * 60 * 1000;
const SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers_exchange.json";
const FMP_BASE_URL = "https://financialmodelingprep.com/stable";

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
    throw new Error("誘멸뎅 二쇱떇 議고쉶?먮뒗 FMP_API_KEY ?섍꼍蹂?섍? ?꾩슂?⑸땲??");
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
    marketLabel: "誘멸뎅 二쇱떇",
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
      throw new Error(`SEC 醫낅ぉ 紐⑸줉 議고쉶 ?ㅽ뙣: HTTP ${response.status}`);
    }

    const text = await response.text();
    if (!text) {
      throw new Error("SEC 醫낅ぉ 紐⑸줉 ?묐떟 蹂몃Ц??鍮꾩뼱 ?덉뒿?덈떎.");
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new Error("SEC 醫낅ぉ 紐⑸줉 JSON ?뚯떛???ㅽ뙣?덉뒿?덈떎.");
    }

    return (data.data ?? [])
      .map((row) => ({
        code: row[2],
        name: row[1],
        exchange: row[3],
        cik: String(row[0]).padStart(10, "0"),
        market: "US",
        marketLabel: "誘멸뎅 二쇱떇",
      }))
      .filter((item) => item.code && item.exchange)
      .sort((a, b) => a.code.localeCompare(b.code));
  });
}

export async function searchUSStocks(query, env) {
  const list = await loadUSTickers(env);
  const normalized = query.trim().toLowerCase();
  const localMatches = (!normalized
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

  if (!normalized || !env.FMP_API_KEY) {
    return localMatches.slice(0, 20);
  }

  const remoteResponses = await Promise.allSettled([
    fmpFetch("/search-symbol", { query: query.trim() }, env),
    fmpFetch("/search-name", { query: query.trim() }, env),
  ]);

  const remoteMatches = remoteResponses
    .filter((result) => result.status === "fulfilled")
    .flatMap((result) => (Array.isArray(result.value) ? result.value : []))
    .map(mapSearchRow)
    .filter(Boolean);

  return mergeSearchItems([...localMatches, ...remoteMatches]).slice(0, 20);
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
        throw new Error("FMP 議고쉶 ?ㅽ뙣: HTTP 403 (API ?ㅺ? ?섎せ?섏뿀嫄곕굹 ?꾩옱 ?뚮옖?먯꽌 ???붿껌???덉슜?섏? ?딆뒿?덈떎.)");
      }
      throw new Error(`FMP 議고쉶 ?ㅽ뙣: HTTP ${response.status}`);
    }
    if (!text) {
      throw new Error(`FMP ?묐떟 蹂몃Ц??鍮꾩뼱 ?덉뒿?덈떎. path=${path}`);
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new Error(`FMP JSON ?뚯떛 ?ㅽ뙣: path=${path}`);
    }

    if (data?.["Error Message"]) {
      throw new Error(data["Error Message"]);
    }
    if (data?.error) {
      throw new Error(typeof data.error === "string" ? data.error : data.error.message || `FMP ?ㅻ쪟: ${path}`);
    }
    if (data?.Error) {
      throw new Error(data.Error);
    }
    if (Array.isArray(data) && data.length === 0) {
      return data;
    }
    if (data == null) {
      throw new Error(`FMP ?묐떟 ?곗씠?곌? 鍮꾩뼱 ?덉뒿?덈떎. path=${path}`);
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
    headline: "遺꾧린 ?ㅼ쟻 諛섏쁺",
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
  return `${latest.label} 湲곗? 遺꾧린 ?щТ? 理쒓렐 媛寃??먮쫫??議고빀??怨꾩궛?덉뒿?덈떎. 誘멸뎅 醫낅ぉ? SEC 醫낅ぉ 紐⑸줉怨?FMP ?щТ/媛寃??곗씠?곕? ?④퍡 ?ъ슜?⑸땲??`;
}

async function getUSEtfData(code, env, stockMeta = null) {
  const [quoteResult, profileResult] = await Promise.allSettled([
    fmpFetch("/quote", { symbol: code }, env),
    fmpFetch("/profile", { symbol: code }, env),
  ]);

  const quoteData = quoteResult.status === "fulfilled" ? quoteResult.value : [];
  const profileData = profileResult.status === "fulfilled" ? profileResult.value : [];
  const quote = Array.isArray(quoteData) ? quoteData[0] ?? {} : quoteData ?? {};
  const profile = Array.isArray(profileData) ? profileData[0] ?? {} : profileData ?? {};
  const latestPrice = toNumber(quote.price);
  const category = profile.industry || profile.sector || "ETF";
  const provider = profile.companyName || stockMeta?.name || null;

  return {
    stock: {
      code,
      name: stockMeta?.name || profile.companyName || code,
      market: "US",
      marketLabel: "誘멸뎅 二쇱떇",
      industry: category,
      assetType: "ETF",
      description: `${category}${provider ? ` 쨌 ${provider}` : ""}${latestPrice != null ? ` 쨌 理쒖떊 媛寃?$${latestPrice.toFixed(2)}` : ""}`,
      metrics: emptyMetrics(),
      metricDefinitions,
    },
    history: [],
    summaryNote:
      "ETF??媛쒕퀎 湲곗뾽 ?щТ?쒗몴 湲곕컲 7媛?吏?쒕? 洹몃?濡??곸슜?섍린 ?대졄?듬땲?? ???붾㈃?먯꽌??ETF?꾩쓣 ?쒖떆?섍퀬, 諛깊뀒?ㅽ똿 ??뿉??媛寃?湲곕컲 ?꾨왂 寃利앹뿉 吏묒쨷?섎뒗 ?몄씠 ?곸젅?⑸땲??",
    notes: [
      "ETF???댁쁺 援ъ“媛 湲곗뾽怨??щ씪 PER쨌PBR쨌ROE 媛숈? 媛쒕퀎 湲곗뾽???щТ吏?쒓? 鍮꾩뼱 ?덉쓣 ???덉뒿?덈떎.",
      "珥앸낫?? ?먯궛洹쒕е, 異붿쥌吏??媛숈? ETF ?꾩슜 吏?쒕? 蹂꾨룄 ??쑝濡?遺꾨━?섎뒗 寃껋씠 ???곹빀?⑸땲??",
      "SOXL 媛숈? ?덈쾭由ъ? ETF???κ린 蹂댁쑀 ??蹂듬━ ?④낵? 蹂?숈꽦 ?쒕옒洹??뚮Ц??湲곗큹吏?섎? ?⑥닚 諛곗닔濡??곕씪媛吏 ?딆뒿?덈떎.",
    ],
    sources: [
      { label: "FMP ETF Symbol Search API", url: "https://site.financialmodelingprep.com/developer/docs/etf-list-api" },
      { label: "FMP Stock Symbol Search API", url: "https://site.financialmodelingprep.com/developer/docs/stable/search-symbol" },
      { label: "FMP Company Name Search API", url: "https://site.financialmodelingprep.com/developer/docs/stable/search-name" },
      { label: "FMP Developer Docs", url: "https://site.financialmodelingprep.com/developer/docs/" },
    ],
  };
}

export async function getUSStockData(code, env) {
  const tickers = await loadUSTickers(env);
  const stockMeta = tickers.find((item) => item.code === code);
  const fallbackMeta = stockMeta || { code, name: code, exchange: "ETF" };
  const selectedMeta = stockMeta || fallbackMeta;

  const today = new Date();
  const from = new Date(today);
  from.setUTCFullYear(from.getUTCFullYear() - 2);

  const [profileData, quoteData, priceData] = await Promise.all([
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
  const dividendHistory = sortDescendingByDate(
    Array.isArray(dividendData) ? dividendData : Array.isArray(dividendData?.historical) ? dividendData.historical : [],
  );

  const quarterlyReports = incomeReports.filter((report) => balanceByDate.has(report.date)).slice(0, 4);
  if (!quarterlyReports.length) {
    return getUSEtfData(code, env, fallbackMeta);
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
      marketLabel: "誘멸뎅 二쇱떇",
      industry: profile.industry || selectedMeta.exchange,
      assetType: "Stock",
      description: `${selectedMeta.exchange} ?곸옣 쨌 理쒖떊 媛寃?${latestPrice != null ? `$${latestPrice.toFixed(2)}` : "議고쉶 遺덇?"}`,
      metrics: latestMetrics,
      metricDefinitions,
    },
    history,
    summaryNote: summarizeUS(history),
    notes: [
      "誘멸뎅 二쇱떇 寃?됱? SEC company_tickers_exchange.json???ъ슜?⑸땲??",
      "誘멸뎅 二쇱떇 ?곸꽭 遺꾩꽍? Financial Modeling Prep(FMP)??遺꾧린 ?щТ?쒗몴? 媛寃??곗씠?곕? ?ъ슜?⑸땲??",
      "PER쨌PBR쨌諛곕떦?섏씡瑜좎? 理쒖떊 媛寃⑷낵 理쒓렐 遺꾧린 ?щТ媛??먮뒗 理쒖떊 諛곕떦 ?곗씠?곕? 議고빀??怨꾩궛媛믪엯?덈떎.",
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
    throw new Error("諛깊뀒?ㅽ듃 媛寃??곗씠?곌? 遺議깊빀?덈떎.");
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
    throw new Error("諛깊뀒?ㅽ듃 李⑦듃瑜?留뚮뱾 媛寃??곗씠?곌? 遺議깊빀?덈떎.");
  }

  const stockStart = filteredStock[0].close;
  const benchmarkLookup = buildBenchmarkLookup(filteredBenchmark);
  const benchmarkStartRow = findClosestPriceOnOrAfter(filteredBenchmark, startDate) || filteredBenchmark[0];
  const benchmarkStart = benchmarkStartRow?.close;
  if (!stockStart || !benchmarkStart) {
    throw new Error("諛깊뀒?ㅽ듃 湲곗? 媛寃⑹쓣 怨꾩궛?섏? 紐삵뻽?듬땲??");
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
    label: "異붿꽭 ?꾪솚 (50??200???대룞?됯퇏)",
    shortLabel: "異붿꽭 ?꾪솚",
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
    label: "怨듯룷吏??(VIX 30 ?댁긽 留ㅼ닔, 20 ?댄븯 留ㅻ룄)",
    shortLabel: "怨듯룷吏??",
    points,
  };
}

function simulateNasdaqBenchmark(benchmarkSeries, startDate, endDate) {
  const filtered = benchmarkSeries.filter((row) => row.date >= startDate && row.date <= endDate && row.close != null);
  if (!filtered.length) {
    throw new Error("NASDAQ 鍮꾧탳??媛寃??곗씠?곌? 遺議깊빀?덈떎.");
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
    throw new Error("蹂댁쑀 湲곌컙? 理쒖냼 1媛쒖썡 ?댁긽?댁뼱???⑸땲??");
  }
  if (!["trend", "vix"].includes(normalizedStrategy)) {
    throw new Error("strategy ?뚮씪誘명꽣??trend ?먮뒗 vix ?ъ빞 ?⑸땲??");
  }

  const tickers = await loadUSTickers(env);
  const stockMeta = tickers.find((item) => item.code === code);
  if (!stockMeta) {
    throw new Error("?대떦 誘멸뎅 醫낅ぉ??李얠? 紐삵뻽?듬땲??");
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
    throw new Error("諛깊뀒?ㅽ듃 湲곌컙???꾩슂??醫낅ぉ 媛寃??곗씠?곌? 遺議깊빀?덈떎.");
  }

  const strategyResult =
    normalizedStrategy === "trend"
      ? simulateTrendStrategy(stockSeries, stockStart.date, stockEnd.date)
      : simulateVixStrategy(stockSeries, vixSeries, stockStart.date, stockEnd.date);

  if (!strategyResult.points.length) {
    throw new Error("?꾨왂 諛깊뀒?ㅽ듃瑜?怨꾩궛???곗씠?곌? 遺議깊빀?덈떎.");
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
        ? "異붿꽭 ?꾪솚 ?꾨왂? ?꾩씪 湲곗? 50???대룞?됯퇏??200???대룞?됯퇏???곹뼢 ?뚰뙆?섎㈃ 留ㅼ닔 ?곹깭濡??꾪솚?섍퀬, 諛섎?濡??대젮媛硫??꾧툑 ?곹깭濡??꾪솚?⑸땲??"
        : "怨듯룷吏???꾨왂? ?꾩씪 VIX媛 30 ?댁긽?대㈃ 留ㅼ닔 ?곹깭濡??꾪솚?섍퀬, 20 ?댄븯?대㈃ 留ㅻ룄 ?곹깭濡??꾪솚?섎뒗 ?⑥닚 由ъ뒪?????ㅽ봽 諛⑹떇?낅땲??",
      "鍮꾧탳 湲곗?? 媛숈? 湲곌컙??NASDAQ Composite (^IXIC) ?⑥닚 蹂댁쑀 ?깃낵?낅땲??",
      "?꾩쟻?섏씡瑜좎? ?쒖옉 ?쒖젏 ?鍮?珥앹닔?듬쪧?닿퀬 CAGR? ?대떦 湲곌컙???곕났由??섏씡瑜좎엯?덈떎.",
    ],
  };
}
