import { remember } from "./cache.js";
import { round, toNumber } from "./metrics.js";

const YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";
const YAHOO_NEWS_RSS_URL = "https://feeds.finance.yahoo.com/rss/2.0/headline";
const PRICE_TTL = 30 * 60 * 1000;
const NEWS_TTL = 30 * 60 * 1000;

function yahooHeaders(env) {
  return {
    "user-agent": `Mozilla/5.0 Stock Insight PWA ${env.SEC_CONTACT_EMAIL || "admin@example.com"}`,
    accept: "application/json,text/xml,application/rss+xml,*/*",
    "accept-language": "en-US,en;q=0.9",
  };
}

function decodeXml(text) {
  return String(text || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(text) {
  return decodeXml(text).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function getTagValue(block, tag) {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? stripTags(match[1]) : "";
}

export async function fetchYahooDailyPriceChart(code, env, limit = 60) {
  const symbol = String(code || "").trim().toUpperCase();
  if (!symbol) return [];

  return remember(`yahoo:chart:${symbol}:${limit}`, PRICE_TTL, async () => {
    const query = new URLSearchParams({
      range: "6mo",
      interval: "1d",
      includePrePost: "false",
      events: "history",
    });
    const response = await fetch(`${YAHOO_CHART_URL}/${encodeURIComponent(symbol)}?${query.toString()}`, {
      headers: yahooHeaders(env),
    });
    const text = await response.text();
    if (!response.ok || !text) return [];

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return [];
    }

    const result = data?.chart?.result?.[0];
    const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];
    const quote = result?.indicators?.quote?.[0] ?? {};
    const closes = Array.isArray(quote.close) ? quote.close : [];
    const volumes = Array.isArray(quote.volume) ? quote.volume : [];

    const rows = timestamps
      .map((timestamp, index) => ({
        date: new Date(timestamp * 1000).toISOString().slice(0, 10),
        close: round(toNumber(closes[index])),
        volume: toNumber(volumes[index]),
      }))
      .filter((row) => row.date && row.close != null)
      .slice(-limit);

    return rows.map((row, index) => {
      const previous = rows[index - 1]?.close ?? null;
      return {
        ...row,
        changePercent: previous ? round(((row.close / previous) - 1) * 100) : null,
      };
    });
  });
}

export async function fetchYahooNews(code, env, limit = 5) {
  const symbol = String(code || "").trim().toUpperCase();
  if (!symbol) return [];

  return remember(`yahoo:news:${symbol}:${limit}`, NEWS_TTL, async () => {
    const query = new URLSearchParams({ s: symbol, region: "US", lang: "en-US" });
    const response = await fetch(`${YAHOO_NEWS_RSS_URL}?${query.toString()}`, {
      headers: yahooHeaders(env),
    });
    const xml = await response.text();
    if (!response.ok || !xml) return [];

    return [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)]
      .map((match) => {
        const block = match[1];
        const title = getTagValue(block, "title");
        const url = getTagValue(block, "link");
        if (!title || !url) return null;

        return {
          title,
          url,
          site: getTagValue(block, "source") || "Yahoo Finance",
          publishedAt: getTagValue(block, "pubDate"),
          summary: getTagValue(block, "description").slice(0, 220),
        };
      })
      .filter(Boolean)
      .slice(0, limit);
  });
}

export async function fillMarketFallbacks(payload, code, env) {
  if (!payload || !code) return payload;

  const next = structuredClone(payload);
  const needsPrice = !Array.isArray(next.priceChart) || next.priceChart.length === 0;
  const needsNews = !Array.isArray(next.news) || next.news.length === 0;

  const [priceChart, news] = await Promise.all([
    needsPrice ? fetchYahooDailyPriceChart(code, env).catch(() => []) : next.priceChart,
    needsNews ? fetchYahooNews(code, env).catch(() => []) : next.news,
  ]);

  if (needsPrice && priceChart.length) {
    next.priceChart = priceChart;
    next.notes = [...(Array.isArray(next.notes) ? next.notes : []), "FMP 일일 가격 응답이 비어 Yahoo Finance 차트 데이터로 보완했습니다."];
    next.sources = [
      ...(Array.isArray(next.sources) ? next.sources : []),
      { label: "Yahoo Finance Chart API", url: `${YAHOO_CHART_URL}/${encodeURIComponent(code)}` },
    ];
  }

  if (needsNews && news.length) {
    next.news = news;
    next.notes = [...(Array.isArray(next.notes) ? next.notes : []), "FMP 뉴스 엔드포인트 권한이 없거나 응답이 비어 Yahoo Finance RSS 뉴스로 보완했습니다."];
    next.sources = [
      ...(Array.isArray(next.sources) ? next.sources : []),
      { label: "Yahoo Finance News RSS", url: `${YAHOO_NEWS_RSS_URL}?s=${encodeURIComponent(code)}&region=US&lang=en-US` },
    ];
  }

  if (Array.isArray(next.sources)) {
    next.sources = next.sources.filter(
      (item, index, array) => item?.url && array.findIndex((candidate) => candidate?.url === item.url) === index,
    );
  }

  return next;
}
