import { json, serverError, badRequest } from "../_lib/http.js";

const ONE_DAY = 24 * 60 * 60 * 1000;
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

  const response = await fetch("https://www.sec.gov/files/company_tickers_exchange.json", {
    headers: {
      "user-agent": `Stock Insight PWA ${env.SEC_CONTACT_EMAIL || "admin@example.com"}`,
      "accept-encoding": "gzip, deflate",
    },
  });

  if (!response.ok) {
    throw new Error(`SEC 종목 마스터 조회 실패: HTTP ${response.status}`);
  }

  const data = await response.json();
  const items = (data.data ?? [])
    .map((row) => ({
      code: row[2],
      name: row[1],
      exchange: row[3],
    }))
    .filter((item) => item.code && item.exchange)
    .sort((a, b) => a.code.localeCompare(b.code));

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
