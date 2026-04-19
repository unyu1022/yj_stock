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
  searchResults: document.querySelector("#search-results"),
  selectionSummary: document.querySelector("#selection-summary"),
  insightSummary: document.querySelector("#insightSummary"),
  metricGrid: document.querySelector("#metricGrid"),
  quarterlyTrend: document.querySelector("#quarterlyTrend"),
  notesList: document.querySelector(".notes-list"),
  screens: [...document.querySelectorAll(".tab-screen")],
  bottomTabs: [...document.querySelectorAll(".bottom-tab")],
  backtestTarget: document.querySelector("#backtestTarget"),
  holdingYears: document.querySelector("#holding-years"),
  holdingMonths: document.querySelector("#holding-months"),
  runBacktest: document.querySelector("#run-backtest"),
  backtestSummary: document.querySelector("#backtestSummary"),
  backtestChart: document.querySelector("#backtestChart"),
  backtestNotes: document.querySelector("#backtestNotes"),
};

function formatMetric(value, format) {
  if (value == null || Number.isNaN(value)) return "-";
  return format === "%" ? `${value.toFixed(1)}%` : `${value.toFixed(2)}x`;
}

function formatDelta(delta, format) {
  if (delta == null || Number.isNaN(delta)) return "-";
  const sign = delta > 0 ? "+" : "";
  return format === "%" ? `${sign}${delta.toFixed(1)}%p` : `${sign}${delta.toFixed(2)}x`;
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

function renderInsightSummary(stock, history, summaryNote, sources) {
  const outlook = buildOutlook(history);
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
  ui.metricGrid.innerHTML = stock.metricDefinitions
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
  ui.quarterlyTrend.innerHTML = history
    .map((quarter) => {
      const pairs = metricDefinitions
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

function renderNotes(notes) {
  ui.notesList.innerHTML = notes.map((note) => `<li>${note}</li>`).join("");
}

function renderBacktestTarget(stock) {
  if (!stock) {
    ui.backtestTarget.textContent = "아직 종목이 선택되지 않았습니다. 먼저 미국 주식 종목을 선택하세요.";
    return;
  }

  ui.backtestTarget.textContent = `${stock.name} (${stock.code}) 기준으로 전략 조건을 준비합니다. 다음 단계에서는 기간, 진입 규칙, 리밸런싱 주기를 실제 수익률 계산과 연결할 수 있습니다.`;
}

function renderBacktestIdleState() {
  ui.backtestSummary.classList.add("empty-state");
  ui.backtestSummary.textContent = "종목을 선택하고 보유 기간을 입력한 뒤 백테스트를 실행하면 결과가 표시됩니다.";
  ui.backtestChart.classList.add("empty-state");
  ui.backtestChart.textContent = "종목과 NASDAQ 비교 차트가 여기에 생성됩니다.";
  ui.backtestNotes.innerHTML = "";
}

function renderBacktestLoading() {
  ui.backtestSummary.classList.remove("empty-state");
  ui.backtestSummary.innerHTML = `<div class="loading-card">백테스트를 계산하고 있습니다...</div>`;
  ui.backtestChart.classList.remove("empty-state");
  ui.backtestChart.innerHTML = `<div class="loading-card">가격 데이터와 NASDAQ 비교 차트를 준비하고 있습니다...</div>`;
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
        <span class="legend-item"><span class="legend-swatch stock"></span>${data.stock.name} (${data.stock.code})</span>
        <span class="legend-item"><span class="legend-swatch benchmark"></span>NASDAQ Composite (^IXIC)</span>
      </div>
    </div>
  `;
}

function renderBacktestSummary(data) {
  const stock = data.result.stock;
  const benchmark = data.result.benchmark;

  ui.backtestSummary.classList.remove("empty-state");
  ui.backtestSummary.innerHTML = `
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
    });
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

function renderError(message) {
  ui.selectionSummary.innerHTML = `<strong>조회 실패</strong><small>${message}</small>`;
  ui.insightSummary.classList.remove("empty-state");
  ui.insightSummary.innerHTML = `<div class="error-card">${message}</div>`;
  ui.metricGrid.innerHTML = "";
  ui.quarterlyTrend.innerHTML = "";
  renderBacktestTarget(null);
  renderBacktestIdleState();
}

function renderSearchResults(items, query) {
  if (!query) {
    renderIdleSearchState();
    return;
  }

  if (!items.length) {
    ui.searchResults.innerHTML = `
      <div class="search-result">
        검색 결과가 없습니다.
        <small>검색어를 조금 다르게 입력해보세요.</small>
      </div>
    `;
    return;
  }

  ui.searchResults.innerHTML = items
    .map(
      (stock) => `
        <button
          class="search-result"
          type="button"
          data-code="${stock.code}"
          data-name="${encodeURIComponent(stock.name)}"
        >
          <strong>${stock.name} (${stock.code})</strong>
          <small>미국 주식 · ${stock.exchange ?? "종목 선택"}</small>
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
  const master = await ensureMasterData();
  renderSearchResults(filterMasterData(master, query), query);
}

function renderIdleSearchState() {
  ui.searchResults.innerHTML = `
    <div class="search-result">
      미국 주식 종목명 또는 티커를 입력하면 검색을 시작합니다.
      <small>입력 중에는 로컬 마스터 목록에서 바로 필터링합니다.</small>
    </div>
  `;
}

async function loadStock(code, name = "") {
  setLoading("실데이터를 조회하고 있습니다...");
  try {
    const params = new URLSearchParams({
      market: "US",
      code,
    });
    if (name) params.set("name", name);

    const data = await fetchJson(`/api/stock?${params.toString()}`);
    state.selectedStock = data.stock;
    state.stockData = data;
    renderSelection(data.stock);
    renderInsightSummary(data.stock, data.history, data.summaryNote, data.sources);
    renderMetrics(data.stock, data.history);
    renderQuarterlyTrend(data.history, data.stock.metricDefinitions);
    renderNotes(data.notes);
    renderBacktestTarget(data.stock);
    renderBacktestIdleState();
    ui.searchInput.value = `${data.stock.name} (${data.stock.code})`;
    renderIdleSearchState();
  } catch (error) {
    renderError(error.message);
  }
}

function scheduleSearch(query) {
  clearTimeout(state.searchTimer);
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

  document.body.addEventListener("click", (event) => {
    const resultButton = event.target.closest(".search-result[data-code]");
    if (resultButton) {
      loadStock(resultButton.dataset.code, decodeURIComponent(resultButton.dataset.name || ""));
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
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js");
  });
}

async function boot() {
  renderNotes([
    "미국 주식 검색은 SEC 종목 마스터를 기반으로 즉시 필터링합니다.",
    "재무제표 탭은 FMP 분기 재무와 가격 데이터를 기준으로 핵심 지표를 계산합니다.",
    "백테스팅 탭은 선택 종목과 NASDAQ Composite를 같은 기간의 buy-and-hold 기준으로 비교합니다.",
  ]);
  renderBacktestTarget(null);
  renderBacktestIdleState();
  setActiveTab("fundamentals");
  attachEvents();
  renderIdleSearchState();
  registerServiceWorker();
  await ensureMasterData().catch(() => {});
}

boot();
