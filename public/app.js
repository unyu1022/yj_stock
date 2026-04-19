const state = {
  market: "KR",
  selectedStock: null,
  stockData: null,
  searchTimer: null,
  masterData: {
    KR: null,
    US: null,
  },
};

const ui = {
  marketTabs: document.querySelector("#marketTabs"),
  searchInput: document.querySelector("#stock-search"),
  searchResults: document.querySelector("#search-results"),
  selectionSummary: document.querySelector("#selection-summary"),
  insightSummary: document.querySelector("#insightSummary"),
  metricGrid: document.querySelector("#metricGrid"),
  quarterlyTrend: document.querySelector("#quarterlyTrend"),
  notesList: document.querySelector(".notes-list"),
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

function renderMarketTabs() {
  [...ui.marketTabs.querySelectorAll(".market-tab")].forEach((button) => {
    button.classList.toggle("active", button.dataset.market === state.market);
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

function renderError(message) {
  ui.selectionSummary.innerHTML = `<strong>조회 실패</strong><small>${message}</small>`;
  ui.insightSummary.classList.remove("empty-state");
  ui.insightSummary.innerHTML = `<div class="error-card">${message}</div>`;
  ui.metricGrid.innerHTML = "";
  ui.quarterlyTrend.innerHTML = "";
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
          data-corp="${stock.corpCode ?? ""}"
          data-name="${encodeURIComponent(stock.name)}"
        >
          <strong>${stock.name} (${stock.code})</strong>
          <small>${state.market === "KR" ? "국내 주식" : "미국 주식"} · ${stock.exchange ?? "종목 선택"}</small>
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

async function ensureMasterData(market) {
  if (state.masterData[market]) return state.masterData[market];

  const data = await fetchJson(`/api/master?market=${market}`);
  state.masterData[market] = data.items ?? [];
  return state.masterData[market];
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
  const master = await ensureMasterData(state.market);
  renderSearchResults(filterMasterData(master, query), query);
}

function renderIdleSearchState() {
  ui.searchResults.innerHTML = `
    <div class="search-result">
      종목명 또는 종목코드를 입력하면 검색을 시작합니다.
      <small>입력 중에는 로컬 마스터 목록에서 바로 필터링합니다.</small>
    </div>
  `;
}

async function loadStock(code, corpCode = "", name = "") {
  setLoading("실데이터를 조회하고 있습니다...");
  try {
    const params = new URLSearchParams({
      market: state.market,
      code,
    });
    if (corpCode) params.set("corpCode", corpCode);
    if (name) params.set("name", name);

    const data = await fetchJson(`/api/stock?${params.toString()}`);
    state.selectedStock = data.stock;
    state.stockData = data;
    renderSelection(data.stock);
    renderInsightSummary(data.stock, data.history, data.summaryNote, data.sources);
    renderMetrics(data.stock, data.history);
    renderQuarterlyTrend(data.history, data.stock.metricDefinitions);
    renderNotes(data.notes);
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

  ui.marketTabs.addEventListener("click", (event) => {
    const button = event.target.closest(".market-tab");
    if (!button) return;
    state.market = button.dataset.market;
    state.selectedStock = null;
    state.stockData = null;
    ui.searchInput.value = "";
    renderMarketTabs();
    ui.selectionSummary.innerHTML = "";
    ui.metricGrid.innerHTML = "";
    ui.quarterlyTrend.innerHTML = "";
    ui.insightSummary.classList.add("empty-state");
    ui.insightSummary.textContent = "종목을 선택하면 현재 평가와 전망이 표시됩니다.";
    renderNotes([
      "검색은 정적 마스터 파일을 로컬에서 필터링해 즉시 표시합니다.",
      "국내 주식 상세 분석은 OpenDART와 시장 시세를 조합해 계산합니다.",
      "미국 주식 상세 분석은 SEC와 Alpha Vantage 데이터를 사용합니다.",
    ]);
    renderIdleSearchState();
    ensureMasterData(state.market).catch(() => {});
  });

  document.body.addEventListener("click", (event) => {
    const button = event.target.closest(".search-result[data-code]");
    if (!button) return;
    loadStock(button.dataset.code, button.dataset.corp || "", decodeURIComponent(button.dataset.name || ""));
  });
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js");
  });
}

async function boot() {
  renderMarketTabs();
  renderNotes([
    "검색은 정적 마스터 파일을 로컬에서 필터링해 즉시 표시합니다.",
    "국내 주식 상세 분석은 OpenDART와 시장 시세를 조합해 계산합니다.",
    "미국 주식 상세 분석은 SEC와 Alpha Vantage 데이터를 사용합니다.",
  ]);
  attachEvents();
  renderIdleSearchState();
  registerServiceWorker();
  await ensureMasterData("KR").catch(() => {});
}

boot();
