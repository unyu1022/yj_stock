import { json, serverError, badRequest } from "../_lib/http.js";

const ONE_DAY = 24 * 60 * 60 * 1000;
const FMP_BASE_URL = "https://financialmodelingprep.com/stable";
const POPULAR_ETF_FALLBACK = [
  ["QQQ", "Invesco QQQ Trust", "NASDAQ"],
  ["SPY", "SPDR S&P 500 ETF Trust", "NYSE ARCA"],
  ["VOO", "Vanguard S&P 500 ETF", "NYSE ARCA"],
  ["IVV", "iShares Core S&P 500 ETF", "NYSE ARCA"],
  ["DIA", "SPDR Dow Jones Industrial Average ETF Trust", "NYSE ARCA"],
  ["IWM", "iShares Russell 2000 ETF", "NYSE ARCA"],
  ["VTI", "Vanguard Total Stock Market ETF", "NYSE ARCA"],
  ["SOXL", "Direxion Daily Semiconductor Bull 3X Shares", "NYSE ARCA"],
  ["SOXS", "Direxion Daily Semiconductor Bear 3X Shares", "NYSE ARCA"],
  ["TQQQ", "ProShares UltraPro QQQ", "NASDAQ"],
  ["SQQQ", "ProShares UltraPro Short QQQ", "NASDAQ"],
  ["UPRO", "ProShares UltraPro S&P500", "NYSE ARCA"],
  ["SPXL", "Direxion Daily S&P 500 Bull 3X Shares", "NYSE ARCA"],
  ["SPXS", "Direxion Daily S&P 500 Bear 3X Shares", "NYSE ARCA"],
  ["TECL", "Direxion Daily Technology Bull 3X Shares", "NYSE ARCA"],
  ["TECS", "Direxion Daily Technology Bear 3X Shares", "NYSE ARCA"],
];
const cache = {
  KR: { fetchedAt: 0, items: null },
  US: { fetchedAt: 0, items: null },
};

function isFresh(entry) {
  return entry.items && Date.now() - entry.fetchedAt < ONE_DAY;
}

async function loadKRCorpMaster(env) {
  if (isFresh(cache.KR)) return cache.KR.items;

  const key = env.OPEN_DART_API_KEY;
  if (!key) throw new Error("국내 주식 조회에는 OPEN_DART_API_KEY 환경변수가 필요합니다.");

  const response = await fetch(`https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${key}`, {
    headers: {
      "user-agent": `Stock Insight PWA / ${env.SEC_CONTACT_EMAIL || "admin@example.com"}`,
      accept: "application/zip, application/octet-stream;q=0.9, */*;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error(`OpenDART 종목 마스터 조회 실패: HTTP ${response.status}`);
  }

  const buffer = await response.arrayBuffer();
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x04034b50) {
    throw new Error("OpenDART 종목 마스터 압축 형식을 해석하지 못했습니다.");
  }

  const compressionMethod = view.getUint16(8, true);
  const compressedSize = view.getUint32(18, true);
  const fileNameLength = view.getUint16(26, true);
  const extraFieldLength = view.getUint16(28, true);
  const dataStart = 30 + fileNameLength + extraFieldLength;
  const compressed = buffer.slice(dataStart, dataStart + compressedSize);

  let xmlText;
  if (compressionMethod === 0) {
    xmlText = new TextDecoder("utf-8").decode(compressed);
  } else if (compressionMethod === 8) {
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    xmlText = await new Response(stream).text();
  } else {
    throw new Error(`지원하지 않는 OpenDART 압축 방식입니다: ${compressionMethod}`);
  }

  const items = [];
  for (const block of xmlText.match(/<list>[\s\S]*?<\/list>/g) ?? []) {
    const code = (block.match(/<stock_code>(.*?)<\/stock_code>/)?.[1] || "").trim();
    const corpCode = (block.match(/<corp_code>(.*?)<\/corp_code>/)?.[1] || "").trim();
    const name = (block.match(/<corp_name>(.*?)<\/corp_name>/)?.[1] || "").trim();
    if (!code || !corpCode || !name) continue;
    items.push({ code, name, corpCode });
  }

  items.sort((a, b) => a.name.localeCompare(b.name, "ko"));
  cache.KR = { fetchedAt: Date.now(), items };
  return items;
}

async function loadUSMaster(env) {
  if (isFresh(cache.US)) return cache.US.items;

  const headers = {
    "user-agent": `Stock Insight PWA ${env.SEC_CONTACT_EMAIL || "admin@example.com"}`,
    "accept-encoding": "gzip, deflate",
  };
  const response = await fetch("https://www.sec.gov/files/company_tickers_exchange.json", { headers });

  if (!response.ok) {
    throw new Error(`SEC 종목 마스터 조회 실패: HTTP ${response.status}`);
  }

  const data = await response.json();
  const stockItems = (data.data ?? [])
    .map((row) => ({
      code: row[2],
      name: row[1],
      exchange: row[3],
      assetType: "Stock",
    }))
    .filter((item) => item.code && item.exchange)
    .sort((a, b) => a.code.localeCompare(b.code));

  let etfItems = [];
  if (env.FMP_API_KEY) {
    const query = new URLSearchParams({ apikey: env.FMP_API_KEY });
    const etfResponse = await fetch(`${FMP_BASE_URL}/etf-list?${query.toString()}`, {
      headers: {
        "user-agent": `Stock Insight PWA ${env.SEC_CONTACT_EMAIL || "admin@example.com"}`,
        accept: "application/json, text/plain, */*",
      },
    });

    if (etfResponse.ok) {
      const etfData = await etfResponse.json();
      etfItems = (Array.isArray(etfData) ? etfData : [])
        .map((row) => ({
          code: row.symbol,
          name: row.name,
          exchange: row.exchange,
          assetType: "ETF",
        }))
        .filter((item) => item.code && item.name);
    }
  }

  const fallbackEtfItems = POPULAR_ETF_FALLBACK.map(([code, name, exchange]) => ({
    code,
    name,
    exchange,
    assetType: "ETF",
  }));

  const deduped = new Map();
  [...stockItems, ...etfItems, ...fallbackEtfItems].forEach((item) => {
    const key = String(item.code || "").toUpperCase();
    if (!key) return;
    if (!deduped.has(key)) {
      deduped.set(key, { ...item, code: key });
      return;
    }

    const current = deduped.get(key);
    if ((current.assetType !== "ETF" && item.assetType === "ETF") || (!current.exchange && item.exchange)) {
      deduped.set(key, { ...current, ...item, code: key });
    }
  });

  const items = [...deduped.values()].sort((a, b) => a.code.localeCompare(b.code));

  cache.US = { fetchedAt: Date.now(), items };
  return items;
}

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const market = (url.searchParams.get("market") || "").toUpperCase();

    if (!market || !["KR", "US"].includes(market)) {
      return badRequest("market 파라미터는 KR 또는 US 여야 합니다.");
    }

    const items = market === "KR" ? await loadKRCorpMaster(context.env) : await loadUSMaster(context.env);
    return json({ ok: true, items });
  } catch (error) {
    return serverError(error.message);
  }
}
