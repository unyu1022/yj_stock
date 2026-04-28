import { remember } from "./cache.js";
import { round, toNumber } from "./metrics.js";

const HALF_DAY = 12 * 60 * 60 * 1000;
const FMP_BASE_URL = "https://financialmodelingprep.com/stable";
const YAHOO_CHART_BASE_URL = "https://query1.finance.yahoo.com/v8/finance/chart";

function fmpHeaders(env) {
  return {
    "user-agent": `Stock Insight PWA ${env.SEC_CONTACT_EMAIL || "admin@example.com"}`,
    accept: "application/json, text/plain, */*",
  };
}

function yahooHeaders(env) {
  return {
    "user-agent": `Mozilla/5.0 Stock Insight PWA ${env.SEC_CONTACT_EMAIL || "admin@example.com"}`,
    accept: "application/json, text/plain, */*",
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

async function yahooChartFetch(symbol, fromDate, toDate, env, ttl = HALF_DAY) {
  const params = new URLSearchParams({
    period1: String(Math.floor(new Date(`${fromDate}T00:00:00Z`).getTime() / 1000)),
    period2: String(Math.floor(new Date(`${toDate}T23:59:59Z`).getTime() / 1000)),
    interval: "1d",
    includePrePost: "false",
    events: "div,splits,capitalGains",
  });
  const cacheKey = `yahoo-chart:${symbol}?${params.toString()}`;

  return remember(cacheKey, ttl, async () => {
    const response = await fetch(`${YAHOO_CHART_BASE_URL}/${encodeURIComponent(symbol)}?${params.toString()}`, {
      headers: yahooHeaders(env),
    });
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`Yahoo Finance 가격 조회 실패: HTTP ${response.status}`);
    }

    if (!text) {
      throw new Error(`Yahoo Finance 응답 본문이 비어 있습니다. symbol=${symbol}`);
    }

    const data = JSON.parse(text);
    const result = data?.chart?.result?.[0];
    if (!result) {
      throw new Error(`Yahoo Finance 가격 데이터가 비어 있습니다. symbol=${symbol}`);
    }

    const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
    const quote = result?.indicators?.quote?.[0] ?? {};
    const closes = Array.isArray(quote.close) ? quote.close : [];
    const meta = result.meta ?? {};

    const rows = timestamps
      .map((timestamp, index) => ({
        date: new Date(timestamp * 1000).toISOString().slice(0, 10),
        close: toNumber(closes[index]),
      }))
      .filter((row) => row.close != null);

    return {
      rows,
      meta,
    };
  });
}

function subtractPeriod(date, years, months) {
  const copy = new Date(date);
  copy.setUTCFullYear(copy.getUTCFullYear() - years);
  copy.setUTCMonth(copy.getUTCMonth() - months);
  return copy;
}

function sortAscendingByDate(items) {
  return [...items].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
}

function normalizePriceSeries(rawSeries) {
  const rows = Array.isArray(rawSeries?.historical) ? rawSeries.historical : Array.isArray(rawSeries) ? rawSeries : [];
  return sortAscendingByDate(rows).map((row) => ({
    date: row.date,
    close: toNumber(row.close) ?? toNumber(row.adjClose) ?? toNumber(row.price) ?? null,
  }));
}

function normalizeYahooSeries(payload) {
  return sortAscendingByDate(Array.isArray(payload?.rows) ? payload.rows : []).map((row) => ({
    date: row.date,
    close: toNumber(row.close),
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

function priceReturn(series, endIndex, length) {
  const startIndex = endIndex - length;
  const startClose = series[startIndex]?.close;
  const endClose = series[endIndex]?.close;
  if (startClose == null || endClose == null || startClose <= 0) return null;
  return (endClose / startClose - 1) * 100;
}

function highestClose(series, endIndex, length) {
  if (endIndex - length + 1 < 0) return null;
  let high = -Infinity;
  for (let index = endIndex; index > endIndex - length; index -= 1) {
    const close = series[index]?.close;
    if (close == null) return null;
    high = Math.max(high, close);
  }
  return high;
}

function lowestClose(series, endIndex, length) {
  if (endIndex - length + 1 < 0) return null;
  let low = Infinity;
  for (let index = endIndex; index > endIndex - length; index -= 1) {
    const close = series[index]?.close;
    if (close == null) return null;
    low = Math.min(low, close);
  }
  return low;
}

function computeRsi(series, endIndex, length = 14) {
  if (endIndex - length < 0) return null;
  let gains = 0;
  let losses = 0;

  for (let index = endIndex - length + 1; index <= endIndex; index += 1) {
    const current = series[index]?.close;
    const previous = series[index - 1]?.close;
    if (current == null || previous == null) return null;
    const change = current - previous;
    if (change >= 0) gains += change;
    else losses += Math.abs(change);
  }

  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function annualizedVolatility(series, endIndex, length = 20) {
  if (endIndex - length < 0) return null;
  const returns = [];

  for (let index = endIndex - length + 1; index <= endIndex; index += 1) {
    const current = series[index]?.close;
    const previous = series[index - 1]?.close;
    if (current == null || previous == null || previous <= 0) return null;
    returns.push(Math.log(current / previous));
  }

  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / returns.length;
  return Math.sqrt(variance) * Math.sqrt(252) * 100;
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

function simulateRuleBasedStrategy(stockSeries, startDate, endDate, config) {
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

    const nextPosition = config.nextPosition(stockSeries, index, regime);
    if (nextPosition === 0 || nextPosition === 1) {
      regime = nextPosition;
    }

    points.push({
      date: row.date,
      value: round(portfolioValue),
      position: priorPosition,
      signal: regime,
    });

    priorPosition = regime;
  }

  return {
    label: config.label,
    shortLabel: config.shortLabel,
    points,
  };
}

function simulateTrendStrategy(stockSeries, startDate, endDate) {
  return simulateRuleBasedStrategy(stockSeries, startDate, endDate, {
    label: "추세 전환 (50일/200일 이동평균)",
    shortLabel: "추세 전환",
    nextPosition: (series, index) => {
      const sma50 = averageClose(series, index - 1, 50);
      const sma200 = averageClose(series, index - 1, 200);
      return sma50 != null && sma200 != null && sma50 > sma200 ? 1 : 0;
    },
  });
}

function simulateMomentumStrategy(stockSeries, startDate, endDate) {
  return simulateRuleBasedStrategy(stockSeries, startDate, endDate, {
    label: "모멘텀 (3개월 수익률 양수 + 200일선 상회)",
    shortLabel: "모멘텀",
    nextPosition: (series, index) => {
      const previousClose = series[index - 1]?.close;
      const sma200 = averageClose(series, index - 1, 200);
      const threeMonthReturn = priceReturn(series, index - 1, 63);
      return previousClose != null && sma200 != null && threeMonthReturn != null && previousClose > sma200 && threeMonthReturn > 0 ? 1 : 0;
    },
  });
}

function simulateRsiStrategy(stockSeries, startDate, endDate) {
  return simulateRuleBasedStrategy(stockSeries, startDate, endDate, {
    label: "RSI 역추세 (RSI 30 이하 매수, 55 이상 매도)",
    shortLabel: "RSI 역추세",
    nextPosition: (series, index, regime) => {
      const rsi = computeRsi(series, index - 1, 14);
      if (rsi == null) return regime;
      if (rsi <= 30) return 1;
      if (rsi >= 55) return 0;
      return regime;
    },
  });
}

function simulateBreakoutStrategy(stockSeries, startDate, endDate) {
  return simulateRuleBasedStrategy(stockSeries, startDate, endDate, {
    label: "돌파 매매 (55일 신고가 매수, 20일 저가 이탈 매도)",
    shortLabel: "돌파 매매",
    nextPosition: (series, index, regime) => {
      const previousClose = series[index - 1]?.close;
      const priorHigh = highestClose(series, index - 2, 55);
      const priorLow = lowestClose(series, index - 2, 20);
      if (previousClose == null) return regime;
      if (priorHigh != null && previousClose >= priorHigh) return 1;
      if (priorLow != null && previousClose <= priorLow) return 0;
      return regime;
    },
  });
}

function simulateLowVolatilityStrategy(stockSeries, startDate, endDate) {
  return simulateRuleBasedStrategy(stockSeries, startDate, endDate, {
    label: "저변동성 추세 (20일 변동성 35% 미만 + 100일선 상회)",
    shortLabel: "저변동성",
    nextPosition: (series, index) => {
      const previousClose = series[index - 1]?.close;
      const sma100 = averageClose(series, index - 1, 100);
      const volatility = annualizedVolatility(series, index - 1, 20);
      return previousClose != null && sma100 != null && volatility != null && previousClose > sma100 && volatility < 35 ? 1 : 0;
    },
  });
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
      if (previousVix >= 30) regime = 1;
      else if (previousVix <= 20) regime = 0;
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
        benchmarkValue,
      };
    })
    .filter(Boolean);
}

function addMonthsUtc(date, months) {
  const copy = new Date(date);
  const originalDate = copy.getUTCDate();
  copy.setUTCDate(1);
  copy.setUTCMonth(copy.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(copy.getUTCFullYear(), copy.getUTCMonth() + 1, 0)).getUTCDate();
  copy.setUTCDate(Math.min(originalDate, lastDay));
  return copy;
}

function buildMonthlyDates(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  const dates = [];
  let cursor = start;

  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor = addMonthsUtc(cursor, 1);
  }

  return dates;
}

function simulateMonthlyDca(series, startDate, endDate, monthlyAmount) {
  const buyDates = buildMonthlyDates(startDate, endDate);
  const endPrice = findClosestPriceOnOrBefore(series, endDate);
  if (!endPrice) {
    throw new Error("기간 종료일에 사용할 가격 데이터가 부족합니다.");
  }

  let shares = 0;
  let principal = 0;
  const points = [];
  const usedBuyDates = new Set();

  for (const targetDate of buyDates) {
    const buy = findClosestPriceOnOrAfter(series, targetDate);
    if (!buy || buy.date > endDate || usedBuyDates.has(buy.date)) continue;

    usedBuyDates.add(buy.date);
    shares += monthlyAmount / buy.close;
    principal += monthlyAmount;
    const currentPrice = findClosestPriceOnOrBefore(series, buy.date);
    const value = shares * (currentPrice?.close ?? buy.close);

    points.push({
      date: buy.date,
      principal: round(principal),
      value: round(value),
      returnRate: principal > 0 ? round(((value / principal) - 1) * 100) : 0,
      shares,
    });
  }

  if (!points.length || principal <= 0) {
    throw new Error("월 적립식 투자를 계산할 수 있는 매수 가능일이 부족합니다.");
  }

  const endingValue = shares * endPrice.close;
  const profit = endingValue - principal;

  return {
    startDate: points[0].date,
    endDate: endPrice.date,
    contributionCount: points.length,
    principal: round(principal),
    endingValue: round(endingValue),
    profit: round(profit),
    cumulativeReturn: round((profit / principal) * 100),
    shares: round(shares),
    points: points.map((point) => {
      const price = findClosestPriceOnOrBefore(series, point.date);
      const value = point.shares * (price?.close ?? 0);
      return {
        date: point.date,
        principal: point.principal,
        value: round(value),
        returnRate: point.principal > 0 ? round(((value / point.principal) - 1) * 100) : 0,
      };
    }),
  };
}

function buildDcaChartSeries(stockPoints, benchmarkPoints) {
  const benchmarkLookup = new Map(benchmarkPoints.map((point) => [point.date, point]));
  return stockPoints
    .map((point) => {
      const benchmarkPoint = benchmarkLookup.get(point.date);
      if (!benchmarkPoint) return null;
      return {
        date: point.date,
        principal: point.principal,
        stockValue: point.value,
        benchmarkValue: benchmarkPoint.value,
        stockReturn: point.returnRate,
        benchmarkReturn: benchmarkPoint.returnRate,
      };
    })
    .filter(Boolean);
}

async function loadMetaAndSeries(symbol, from, to, env) {
  if (env.FMP_API_KEY) {
    try {
      const fmpPriceData = await fmpFetch("/historical-price-eod/full", { symbol, from, to }, env);
      const fmpSeries = normalizePriceSeries(fmpPriceData);
      if (fmpSeries.length) {
        return {
          series: fmpSeries,
          meta: null,
          source: "fmp",
        };
      }
    } catch (error) {
      const status = error?.status;
      if (status != null && ![401, 402, 403, 429].includes(status)) {
        throw error;
      }
    }
  }

  const yahooData = await yahooChartFetch(symbol, from, to, env);
  return {
    series: normalizeYahooSeries(yahooData),
    meta: yahooData.meta,
    source: "yahoo",
  };
}

export async function getUSDcaDataAny(code, env, years = 0, months = 0, monthlyAmount = 0) {
  const normalizedYears = Number.isFinite(years) ? Math.max(0, Math.trunc(years)) : 0;
  const normalizedMonths = Number.isFinite(months) ? Math.max(0, Math.trunc(months)) : 0;
  const normalizedMonthlyAmount = Number.isFinite(monthlyAmount) ? Math.max(0, Math.trunc(monthlyAmount)) : 0;

  if (normalizedYears === 0 && normalizedMonths === 0) {
    throw new Error("투자 기간은 최소 1개월 이상이어야 합니다.");
  }
  if (normalizedMonthlyAmount <= 0) {
    throw new Error("월 투자금은 0보다 커야 합니다.");
  }

  const today = new Date();
  const fromDate = subtractPeriod(today, normalizedYears, normalizedMonths);
  const from = fromDate.toISOString().slice(0, 10);
  const to = today.toISOString().slice(0, 10);

  const [stockPayload, benchmarkPayload] = await Promise.all([
    loadMetaAndSeries(code, from, to, env),
    loadMetaAndSeries("^IXIC", from, to, env),
  ]);

  const stockStart = findClosestPriceOnOrAfter(stockPayload.series, from);
  const stockEnd = findClosestPriceOnOrBefore(stockPayload.series, to);
  const benchmarkStart = findClosestPriceOnOrAfter(benchmarkPayload.series, from);
  const benchmarkEnd = findClosestPriceOnOrBefore(benchmarkPayload.series, to);

  if (!stockStart || !stockEnd || !benchmarkStart || !benchmarkEnd) {
    throw new Error("적립식 투자 비교에 필요한 가격 데이터가 부족합니다.");
  }

  const alignedStartDate = stockStart.date > benchmarkStart.date ? stockStart.date : benchmarkStart.date;
  const alignedEndDate = stockEnd.date < benchmarkEnd.date ? stockEnd.date : benchmarkEnd.date;
  const stockResult = simulateMonthlyDca(stockPayload.series, alignedStartDate, alignedEndDate, normalizedMonthlyAmount);
  const benchmarkResult = simulateMonthlyDca(benchmarkPayload.series, alignedStartDate, alignedEndDate, normalizedMonthlyAmount);
  const chartSeries = buildDcaChartSeries(stockResult.points, benchmarkResult.points);

  return {
    mode: "dca",
    stock: {
      code,
      name: stockPayload.meta?.longName || stockPayload.meta?.shortName || code,
      assetType: stockPayload.meta?.instrumentType === "ETF" ? "ETF" : undefined,
    },
    period: {
      years: normalizedYears,
      months: normalizedMonths,
      startDate: alignedStartDate,
      endDate: alignedEndDate,
    },
    monthlyAmount: normalizedMonthlyAmount,
    result: {
      stock: stockResult,
      benchmark: {
        ...benchmarkResult,
        code: "^IXIC",
        name: benchmarkPayload.meta?.longName || "NASDAQ Composite",
      },
      excessReturn: round(stockResult.cumulativeReturn - benchmarkResult.cumulativeReturn),
      excessProfit: round(stockResult.profit - benchmarkResult.profit),
    },
    chartSeries,
    notes: [
      "매월 첫 거래 가능일 종가에 같은 금액을 투자한다고 가정했습니다.",
      "원금은 월 투자금과 실제 매수 횟수를 곱한 값이며, 누적수익률은 현재 평가금액 대비 원금 기준입니다.",
      "비교 기준은 같은 월 투자금으로 NASDAQ Composite (^IXIC)에 적립식 투자한 결과입니다.",
      `가격 데이터 소스: ${stockPayload.source === "yahoo" ? "Yahoo Finance fallback" : "FMP"} / benchmark ${benchmarkPayload.source === "yahoo" ? "Yahoo Finance fallback" : "FMP"}`,
    ],
  };
}

export async function getUSBacktestDataAny(code, env, years = 0, months = 0, strategy = "trend") {
  const normalizedYears = Number.isFinite(years) ? Math.max(0, Math.trunc(years)) : 0;
  const normalizedMonths = Number.isFinite(months) ? Math.max(0, Math.trunc(months)) : 0;
  const normalizedStrategy = String(strategy || "trend").toLowerCase();
  const strategyNames = ["trend", "vix", "momentum", "rsi", "breakout", "lowvol", "all"];

  if (normalizedYears === 0 && normalizedMonths === 0) {
    throw new Error("보유 기간은 최소 1개월 이상이어야 합니다.");
  }
  if (!strategyNames.includes(normalizedStrategy)) {
    throw new Error(`strategy 파라미터는 ${strategyNames.join(", ")} 중 하나여야 합니다.`);
  }

  const today = new Date();
  const fromDate = subtractPeriod(today, normalizedYears, normalizedMonths);
  const historyPaddingDate = subtractPeriod(fromDate, 1, 6);
  const from = fromDate.toISOString().slice(0, 10);
  const to = today.toISOString().slice(0, 10);
  const extendedFrom = historyPaddingDate.toISOString().slice(0, 10);

  const stockPromise = loadMetaAndSeries(code, extendedFrom, to, env);
  const benchmarkPromise = loadMetaAndSeries("^IXIC", extendedFrom, to, env);
  const vixPromise = ["vix", "all"].includes(normalizedStrategy)
    ? loadMetaAndSeries("^VIX", extendedFrom, to, env)
    : Promise.resolve({ series: [] });

  const [stockPayload, benchmarkPayload, vixPayload] = await Promise.all([stockPromise, benchmarkPromise, vixPromise]);
  const stockSeries = stockPayload.series;
  const benchmarkSeries = benchmarkPayload.series;
  const vixSeries = vixPayload.series;

  const stockStart = findClosestPriceOnOrAfter(stockSeries, from);
  const stockEnd = findClosestPriceOnOrBefore(stockSeries, to);
  if (!stockStart || !stockEnd) {
    throw new Error("백테스트 기간에 필요한 종목 가격 데이터가 부족합니다.");
  }

  const strategyFactories = {
    trend: () => simulateTrendStrategy(stockSeries, stockStart.date, stockEnd.date),
    vix: () => simulateVixStrategy(stockSeries, vixSeries, stockStart.date, stockEnd.date),
    momentum: () => simulateMomentumStrategy(stockSeries, stockStart.date, stockEnd.date),
    rsi: () => simulateRsiStrategy(stockSeries, stockStart.date, stockEnd.date),
    breakout: () => simulateBreakoutStrategy(stockSeries, stockStart.date, stockEnd.date),
    lowvol: () => simulateLowVolatilityStrategy(stockSeries, stockStart.date, stockEnd.date),
  };

  if (normalizedStrategy === "all") {
    const strategySummaries = Object.entries(strategyFactories)
      .map(([key, factory]) => {
        const result = factory();
        if (!result.points.length) return null;
        const benchmark = simulateNasdaqBenchmark(
          benchmarkSeries,
          result.points[0].date,
          result.points[result.points.length - 1].date,
        );
        const summary = summarizeStrategyPerformance(result, benchmark);
        return {
          key,
          label: result.label,
          shortLabel: result.shortLabel,
          stock: summary.strategy,
          benchmark: {
            ...summary.benchmark,
            code: "^IXIC",
            name: benchmarkPayload.meta?.longName || "NASDAQ Composite",
          },
          excessCagr: summary.excessCagr,
          excessReturn: summary.excessReturn,
          chartSeries: buildStrategyChartSeries(result.points, benchmark),
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.excessCagr - a.excessCagr);

    if (!strategySummaries.length) {
      throw new Error("전략 백테스트를 계산할 데이터가 부족합니다.");
    }

    const best = strategySummaries[0];
    return {
      stock: {
        code,
        name: stockPayload.meta?.longName || stockPayload.meta?.shortName || code,
        assetType: stockPayload.meta?.instrumentType === "ETF" ? "ETF" : undefined,
      },
      period: {
        years: normalizedYears,
        months: normalizedMonths,
        startDate: best.stock.startDate,
        endDate: best.stock.endDate,
      },
      result: {
        stock: best.stock,
        benchmark: best.benchmark,
        excessCagr: best.excessCagr,
        excessReturn: best.excessReturn,
      },
      strategy: {
        key: "all",
        label: `전체 전략 비교: 최고 성과 ${best.label}`,
        shortLabel: best.shortLabel,
      },
      strategies: strategySummaries.map(({ chartSeries, ...item }) => item),
      chartSeries: best.chartSeries,
      notes: [
        "전체 전략 비교는 같은 종목과 기간에 대해 제공 전략을 모두 계산한 뒤 초과 CAGR 기준으로 정렬합니다.",
        "차트는 초과 CAGR이 가장 높은 전략과 NASDAQ Composite (^IXIC) 단순 보유 성과를 비교합니다.",
        "누적수익률은 시작 시점 100 기준 총수익률이며 CAGR은 해당 기간의 연복리 수익률입니다.",
        `가격 데이터 소스: ${stockPayload.source === "yahoo" ? "Yahoo Finance fallback" : "FMP"} / benchmark ${benchmarkPayload.source === "yahoo" ? "Yahoo Finance fallback" : "FMP"}`,
      ],
    };
  }

  const strategyResult = strategyFactories[normalizedStrategy]();

  if (!strategyResult.points.length) {
    throw new Error("전략 백테스트를 계산할 데이터가 부족합니다.");
  }

  const benchmarkResult = simulateNasdaqBenchmark(
    benchmarkSeries,
    strategyResult.points[0].date,
    strategyResult.points[strategyResult.points.length - 1].date,
  );
  const summary = summarizeStrategyPerformance(strategyResult, benchmarkResult);
  const chartSeries = buildStrategyChartSeries(strategyResult.points, benchmarkResult);

  return {
    stock: {
      code,
      name: stockPayload.meta?.longName || stockPayload.meta?.shortName || code,
      assetType: stockPayload.meta?.instrumentType === "ETF" ? "ETF" : undefined,
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
        name: benchmarkPayload.meta?.longName || "NASDAQ Composite",
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
      {
        trend:
          "추세 전환 전략은 전일 기준 50일 이동평균이 200일 이동평균을 상회하면 매수 상태로 전환하고, 반대로 내려가면 현금 상태로 전환합니다.",
        vix:
          "공포지수 전략은 전일 VIX가 30 이상이면 매수 상태로 전환하고, 20 이하이면 매도 상태로 전환하는 단순 리스크 오프 방식입니다.",
        momentum:
          "모멘텀 전략은 전일 종가가 200일 이동평균 위에 있고 최근 63거래일 수익률이 양수일 때만 매수 상태를 유지합니다.",
        rsi:
          "RSI 역추세 전략은 14일 RSI가 30 이하이면 과매도 반등을 기대해 매수하고, 55 이상이면 현금화합니다.",
        breakout:
          "돌파 매매 전략은 전일 종가가 직전 55거래일 고가를 넘으면 매수하고, 직전 20거래일 저가를 이탈하면 현금화합니다.",
        lowvol:
          "저변동성 추세 전략은 전일 종가가 100일 이동평균 위에 있고 20일 연율화 변동성이 35% 미만일 때만 매수 상태를 유지합니다.",
      }[normalizedStrategy],
      "비교 기준은 같은 기간의 NASDAQ Composite (^IXIC) 단순 보유 성과입니다.",
      "누적수익률은 시작 시점 100 기준 총수익률이며 CAGR은 해당 기간의 연복리 수익률입니다.",
      `가격 데이터 소스: ${stockPayload.source === "yahoo" ? "Yahoo Finance fallback" : "FMP"} / benchmark ${benchmarkPayload.source === "yahoo" ? "Yahoo Finance fallback" : "FMP"}`,
    ],
  };
}
