export const metricDefinitions = [
  {
    key: "per",
    label: "PER",
    category: "가치",
    format: "x",
    guidance: "낮을수록 이익 대비 주가 부담이 낮다고 해석하는 경우가 많습니다.",
  },
  {
    key: "pbr",
    label: "PBR",
    category: "가치",
    format: "x",
    guidance: "낮을수록 순자산 대비 주가가 낮은 편으로 볼 수 있습니다.",
  },
  {
    key: "roe",
    label: "ROE",
    category: "성장",
    format: "%",
    guidance: "자본 대비 수익성을 보여주며 일반적으로 높을수록 좋게 봅니다.",
  },
  {
    key: "roic",
    label: "ROIC",
    category: "성장",
    format: "%",
    guidance: "투하자본 대비 수익성으로, 사업 효율을 볼 때 유용합니다.",
  },
  {
    key: "operatingMargin",
    label: "영업이익률",
    category: "성장",
    format: "%",
    guidance: "본업에서 얼마를 남기는지 보여주는 대표 수익성 지표입니다.",
  },
  {
    key: "debtRatio",
    label: "부채비율",
    category: "건전성",
    format: "%",
    guidance: "낮을수록 재무 부담이 적은 편으로 보는 경우가 많습니다.",
  },
  {
    key: "dividendYield",
    label: "배당수익률",
    category: "건전성",
    format: "%",
    guidance: "배당 중심 투자에서는 높을수록 매력이 커질 수 있습니다.",
  },
];

export function round(value, digits = 2) {
  if (value == null || Number.isNaN(value) || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function toNumber(value) {
  if (value == null) return null;
  const normalized = String(value).replace(/,/g, "").trim();
  if (!normalized || normalized === "-") return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function pickLatest(values) {
  return values[values.length - 1] ?? null;
}

export function percent(numerator, denominator) {
  if (numerator == null || denominator == null || denominator === 0) return null;
  return (numerator / denominator) * 100;
}
