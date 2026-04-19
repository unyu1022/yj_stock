import { remember } from "./cache.js";
import { metricDefinitions, percent, round, toNumber } from "./metrics.js";

const ONE_DAY = 24 * 60 * 60 * 1000;
const HALF_DAY = 12 * 60 * 60 * 1000;
const SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers_exchange.json";
const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";

function secHeaders(env) {
  const contact = env.SEC_CONTACT_EMAIL || "admin@example.com";
  return {
    "user-agent": `Stock Insight PWA ${contact}`,
    "accept-encoding": "gzip, deflate",
  };
}

function ensureAlphaKey(env) {
  if (!env.ALPHA_VANTAGE_API_KEY) {
    throw new Error("미국 주식 조회에는 ALPHA_VANTAGE_API_KEY 환경변수가 필요합니다.");
  }
  return env.ALPHA_VANTAGE_API_KEY;
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

async function alphaFetch(params, env) {
  const key = ensureAlphaKey(env);
  const cacheKey = `alpha:${new URLSearchParams(params).toString()}`;

  return remember(cacheKey, HALF_DAY, async () => {
    const query = new URLSearchParams({ ...params, apikey: key });
    const response = await fetch(`${ALPHA_VANTAGE_URL}?${query.toString()}`);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Alpha Vantage 조회 실패: HTTP ${response.status}`);
    }

    if (!text) {
      throw new Error(`Alpha Vantage 응답 본문이 비어 있습니다. function=${params.function}`);
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new Error(`Alpha Vantage JSON 파싱 실패: function=${params.function}`);
    }

    if (data.Note) {
      throw new Error("Alpha Vantage 무료 호출 제한에 걸렸습니다. 잠시 후 다시 시도하거나, 같은 종목은 잠시 뒤 재조회해 주세요.");
    }
    if (data.Information) {
      throw new Error(data.Information);
    }
    if (data["Error Message"]) {
      throw new Error(data["Error Message"]);
    }
    return data;
  });
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function parseQuarterDateLabel(dateString) {
  const date = new Date(`${dateString}T00:00:00Z`);
  const quarter = Math.floor(date.getUTCMonth() / 3) + 1;
  return `${date.getUTCFullYear()} Q${quarter}`;
}

function findPriceOnOrBefore(series, targetDate) {
  const target = new Date(`${targetDate}T00:00:00Z`).getTime();
  for (const [date, values] of Object.entries(series)) {
    const ts = new Date(`${date}T00:00:00Z`).getTime();
    if (ts <= target) return { date, close: toNumber(values["5. adjusted close"]), dividend: toNumber(values["7. dividend amount"]) };
  }
  return null;
}

function trailingDividends(series, targetDate) {
  const target = new Date(`${targetDate}T00:00:00Z`).getTime();
  const floor = target - 365 * 24 * 60 * 60 * 1000;
  let total = 0;
  for (const [date, values] of Object.entries(series)) {
    const ts = new Date(`${date}T00:00:00Z`).getTime();
    if (ts <= target && ts >= floor) total += toNumber(values["7. dividend amount"]) ?? 0;
  }
  return total;
}

function balanceByDate(balanceSheet) {
  const map = new Map();
  for (const report of balanceSheet.quarterlyReports ?? []) {
    map.set(report.fiscalDateEnding, report);
  }
  return map;
}

function earningsByDate(earnings) {
  const map = new Map();
  for (const report of earnings.quarterlyEarnings ?? []) {
    map.set(report.fiscalDateEnding, report);
  }
  return map;
}

function computeUSRoic(incomeReport, balanceReport) {
  const operatingIncome = toNumber(incomeReport.operatingIncome);
  const incomeBeforeTax = toNumber(incomeReport.incomeBeforeTax);
  const incomeTaxExpense = toNumber(incomeReport.incomeTaxExpense);
  const equity = toNumber(balanceReport.totalShareholderEquity);
  const cash = toNumber(balanceReport.cashAndCashEquivalentsAtCarryingValue);
  const debt =
    toNumber(balanceReport.shortLongTermDebtTotal) ??
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

function buildQuarterSnapshot(incomeReport, balanceReport, earningsReport, dailySeries) {
  const date = incomeReport.fiscalDateEnding;
  const priceInfo = findPriceOnOrBefore(dailySeries, date);
  const price = priceInfo?.close ?? null;
  const revenue = toNumber(incomeReport.totalRevenue);
  const operatingIncome = toNumber(incomeReport.operatingIncome);
  const netIncome = toNumber(incomeReport.netIncome);
  const equity = toNumber(balanceReport.totalShareholderEquity);
  const liabilities = toNumber(balanceReport.totalLiabilities);
  const shares = toNumber(balanceReport.commonStockSharesOutstanding);
  const eps = toNumber(earningsReport?.reportedEPS);
  const dividends = trailingDividends(dailySeries, date);

  const metrics = {
    per: price != null && eps != null && eps > 0 ? price / (eps * 4) : null,
    pbr: price != null && equity != null && shares != null && shares > 0 ? price / (equity / shares) : null,
    roe: netIncome != null && equity != null ? percent(netIncome * 4, equity) : null,
    roic: computeUSRoic(incomeReport, balanceReport),
    operatingMargin: operatingIncome != null && revenue != null ? percent(operatingIncome, revenue) : null,
    debtRatio: liabilities != null && equity != null ? percent(liabilities, equity) : null,
    dividendYield: price != null ? percent(dividends, price) : null,
  };

  return {
    label: parseQuarterDateLabel(date),
    headline: "분기 실적 반영",
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
  return `${latest.label} 기준 분기 재무와 최근 가격 흐름을 조합해 계산했습니다. 미국 종목은 SEC 종목 목록과 Alpha Vantage 재무/가격 데이터를 함께 사용합니다.`;
}

export async function getUSStockData(code, env) {
  const tickers = await loadUSTickers(env);
  const stockMeta = tickers.find((item) => item.code === code);
  if (!stockMeta) {
    throw new Error("해당 미국 종목을 찾지 못했습니다.");
  }

  const overview = await alphaFetch({ function: "OVERVIEW", symbol: code }, env);
  await wait(1100);
  const incomeStatement = await alphaFetch({ function: "INCOME_STATEMENT", symbol: code }, env);
  await wait(1100);
  const balanceSheet = await alphaFetch({ function: "BALANCE_SHEET", symbol: code }, env);
  await wait(1100);
  const earnings = await alphaFetch({ function: "EARNINGS", symbol: code }, env);
  await wait(1100);
  const dailyAdjusted = await alphaFetch({ function: "TIME_SERIES_DAILY_ADJUSTED", symbol: code, outputsize: "full" }, env);

  const balanceMap = balanceByDate(balanceSheet);
  const earningsMap = earningsByDate(earnings);
  const dailySeries = dailyAdjusted["Time Series (Daily)"] ?? {};
  const quarterlyReports = (incomeStatement.quarterlyReports ?? [])
    .filter((report) => balanceMap.has(report.fiscalDateEnding))
    .slice(0, 4);

  if (!quarterlyReports.length) {
    throw new Error("최근 분기 기준으로 조회 가능한 미국 재무 데이터가 없습니다.");
  }

  const history = quarterlyReports
    .map((incomeReport) =>
      buildQuarterSnapshot(
        incomeReport,
        balanceMap.get(incomeReport.fiscalDateEnding),
        earningsMap.get(incomeReport.fiscalDateEnding),
        dailySeries,
      ),
    )
    .reverse();

  const latestHistory = history[history.length - 1];
  const latestPrice = findPriceOnOrBefore(dailySeries, Object.keys(dailySeries)[0] ?? quarterlyReports[0].fiscalDateEnding)?.close ?? null;

  const latestMetrics = {
    per: round(toNumber(overview.PERatio) ?? latestHistory.metrics.per),
    pbr: round(toNumber(overview.PriceToBookRatio) ?? latestHistory.metrics.pbr),
    roe: round((toNumber(overview.ReturnOnEquityTTM) ?? latestHistory.metrics.roe) * (toNumber(overview.ReturnOnEquityTTM) != null ? 100 : 1)),
    roic: latestHistory.metrics.roic,
    operatingMargin: round((toNumber(overview.OperatingMarginTTM) ?? latestHistory.metrics.operatingMargin) * (toNumber(overview.OperatingMarginTTM) != null ? 100 : 1)),
    debtRatio: latestHistory.metrics.debtRatio,
    dividendYield: round((toNumber(overview.DividendYield) ?? latestHistory.metrics.dividendYield) * (toNumber(overview.DividendYield) != null ? 100 : 1)),
  };

  return {
    stock: {
      code: stockMeta.code,
      name: stockMeta.name,
      market: "US",
      marketLabel: "미국 주식",
      industry: overview.Industry || stockMeta.exchange,
      description: `${stockMeta.exchange} 상장 · 최신 가격 ${latestPrice != null ? `$${latestPrice.toFixed(2)}` : "조회 불가"}`,
      metrics: latestMetrics,
      metricDefinitions,
    },
    history,
    summaryNote: summarizeUS(history),
    notes: [
      "미국 주식 검색은 SEC company_tickers_exchange.json을 사용합니다.",
      "PER, PBR, ROE, 영업이익률, 배당수익률 최신값은 Alpha Vantage Overview를 우선 사용했습니다.",
      "분기 흐름과 ROIC, 부채비율은 Alpha Vantage 분기 재무와 일별 가격 데이터로 계산했습니다.",
    ],
    sources: [
      { label: "SEC Company Tickers Exchange", url: "https://www.sec.gov/file/company-tickers-exchange" },
      { label: "SEC EDGAR API Documentation", url: "https://www.sec.gov/edgar/sec-api-documentation" },
      { label: "Alpha Vantage Documentation", url: "https://www.alphavantage.co/documentation/" },
    ],
  };
}
