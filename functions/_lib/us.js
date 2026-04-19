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
  const [quoteData, infoData] = await Promise.all([
    fmpFetch("/quote", { symbol: code }, env),
    fmpFetch("/etf/info", { symbol: code }, env),
  ]);

  const quote = Array.isArray(quoteData) ? quoteData[0] ?? {} : quoteData ?? {};
  const info = Array.isArray(infoData) ? infoData[0] ?? {} : infoData ?? {};
  const latestPrice = toNumber(quote.price);
  const category = info.category || info.assetClass || "ETF";
  const provider = info.issuer || info.provider || info.fundFamily || null;
  const expenseRatio = toNumber(info.expenseRatio);

  return {
    stock: {
      code,
      name: info.name || stockMeta?.name || code,
      market: "US",
      marketLabel: "미국 주식",
      industry: category,
      assetType: "ETF",
      description: `${category}${provider ? ` · ${provider}` : ""}${latestPrice != null ? ` · 최신 가격 $${latestPrice.toFixed(2)}` : ""}`,
      metrics: emptyMetrics(),
      metricDefinitions,
    },
    history: [],
    summaryNote:
      "ETF는 개별 기업 재무제표 기반 7개 지표를 그대로 적용하기 어렵습니다. 이 화면에서는 ETF임을 표시하고, 백테스팅 탭에서 가격 기반 전략 검증에 집중하는 편이 적절합니다.",
    notes: [
      "ETF는 운영 구조가 기업과 달라 PER·PBR·ROE 같은 개별 기업용 재무지표가 비어 있을 수 있습니다.",
      expenseRatio != null
        ? `FMP ETF 정보 기준 총보수(Expense Ratio)는 ${expenseRatio}% 입니다.`
        : "총보수, 자산규모, 추종지수 같은 ETF 전용 지표를 별도 탭으로 분리하는 것이 더 적합합니다.",
      "SOXL 같은 레버리지 ETF는 장기 보유 시 복리 효과와 변동성 드래그 때문에 기초지수를 단순 배수로 따라가지 않습니다.",
    ],
    sources: [
      { label: "FMP ETF Symbol Search API", url: "https://site.financialmodelingprep.com/developer/docs/etf-list-api" },
      { label: "FMP ETF & Mutual Fund Information API", url: "https://site.financialmodelingprep.com/developer/docs/stable/information" },
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

  const [profileData, quoteData, incomeData, balanceData, priceData, dividendData] = await Promise.all([
    fmpFetch("/profile", { symbol: code }, env),
    fmpFetch("/quote", { symbol: code }, env),
    fmpFetch("/income-statement", { symbol: code, period: "quarter", limit: "4" }, env),
    fmpFetch("/balance-sheet-statement", { symbol: code, period: "quarter", limit: "4" }, env),
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
    fmpFetch("/dividends", { symbol: code }, env),
  ]);

  const profile = Array.isArray(profileData) ? profileData[0] ?? {} : profileData ?? {};
  const quote = Array.isArray(quoteData) ? quoteData[0] ?? {} : quoteData ?? {};
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
      marketLabel: "미국 주식",
      industry: profile.industry || selectedMeta.exchange,
      assetType: "Stock",
      description: `${selectedMeta.exchange} 상장 · 최신 가격 ${latestPrice != null ? `$${latestPrice.toFixed(2)}` : "조회 불가"}`,
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
