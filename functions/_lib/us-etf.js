import { remember } from "./cache.js";
import { round, toNumber } from "./metrics.js";

const HALF_DAY = 12 * 60 * 60 * 1000;
const FMP_BASE_URL = "https://financialmodelingprep.com/stable";

function fmpHeaders(env) {
  return {
    "user-agent": `Stock Insight PWA ${env.SEC_CONTACT_EMAIL || "admin@example.com"}`,
    accept: "application/json, text/plain, */*",
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
      if (response.status === 402) {
        throw new Error("FMP 조회 실패: HTTP 402 (현재 요금제에서 해당 ETF 상세 API를 지원하지 않습니다.)");
      }
      if (response.status === 403) {
        throw new Error("FMP 조회 실패: HTTP 403 (API 키가 잘못되었거나 현재 플랜에서 요청이 허용되지 않습니다.)");
      }
      throw new Error(`FMP 조회 실패: HTTP ${response.status}`);
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

function emptyEtfMetrics() {
  return {
    expenseRatio: null,
    dividendYield: null,
    assetsUnderManagement: null,
    nav: null,
  };
}

function formatCompactCurrency(value) {
  if (value == null || !Number.isFinite(value)) return null;
  if (Math.abs(value) >= 1_000_000_000) return `$${round(value / 1_000_000_000, 2)}B`;
  if (Math.abs(value) >= 1_000_000) return `$${round(value / 1_000_000, 2)}M`;
  if (Math.abs(value) >= 1_000) return `$${round(value / 1_000, 2)}K`;
  return `$${round(value, 2)}`;
}

function normalizeEtfInfoRow(row) {
  if (!row || typeof row !== "object") return {};
  return {
    expenseRatio:
      toNumber(row.expenseRatio) ??
      toNumber(row.totalExpenseRatio) ??
      toNumber(row.netExpenseRatio) ??
      null,
    assetsUnderManagement:
      toNumber(row.aum) ??
      toNumber(row.assetsUnderManagement) ??
      toNumber(row.totalAssets) ??
      toNumber(row.netAssets) ??
      null,
    nav: toNumber(row.nav) ?? toNumber(row.navPrice) ?? null,
    dividendYield:
      toNumber(row.dividendYield) ??
      toNumber(row.yield) ??
      toNumber(row.trailingDividendYield) ??
      null,
  };
}

function buildEtfDetailCards(info, quote) {
  const latestPrice = toNumber(quote.price);
  return [
    {
      label: "운용보수",
      value: info.expenseRatio != null ? `${round(info.expenseRatio, 2)}%` : "-",
      description: "ETF 총보수 또는 순보수 기준입니다.",
    },
    {
      label: "배당수익률",
      value: info.dividendYield != null ? `${round(info.dividendYield, 2)}%` : "-",
      description: "최근 제공된 ETF 배당수익률 기준입니다.",
    },
    {
      label: "순자산 규모",
      value: formatCompactCurrency(info.assetsUnderManagement) ?? "-",
      description: "AUM 또는 총 순자산 규모입니다.",
    },
    {
      label: "NAV",
      value: info.nav != null ? `$${round(info.nav, 2)}` : latestPrice != null ? `$${round(latestPrice, 2)}` : "-",
      description: "공식 NAV가 없으면 최근 가격을 대체 표시합니다.",
    },
  ];
}

function normalizeEtfHoldings(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      name: row.asset || row.name || row.holding || row.symbol || "",
      symbol: row.symbol || "",
      weight:
        toNumber(row.weightPercentage) ??
        toNumber(row.weight) ??
        toNumber(row.percentage) ??
        toNumber(row.percentAssets) ??
        null,
    }))
    .filter((row) => row.name)
    .sort((a, b) => (b.weight ?? -1) - (a.weight ?? -1))
    .slice(0, 10);
}

function normalizeEtfSectorWeights(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      name: row.sector || row.name || "",
      weight: toNumber(row.weightPercentage) ?? toNumber(row.weight) ?? toNumber(row.percentage) ?? null,
    }))
    .filter((row) => row.name)
    .sort((a, b) => (b.weight ?? -1) - (a.weight ?? -1))
    .slice(0, 8);
}

function fallbackEtfCards(quote) {
  const latestPrice = toNumber(quote.price);
  return [
    {
      label: "운용보수",
      value: "-",
      description: "현재 API 요금제에서는 운용보수 상세 응답이 비어 있습니다.",
    },
    {
      label: "배당수익률",
      value: "-",
      description: "현재 API 요금제에서는 ETF 배당 상세 응답이 제한될 수 있습니다.",
    },
    {
      label: "순자산 규모",
      value: "-",
      description: "AUM 데이터를 받지 못해 비워 두었습니다.",
    },
    {
      label: "최근 가격",
      value: latestPrice != null ? `$${round(latestPrice, 2)}` : "-",
      description: "ETF 상세 정보가 제한될 때는 가격 기반 정보만 우선 표시합니다.",
    },
  ];
}

export async function getUSEtfData(code, env, selectedName = "") {
  const [quoteResult, profileResult, infoResult, holdingsResult, sectorResult] = await Promise.allSettled([
    fmpFetch("/quote", { symbol: code }, env),
    fmpFetch("/profile", { symbol: code }, env),
    fmpFetch("/etf/info", { symbol: code }, env),
    fmpFetch("/etf/holdings", { symbol: code }, env),
    fmpFetch("/etf/sector-weightings", { symbol: code }, env),
  ]);

  const quoteData = quoteResult.status === "fulfilled" ? quoteResult.value : [];
  const profileData = profileResult.status === "fulfilled" ? profileResult.value : [];
  const infoData = infoResult.status === "fulfilled" ? infoResult.value : [];
  const holdingsData = holdingsResult.status === "fulfilled" ? holdingsResult.value : [];
  const sectorData = sectorResult.status === "fulfilled" ? sectorResult.value : [];

  const quote = Array.isArray(quoteData) ? quoteData[0] ?? {} : quoteData ?? {};
  const profile = Array.isArray(profileData) ? profileData[0] ?? {} : profileData ?? {};
  const info = normalizeEtfInfoRow(Array.isArray(infoData) ? infoData[0] ?? {} : infoData ?? {});
  const holdings = normalizeEtfHoldings(holdingsData);
  const sectorWeights = normalizeEtfSectorWeights(sectorData);
  const latestPrice = toNumber(quote.price);

  const detailCards =
    info.expenseRatio != null ||
    info.dividendYield != null ||
    info.assetsUnderManagement != null ||
    info.nav != null
      ? buildEtfDetailCards(info, quote)
      : fallbackEtfCards(quote);

  const notes = [
    "ETF는 개별 기업 재무제표보다 운용보수, 배당수익률, 순자산 규모, 보유종목 구성과 비중을 보는 편이 더 적절합니다.",
    "상위 보유종목과 섹터 비중을 함께 보면 ETF가 어느 방향의 리스크에 노출되는지 빠르게 파악할 수 있습니다.",
  ];

  if (!holdings.length) {
    notes.push("현재 API 응답에서 보유종목 구성이 비어 있어, 이 ETF는 가격 정보 위주로만 표시됩니다.");
  }

  return {
    stock: {
      code,
      name: selectedName || profile.companyName || code,
      market: "US",
      marketLabel: "미국 주식",
      industry: profile.industry || profile.sector || "ETF",
      assetType: "ETF",
      description: `${profile.sector || profile.industry || "ETF"}${latestPrice != null ? ` · 최근 가격 $${latestPrice.toFixed(2)}` : ""}`,
      metrics: emptyEtfMetrics(),
      metricDefinitions: [],
      etfDetails: detailCards,
      holdings,
      sectorWeights,
    },
    history: [],
    summaryNote:
      "ETF는 기업 실적보다 운용 구조를 보는 자산입니다. 운용보수, 배당수익률, 순자산 규모, 상위 보유종목, 섹터 비중 중심으로 해석하는 편이 맞습니다.",
    notes,
    sources: [
      { label: "FMP Quote API", url: "https://site.financialmodelingprep.com/developer/docs/stable/quotes" },
      { label: "FMP ETF Information API", url: "https://site.financialmodelingprep.com/developer/docs/stable/information" },
      { label: "FMP ETF Holdings API", url: "https://site.financialmodelingprep.com/developer/docs/stable/holdings" },
      { label: "FMP ETF Sector Weightings API", url: "https://site.financialmodelingprep.com/developer/docs/etf-sector-weightings-api" },
    ],
  };
}
