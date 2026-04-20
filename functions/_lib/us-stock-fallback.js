import { round, toNumber } from "./metrics.js";

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

export async function fetchUSStockMetricFallback(code, env) {
  const response = await fetch(
    `${STOCKANALYSIS_STOCK_URL}/${encodeURIComponent(String(code || "").toLowerCase())}/financials/ratios/?p=quarterly`,
    { headers: htmlHeaders(env) },
  );
  const html = await response.text();

  if (!response.ok) {
    throw new Error(`Stock Analysis fallback 조회 실패: HTTP ${response.status}`);
  }
  if (!html) {
    throw new Error("Stock Analysis fallback 응답 본문이 비어 있습니다.");
  }

  const operatingMargin =
    toNumber(firstValue(html, "Operating Margin")) ??
    toNumber(firstValue(html, "Operating Margin %"));
  const dividendYield = toNumber(firstValue(html, "Dividend Yield"));

  return {
    per: round(toNumber(firstValue(html, "PE Ratio"))),
    pbr: round(toNumber(firstValue(html, "PB Ratio"))),
    roe: round(toNumber(firstValue(html, "Return on Equity (ROE)"))),
    roic: round(toNumber(firstValue(html, "Return on Invested Capital (ROIC)"))),
    operatingMargin: round(operatingMargin),
    dividendYield: round(dividendYield),
    source: {
      label: "Stock Analysis Financial Ratios",
      url: `${STOCKANALYSIS_STOCK_URL}/${encodeURIComponent(String(code || "").toLowerCase())}/financials/ratios/?p=quarterly`,
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
  metrics.dividendYield = metrics.dividendYield ?? fallback.dividendYield ?? 0;

  next.stock.metrics = metrics;
  next.notes = [
    ...(Array.isArray(next.notes) ? next.notes : []),
    "일부 핵심지표가 비어 있을 때는 Stock Analysis 분기 비율 페이지로 보정합니다.",
  ];
  next.sources = [...(Array.isArray(next.sources) ? next.sources : []), fallback.source].filter(
    (item, index, array) => item?.url && array.findIndex((candidate) => candidate?.url === item.url) === index,
  );

  return next;
}
