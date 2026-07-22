const TWELVE_DATA_API = "https://api.twelvedata.com/time_series";
const API_KEY_CACHE = "us-stock-iv:twelve-data-key";
const TERM_WINDOWS = [
  { months: 2, sessions: 42 },
  { months: 3, sessions: 63 },
  { months: 4, sessions: 84 },
  { months: 5, sessions: 105 },
  { months: 6, sessions: 126 },
];
const EWMA_LAMBDA = 0.94;

const els = {
  form: document.querySelector("#queryForm"),
  symbol: document.querySelector("#symbol"),
  conservativeBuffer: document.querySelector("#conservativeBuffer"),
  apiKey: document.querySelector("#apiKey"),
  loadButton: document.querySelector("#loadButton"),
  statusText: document.querySelector("#statusText"),
  resultTitle: document.querySelector("#resultTitle"),
  emptyState: document.querySelector("#emptyState"),
  results: document.querySelector("#results"),
  quoteSummary: document.querySelector("#quoteSummary"),
  resultBody: document.querySelector("#resultBody"),
  tableFootnote: document.querySelector("#tableFootnote"),
};

function setStatus(message, isError = false) {
  els.statusText.textContent = message;
  els.statusText.classList.toggle("error", isError);
}

function formatMoney(value) {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : "—";
}

function formatDate(value) {
  return new Intl.DateTimeFormat("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "UTC",
  }).format(value);
}

async function fetchDailyPrices(symbol, apiKey) {
  const url = new URL(TWELVE_DATA_API);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", "1day");
  url.searchParams.set("outputsize", "500");
  url.searchParams.set("apikey", apiKey);

  let response;
  try {
    response = await fetch(url, { cache: "no-store" });
  } catch {
    throw new Error("Twelve Data 日線來源暫時無法連線，請稍後再試。");
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.status === "error" || payload?.code) {
    throw new Error(payload?.message || `Twelve Data 回傳 ${response.status}。`);
  }
  if (!Array.isArray(payload?.values)) {
    throw new Error("找不到此美股代碼的可用日線資料。");
  }
  return payload.values.map((row) => ({
    date: new Date(`${row.datetime}T00:00:00Z`),
    close: Number(row.close),
  })).filter((row) => Number.isFinite(row.close) && row.close > 0).reverse();
}

function toLogReturns(prices) {
  const values = [];
  for (let index = 1; index < prices.length; index += 1) {
    const current = prices[index];
    const previous = prices[index - 1];
    values.push({
      date: current.date,
      value: Math.log(current.close / previous.close),
    });
  }
  return values.filter((row) => Number.isFinite(row.value));
}

function ewmaAnnualisedVolatility(returns) {
  let weightedSquares = 0;
  let totalWeight = 0;
  returns.forEach((entry, index) => {
    const age = returns.length - index - 1;
    const weight = EWMA_LAMBDA ** age;
    weightedSquares += weight * entry.value * entry.value;
    totalWeight += weight;
  });
  return Math.sqrt(weightedSquares / totalWeight) * Math.sqrt(252);
}

function downsideAnnualisedVolatility(returns) {
  const downsideVariance = returns.reduce((sum, entry) => sum + Math.min(entry.value, 0) ** 2, 0) / returns.length;
  return Math.sqrt(downsideVariance) * Math.sqrt(252);
}

function calculateMetrics(returns, buffer) {
  const ewma = ewmaAnnualisedVolatility(returns);
  const downside = downsideAnnualisedVolatility(returns);
  const maxDailyDrop = Math.expm1(Math.min(...returns.map((entry) => entry.value)));
  const conservative = Math.max(ewma, downside) * (1 + buffer);
  return { ewma, downside, maxDailyDrop, conservative };
}

function renderResults({ symbol, prices, rows, buffer }) {
  const latest = prices.at(-1);
  els.resultTitle.textContent = `${symbol} · FCN 波動率代理值`;
  els.quoteSummary.innerHTML = [
    ["最近收盤價", formatMoney(latest.close)],
    ["資料日期", formatDate(latest.date)],
    ["日線樣本", `${prices.length.toLocaleString()} 日`],
    ["保守加成", `${(buffer * 100).toFixed(0)}%`],
  ].map(([label, value]) => `<div class="quote-chip"><span>${label}</span><strong>${value}</strong></div>`).join("");

  els.resultBody.innerHTML = rows.map(({ months, sessions, metrics }) => {
    const expectedMove = metrics.conservative * Math.sqrt(sessions / 252);
    return `<tr>
      <td>${months} 個月</td>
      <td>${sessions} 日</td>
      <td>${formatPercent(metrics.ewma)}</td>
      <td>${formatPercent(metrics.downside)}</td>
      <td>${formatPercent(metrics.maxDailyDrop)}</td>
      <td class="iv-value">${formatPercent(metrics.conservative)}</td>
      <td>${formatPercent(expectedMove)}</td>
    </tr>`;
  }).join("");
  els.tableFootnote.textContent = `FCN 保守代理值 = max(EWMA 年化波動、下跌年化波動) × (1 + ${(buffer * 100).toFixed(0)}%)。期限 1σ 預期波動以代理值 × √(交易日 ÷ 252) 計算；它不是選擇權 IV，也不是票息估算。`;
  els.emptyState.classList.add("hidden");
  els.results.classList.remove("hidden");
}

async function loadVolatility(event) {
  event.preventDefault();
  const symbol = els.symbol.value.trim().toUpperCase().replace(/[^A-Z.\-]/g, "");
  const buffer = Number(els.conservativeBuffer.value) / 100;
  const apiKey = els.apiKey.value.trim();
  if (!symbol || !(buffer >= 0)) {
    setStatus("請確認美股代碼與保守加成設定。", true);
    return;
  }
  if (!apiKey) {
    setStatus("請先貼上 Twelve Data 的免費 API Key。", true);
    els.apiKey.focus();
    return;
  }

  sessionStorage.setItem(API_KEY_CACHE, apiKey);
  els.loadButton.disabled = true;
  els.loadButton.querySelector("span").textContent = "載入中…";
  setStatus("正在下載免費日線資料並計算期限波動率…", false);
  try {
    const prices = await fetchDailyPrices(symbol, apiKey);
    const returns = toLogReturns(prices);
    if (returns.length < TERM_WINDOWS.at(-1).sessions) {
      throw new Error("可用日線資料不足 126 個交易日，無法計算完整 2 至 6 個月期限。");
    }
    const rows = TERM_WINDOWS.map(({ months, sessions }) => ({
      months,
      sessions,
      metrics: calculateMetrics(returns.slice(-sessions), buffer),
    }));
    renderResults({ symbol, prices, rows, buffer });
    setStatus(`已載入 ${symbol} 的免費日線波動率資料。`, false);
  } catch (error) {
    console.error(error);
    setStatus(error.message || "資料載入失敗，請稍後再試。", true);
  } finally {
    els.loadButton.disabled = false;
    els.loadButton.querySelector("span").textContent = "載入波動率";
  }
}

els.apiKey.value = sessionStorage.getItem(API_KEY_CACHE) || "";
els.form.addEventListener("submit", loadVolatility);
