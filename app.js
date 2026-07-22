const DATA_API = "https://data.alpaca.markets";
const CREDENTIALS_KEY = "us-stock-iv:alpaca-credentials";
const TARGET_MONTHS = [2, 3, 4, 5, 6];
const MAX_PAGES = 16;

const els = {
  form: document.querySelector("#queryForm"),
  symbol: document.querySelector("#symbol"),
  strikePercent: document.querySelector("#strikePercent"),
  riskFreeRate: document.querySelector("#riskFreeRate"),
  dividendYield: document.querySelector("#dividendYield"),
  apiKey: document.querySelector("#apiKey"),
  apiSecret: document.querySelector("#apiSecret"),
  saveCredentials: document.querySelector("#saveCredentials"),
  clearCredentials: document.querySelector("#clearCredentials"),
  apiSettings: document.querySelector("#apiSettings"),
  loadButton: document.querySelector("#loadButton"),
  statusText: document.querySelector("#statusText"),
  resultTitle: document.querySelector("#resultTitle"),
  emptyState: document.querySelector("#emptyState"),
  results: document.querySelector("#results"),
  quoteSummary: document.querySelector("#quoteSummary"),
  resultBody: document.querySelector("#resultBody"),
  tableFootnote: document.querySelector("#tableFootnote"),
};

function loadCredentials() {
  try {
    const value = JSON.parse(sessionStorage.getItem(CREDENTIALS_KEY) || "null");
    if (value?.key && value?.secret) {
      els.apiKey.value = value.key;
      els.apiSecret.value = value.secret;
      return value;
    }
  } catch {
    sessionStorage.removeItem(CREDENTIALS_KEY);
  }
  return null;
}

function credentialsFromForm() {
  const key = els.apiKey.value.trim();
  const secret = els.apiSecret.value.trim();
  return key && secret ? { key, secret } : null;
}

function saveCredentials() {
  const credentials = credentialsFromForm();
  if (!credentials) {
    setStatus("請完整輸入 API Key ID 與 Secret Key。", true);
    els.apiSettings.open = true;
    return;
  }
  sessionStorage.setItem(CREDENTIALS_KEY, JSON.stringify(credentials));
  setStatus("API Key 已暫存於此瀏覽器分頁。", false);
}

function clearCredentials() {
  sessionStorage.removeItem(CREDENTIALS_KEY);
  els.apiKey.value = "";
  els.apiSecret.value = "";
  setStatus("API Key 已從此瀏覽器分頁清除。", false);
}

function setStatus(message, isError = false) {
  els.statusText.textContent = message;
  els.statusText.classList.toggle("error", isError);
}

function formatMoney(value) {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : "—";
}

function formatNumber(value, digits = 2) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : "—";
}

function dateIso(date) {
  return date.toISOString().slice(0, 10);
}

function addMonths(date, months) {
  const copy = new Date(date);
  const day = copy.getDate();
  copy.setDate(1);
  copy.setMonth(copy.getMonth() + months);
  copy.setDate(Math.min(day, new Date(copy.getFullYear(), copy.getMonth() + 1, 0).getDate()));
  return copy;
}

function parseOccSymbol(symbol) {
  const match = String(symbol).match(/^(.+?)(\d{6})([CP])(\d{8})$/);
  if (!match) return null;
  const [, root, datePart, type, strikePart] = match;
  const year = 2000 + Number(datePart.slice(0, 2));
  const month = Number(datePart.slice(2, 4));
  const day = Number(datePart.slice(4, 6));
  const expiry = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(expiry.getTime())) return null;
  return { root, type: type === "P" ? "put" : "call", expiry, strike: Number(strikePart) / 1000 };
}

function getSnapshotEntries(payload) {
  const snapshots = payload?.snapshots || payload?.option_snapshots || payload || {};
  return Object.entries(snapshots).map(([symbol, snapshot]) => ({ symbol, snapshot }));
}

function midpoint(quote) {
  const bid = Number(quote?.bp ?? quote?.bid_price ?? quote?.bidPrice);
  const ask = Number(quote?.ap ?? quote?.ask_price ?? quote?.askPrice);
  if (bid > 0 && ask > 0 && ask >= bid) return (bid + ask) / 2;
  return Number(quote?.ap ?? quote?.ask_price ?? quote?.askPrice ?? quote?.bp ?? quote?.bid_price ?? quote?.bidPrice) || null;
}

function directIv(snapshot) {
  const values = [
    snapshot?.implied_volatility,
    snapshot?.impliedVolatility,
    snapshot?.iv,
    snapshot?.greeks?.implied_volatility,
    snapshot?.greeks?.impliedVolatility,
  ];
  const value = values.find((item) => Number.isFinite(Number(item)) && Number(item) > 0);
  if (value == null) return null;
  const number = Number(value);
  return number > 3 ? number / 100 : number;
}

function normalCdf(x) {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-z * z);
  return 0.5 * (1 + sign * erf);
}

function blackScholesPut({ spot, strike, years, rate, dividend, volatility }) {
  if (!(spot > 0 && strike > 0 && years > 0 && volatility > 0)) return null;
  const sigmaRootT = volatility * Math.sqrt(years);
  const d1 = (Math.log(spot / strike) + (rate - dividend + (volatility * volatility) / 2) * years) / sigmaRootT;
  const d2 = d1 - sigmaRootT;
  return strike * Math.exp(-rate * years) * normalCdf(-d2) - spot * Math.exp(-dividend * years) * normalCdf(-d1);
}

function solveImpliedVolatility({ optionPrice, spot, strike, years, rate, dividend }) {
  if (!(optionPrice > 0 && spot > 0 && strike > 0 && years > 0)) return null;
  const lowerBound = Math.max(0, strike * Math.exp(-rate * years) - spot * Math.exp(-dividend * years));
  if (optionPrice < lowerBound - 0.02 || optionPrice > strike) return null;
  let low = 0.0001;
  let high = 5;
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const mid = (low + high) / 2;
    const modelPrice = blackScholesPut({ spot, strike, years, rate, dividend, volatility: mid });
    if (modelPrice == null) return null;
    if (Math.abs(modelPrice - optionPrice) < 0.0001) return mid;
    if (modelPrice > optionPrice) high = mid;
    else low = mid;
  }
  return (low + high) / 2;
}

async function apiFetch(path, credentials, query = {}) {
  const url = new URL(`${DATA_API}${path}`);
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  });
  const response = await fetch(url, {
    headers: {
      "APCA-API-KEY-ID": credentials.key,
      "APCA-API-SECRET-KEY": credentials.secret,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message || `Alpaca 回傳 ${response.status}`);
  }
  return response.json();
}

async function fetchUnderlyingPrice(symbol, credentials) {
  const payload = await apiFetch(`/v2/stocks/${encodeURIComponent(symbol)}/snapshot`, credentials, { feed: "iex" });
  const quote = payload?.latestQuote || payload?.latest_quote;
  const trade = payload?.latestTrade || payload?.latest_trade;
  return midpoint(quote) || Number(trade?.p ?? trade?.price) || Number(payload?.dailyBar?.c ?? payload?.daily_bar?.close) || null;
}

async function fetchPutChain(symbol, credentials, startDate, endDate) {
  const entries = [];
  let pageToken = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const payload = await apiFetch(`/v1beta1/options/snapshots/${encodeURIComponent(symbol)}`, credentials, {
      feed: "indicative",
      type: "put",
      expiration_date_gte: dateIso(startDate),
      expiration_date_lte: dateIso(endDate),
      limit: 1000,
      page_token: pageToken,
    });
    entries.push(...getSnapshotEntries(payload));
    pageToken = payload?.next_page_token || payload?.nextPageToken || null;
    if (!pageToken) return entries;
  }
  throw new Error("選擇權鏈過大，已停止於 16 頁；請改用流動性較高的轉換價範圍或稍後再試。");
}

function normaliseOptions(entries, spot, rate, dividend) {
  const now = new Date();
  return entries.map(({ symbol, snapshot }) => {
    const contract = parseOccSymbol(symbol);
    if (!contract || contract.type !== "put") return null;
    const quote = snapshot?.latestQuote || snapshot?.latest_quote || snapshot?.quote || {};
    const bid = Number(quote?.bp ?? quote?.bid_price ?? quote?.bidPrice) || null;
    const ask = Number(quote?.ap ?? quote?.ask_price ?? quote?.askPrice) || null;
    const mid = midpoint(quote);
    const years = Math.max((contract.expiry.getTime() - now.getTime()) / (365.25 * 24 * 60 * 60 * 1000), 0);
    const apiIv = directIv(snapshot);
    const computedIv = apiIv ? null : solveImpliedVolatility({ optionPrice: mid, spot, strike: contract.strike, years, rate, dividend });
    const delta = Number(snapshot?.greeks?.delta ?? snapshot?.delta);
    return {
      ...contract,
      symbol,
      bid,
      ask,
      mid,
      iv: apiIv || computedIv,
      ivSource: apiIv ? "API IV" : computedIv ? "模型估算" : "無法計算",
      delta: Number.isFinite(delta) ? delta : null,
      distance: Math.abs(contract.strike - spot),
    };
  }).filter((option) => option && Number.isFinite(option.iv));
}

function chooseContracts(options, targetStrike) {
  const expiryGroups = new Map();
  options.forEach((option) => {
    const key = dateIso(option.expiry);
    if (!expiryGroups.has(key)) expiryGroups.set(key, []);
    expiryGroups.get(key).push(option);
  });
  const grouped = [...expiryGroups.entries()].map(([expiry, contracts]) => ({ expiry: new Date(`${expiry}T00:00:00Z`), contracts }));
  const today = new Date();
  return TARGET_MONTHS.map((months) => {
    const targetDate = addMonths(today, months);
    const group = grouped.reduce((best, candidate) => {
      if (!best) return candidate;
      return Math.abs(candidate.expiry - targetDate) < Math.abs(best.expiry - targetDate) ? candidate : best;
    }, null);
    if (!group) return { months, targetDate, option: null };
    const option = group.contracts.reduce((best, candidate) => {
      if (!best) return candidate;
      return Math.abs(candidate.strike - targetStrike) < Math.abs(best.strike - targetStrike) ? candidate : best;
    }, null);
    return { months, targetDate, option };
  });
}

function renderResults({ symbol, spot, targetStrike, rows, rate, dividend, optionCount }) {
  els.resultTitle.textContent = `${symbol} · 2–6 個月 Put IV`;
  els.quoteSummary.innerHTML = [
    ["標的 Indicative 價格", formatMoney(spot)],
    ["FCN 目標轉換價", formatMoney(targetStrike)],
    ["無風險／股利率", `${(rate * 100).toFixed(2)}% / ${(dividend * 100).toFixed(2)}%`],
    ["可計算 Put 合約", `${optionCount.toLocaleString()} 份`],
  ].map(([label, value]) => `<div class="quote-chip"><span>${label}</span><strong>${value}</strong></div>`).join("");

  els.resultBody.innerHTML = rows.map(({ months, option }) => {
    if (!option) {
      return `<tr><td>${months} 個月</td><td colspan="6">此目標期間沒有可用的 Indicative Put IV。</td></tr>`;
    }
    const expiryText = new Intl.DateTimeFormat("zh-TW", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "UTC" }).format(option.expiry);
    return `<tr>
      <td>${months} 個月</td>
      <td>${expiryText}</td>
      <td>${formatMoney(option.strike)}</td>
      <td class="iv-value">${formatPercent(option.iv)}</td>
      <td><span class="data-tag ${option.ivSource === "API IV" ? "api" : ""}">${option.ivSource}</span></td>
      <td>${formatMoney(option.bid)} / ${formatMoney(option.ask)}</td>
      <td>${formatNumber(option.delta, 3)}</td>
    </tr>`;
  }).join("");
  els.tableFootnote.textContent = "資料來源：Alpaca Indicative option feed。模型估算 IV 採用 Put 中間價與 Black–Scholes，未納入離散股利、提前履約與發行人避險成本。";
  els.emptyState.classList.add("hidden");
  els.results.classList.remove("hidden");
}

async function loadTermStructure(event) {
  event.preventDefault();
  const credentials = credentialsFromForm() || loadCredentials();
  if (!credentials) {
    els.apiSettings.open = true;
    setStatus("請先輸入並暫存 Alpaca API Key。", true);
    return;
  }
  sessionStorage.setItem(CREDENTIALS_KEY, JSON.stringify(credentials));
  const symbol = els.symbol.value.trim().toUpperCase().replace(/[^A-Z.\-]/g, "");
  const strikePercent = Number(els.strikePercent.value);
  const rate = Number(els.riskFreeRate.value) / 100;
  const dividend = Number(els.dividendYield.value) / 100;
  if (!symbol || !(strikePercent > 0) || !(rate >= 0) || !(dividend >= 0)) {
    setStatus("請確認代碼、轉換價、利率與股利率設定。", true);
    return;
  }

  els.loadButton.disabled = true;
  els.loadButton.querySelector("span").textContent = "查詢中…";
  setStatus("正在下載 Indicative 標的價與 Put 選擇權鏈…", false);
  try {
    const today = new Date();
    const sixMonths = addMonths(today, 6);
    const [spot, entries] = await Promise.all([
      fetchUnderlyingPrice(symbol, credentials),
      fetchPutChain(symbol, credentials, today, sixMonths),
    ]);
    if (!(spot > 0)) throw new Error("無法取得標的價格，請確認代碼或 API 資料權限。");
    const options = normaliseOptions(entries, spot, rate, dividend);
    if (!options.length) throw new Error("此標的在 2 至 6 個月內沒有可計算的 Indicative Put 資料。");
    const targetStrike = spot * strikePercent / 100;
    const rows = chooseContracts(options, targetStrike);
    renderResults({ symbol, spot, targetStrike, rows, rate, dividend, optionCount: options.length });
    setStatus(`已載入 ${symbol} 的 Indicative Put 選擇權鏈。`, false);
  } catch (error) {
    console.error(error);
    setStatus(error.message || "資料載入失敗，請稍後再試。", true);
  } finally {
    els.loadButton.disabled = false;
    els.loadButton.querySelector("span").textContent = "載入期限 IV";
  }
}

els.form.addEventListener("submit", loadTermStructure);
els.saveCredentials.addEventListener("click", saveCredentials);
els.clearCredentials.addEventListener("click", clearCredentials);
loadCredentials();
