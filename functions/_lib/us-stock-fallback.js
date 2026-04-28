import { metricDefinitions, round, toNumber } from "./metrics.js";

const STOCKANALYSIS_STOCK_URL = "https://stockanalysis.com/stocks";

function htmlHeaders(env) {
  return {
    "user-agent": `Mozilla/5.0 Stock Insight PWA ${env.SEC_CONTACT_EMAIL || "admin@example.com"}`,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
  };
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

function extractRowValues(html, label) {
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

function firstValue(html, label) {
  return extractRowValues(html, label)[0] ?? null;
}

async function fetchPage(url, env) {
  const response = await fetch(url, { headers: htmlHeaders(env) });
  const html = await response.text();

  if (!response.ok) {
    throw new Error(`Stock Analysis fallback 조회 실패: HTTP ${response.status}`);
  }
  if (!html) {
    throw new Error("Stock Analysis fallback 응답 본문이 비어 있습니다.");
  }

  return html;
}

function extractJsArrayBlock(html, key) {
  const match = html.match(new RegExp(`${key}:\\[(.*?)\\]`, "s"));
  return match?.[1] ?? "";
}

function parseJsArray(html, key) {
  const block = extractJsArrayBlock(html, key);
  if (!block) return [];

  const matches = [...block.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"|null|-?(?:\d+\.\d+|\.\d+|\d+)(?:e[+-]?\d+)?/gi)];
  return matches.map((match) => {
    if (match[1] != null) return match[1];
    const token = match[0];
    if (token === "null") return null;
    return Number(token);
  });
}

function quarterLabel(dateKey, fiscalQuarter) {
  if (dateKey && dateKey !== "TTM") {
    const year = String(dateKey).slice(0, 4);
    return `${year} ${fiscalQuarter || ""}`.trim();
  }
  return fiscalQuarter || "최근 분기";
}

function buildQuarterlyHistoryFromPages(ratiosHtml, incomeHtml) {
  const ratioDateKeys = parseJsArray(ratiosHtml, "datekey");
  const ratioQuarters = parseJsArray(ratiosHtml, "fiscalQuarter");
  const perList = parseJsArray(ratiosHtml, "pe");
  const pbrList = parseJsArray(ratiosHtml, "pb");
  const roeList = parseJsArray(ratiosHtml, "roe");
  const roicList = parseJsArray(ratiosHtml, "roic");
  const debtEquityList = parseJsArray(ratiosHtml, "debtequity");

  const incomeDateKeys = parseJsArray(incomeHtml, "datekey");
  const revenueList = parseJsArray(incomeHtml, "revenue");
  const operatingIncomeList = parseJsArray(incomeHtml, "operatingIncome");

  const operatingMarginByDate = new Map(
    incomeDateKeys.map((dateKey, index) => {
      const revenue = toNumber(revenueList[index]);
      const operatingIncome = toNumber(operatingIncomeList[index]);
      const margin =
        revenue != null && operatingIncome != null && revenue !== 0 ? round((operatingIncome / revenue) * 100) : null;
      return [dateKey, margin];
    }),
  );

  const points = [];
  for (let index = 0; index < ratioDateKeys.length; index += 1) {
    const dateKey = ratioDateKeys[index];
    if (!dateKey || dateKey === "TTM") continue;

    points.push({
      label: quarterLabel(dateKey, ratioQuarters[index]),
      headline: "보조 소스 분기 지표",
      periodEnd: dateKey,
      metrics: {
        per: round(toNumber(perList[index])),
        pbr: round(toNumber(pbrList[index])),
        roe: round(toNumber(roeList[index]) != null ? toNumber(roeList[index]) * 100 : null),
        roic: round(toNumber(roicList[index]) != null ? toNumber(roicList[index]) * 100 : null),
        operatingMargin: operatingMarginByDate.get(dateKey) ?? null,
        debtRatio: round(toNumber(debtEquityList[index]) != null ? toNumber(debtEquityList[index]) * 100 : null),
        dividendYield: null,
      },
    });

    if (points.length >= 4) break;
  }

  return points.reverse();
}

export async function fetchUSStockMetricFallback(code, env) {
  const normalizedCode = encodeURIComponent(String(code || "").toLowerCase());
  const ratiosUrl = `${STOCKANALYSIS_STOCK_URL}/${normalizedCode}/financials/ratios/?p=quarterly`;
  const incomeUrl = `${STOCKANALYSIS_STOCK_URL}/${normalizedCode}/financials/?p=quarterly`;
  const [ratiosHtml, incomeHtml] = await Promise.all([fetchPage(ratiosUrl, env), fetchPage(incomeUrl, env)]);

  const operatingMargin =
    toNumber(firstValue(ratiosHtml, "Operating Margin")) ??
    toNumber(firstValue(ratiosHtml, "Operating Margin %"));
  const dividendYield = toNumber(firstValue(ratiosHtml, "Dividend Yield"));
  const history = buildQuarterlyHistoryFromPages(ratiosHtml, incomeHtml);
  const latestHistory = history[history.length - 1]?.metrics ?? {};

  return {
    per: round(toNumber(firstValue(ratiosHtml, "PE Ratio")) ?? latestHistory.per),
    pbr: round(toNumber(firstValue(ratiosHtml, "PB Ratio")) ?? latestHistory.pbr),
    roe: round(toNumber(firstValue(ratiosHtml, "Return on Equity (ROE)")) ?? latestHistory.roe),
    roic: round(toNumber(firstValue(ratiosHtml, "Return on Invested Capital (ROIC)")) ?? latestHistory.roic),
    operatingMargin: round(operatingMargin ?? latestHistory.operatingMargin),
    debtRatio: round(latestHistory.debtRatio),
    dividendYield: round(dividendYield),
    history,
    source: {
      label: "Stock Analysis Financial Ratios",
      url: ratiosUrl,
    },
  };
}

export function mergeUSStockMetricFallback(payload, fallback) {
  if (!payload?.stock || payload.stock.assetType === "ETF" || !fallback) {
    return payload;
  }

  const next = structuredClone(payload);
  const metrics = next.stock.metrics || {};

  metrics.per = metrics.per ?? fallback.per ?? null;
  metrics.pbr = metrics.pbr ?? fallback.pbr ?? null;
  metrics.roe = metrics.roe ?? fallback.roe ?? null;
  metrics.roic = metrics.roic ?? fallback.roic ?? null;
  metrics.operatingMargin = metrics.operatingMargin ?? fallback.operatingMargin ?? null;
  metrics.debtRatio = metrics.debtRatio ?? fallback.debtRatio ?? null;
  metrics.dividendYield = metrics.dividendYield ?? fallback.dividendYield ?? 0;

  next.stock.metrics = metrics;
  if ((!Array.isArray(next.history) || !next.history.length) && Array.isArray(fallback.history) && fallback.history.length) {
    next.history = fallback.history;
  }
  next.notes = [
    ...(Array.isArray(next.notes) ? next.notes : []),
    "일부 핵심지표나 분기 히스토리가 비어 있을 때는 Stock Analysis 분기 페이지로 보정합니다.",
  ];
  next.sources = [...(Array.isArray(next.sources) ? next.sources : []), fallback.source].filter(
    (item, index, array) => item?.url && array.findIndex((candidate) => candidate?.url === item.url) === index,
  );

  return next;
}

export function buildUSStockFallbackPayload(code, name, fallback) {
  const latestHistory = Array.isArray(fallback?.history) ? fallback.history[fallback.history.length - 1]?.metrics ?? {} : {};
  const metrics = {
    per: fallback?.per ?? latestHistory.per ?? null,
    pbr: fallback?.pbr ?? latestHistory.pbr ?? null,
    roe: fallback?.roe ?? latestHistory.roe ?? null,
    roic: fallback?.roic ?? latestHistory.roic ?? null,
    operatingMargin: fallback?.operatingMargin ?? latestHistory.operatingMargin ?? null,
    debtRatio: fallback?.debtRatio ?? latestHistory.debtRatio ?? null,
    dividendYield: fallback?.dividendYield ?? latestHistory.dividendYield ?? 0,
  };

  return {
    stock: {
      code,
      name: name || code,
      market: "US",
      marketLabel: "미국 주식",
      industry: "보조 재무 데이터",
      assetType: "Stock",
      description: "FMP 분기 재무 응답이 비어 Stock Analysis 공개 분기 지표로 표시합니다.",
      metrics,
      metricDefinitions,
    },
    history: Array.isArray(fallback?.history) ? fallback.history : [],
    priceChart: [],
    news: [],
    summaryNote: "FMP 분기 재무 데이터를 받지 못해 Stock Analysis 공개 분기 지표로 핵심 지표와 분기 흐름을 복구했습니다.",
    notes: [
      "FMP 분기 재무제표 응답이 비어 있을 때 조회 실패로 끝내지 않고 보조 소스의 분기 지표를 사용합니다.",
      "가격 기반 차트와 뉴스는 기본 FMP 응답을 받지 못한 경우 비어 있을 수 있습니다.",
    ],
    sources: [fallback?.source].filter(Boolean),
  };
}
