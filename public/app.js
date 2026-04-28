const state = {
  market: "US",
  activeTab: "fundamentals",
  selectedStock: null,
  stockData: null,
  searchTimer: null,
  masterData: null,
};

const ui = {
  searchInput: document.querySelector("#stock-search"),
  clearSearch: document.querySelector("#clear-search"),
  searchResults: document.querySelector("#search-results"),
  selectionSummary: document.querySelector("#selection-summary"),
  fxBanner: document.querySelector("#fxBanner"),
  insightSummary: document.querySelector("#insightSummary"),
  priceChart: document.querySelector("#priceChart"),
  newsList: document.querySelector("#newsList"),
  metricGrid: document.querySelector("#metricGrid"),
  quarterlyTrend: document.querySelector("#quarterlyTrend"),
  notesList: document.querySelector(".notes-list"),
  screens: [...document.querySelectorAll(".tab-screen")],
  bottomTabs: [...document.querySelectorAll(".bottom-tab")],
  backtestTarget: document.querySelector("#backtestTarget"),
  strategySelect: document.querySelector("#strategy-select"),
  holdingYears: document.querySelector("#holding-years"),
  holdingMonths: document.querySelector("#holding-months"),
  runBacktest: document.querySelector("#run-backtest"),
  backtestSummary: document.querySelector("#backtestSummary"),
  backtestChart: document.querySelector("#backtestChart"),
  backtestNotes: document.querySelector("#backtestNotes"),
  labTarget: document.querySelector("#labTarget"),
  labMonthlyAmount: document.querySelector("#lab-monthly-amount"),
  labYears: document.querySelector("#lab-years"),
  labMonths: document.querySelector("#lab-months"),
  runLabDca: document.querySelector("#run-lab-dca"),
  labSummary: document.querySelector("#labSummary"),
  labChart: document.querySelector("#labChart"),
  labNotes: document.querySelector("#labNotes"),
};

const DEFAULT_METRIC_DEFINITIONS = [
  {
    key: "per",
    label: "PER",
    category: "가치",
    format: "x",
    guidance: "주가를 주당순이익으로 나눈 값입니다.",
  },
  {
    key: "pbr",
    label: "PBR",
    category: "가치",
    format: "x",
    guidance: "주가를 주당순자산으로 나눈 값입니다.",
  },
  {
    key: "roe",
    label: "ROE",
    category: "성장",
    format: "%",
    guidance: "자기자본 대비 수익성입니다.",
  },
  {
    key: "roic",
    label: "ROIC",
    category: "성장",
    format: "%",
    guidance: "투하자본 대비 수익성입니다.",
  },
  {
    key: "operatingMargin",
    label: "영업이익률",
    category: "성장",
    format: "%",
    guidance: "매출 대비 영업이익 비율입니다.",
  },
  {
    key: "debtRatio",
    label: "부채비율",
    category: "건전성",
    format: "%",
    guidance: "자기자본 대비 부채 비율입니다.",
  },
  {
    key: "dividendYield",
    label: "배당수익률",
    category: "건전성",
    format: "%",
    guidance: "주가 대비 배당 비율입니다.",
  },
];

function formatMetric(value, format) {
  if (value == null || Number.isNaN(value)) return "-";
  if (format === "text") return String(value);
  return format === "%" ? `${value.toFixed(1)}%` : `${value.toFixed(2)}x`;
}

function formatDelta(delta, format) {
  if (delta == null || Number.isNaN(delta)) return "-";
  if (format === "text") return "-";
  const sign = delta > 0 ? "+" : "";
  return format === "%" ? `${sign}${delta.toFixed(1)}%p` : `${sign}${delta.toFixed(2)}x`;
}

function isEtf(stock) {
  return stock?.assetType === "ETF";
}

function getFxRate() {
  return state.stockData?.fx?.rate ?? null;
}

function formatKrw(value) {
  if (value == null || Number.isNaN(value)) return "-";
  return new Intl.NumberFormat("ko-KR", {
    style: "currency",
    currency: "KRW",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatUsd(value) {
  if (value == null || Number.isNaN(value)) return "-";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 100 ? 0 : 2,
  }).format(value);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatPercent(value) {
  if (value == null || Number.isNaN(value)) return "-";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function summarizePriceAction(priceChart = []) {
  const points = priceChart.filter((point) => point.close != null);
  if (points.length < 2) {
    return {
      tone: "warn",
      title: "가격 데이터 부족",
      body: "최근 일일 가격 흐름을 계산할 데이터가 충분하지 않습니다.",
    };
  }

  const first = points[0];
  const last = points[points.length - 1];
  const high = points.reduce((best, point) => (point.close > best.close ? point : best), first);
  const low = points.reduce((best, point) => (point.close < best.close ? point : best), first);
  const periodReturn = ((last.close / first.close) - 1) * 100;
  const range = ((high.close / low.close) - 1) * 100;
  const tone = periodReturn >= 5 ? "good" : periodReturn <= -5 ? "bad" : "warn";
  const title = periodReturn >= 5 ? "단기 상승 우위" : periodReturn <= -5 ? "단기 조정 구간" : "박스권 또는 혼조 흐름";

  return {
    tone,
    title,
    body: `최근 ${points.length}거래일 수익률은 ${formatPercent(periodReturn)}입니다. 고점은 ${high.date} ${formatUsd(high.close)}, 저점은 ${low.date} ${formatUsd(low.close)}이며, 관찰 구간 변동폭은 약 ${formatPercent(range)}입니다.`,
  };
}

function buildDetailedOutlook(stock, history = [], priceChart = []) {
  if (isEtf(stock)) {
    const details = Array.isArray(stock.etfDetails) ? stock.etfDetails : [];
    const holdings = Array.isArray(stock.holdings) ? stock.holdings : [];
    const sectors = Array.isArray(stock.sectorWeights) ? stock.sectorWeights : [];
    const price = summarizePriceAction(priceChart);
    const expense = details.find((item) => item.key === "expenseRatio")?.value ?? "-";
    const dividend = details.find((item) => item.key === "dividendYield")?.value ?? "-";
    const topHolding = holdings[0] ? `${holdings[0].name}${holdings[0].weight != null ? ` ${holdings[0].weight.toFixed(2)}%` : ""}` : "상위 보유 종목 미확인";
    const topSector = sectors[0] ? `${sectors[0].name}${sectors[0].weight != null ? ` ${sectors[0].weight.toFixed(2)}%` : ""}` : "섹터 비중 미확인";

    return {
      tone: price.tone,
      title: price.title,
      bullets: [
        `ETF 구조는 운용보수 ${expense}, 배당수익률 ${dividend}를 먼저 확인해야 합니다.`,
        `집중도는 상위 보유 종목 ${topHolding}, 대표 섹터 ${topSector}를 기준으로 점검할 수 있습니다.`,
        price.body,
        "전망은 기초지수 방향성, 금리와 유동성, 레버리지 여부, 보유 종목 집중도 변화에 크게 좌우됩니다.",
      ],
    };
  }

  const metrics = stock.metrics ?? {};
  const price = summarizePriceAction(priceChart);
  const marginTrend = summarizeTrend("operatingMargin", history);
  const roeTrend = summarizeTrend("roe", history);
  const debtTrend = summarizeTrend("debtRatio", history);
  const valuation =
    metrics.per != null && metrics.pbr != null
      ? `PER ${formatMetric(metrics.per, "x")}, PBR ${formatMetric(metrics.pbr, "x")} 기준으로 밸류에이션 부담을 확인해야 합니다.`
      : "PER 또는 PBR 데이터가 비어 있어 밸류에이션 판단은 보수적으로 봐야 합니다.";

  return {
    tone: price.tone,
    title: price.title,
    bullets: [
      valuation,
      `수익성은 ROE ${formatMetric(metrics.roe, "%")}, 영업이익률 ${formatMetric(metrics.operatingMargin, "%")} 수준이며, ROE 흐름은 "${roeTrend.sentence}"`,
      `재무 안정성은 부채비율 ${formatMetric(metrics.debtRatio, "%")} 기준으로 보며, 최근 흐름은 "${debtTrend.sentence}"`,
      `마진 추세는 "${marginTrend.sentence}" ${price.body}`,
      "전망은 다음 실적 발표에서 매출 성장률, 마진 유지력, 가이던스 변화가 현재 밸류에이션을 정당화하는지에 달려 있습니다.",
    ],
  };
}

function buildEtfDisplayValue(item) {
  const fxRate = getFxRate();
  if (!item || item.rawValue == null || Number.isNaN(item.rawValue)) {
    return item?.value ?? "-";
  }

  if (item.key === "assetsUnderManagement" || item.key === "lastPrice") {
    return formatUsd(item.rawValue);
  }

  if (item.kind === "money" && fxRate) {
    return `${formatUsd(item.rawValue)}\n${formatKrw(item.rawValue * fxRate)}`;
  }

  return item.value ?? "-";
}

function renderEtfMetrics(stock) {
  const details = Array.isArray(stock.etfDetails) ? stock.etfDetails : [];
  ui.metricGrid.innerHTML = details
    .map(
      (item) => `
        <article class="metric-card">
          <div class="metric-topline">
            <div>
              <p class="section-kicker">ETF</p>
              <h3>${item.label}</h3>
            </div>
            <span class="metric-tag tag-value" style="white-space:pre-line">${buildEtfDisplayValue(item)}</span>
          </div>
          <div class="insight warn">
            ${item.description ?? ""}
          </div>
        </article>
      `,
    )
    .join("");
}

function renderEtfBreakdown(stock) {
  const holdings = Array.isArray(stock.holdings) ? stock.holdings : [];
  const sectors = Array.isArray(stock.sectorWeights) ? stock.sectorWeights : [];

  const holdingsHtml = holdings.length
    ? holdings
        .map(
          (item) => `
            <div class="pair">
              <dt>${item.name}${item.symbol ? ` (${item.symbol})` : ""}</dt>
              <dd>${item.weight != null ? `${item.weight.toFixed(2)}%` : "-"}</dd>
            </div>
          `,
        )
        .join("")
    : `<div class="empty-state">보유종목 데이터를 제공하지 않습니다.</div>`;

  const sectorsHtml = sectors.length
    ? sectors
        .map(
          (item) => `
            <div class="pair">
              <dt>${item.name}</dt>
              <dd>${item.weight != null ? `${item.weight.toFixed(2)}%` : "-"}</dd>
            </div>
          `,
        )
        .join("")
    : `<div class="empty-state">섹터 비중 데이터를 제공하지 않습니다.</div>`;

  ui.quarterlyTrend.innerHTML = `
    <article class="quarter-card">
      <div class="quarter-head">
        <h3>상위 보유종목</h3>
        <span class="metric-tag tag-muted">Top Holdings</span>
      </div>
      <dl class="quarter-list">${holdingsHtml}</dl>
    </article>
    <article class="quarter-card">
      <div class="quarter-head">
        <h3>섹터 비중</h3>
        <span class="metric-tag tag-muted">Sector Weights</span>
      </div>
      <dl class="quarter-list">${sectorsHtml}</dl>
    </article>
  `;
}

function renderEtfBreakdownLocalized(stock) {
  const holdings = Array.isArray(stock.holdings) ? stock.holdings : [];
  const sectors = Array.isArray(stock.sectorWeights) ? stock.sectorWeights : [];

  const holdingsHtml = holdings.length
    ? holdings
        .map(
          (item) => `
            <div class="pair">
              <dt>${item.name}${item.symbol ? ` (${item.symbol})` : ""}</dt>
              <dd>${item.weight != null ? `${item.weight.toFixed(2)}%` : "-"}</dd>
            </div>
          `,
        )
        .join("")
    : `<div class="empty-state">보유 종목 데이터를 받지 못했습니다.</div>`;

  const sectorsHtml = sectors.length
    ? sectors
        .map(
          (item) => `
            <div class="pair">
              <dt>${item.name}</dt>
              <dd>${item.weight != null ? `${item.weight.toFixed(2)}%` : "-"}</dd>
            </div>
          `,
        )
        .join("")
    : `<div class="empty-state">섹터 비중 데이터를 받지 못했습니다.</div>`;

  ui.quarterlyTrend.innerHTML = `
    <article class="quarter-card">
      <div class="quarter-head">
        <h3>상위 보유 종목</h3>
        <span class="metric-tag tag-muted">Top Holdings</span>
      </div>
      <dl class="quarter-list">${holdingsHtml}</dl>
    </article>
    <article class="quarter-card">
      <div class="quarter-head">
        <h3>섹터 비중</h3>
        <span class="metric-tag tag-muted">Sector Weights</span>
      </div>
      <dl class="quarter-list">${sectorsHtml}</dl>
    </article>
  `;
}

function renderEtfInsightSummary(stock, summaryNote, sources, priceChart = []) {
  const detailed = buildDetailedOutlook(stock, [], priceChart);
  ui.insightSummary.classList.remove("empty-state");
  ui.insightSummary.innerHTML = `
    <article class="summary-card">
      <p class="section-kicker">ETF 요약</p>
      <h3>${stock.name} ETF 요약</h3>
      <p>${summaryNote}</p>
    </article>
    <article class="summary-card outlook-card ${detailed.tone}">
      <p class="section-kicker">Outlook</p>
      <h3>${detailed.title}</h3>
      <ul class="detail-list">
        ${detailed.bullets.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
      </ul>
    </article>
    <article class="summary-card">
      <p class="section-kicker">출처</p>
      <h3>데이터 출처</h3>
      <ul class="source-list">
        ${sources.map((source) => `<li><a href="${source.url}" target="_blank" rel="noreferrer">${source.label}</a></li>`).join("")}
      </ul>
    </article>
  `;
}

function renderFxBanner() {
  const fx = state.stockData?.fx;
  ui.fxBanner.classList.remove("empty-state");

  if (!fx?.rate) {
    ui.fxBanner.classList.add("empty-state");
    ui.fxBanner.textContent = "USD/KRW 환율 데이터를 불러오지 못했습니다.";
    return;
  }

  const provider = fx.provider || "환율 API";
  const updatedAt = fx.updatedAt || "기준 시각 없음";
  ui.fxBanner.innerHTML = `
    <strong>1 USD = ${fx.rate.toFixed(2)} KRW</strong>
    <small>기준 시각: ${updatedAt}</small>
    <small>출처: ${provider}</small>
  `;
}

function evaluateMetric(key, value) {
  if (value == null || Number.isNaN(value)) {
    return { tone: "warn", text: "데이터가 부족해 보수적으로 해석하는 것이 좋습니다." };
  }

  const lowerIsBetter = new Set(["per", "pbr", "debtRatio"]);
  const thresholds = {
    per: { good: 15, warn: 25 },
    pbr: { good: 1.5, warn: 3 },
    roe: { good: 15, warn: 8 },
    roic: { good: 12, warn: 6 },
    operatingMargin: { good: 20, warn: 10 },
    debtRatio: { good: 60, warn: 120 },
    dividendYield: { good: 3, warn: 1 },
  };

  const threshold = thresholds[key];
  if (!threshold) {
    return { tone: "warn", text: "기준선이 아직 정의되지 않았습니다." };
  }

  if (lowerIsBetter.has(key)) {
    if (value <= threshold.good) return { tone: "good", text: "현재 수치 부담이 낮은 편입니다." };
    if (value <= threshold.warn) return { tone: "warn", text: "중립 구간입니다. 업종 평균과 함께 보는 것이 좋습니다." };
    return { tone: "bad", text: "밸류에이션 또는 재무 부담을 함께 점검할 필요가 있습니다." };
  }

  if (value >= threshold.good) return { tone: "good", text: "질적으로 강한 수치로 해석할 수 있습니다." };
  if (value >= threshold.warn) return { tone: "warn", text: "나쁘지 않지만 추세 확인이 필요한 구간입니다." };
  return { tone: "bad", text: "약한 편의 수치라 원인과 회복 가능성을 함께 봐야 합니다." };
}

function summarizeTrend(metricKey, history) {
  const first = history[0]?.metrics?.[metricKey];
  const last = history[history.length - 1]?.metrics?.[metricKey];
  if (first == null || last == null || Number.isNaN(first) || Number.isNaN(last)) {
    return { direction: "flat", delta: null, sentence: "추세를 계산할 데이터가 부족합니다." };
  }

  const delta = last - first;
  const lowerIsBetter = new Set(["per", "pbr", "debtRatio"]);
  const improved = lowerIsBetter.has(metricKey) ? delta < 0 : delta > 0;
  const weakened = lowerIsBetter.has(metricKey) ? delta > 0 : delta < 0;

  if (Math.abs(delta) < 0.2) {
    return { direction: "flat", delta, sentence: "1년 기준으로 큰 방향성 변화는 제한적입니다." };
  }
  if (improved) {
    return { direction: "up", delta, sentence: "최근 1년 흐름은 개선 방향으로 해석됩니다." };
  }
  if (weakened) {
    return { direction: "down", delta, sentence: "최근 1년 흐름은 다소 약화된 모습입니다." };
  }

  return { direction: "flat", delta, sentence: "방향성이 혼재되어 있어 추가 확인이 필요합니다." };
}

function buildOutlook(history) {
  const trackedKeys = ["roe", "roic", "operatingMargin", "debtRatio", "dividendYield"];
  let positive = 0;
  let negative = 0;

  trackedKeys.forEach((key) => {
    const trend = summarizeTrend(key, history);
    if (trend.direction === "up") positive += 1;
    if (trend.direction === "down") negative += 1;
  });

  if (positive >= 3 && negative <= 1) {
    return {
      tone: "good",
      title: "완만한 개선 시나리오",
      body: "수익성과 자본 효율이 점진적으로 개선되고 있습니다. 다음 분기에도 영업이익률과 ROIC가 유지되는지 확인하면 좋습니다.",
    };
  }

  if (negative >= 3) {
    return {
      tone: "bad",
      title: "보수적 관찰 필요",
      body: "최근 1년 동안 핵심 지표 둔화가 이어졌습니다. 실적 반등 신호가 분명해질 때까지는 보수적으로 접근하는 편이 안전합니다.",
    };
  }

  return {
    tone: "warn",
    title: "혼합 신호 구간",
    body: "좋아지는 지표와 둔화되는 지표가 함께 보입니다. 단일 지표보다 분기별 추세와 업종 평균을 같이 보는 것이 좋습니다.",
  };
}

function setActiveTab(tab) {
  state.activeTab = tab;
  ui.screens.forEach((screen) => {
    screen.classList.toggle("active", screen.dataset.screen === tab);
  });
  ui.bottomTabs.forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tab);
  });
}

function setLoading(message) {
  ui.insightSummary.classList.remove("empty-state");
  ui.insightSummary.innerHTML = `<div class="loading-card">${message}</div>`;
}

function renderSelection(stock) {
  ui.selectionSummary.innerHTML = `
    <strong>${stock.name} (${stock.code})</strong>
    <small>${stock.marketLabel} · ${stock.industry ?? "업종 정보 없음"}</small>
    <small>${stock.description ?? "실데이터를 기반으로 최신 재무 지표를 조회합니다."}</small>
  `;
}

function renderInsightSummary(stock, history, summaryNote, sources, priceChart = []) {
  if (isEtf(stock)) {
    renderEtfInsightSummary(stock, summaryNote, sources, priceChart);
    return;
  }

  const outlook = buildOutlook(history);
  const detailed = buildDetailedOutlook(stock, history, priceChart);
  const coreMetrics = [
    `PER ${formatMetric(stock.metrics.per, "x")}`,
    `PBR ${formatMetric(stock.metrics.pbr, "x")}`,
    `ROE ${formatMetric(stock.metrics.roe, "%")}`,
    `영업이익률 ${formatMetric(stock.metrics.operatingMargin, "%")}`,
  ];

  ui.insightSummary.classList.remove("empty-state");
  ui.insightSummary.innerHTML = `
    <article class="summary-card">
      <p class="section-kicker">Current View</p>
      <h3>${stock.name}의 현재 상태</h3>
      <p>${coreMetrics.join(" · ")} 수준입니다. ${summaryNote}</p>
    </article>
    <article class="summary-card outlook-card ${outlook.tone}">
      <p class="section-kicker">Outlook</p>
      <h3>${outlook.title}</h3>
      <p>${outlook.body}</p>
    </article>
    <article class="summary-card outlook-card ${detailed.tone}">
      <p class="section-kicker">Detailed View</p>
      <h3>${detailed.title}</h3>
      <ul class="detail-list">
        ${detailed.bullets.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
      </ul>
    </article>
    <article class="summary-card">
      <p class="section-kicker">Source</p>
      <h3>데이터 출처</h3>
      <ul class="source-list">
        ${sources.map((source) => `<li><a href="${source.url}" target="_blank" rel="noreferrer">${source.label}</a></li>`).join("")}
      </ul>
    </article>
  `;
}

function renderMetrics(stock, history) {
  if (isEtf(stock)) {
    renderEtfMetrics(stock);
    return;
  }

  const metricDefinitions =
    Array.isArray(stock.metricDefinitions) && stock.metricDefinitions.length
      ? stock.metricDefinitions
      : DEFAULT_METRIC_DEFINITIONS;

  ui.metricGrid.innerHTML = metricDefinitions
    .map((metric) => {
      const value = stock.metrics[metric.key];
      const evaluation = evaluateMetric(metric.key, value);
      const trend = summarizeTrend(metric.key, history);
      const trendTone = trend.direction === "up" ? "good" : trend.direction === "down" ? "bad" : "warn";

      return `
        <article class="metric-card">
          <div class="metric-topline">
            <div>
              <p class="section-kicker">${metric.category}</p>
              <h3>${metric.label}</h3>
            </div>
            <span class="metric-tag tag-value">${formatMetric(value, metric.format)}</span>
          </div>
          <p class="empty-state">${metric.guidance}</p>
          <dl>
            <div class="pair">
              <dt>현재 수치</dt>
              <dd>${formatMetric(value, metric.format)}</dd>
            </div>
            <div class="pair">
              <dt>1년 변화</dt>
              <dd>${formatDelta(trend.delta, metric.format)}</dd>
            </div>
          </dl>
          <div class="insight ${evaluation.tone}">
            ${evaluation.text}
          </div>
          <div class="insight ${trendTone}">
            ${trend.sentence}
          </div>
        </article>
      `;
    })
    .join("");
}

function renderQuarterlyTrend(history, metricDefinitions) {
  if (isEtf(state.selectedStock)) {
    renderEtfBreakdownLocalized(state.selectedStock);
    return;
  }

  const safeMetricDefinitions =
    Array.isArray(metricDefinitions) && metricDefinitions.length
      ? metricDefinitions
      : DEFAULT_METRIC_DEFINITIONS;

  if (!Array.isArray(history) || !history.length) {
    ui.quarterlyTrend.innerHTML = `
      <article class="quarter-card">
        <div class="quarter-head">
          <h3>최근 1년 분기 흐름</h3>
          <span class="metric-tag tag-muted">No quarterly history</span>
        </div>
        <div class="empty-state">분기 재무 히스토리를 받지 못해 현재 지표 중심으로 표시합니다.</div>
      </article>
    `;
    return;
  }

  ui.quarterlyTrend.innerHTML = history
    .map((quarter) => {
      const pairs = safeMetricDefinitions
        .map(
          (metric) => `
            <div class="pair">
              <dt>${metric.label}</dt>
              <dd>${formatMetric(quarter.metrics[metric.key], metric.format)}</dd>
            </div>
          `,
        )
        .join("");

      return `
        <article class="quarter-card">
          <div class="quarter-head">
            <h3>${quarter.label}</h3>
            <span class="metric-tag tag-muted">${quarter.headline}</span>
          </div>
          <dl class="quarter-list">
            ${pairs}
          </dl>
        </article>
      `;
    })
    .join("");
}

function renderPriceChart(priceChart = [], stock = null) {
  const points = priceChart.filter((point) => point.close != null);
  if (!points.length) {
    ui.priceChart.classList.add("empty-state");
    ui.priceChart.textContent = "최근 일일 가격 데이터를 받지 못했습니다.";
    return;
  }

  const values = points.map((point) => point.close);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const width = 720;
  const height = 300;
  const padding = 28;
  const path = buildChartPath(points, "close", width, height, padding, minValue, maxValue);
  const start = points[0];
  const end = points[points.length - 1];
  const totalReturn = start.close ? ((end.close / start.close) - 1) * 100 : null;
  const latestChange = end.changePercent;
  const tone = totalReturn >= 0 ? "good" : "bad";

  ui.priceChart.classList.remove("empty-state");
  ui.priceChart.innerHTML = `
    <div class="chart-wrap">
      <div class="chart-meta">
        <span>${stock ? `${stock.name} (${stock.code})` : "선택 종목"} · ${points.length}거래일</span>
        <span>${start.date} ~ ${end.date}</span>
      </div>
      <svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="최근 일일 종가 차트">
        <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="rgba(20,32,51,0.18)" stroke-width="1" />
        <line x1="${padding}" y1="${padding}" x2="${padding}" y2="${height - padding}" stroke="rgba(20,32,51,0.18)" stroke-width="1" />
        <path d="${path}" fill="none" stroke="#0d2a45" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <div class="chart-legend">
        <span class="legend-item"><span class="legend-swatch stock"></span>종가 ${formatUsd(end.close)}</span>
        <span class="metric-tag ${tone === "good" ? "tag-good" : "tag-bad"}">기간 수익률 ${formatPercent(totalReturn)}</span>
        <span class="metric-tag tag-muted">최근 일간 ${formatPercent(latestChange)}</span>
      </div>
    </div>
  `;
}

function cleanNewsText(value = "") {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = String(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return textarea.value.replace(/\s+/g, " ").trim();
}

function hasAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function extractNewsNumbers(text = "") {
  return [...text.matchAll(/(?:[$€£]\s?\d+(?:[.,]\d+)?(?:\s?(?:billion|million|trillion|bn|m))?|\d+(?:[.,]\d+)?\s?%|\d+(?:[.,]\d+)?\s?(?:billion|million|trillion|bn|m))/gi)]
    .map((match) => match[0].replace(/\s+/g, " ").trim())
    .filter((value, index, array) => array.indexOf(value) === index)
    .slice(0, 3);
}

function detectNewsTone(text = "") {
  if (hasAny(text, [/beat/i, /beats/i, /surge/i, /jump/i, /rall/i, /gain/i, /upgrade/i, /raise/i, /record/i, /strong/i, /better than expected/i])) {
    return "긍정적인 재료로 해석될 수 있습니다.";
  }

  if (hasAny(text, [/miss/i, /fall/i, /drop/i, /slump/i, /downgrade/i, /cut/i, /weak/i, /lawsuit/i, /probe/i, /investigation/i, /concern/i, /risk/i])) {
    return "단기 부담 요인으로 해석될 수 있습니다.";
  }

  return "방향성은 추가 지표와 가격 흐름을 함께 봐야 합니다.";
}

function detectNewsTopic(text = "") {
  if (hasAny(text, [/war/i, /conflict/i, /invasion/i, /attack/i, /sanction/i, /export control/i, /tariff/i, /trade restriction/i])) {
    return "지정학, 전쟁, 제재, 관세 관련 소식입니다. 공급망과 매출 노출도가 주가에 직접 영향을 줄 수 있습니다.";
  }

  if (hasAny(text, [/merger/i, /acquisition/i, /deal/i, /takeover/i, /buyout/i, /spin[- ]?off/i, /joint venture/i, /partnership/i])) {
    return "인수합병이나 전략적 거래 관련 소식입니다. 거래 조건, 승인 가능성, 시너지 기대가 핵심 확인 포인트입니다.";
  }

  if (hasAny(text, [/lawsuit/i, /regulatory/i, /probe/i, /investigation/i, /approval/i, /ban/i, /antitrust/i, /recall/i, /bankruptcy/i, /default/i])) {
    return "규제, 소송, 승인, 리콜 같은 법적 이슈에 관한 소식입니다. 비용 증가와 사업 지연 가능성을 확인해야 합니다.";
  }

  if (hasAny(text, [/dividend/i, /yield/i, /buyback/i, /repurchase/i, /split/i])) {
    return "주주환원 정책에 관한 소식입니다. 배당, 자사주 매입, 주식분할 여부가 투자 매력도에 영향을 줄 수 있습니다.";
  }

  if (hasAny(text, [/contract/i, /order/i, /supply agreement/i, /product/i, /launch/i, /plant/i, /factory/i, /strike/i, /cyberattack/i, /outage/i, /shutdown/i])) {
    return "수주, 제품, 공장, 파업, 장애 같은 사업 이벤트입니다. 매출 지속성과 비용 영향을 함께 봐야 합니다.";
  }

  return "개인 투자자가 확인할 만한 핵심 재료입니다. 단순 의견보다 실제 사업과 주주가치에 미치는 영향을 보는 용도입니다.";
}

function buildKoreanNewsSummary(item) {
  const title = cleanNewsText(item.title);
  const body = cleanNewsText(item.summary);
  const sourceText = [title, body].filter(Boolean).join(". ");
  const compact = sourceText.replace(/\s+/g, " ").trim();
  const topic = detectNewsTopic(compact);
  const tone = detectNewsTone(compact);
  const numbers = extractNewsNumbers(compact);
  const numberNote = numbers.length ? ` 기사에 언급된 주요 수치는 ${numbers.join(", ")}입니다.` : "";

  return `요약: ${topic} ${tone}${numberNote}`;
}

function renderNews(news = []) {
  const items = Array.isArray(news) ? news : [];
  if (!items.length) {
    ui.newsList.classList.add("empty-state");
    ui.newsList.textContent = "현재 전쟁, 합병, 규제, 소송, 리콜, 공급 차질처럼 투자 판단에 직접 영향을 줄 만한 핵심 뉴스가 없습니다.";
    return;
  }

  ui.newsList.classList.remove("empty-state");
  ui.newsList.innerHTML = items
    .map(
      (item) => {
        const title = cleanNewsText(item.title);
        const koreanSummary = buildKoreanNewsSummary(item);
        return `
        <article class="news-card">
          <a class="news-title" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(title || "원문 보기")}</a>
          <p class="news-summary">${escapeHtml(koreanSummary)}</p>
          <div class="news-meta">
            <span>${escapeHtml(item.site || "뉴스")}</span>
            <span>${escapeHtml(item.publishedAt || "날짜 없음")}</span>
          </div>
        </article>
      `;
      },
    )
    .join("");
}

function renderNotes(notes) {
  ui.notesList.innerHTML = notes.map((note) => `<li>${note}</li>`).join("");
}

function renderBacktestTarget(stock) {
  if (!stock) {
    ui.backtestTarget.textContent = "아직 종목이 선택되지 않았습니다. 먼저 미국 주식 종목을 선택하세요.";
    return;
  }

  ui.backtestTarget.textContent = `${stock.name} (${stock.code}) 기준으로 선택 전략을 검증합니다. 추세 전환, 공포지수, 모멘텀, RSI 역추세, 돌파 매매, 저변동성 추세를 같은 기간의 NASDAQ Composite와 비교할 수 있습니다.`;
}

function renderLabTarget(stock) {
  if (!stock) {
    ui.labTarget.textContent = "아직 종목이 선택되지 않았습니다. 먼저 미국 주식 또는 ETF를 선택하세요.";
    return;
  }

  ui.labTarget.textContent = `${stock.name} (${stock.code})에 매월 같은 금액을 투자했을 때 원금, 평가금액, 누적 수익률을 NASDAQ Composite 적립식 투자와 비교합니다.`;
}

function renderBacktestIdleState() {
  ui.backtestSummary.classList.add("empty-state");
  ui.backtestSummary.textContent = "종목을 선택하고 보유 기간을 입력한 뒤 백테스트를 실행하면 결과가 표시됩니다.";
  ui.backtestChart.classList.add("empty-state");
  ui.backtestChart.textContent = "종목과 NASDAQ 비교 차트가 여기에 생성됩니다.";
  ui.backtestNotes.innerHTML = "";
}

function renderLabIdleState() {
  ui.labSummary.classList.add("empty-state");
  ui.labSummary.textContent = "종목과 투자 기간, 월 투자금을 선택한 뒤 실행하면 원금과 누적 수익률을 NASDAQ 지수 투자와 비교합니다.";
  ui.labChart.classList.add("empty-state");
  ui.labChart.textContent = "원금, 선택 종목, NASDAQ 적립식 투자 평가금액 차트가 여기에 생성됩니다.";
  ui.labNotes.innerHTML = "";
}

function renderBacktestLoading() {
  ui.backtestSummary.classList.remove("empty-state");
  ui.backtestSummary.innerHTML = `<div class="loading-card">백테스트를 계산하고 있습니다...</div>`;
  ui.backtestChart.classList.remove("empty-state");
  ui.backtestChart.innerHTML = `<div class="loading-card">가격 데이터와 NASDAQ 비교 차트를 준비하고 있습니다...</div>`;
}

function renderLabLoading() {
  ui.labSummary.classList.remove("empty-state");
  ui.labSummary.innerHTML = `<div class="loading-card">적립식 투자 결과를 계산하고 있습니다...</div>`;
  ui.labChart.classList.remove("empty-state");
  ui.labChart.innerHTML = `<div class="loading-card">원금과 NASDAQ 비교 차트를 준비하고 있습니다...</div>`;
}

function buildChartPath(points, key, width, height, padding, minValue, maxValue) {
  const span = Math.max(1, maxValue - minValue);
  return points
    .map((point, index) => {
      const x = padding + (index / Math.max(1, points.length - 1)) * (width - padding * 2);
      const y = height - padding - ((point[key] - minValue) / span) * (height - padding * 2);
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

function renderBacktestChart(data) {
  const points = data.chartSeries ?? [];
  if (!points.length) {
    ui.backtestChart.classList.add("empty-state");
    ui.backtestChart.textContent = "차트를 만들 데이터가 부족합니다.";
    return;
  }

  const values = points.flatMap((point) => [point.stockValue, point.benchmarkValue]);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const width = 720;
  const height = 320;
  const padding = 28;
  const stockPath = buildChartPath(points, "stockValue", width, height, padding, minValue, maxValue);
  const benchmarkPath = buildChartPath(points, "benchmarkValue", width, height, padding, minValue, maxValue);
  const start = points[0]?.date;
  const end = points[points.length - 1]?.date;

  ui.backtestChart.classList.remove("empty-state");
  ui.backtestChart.innerHTML = `
    <div class="chart-wrap">
      <div class="chart-meta">
        <span>기준값 100에서 시작한 상대 성과 비교</span>
        <span>${start} ~ ${end}</span>
      </div>
      <svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="백테스트 비교 차트">
        <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="rgba(20,32,51,0.18)" stroke-width="1" />
        <line x1="${padding}" y1="${padding}" x2="${padding}" y2="${height - padding}" stroke="rgba(20,32,51,0.18)" stroke-width="1" />
        <path d="${benchmarkPath}" fill="none" stroke="#b96d2b" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
        <path d="${stockPath}" fill="none" stroke="#0d2a45" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <div class="chart-legend">
        <span class="legend-item"><span class="legend-swatch stock"></span>${data.strategy.shortLabel}</span>
        <span class="legend-item"><span class="legend-swatch benchmark"></span>NASDAQ Composite (^IXIC)</span>
      </div>
    </div>
  `;
}

function renderLabChart(data) {
  const points = data.chartSeries ?? [];
  if (!points.length) {
    ui.labChart.classList.add("empty-state");
    ui.labChart.textContent = "차트를 만들 데이터가 부족합니다.";
    return;
  }

  const values = points.flatMap((point) => [point.principal, point.stockValue, point.benchmarkValue]);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const width = 720;
  const height = 320;
  const padding = 28;
  const principalPath = buildChartPath(points, "principal", width, height, padding, minValue, maxValue);
  const stockPath = buildChartPath(points, "stockValue", width, height, padding, minValue, maxValue);
  const benchmarkPath = buildChartPath(points, "benchmarkValue", width, height, padding, minValue, maxValue);
  const start = points[0]?.date;
  const end = points[points.length - 1]?.date;

  ui.labChart.classList.remove("empty-state");
  ui.labChart.innerHTML = `
    <div class="chart-wrap">
      <div class="chart-meta">
        <span>월 ${formatUsd(data.monthlyAmount)} 적립 기준 평가금액 비교</span>
        <span>${start} ~ ${end}</span>
      </div>
      <svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="적립식 투자 비교 차트">
        <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="rgba(20,32,51,0.18)" stroke-width="1" />
        <line x1="${padding}" y1="${padding}" x2="${padding}" y2="${height - padding}" stroke="rgba(20,32,51,0.18)" stroke-width="1" />
        <path d="${principalPath}" fill="none" stroke="#586377" stroke-width="2.5" stroke-dasharray="7 7" stroke-linecap="round" stroke-linejoin="round" />
        <path d="${benchmarkPath}" fill="none" stroke="#b96d2b" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
        <path d="${stockPath}" fill="none" stroke="#0d2a45" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <div class="chart-legend">
        <span class="legend-item"><span class="legend-swatch principal"></span>투입 원금</span>
        <span class="legend-item"><span class="legend-swatch stock"></span>${data.stock.code} 평가금액</span>
        <span class="legend-item"><span class="legend-swatch benchmark"></span>NASDAQ 평가금액</span>
      </div>
    </div>
  `;
}

function renderBacktestSummary(data) {
  if (Array.isArray(data.strategies) && data.strategies.length) {
    ui.backtestSummary.classList.remove("empty-state");
    ui.backtestSummary.innerHTML = data.strategies
      .map(
        (item, index) => `
          <article class="summary-card ${index === 0 ? "outlook-card good" : ""}">
            <p class="section-kicker">${index === 0 ? "Best Strategy" : "Strategy"}</p>
            <h3>${item.label}</h3>
            <p>누적수익률 ${item.stock.totalReturn}% · CAGR ${item.stock.cagr}%</p>
            <p>NASDAQ 대비 ${item.excessReturn}%p · 초과 CAGR ${item.excessCagr}%p</p>
            <p>매매 전환 횟수 ${item.stock.trades ?? 0}회</p>
          </article>
        `,
      )
      .join("");

    ui.backtestNotes.innerHTML = (data.notes ?? []).map((note) => `<li>${note}</li>`).join("");
    return;
  }

  const stock = data.result.stock;
  const benchmark = data.result.benchmark;

  ui.backtestSummary.classList.remove("empty-state");
  ui.backtestSummary.innerHTML = `
    <article class="summary-card">
      <p class="section-kicker">Strategy</p>
      <h3>${data.strategy.label}</h3>
      <p>${data.stock.name} (${data.stock.code})에 적용한 결과입니다.</p>
      <p>매매 전환 횟수 ${stock.trades ?? 0}회</p>
    </article>
    <article class="summary-card">
      <p class="section-kicker">Selected Stock</p>
      <h3>${data.stock.name} (${data.stock.code})</h3>
      <p>누적수익률 ${stock.totalReturn}% · CAGR ${stock.cagr}%</p>
      <p>${stock.startDate} 시작, ${stock.endDate} 종료 기준입니다.</p>
    </article>
    <article class="summary-card">
      <p class="section-kicker">Benchmark</p>
      <h3>${benchmark.name}</h3>
      <p>누적수익률 ${benchmark.totalReturn}% · CAGR ${benchmark.cagr}%</p>
      <p>${benchmark.startDate} 시작, ${benchmark.endDate} 종료 기준입니다.</p>
    </article>
    <article class="summary-card ${data.result.excessCagr >= 0 ? "outlook-card good" : "outlook-card bad"}">
      <p class="section-kicker">Relative</p>
      <h3>NASDAQ 대비 성과</h3>
      <p>초과 누적수익률 ${data.result.excessReturn}%p · 초과 CAGR ${data.result.excessCagr}%p</p>
    </article>
  `;

  ui.backtestNotes.innerHTML = (data.notes ?? []).map((note) => `<li>${note}</li>`).join("");
}

function renderLabSummary(data) {
  const stock = data.result.stock;
  const benchmark = data.result.benchmark;
  const stockBetter = data.result.excessReturn >= 0;

  ui.labSummary.classList.remove("empty-state");
  ui.labSummary.innerHTML = `
    <article class="summary-card">
      <p class="section-kicker">Input</p>
      <h3>매월 ${formatUsd(data.monthlyAmount)} 투자</h3>
      <p>${data.period.startDate}부터 ${data.period.endDate}까지 ${stock.contributionCount}회 매수한 가정입니다.</p>
      <p>총 투입 원금 ${formatUsd(stock.principal)}</p>
    </article>
    <article class="summary-card">
      <p class="section-kicker">Selected</p>
      <h3>${data.stock.name} (${data.stock.code})</h3>
      <p>평가금액 ${formatUsd(stock.endingValue)} · 손익 ${formatUsd(stock.profit)}</p>
      <p>누적수익률 ${formatPercent(stock.cumulativeReturn)}</p>
    </article>
    <article class="summary-card">
      <p class="section-kicker">NASDAQ</p>
      <h3>${benchmark.name}</h3>
      <p>평가금액 ${formatUsd(benchmark.endingValue)} · 손익 ${formatUsd(benchmark.profit)}</p>
      <p>누적수익률 ${formatPercent(benchmark.cumulativeReturn)}</p>
    </article>
    <article class="summary-card ${stockBetter ? "outlook-card good" : "outlook-card bad"}">
      <p class="section-kicker">Relative</p>
      <h3>NASDAQ 대비</h3>
      <p>초과 누적수익률 ${formatPercent(data.result.excessReturn)}p</p>
      <p>초과 손익 ${formatUsd(data.result.excessProfit)}</p>
    </article>
  `;

  ui.labNotes.innerHTML = (data.notes ?? []).map((note) => `<li>${note}</li>`).join("");
}

async function runBacktest() {
  if (!state.selectedStock?.code) {
    renderBacktestIdleState();
    ui.backtestSummary.classList.remove("empty-state");
    ui.backtestSummary.innerHTML = `<div class="error-card">먼저 미국 주식 종목을 선택하세요.</div>`;
    return;
  }

  const years = Number(ui.holdingYears.value || "0");
  const months = Number(ui.holdingMonths.value || "0");
  const safeYears = Number.isFinite(years) ? Math.max(0, Math.trunc(years)) : 0;
  const safeMonths = Number.isFinite(months) ? Math.max(0, Math.trunc(months)) : 0;

  renderBacktestLoading();
  try {
    const params = new URLSearchParams({
      code: state.selectedStock.code,
      years: String(safeYears),
      months: String(safeMonths),
      strategy: ui.strategySelect.value,
    });
    if (state.selectedStock.assetType) {
      params.set("assetType", state.selectedStock.assetType);
    }
    const data = await fetchJson(`/api/backtest?${params.toString()}`);
    renderBacktestSummary(data);
    renderBacktestChart(data);
    setActiveTab("backtest");
  } catch (error) {
    ui.backtestSummary.classList.remove("empty-state");
    ui.backtestSummary.innerHTML = `<div class="error-card">${error.message}</div>`;
    ui.backtestChart.classList.add("empty-state");
    ui.backtestChart.textContent = "차트를 불러오지 못했습니다.";
    ui.backtestNotes.innerHTML = "";
  }
}

async function runLabDca() {
  if (!state.selectedStock?.code) {
    renderLabIdleState();
    ui.labSummary.classList.remove("empty-state");
    ui.labSummary.innerHTML = `<div class="error-card">먼저 미국 주식 또는 ETF를 선택하세요.</div>`;
    return;
  }

  const years = Number(ui.labYears.value || "0");
  const months = Number(ui.labMonths.value || "0");
  const monthlyAmount = Number(ui.labMonthlyAmount.value || "0");
  const safeYears = Number.isFinite(years) ? Math.max(0, Math.trunc(years)) : 0;
  const safeMonths = Number.isFinite(months) ? Math.max(0, Math.trunc(months)) : 0;
  const safeMonthlyAmount = Number.isFinite(monthlyAmount) ? Math.max(0, Math.trunc(monthlyAmount)) : 0;

  renderLabLoading();
  try {
    const params = new URLSearchParams({
      mode: "dca",
      code: state.selectedStock.code,
      years: String(safeYears),
      months: String(safeMonths),
      monthly: String(safeMonthlyAmount),
    });
    if (state.selectedStock.assetType) {
      params.set("assetType", state.selectedStock.assetType);
    }
    const data = await fetchJson(`/api/backtest?${params.toString()}`);
    renderLabSummary(data);
    renderLabChart(data);
    setActiveTab("lab");
  } catch (error) {
    ui.labSummary.classList.remove("empty-state");
    ui.labSummary.innerHTML = `<div class="error-card">${error.message}</div>`;
    ui.labChart.classList.add("empty-state");
    ui.labChart.textContent = "차트를 불러오지 못했습니다.";
    ui.labNotes.innerHTML = "";
  }
}

function renderError(message) {
  ui.selectionSummary.innerHTML = `<strong>조회 실패</strong><small>${message}</small>`;
  renderFxBanner();
  ui.insightSummary.classList.remove("empty-state");
  ui.insightSummary.innerHTML = `<div class="error-card">${message}</div>`;
  ui.priceChart.classList.add("empty-state");
  ui.priceChart.textContent = "최근 일일 가격 차트를 불러오지 못했습니다.";
  ui.newsList.classList.add("empty-state");
  ui.newsList.textContent = "관련 뉴스를 불러오지 못했습니다.";
  ui.metricGrid.innerHTML = "";
  ui.quarterlyTrend.innerHTML = "";
  renderBacktestTarget(null);
  renderBacktestIdleState();
  renderLabTarget(null);
  renderLabIdleState();
}

function renderSearchResults(items, query) {
  if (!query) {
    renderIdleSearchState();
    return;
  }

  const normalizedQuery = query.trim().toUpperCase();
  const canDirectLookup = /^[A-Z][A-Z0-9.-]{0,9}$/.test(normalizedQuery);
  const hasExactMatch = items.some((item) => String(item.code || "").toUpperCase() === normalizedQuery);

  if (!items.length) {
    ui.searchResults.innerHTML = `
      <div class="search-result">
        검색 결과가 없습니다.
        <small>검색어를 조금 다르게 입력해보세요.</small>
      </div>
    ` + (canDirectLookup
      ? `
      <button
        class="search-result"
        type="button"
        data-code="${normalizedQuery}"
        data-name="${encodeURIComponent(normalizedQuery)}"
        data-asset-type=""
      >
        <strong>${normalizedQuery} 직접 조회</strong>
        <small>검색 목록에 없어도 티커로 바로 조회합니다.</small>
      </button>
    `
      : "");
    return;
  }

  const directLookupHtml = canDirectLookup && !hasExactMatch
    ? `
        <button
          class="search-result"
          type="button"
          data-code="${normalizedQuery}"
          data-name="${encodeURIComponent(normalizedQuery)}"
          data-asset-type=""
        >
          <strong>${normalizedQuery} 직접 조회</strong>
          <small>검색 결과와 별개로 이 티커를 바로 조회합니다.</small>
        </button>
      `
    : "";

  ui.searchResults.innerHTML =
    directLookupHtml +
    items
    .map(
      (stock) => `
        <button
          class="search-result"
          type="button"
          data-code="${stock.code}"
          data-name="${encodeURIComponent(stock.name)}"
          data-asset-type="${stock.assetType ?? ""}"
        >
          <strong>${stock.name} (${stock.code})</strong>
          <small>미국 ${stock.assetType === "ETF" ? "ETF" : "주식"} · ${stock.exchange ?? "종목 선택"}</small>
        </button>
      `,
    )
    .join("");
}

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new Error(`API 응답을 JSON으로 해석하지 못했습니다. status=${response.status}`);
    }
  }

  if (!response.ok || data?.ok === false) {
    throw new Error(data?.error ?? `데이터를 불러오지 못했습니다. status=${response.status}`);
  }
  if (!data) {
    throw new Error(`API 응답 본문이 비어 있습니다. status=${response.status}`);
  }

  return data;
}

async function ensureMasterData() {
  if (state.masterData) return state.masterData;

  const data = await fetchJson("/api/master?market=US");
  state.masterData = data.items ?? [];
  return state.masterData;
}

function filterMasterData(items, query) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];

  const exactCode = [];
  const prefixCode = [];
  const nameMatch = [];
  const fallback = [];

  for (const item of items) {
    const code = item.code.toLowerCase();
    const name = item.name.toLowerCase();
    const exchange = (item.exchange || "").toLowerCase();
    const search = `${code} ${name} ${exchange}`;

    if (code === normalized) {
      exactCode.push(item);
    } else if (code.startsWith(normalized)) {
      prefixCode.push(item);
    } else if (name.startsWith(normalized)) {
      nameMatch.push(item);
    } else if (search.includes(normalized)) {
      fallback.push(item);
    }
  }

  return [...exactCode, ...prefixCode, ...nameMatch, ...fallback].slice(0, 20);
}

async function loadSearchResults(query) {
  let master = [];
  let masterError = null;

  try {
    master = await ensureMasterData();
  } catch (error) {
    masterError = error;
  }

  const localMatches = filterMasterData(master, query);

  try {
    const remote = await fetchJson(`/api/search?market=US&q=${encodeURIComponent(query)}`);
    const merged = new Map();
    [...localMatches, ...(remote.items ?? [])].forEach((item) => {
      const key = item.code;
      if (!key || merged.has(key)) return;
      merged.set(key, item);
    });
    renderSearchResults([...merged.values()].slice(0, 20), query);
  } catch (error) {
    if (masterError && !localMatches.length) {
      throw error;
    }
    renderSearchResults(localMatches, query);
  }
}

function renderIdleSearchState() {
  ui.searchResults.innerHTML = `
    <div class="search-result">
      미국 주식·ETF 이름 또는 티커를 입력하면 검색을 시작합니다.
      <small>입력 중에는 로컬 마스터 목록에서 바로 필터링합니다.</small>
    </div>
  `;
}

function updateSearchClearButton() {
  if (!ui.clearSearch) return;
  ui.clearSearch.hidden = !Boolean(ui.searchInput?.value?.trim());
}

function resetSearchSelection() {
  state.selectedStock = null;
  state.stockData = null;
  ui.searchInput.value = "";
  updateSearchClearButton();
  ui.selectionSummary.innerHTML = "";
  renderFxBanner();
  ui.insightSummary.classList.add("empty-state");
  ui.insightSummary.textContent = "종목이나 ETF를 선택하면 주요 분석과 전망이 표시됩니다.";
  ui.priceChart.classList.add("empty-state");
  ui.priceChart.textContent = "종목이나 ETF를 선택하면 최근 일일 가격 차트가 표시됩니다.";
  ui.newsList.classList.add("empty-state");
  ui.newsList.textContent = "종목이나 ETF를 선택하면 관련 뉴스가 표시됩니다.";
  ui.metricGrid.innerHTML = "";
  ui.quarterlyTrend.innerHTML = "";
  renderBacktestTarget(null);
  renderBacktestIdleState();
  renderLabTarget(null);
  renderLabIdleState();
  renderIdleSearchState();
}

async function loadStock(code, name = "", assetType = "") {
  setLoading("실데이터를 조회하고 있습니다...");
  try {
    const params = new URLSearchParams({
      market: "US",
      code,
    });
    if (name) params.set("name", name);
    if (assetType) params.set("assetType", assetType);

    const data = await fetchJson(`/api/stock?${params.toString()}`);
    state.selectedStock = data.stock;
    state.stockData = data;
    renderSelection(data.stock);
    renderFxBanner();
    renderInsightSummary(data.stock, data.history, data.summaryNote, data.sources, data.priceChart);
    renderPriceChart(data.priceChart, data.stock);
    renderNews(data.news);
    renderMetrics(data.stock, data.history);
    renderQuarterlyTrend(data.history, data.stock.metricDefinitions);
    renderNotes(data.notes);
    renderBacktestTarget(data.stock);
    renderBacktestIdleState();
    renderLabTarget(data.stock);
    renderLabIdleState();
    ui.searchInput.value = `${data.stock.name} (${data.stock.code})`;
    updateSearchClearButton();
    renderIdleSearchState();
  } catch (error) {
    renderError(error.message);
  }
}

function scheduleSearch(query) {
  clearTimeout(state.searchTimer);
  updateSearchClearButton();
  if (!query) {
    renderIdleSearchState();
    return;
  }

  state.searchTimer = setTimeout(() => {
    loadSearchResults(query).catch((error) => {
      ui.searchResults.innerHTML = `<div class="search-result"><strong>검색 실패</strong><small>${error.message}</small></div>`;
    });
  }, 120);
}

function attachEvents() {
  ui.searchInput.addEventListener("input", (event) => {
    scheduleSearch(event.target.value.trim());
  });

  ui.clearSearch?.addEventListener("click", () => {
    resetSearchSelection();
    ui.searchInput.focus();
  });

  document.body.addEventListener("click", (event) => {
    const resultButton = event.target.closest(".search-result[data-code]");
    if (resultButton) {
      loadStock(
        resultButton.dataset.code,
        decodeURIComponent(resultButton.dataset.name || ""),
        resultButton.dataset.assetType || "",
      );
      return;
    }

    const tabButton = event.target.closest(".bottom-tab[data-tab]");
    if (tabButton) {
      setActiveTab(tabButton.dataset.tab);
    }
  });

  ui.runBacktest.addEventListener("click", () => {
    runBacktest();
  });

  ui.runLabDca.addEventListener("click", () => {
    runLabDca();
  });
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    let reloading = false;

    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });

    navigator.serviceWorker
      .register("./service-worker.js")
      .then((registration) => {
        registration.update().catch(() => {});

        const refreshRegistration = () => registration.update().catch(() => {});
        window.setInterval(refreshRegistration, 60 * 1000);
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") {
            refreshRegistration();
          }
        });
      })
      .catch(() => {});
  });
}

async function boot() {
  renderNotes([
    "미국 종목 검색은 SEC 종목 마스터와 FMP ETF 목록을 합쳐 즉시 필터링합니다.",
    "재무제표 탭은 FMP 분기 재무와 가격 데이터를 기준으로 핵심 지표를 계산합니다.",
    "백테스팅 탭은 여러 매매 전략을 NASDAQ Composite와 비교합니다.",
    "실험실 탭은 매월 같은 금액을 투자했을 때 선택 종목과 NASDAQ Composite의 적립식 성과를 비교합니다.",
  ]);
  renderBacktestTarget(null);
  renderBacktestIdleState();
  renderLabTarget(null);
  renderLabIdleState();
  renderFxBanner();
  setActiveTab("fundamentals");
  attachEvents();
  updateSearchClearButton();
  renderIdleSearchState();
  registerServiceWorker();
  await ensureMasterData().catch(() => {});
}

boot();
