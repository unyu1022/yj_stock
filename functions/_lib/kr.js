import { remember } from "./cache.js";
import { metricDefinitions, percent, round, toNumber } from "./metrics.js";

const ONE_DAY = 24 * 60 * 60 * 1000;
const TEN_MINUTES = 10 * 60 * 1000;
const OPEN_DART_BASE = "https://opendart.fss.or.kr/api";

function ensureKey(env) {
  if (!env.OPEN_DART_API_KEY) {
    throw new Error("국내 주식 조회에는 OPEN_DART_API_KEY 환경변수가 필요합니다.");
  }
  return env.OPEN_DART_API_KEY;
}

function dartHeaders(env) {
  const contact = env.SEC_CONTACT_EMAIL || "admin@example.com";
  return {
    "user-agent": `Stock Insight PWA / ${contact}`,
    accept: "application/json, text/xml, application/xml;q=0.9, */*;q=0.8",
    "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
  };
}

function recentDisclosureRanges() {
  const end = new Date();
  const ranges = [];
  for (let i = 0; i < 4; i += 1) {
    const rangeEnd = new Date(end);
    rangeEnd.setUTCMonth(rangeEnd.getUTCMonth() - i * 3);
    const rangeStart = new Date(rangeEnd);
    rangeStart.setUTCMonth(rangeStart.getUTCMonth() - 3);
    rangeStart.setUTCDate(rangeStart.getUTCDate() + 1);
    ranges.push({
      bgnDe: rangeStart.toISOString().slice(0, 10).replace(/-/g, ""),
      endDe: rangeEnd.toISOString().slice(0, 10).replace(/-/g, ""),
    });
  }
  return ranges;
}

function normalizeKrSearch(value) {
  return (value || "").toLowerCase().replace(/\s+/g, "");
}

function toSearchItem(item) {
  return {
    corpCode: item.corp_code,
    code: item.stock_code,
    name: item.corp_name,
    market: "KR",
    marketLabel: "국내 주식",
  };
}

function matchesQuery(item, normalizedQuery) {
  return normalizeKrSearch(item.corp_name).includes(normalizedQuery) || (item.stock_code || "").includes(normalizedQuery);
}

async function fetchJson(url, env) {
  const response = await fetch(url, {
    headers: dartHeaders(env),
    redirect: "manual",
  });

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location") || "unknown";
    throw new Error(`OpenDART 요청이 리다이렉트되었습니다. location=${location}`);
  }

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`OpenDART 조회 실패: HTTP ${response.status}`);
  }
  if (data.status !== "000" && data.status !== "013") {
    throw new Error(`OpenDART 오류 ${data.status}: ${data.message}`);
  }
  return data;
}

async function searchRecentDisclosures(query, env, limit = 20) {
  const normalizedQuery = normalizeKrSearch(query);
  const key = ensureKey(env);
  const found = new Map();

  return remember(`kr-search:${normalizedQuery}`, TEN_MINUTES, async () => {
    for (const range of recentDisclosureRanges()) {
      let page = 1;
      let totalPages = 1;
      const maxPages = 8;

      while (page <= totalPages && page <= maxPages && found.size < limit) {
        const params = new URLSearchParams({
          crtfc_key: key,
          bgn_de: range.bgnDe,
          end_de: range.endDe,
          page_no: String(page),
          page_count: "100",
        });

        const data = await fetchJson(`${OPEN_DART_BASE}/list.json?${params.toString()}`, env);
        totalPages = Number(data.total_page || 1);

        for (const item of data.list ?? []) {
          if (!item.stock_code) continue;
          if (!matchesQuery(item, normalizedQuery)) continue;
          if (!found.has(item.stock_code)) {
            found.set(item.stock_code, toSearchItem(item));
          }
        }

        page += 1;
      }

      if (found.size >= limit) break;
    }

    return [...found.values()].slice(0, limit);
  });
}

async function resolveCorpByCode(code, env) {
  return remember(`kr-code:${code}`, ONE_DAY, async () => {
    const key = ensureKey(env);

    for (const range of recentDisclosureRanges()) {
      let page = 1;
      let totalPages = 1;
      const maxPages = 12;

      while (page <= totalPages && page <= maxPages) {
        const params = new URLSearchParams({
          crtfc_key: key,
          bgn_de: range.bgnDe,
          end_de: range.endDe,
          page_no: String(page),
          page_count: "100",
        });

        const data = await fetchJson(`${OPEN_DART_BASE}/list.json?${params.toString()}`, env);
        totalPages = Number(data.total_page || 1);

        const match = (data.list ?? []).find((item) => item.stock_code === code);
        if (match) return toSearchItem(match);
        page += 1;
      }
    }

    return null;
  });
}

export async function searchKRStocks(query, env) {
  const normalized = normalizeKrSearch(query);
  if (!normalized) return [];

  const items = await searchRecentDisclosures(query, env, 20);
  return items.map((item) => ({
    code: item.code,
    name: item.name,
    market: item.market,
    marketLabel: item.marketLabel,
    corpCode: item.corpCode,
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

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s_\-()/.,]/g, "")
    .trim();
}

function includesAny(value, patterns) {
  return patterns.some((pattern) => value.includes(pattern));
}

function normalizeAccountId(value) {
  return normalizeName(value).replace(/[^a-z0-9]/g, "");
}

function indicatorMap(list) {
  const map = {};
  for (const item of list ?? []) {
    const name = normalizeName(item.idx_nm || "");
    const value = toNumber(item.idx_val);
    if (!map.per && ["per", "priceearningratio", "주가수익비율"].includes(name)) map.per = value;
    if (!map.pbr && ["pbr", "pricetobookratio", "주가순자산비율"].includes(name)) map.pbr = value;
    if (!map.roe && ["roe", "returnonequity", "자기자본이익률"].includes(name)) map.roe = value;
    if (!map.operatingMargin && ["operatingincomemargin", "operatingmargin", "영업이익률"].includes(name)) {
      map.operatingMargin = value;
    }
    if (!map.debtRatio && ["debtratio", "부채비율"].includes(name)) map.debtRatio = value;
    if (!map.dividendYield && ["dividendyield", "cashdividendyield", "배당수익률"].includes(name)) {
      map.dividendYield = value;
    }
  }
  return map;
}

function pickAmount(line) {
  if (!line) return null;
  return toNumber(line.thstrm_amount) ?? toNumber(line.thstrm_add_amount) ?? toNumber(line.frmtrm_amount) ?? null;
}

function findStatementValue(lines, sjDivs, accountIdPatterns, accountNamePatterns) {
  const line = (lines ?? []).find((entry) => {
    if (!sjDivs.includes(entry.sj_div)) return false;
    const accountId = normalizeAccountId(entry.account_id || "");
    const accountName = normalizeName(entry.account_nm || "");
    return includesAny(accountId, accountIdPatterns) || includesAny(accountName, accountNamePatterns);
  });
  return pickAmount(line);
}

function sumStatementValues(lines, sjDivs, accountIdPatterns, accountNamePatterns) {
  return (lines ?? [])
    .filter((entry) => sjDivs.includes(entry.sj_div))
    .filter((entry) => {
      const accountId = normalizeAccountId(entry.account_id || "");
      const accountName = normalizeName(entry.account_nm || "");
      return includesAny(accountId, accountIdPatterns) || includesAny(accountName, accountNamePatterns);
    })
    .reduce((total, line) => total + (pickAmount(line) ?? 0), 0);
}

function computeKrRoic(lines) {
  const operatingIncome = findStatementValue(
    lines,
    ["IS", "CIS"],
    ["operatingincomeloss", "profitlossfromoperations"],
    ["operatingincome", "profitlossfromoperations", "영업이익"],
  );
  const incomeTax = findStatementValue(
    lines,
    ["IS", "CIS"],
    ["incometaxexpensecontinuingoperations", "incometaxexpensebenefit"],
    ["incometaxexpense", "법인세비용"],
  );
  const profitBeforeTax = findStatementValue(
    lines,
    ["IS", "CIS"],
    ["profitlossbeforetax", "profitlossbeforetaxexpense"],
    ["profitlossbeforetax", "법인세비용차감전순이익"],
  );

  const equity = findStatementValue(
    lines,
    ["BS"],
    ["equity", "equityattributabletoownersofparent"],
    ["totalequity", "equity", "자본총계", "지배기업의소유주지분"],
  );
  const cash = sumStatementValues(
    lines,
    ["BS"],
    ["cashandcashequivalents", "shorttermfinancialinstruments", "currentfinancialassets"],
    ["cashandcashequivalents", "shorttermfinancialinstruments", "현금및현금성자산", "단기금융상품"],
  );
  const debt = sumStatementValues(
    lines,
    ["BS"],
    [
      "shorttermborrowings",
      "longtermborrowings",
      "currentportionoflongtermborrowings",
      "debentures",
      "bondsissued",
      "leaseliabilities",
      "currentleaseliabilities",
    ],
    ["shorttermborrowings", "longtermborrowings", "debentures", "차입금", "사채", "리스부채"],
  );

  if (operatingIncome == null || equity == null) return null;

  const effectiveTaxRate =
    incomeTax != null && profitBeforeTax != null && profitBeforeTax !== 0
      ? Math.min(Math.max(incomeTax / profitBeforeTax, 0), 0.35)
      : 0.24;
  const nopat = operatingIncome * (1 - effectiveTaxRate);
  const investedCapital = equity + debt - cash;
  return percent(nopat, investedCapital);
}

function deriveMetricsFromStatements(lines) {
  const revenue = findStatementValue(
    lines,
    ["IS", "CIS"],
    ["revenue", "salesrevenue"],
    ["revenue", "salesrevenue", "매출액", "영업수익"],
  );
  const operatingIncome = findStatementValue(
    lines,
    ["IS", "CIS"],
    ["operatingincomeloss", "profitlossfromoperations"],
    ["operatingincome", "profitlossfromoperations", "영업이익"],
  );
  const netIncome = findStatementValue(
    lines,
    ["IS", "CIS"],
    ["profitloss", "profitlossattributabletoownersofparent"],
    ["profitloss", "당기순이익", "분기순이익", "지배기업소유주지분순이익"],
  );
  const equity = findStatementValue(
    lines,
    ["BS"],
    ["equity", "equityattributabletoownersofparent"],
    ["totalequity", "equity", "자본총계", "지배기업의소유주지분"],
  );
  const liabilities = findStatementValue(
    lines,
    ["BS"],
    ["liabilities"],
    ["liabilities", "부채총계"],
  );

  return {
    roe: percent(netIncome, equity),
    roic: computeKrRoic(lines),
    operatingMargin: percent(operatingIncome, revenue),
    debtRatio: percent(liabilities, equity),
  };
}

async function fetchKrIndicators(corpCode, bsnsYear, reprtCode, env) {
  const key = ensureKey(env);
  const categories = ["M210000", "M220000", "M230000"];
  const responses = await Promise.all(
    categories.map((category) =>
      fetchJson(
        `${OPEN_DART_BASE}/fnlttSinglIndx.json?crtfc_key=${key}&corp_code=${corpCode}&bsns_year=${bsnsYear}&reprt_code=${reprtCode}&idx_cl_code=${category}`,
        env,
      ),
    ),
  );
  return responses.flatMap((response) => response.list ?? []);
}

async function fetchKrStatements(corpCode, bsnsYear, reprtCode, env) {
  const key = ensureKey(env);
  const data = await fetchJson(
    `${OPEN_DART_BASE}/fnlttSinglAcntAll.json?crtfc_key=${key}&corp_code=${corpCode}&bsns_year=${bsnsYear}&reprt_code=${reprtCode}&fs_div=CFS`,
    env,
  );
  if ((data.list ?? []).length) return data.list;

  const fallback = await fetchJson(
    `${OPEN_DART_BASE}/fnlttSinglAcntAll.json?crtfc_key=${key}&corp_code=${corpCode}&bsns_year=${bsnsYear}&reprt_code=${reprtCode}&fs_div=OFS`,
    env,
  );
  return fallback.list ?? [];
}

async function fetchQuarterSnapshot(corp, period, env) {
  const [indicators, statements] = await Promise.all([
    fetchKrIndicators(corp.corpCode, period.bsnsYear, period.reprtCode, env).catch(() => []),
    fetchKrStatements(corp.corpCode, period.bsnsYear, period.reprtCode, env).catch(() => []),
  ]);
  if (!indicators.length && !statements.length) return null;

  const mapped = indicatorMap(indicators);
  const derived = deriveMetricsFromStatements(statements);

  return {
    label: reprtLabel(period.bsnsYear, period.reprtCode),
    headline: period.reprtCode === "11011" ? "연간 보고" : "분기 보고",
    metrics: {
      per: round(mapped.per),
      pbr: round(mapped.pbr),
      roe: round(mapped.roe ?? derived.roe),
      roic: round(derived.roic),
      operatingMargin: round(derived.operatingMargin ?? mapped.operatingMargin),
      debtRatio: round(mapped.debtRatio ?? derived.debtRatio),
      dividendYield: round(mapped.dividendYield),
    },
  };
}

function summarizeKr(history) {
  const latest = history[history.length - 1];
  return `${latest.label} 기준으로 최근 재무지표를 반영했습니다. 국내 종목은 OpenDART 공시 지표와 재무제표를 조합해 분석합니다.`;
}

export async function getKRStockData(code, env, corpCodeHint = "", nameHint = "") {
  const corp = corpCodeHint
    ? {
        corpCode: corpCodeHint,
        code,
        name: nameHint || code,
        market: "KR",
        marketLabel: "국내 주식",
      }
    : await resolveCorpByCode(code, env);

  if (!corp) {
    throw new Error("해당 국내 종목을 최근 OpenDART 공시 목록에서 찾지 못했습니다.");
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
      "국내 주식 검색은 최근 OpenDART 공시에서 검색어와 일치하는 종목만 찾아 호출 수를 줄였습니다.",
      "PER, PBR, ROE, 영업이익률, 부채비율, 배당수익률은 OpenDART 주요 지표 응답을 사용했습니다.",
      "ROIC는 OpenDART 재무제표 계정값으로 근사 계산했습니다.",
    ],
    sources: [
      { label: "OpenDART Disclosure Search", url: "https://opendart.fss.or.kr/guide/main.do?apiGrpCd=DS002" },
      { label: "OpenDART Single Company Indicators", url: "https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS003&apiId=2022001" },
      { label: "OpenDART Financial Statements", url: "https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS003&apiId=2019017" },
    ],
  };
}
