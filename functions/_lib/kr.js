import { remember } from "./cache.js";
import { metricDefinitions, percent, round, toNumber } from "./metrics.js";

const ONE_DAY = 24 * 60 * 60 * 1000;
const OPEN_DART_BASE = "https://engopendart.fss.or.kr/engapi";

function ensureKey(env) {
  if (!env.OPEN_DART_API_KEY) {
    throw new Error("국내 주식 조회에는 OPEN_DART_API_KEY 환경변수가 필요합니다.");
  }
  return env.OPEN_DART_API_KEY;
}

function getTagValue(block, tagName) {
  const match = block.match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`));
  return match ? match[1].trim() : "";
}

async function unzipXml(buffer) {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x04034b50) {
    throw new Error("OpenDART corpCode 압축 형식을 해석하지 못했습니다.");
  }

  const compressionMethod = view.getUint16(8, true);
  const compressedSize = view.getUint32(18, true);
  const fileNameLength = view.getUint16(26, true);
  const extraFieldLength = view.getUint16(28, true);
  const dataStart = 30 + fileNameLength + extraFieldLength;
  const compressed = buffer.slice(dataStart, dataStart + compressedSize);

  if (compressionMethod === 0) {
    return new TextDecoder("utf-8").decode(compressed);
  }

  if (compressionMethod === 8) {
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return await new Response(stream).text();
  }

  throw new Error(`지원하지 않는 OpenDART 압축 방식입니다: ${compressionMethod}`);
}

async function loadCorpList(env) {
  return remember("kr-corp-list", ONE_DAY, async () => {
    const key = ensureKey(env);
    const response = await fetch(`${OPEN_DART_BASE}/corpCode.xml?crtfc_key=${key}`);
    if (!response.ok) {
      throw new Error(`OpenDART corpCode 조회 실패: HTTP ${response.status}`);
    }

    const xml = await unzipXml(await response.arrayBuffer());
    const items = [...xml.matchAll(/<list>([\s\S]*?)<\/list>/g)]
      .map((match) => match[1])
      .map((block) => ({
        corpCode: getTagValue(block, "corp_code"),
        code: getTagValue(block, "stock_code"),
        name: getTagValue(block, "corp_name"),
        marketLabel: "국내 주식",
      }))
      .filter((item) => item.code);

    items.sort((a, b) => a.name.localeCompare(b.name, "ko"));
    return items;
  });
}

export async function searchKRStocks(query, env) {
  const list = await loadCorpList(env);
  const normalized = query.trim().toLowerCase();
  const filtered = !normalized
    ? list.slice(0, 20)
    : list.filter((item) => item.name.toLowerCase().includes(normalized) || item.code.includes(normalized)).slice(0, 20);

  return filtered.map((item) => ({
    code: item.code,
    name: item.name,
    market: "KR",
    marketLabel: item.marketLabel,
  }));
}

function reprtLabel(bsnsYear, reprtCode) {
  const suffix = {
    "11013": "Q1",
    "11012": "Q2",
    "11014": "Q3",
    "11011": "FY",
  }[reprtCode] ?? reprtCode;

  return `${bsnsYear} ${suffix}`;
}

function candidateReports() {
  const currentYear = new Date().getUTCFullYear();
  const years = [];
  for (let year = currentYear; year >= currentYear - 3; year -= 1) {
    years.push(
      { bsnsYear: String(year), reprtCode: "11013" },
      { bsnsYear: String(year), reprtCode: "11012" },
      { bsnsYear: String(year), reprtCode: "11014" },
      { bsnsYear: String(year), reprtCode: "11011" },
    );
  }
  return years;
}

async function fetchJson(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`OpenDART 조회 실패: HTTP ${response.status}`);
  }
  if (data.status !== "000" && data.status !== "013") {
    throw new Error(`OpenDART 오류 ${data.status}: ${data.message}`);
  }
  return data;
}

function normalizeName(value) {
  return value.toLowerCase().replace(/[^a-z]/g, "");
}

function indicatorMap(list) {
  const map = {};
  for (const item of list ?? []) {
    const name = normalizeName(item.idx_nm || "");
    if (!map.per && name === "per") map.per = toNumber(item.idx_val);
    if (!map.pbr && name === "pbr") map.pbr = toNumber(item.idx_val);
    if (!map.roe && (name.includes("returnonequity") || name === "roe")) map.roe = percent(toNumber(item.idx_val), 1);
    if (!map.operatingMargin && name.includes("operatingincomemargin")) map.operatingMargin = percent(toNumber(item.idx_val), 1);
    if (!map.debtRatio && name.includes("debtratio")) map.debtRatio = percent(toNumber(item.idx_val), 1);
    if (!map.dividendYield && name.includes("dividendyield")) map.dividendYield = percent(toNumber(item.idx_val), 1);
  }
  return map;
}

function sumMatching(lines, sjDiv, patterns) {
  return lines
    .filter((line) => line.sj_div === sjDiv)
    .filter((line) => patterns.some((pattern) => normalizeName(line.account_nm || "").includes(pattern)))
    .reduce((total, line) => total + (toNumber(line.thstrm_amount) ?? 0), 0);
}

function firstMatching(lines, sjDiv, patterns) {
  const line = lines.find(
    (entry) =>
      entry.sj_div === sjDiv &&
      patterns.some((pattern) => normalizeName(entry.account_nm || "").includes(pattern)),
  );
  return line ? toNumber(line.thstrm_amount) : null;
}

function computeKrRoic(lines) {
  const operatingIncome =
    firstMatching(lines, "IS", ["operatingincome", "profitlossfromoperations"]) ??
    firstMatching(lines, "CIS", ["operatingincome", "profitlossfromoperations"]);
  const incomeTax = firstMatching(lines, "IS", ["incometaxexpense"]) ?? firstMatching(lines, "CIS", ["incometaxexpense"]);
  const profitBeforeTax =
    firstMatching(lines, "IS", ["profitlossbeforetax"]) ?? firstMatching(lines, "CIS", ["profitlossbeforetax"]);

  const equity = firstMatching(lines, "BS", ["totalequity", "equity"]);
  const cash = sumMatching(lines, "BS", ["cashandcashequivalents", "shorttermfinancialinstruments"]);
  const debt = sumMatching(lines, "BS", [
    "shorttermborrowings",
    "longtermborrowings",
    "currentportionoflongtermborrowings",
    "debentures",
    "bondsissued",
    "lease liabilities".replace(/\s/g, ""),
    "currentlease liabilities".replace(/\s/g, ""),
  ]);

  if (operatingIncome == null || equity == null) return null;

  const effectiveTaxRate =
    incomeTax != null && profitBeforeTax != null && profitBeforeTax !== 0
      ? Math.min(Math.max(incomeTax / profitBeforeTax, 0), 0.35)
      : 0.24;
  const nopat = operatingIncome * (1 - effectiveTaxRate);
  const investedCapital = equity + debt - cash;
  return percent(nopat, investedCapital);
}

async function fetchKrIndicators(corpCode, bsnsYear, reprtCode, env) {
  const key = ensureKey(env);
  const categories = ["M210000", "M220000", "M230000"];
  const responses = await Promise.all(
    categories.map((category) =>
      fetchJson(
        `${OPEN_DART_BASE}/fnlttSinglIndx.json?crtfc_key=${key}&corp_code=${corpCode}&bsns_year=${bsnsYear}&reprt_code=${reprtCode}&idx_cl_code=${category}`,
      ),
    ),
  );
  return responses.flatMap((response) => response.list ?? []);
}

async function fetchKrStatements(corpCode, bsnsYear, reprtCode, env) {
  const key = ensureKey(env);
  const data = await fetchJson(
    `${OPEN_DART_BASE}/fnlttSinglAcntAll.json?crtfc_key=${key}&corp_code=${corpCode}&bsns_year=${bsnsYear}&reprt_code=${reprtCode}&fs_div=CFS`,
  );
  if ((data.list ?? []).length) return data.list;

  const fallback = await fetchJson(
    `${OPEN_DART_BASE}/fnlttSinglAcntAll.json?crtfc_key=${key}&corp_code=${corpCode}&bsns_year=${bsnsYear}&reprt_code=${reprtCode}&fs_div=OFS`,
  );
  return fallback.list ?? [];
}

async function fetchQuarterSnapshot(corp, period, env) {
  const indicators = await fetchKrIndicators(corp.corpCode, period.bsnsYear, period.reprtCode, env);
  if (!indicators.length) return null;

  const statements = await fetchKrStatements(corp.corpCode, period.bsnsYear, period.reprtCode, env);
  const mapped = indicatorMap(indicators);
  const roic = computeKrRoic(statements);

  return {
    label: reprtLabel(period.bsnsYear, period.reprtCode),
    headline: period.reprtCode === "11011" ? "연간 보고" : "분기 보고",
    metrics: {
      per: round(mapped.per),
      pbr: round(mapped.pbr),
      roe: round(mapped.roe),
      roic: round(roic),
      operatingMargin: round(mapped.operatingMargin),
      debtRatio: round(mapped.debtRatio),
      dividendYield: round(mapped.dividendYield),
    },
  };
}

function summarizeKr(history) {
  const latest = history[history.length - 1];
  return `${latest.label} 기준으로 최근 재무지표를 반영했습니다. 국내 종목은 OpenDART 공시 지표와 재무제표를 조합해 분석합니다.`;
}

export async function getKRStockData(code, env) {
  const list = await loadCorpList(env);
  const corp = list.find((item) => item.code === code);
  if (!corp) {
    throw new Error("해당 국내 종목을 찾지 못했습니다.");
  }

  const history = [];
  for (const period of candidateReports()) {
    const snapshot = await fetchQuarterSnapshot(corp, period, env);
    if (snapshot) history.push(snapshot);
    if (history.length >= 4) break;
  }

  if (!history.length) {
    throw new Error("최근 분기 기준으로 조회 가능한 국내 재무 데이터가 없습니다.");
  }

  history.reverse();
  const latest = history[history.length - 1];

  return {
    stock: {
      code: corp.code,
      name: corp.name,
      market: "KR",
      marketLabel: "국내 주식",
      industry: "OpenDART 상장사",
      description: "OpenDART 공시 기반 실데이터 조회",
      metrics: latest.metrics,
      metricDefinitions,
    },
    history,
    summaryNote: summarizeKr(history),
    notes: [
      "국내 주식 검색은 OpenDART 상장사 코드(stock_code) 기준으로 제공합니다.",
      "PER, PBR, ROE, 영업이익률, 부채비율, 배당수익률은 OpenDART 주요 지표 응답을 사용했습니다.",
      "ROIC는 OpenDART 재무제표 계정값으로 근사 계산했습니다.",
    ],
    sources: [
      { label: "OpenDART Corporation Code", url: "https://engopendart.fss.or.kr/guide/detail.do?apiGrpCd=DE001&apiId=AE00004" },
      { label: "OpenDART Single Company Indicators", url: "https://engopendart.fss.or.kr/guide/detail.do?apiGrpCd=DE003&apiId=AE00038" },
      { label: "OpenDART Financial Statements", url: "https://engopendart.fss.or.kr/guide/detail.do?apiGrpCd=DE003&apiId=AE00036" },
    ],
  };
}
