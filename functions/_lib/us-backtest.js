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

export async function getUSBacktestDataAny(code, env, years = 0, months = 0, strategy = "trend") {
  const normalizedYears = Number.isFinite(years) ? Math.max(0, Math.trunc(years)) : 0;
  const normalizedMonths = Number.isFinite(months) ? Math.max(0, Math.trunc(months)) : 0;
  const normalizedStrategy = String(strategy || "trend").toLowerCase();

  if (normalizedYears === 0 && normalizedMonths === 0) {
    throw new Error("보유 기간은 최소 1개월 이상이어야 합니다.");
  }
  if (!["trend", "vix"].includes(normalizedStrategy)) {
    throw new Error("strategy 파라미터는 trend 또는 vix 여야 합니다.");
  }

  const today = new Date();
  const fromDate = subtractPeriod(today, normalizedYears, normalizedMonths);
  const historyPaddingDate = subtractPeriod(fromDate, 1, 6);
  const from = fromDate.toISOString().slice(0, 10);
  const to = today.toISOString().slice(0, 10);
  const extendedFrom = historyPaddingDate.toISOString().slice(0, 10);

  const stockPromise = loadMetaAndSeries(code, extendedFrom, to, env);
  const benchmarkPromise = loadMetaAndSeries("^IXIC", extendedFrom, to, env);
  const vixPromise = normalizedStrategy === "vix" ? loadMetaAndSeries("^VIX", extendedFrom, to, env) : Promise.resolve({ series: [] });

  const [stockPayload, benchmarkPayload, vixPayload] = await Promise.all([stockPromise, benchmarkPromise, vixPromise]);
  const stockSeries = stockPayload.series;
  const benchmarkSeries = benchmarkPayload.series;
  const vixSeries = vixPayload.series;

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
      normalizedStrategy === "trend"
        ? "추세 전환 전략은 전일 기준 50일 이동평균이 200일 이동평균을 상향 돌파하면 매수 상태로 전환하고, 반대로 내려가면 현금 상태로 전환합니다."
        : "공포지수 전략은 전일 VIX가 30 이상이면 매수 상태로 전환하고, 20 이하이면 매도 상태로 전환하는 단순 리스크 오프 방식입니다.",
      "비교 기준은 같은 기간의 NASDAQ Composite (^IXIC) 단순 보유 성과입니다.",
      "누적수익률은 시작 시점 100 기준 총수익률이며 CAGR은 해당 기간의 연복리 수익률입니다.",
      `가격 데이터 소스: ${stockPayload.source === "yahoo" ? "Yahoo Finance fallback" : "FMP"} / benchmark ${benchmarkPayload.source === "yahoo" ? "Yahoo Finance fallback" : "FMP"}`,
    ],
  };
}
