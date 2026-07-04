const state = {
  meta: null,
  rates: [],
  ratesLoaded: false,
  ratesPromise: null,
  dashboard: null,
  indexMeta: null,
  observations: [],
  indexLoaded: false,
  indexPromise: null,
  dashboardApiMs: null,
  months: 24,
  colors: ["#b7ff2a", "#7fb3ff", "#f7b041", "#53d769", "#b8c3d1", "#a78bfa", "#ff6b8a", "#7dd3fc", "#f2f4f8", "#34d399"]
};

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value = "") => String(value).replace(/[&<>"']/g, (char) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&#39;"
})[char]);
const money = (value) => `$${Number(value).toFixed(2)}`;
const shortDate = (date) => new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "2-digit",
  timeZone: "UTC"
}).format(new Date(date));
const fullDate = (date) => new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC"
}).format(new Date(date));
const fullDateTime = (date) => new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short"
}).format(new Date(date));
const GROUPS = {
  "last-released": ["B200", "B300", "MI300X", "RTX 5090", "GB200", "GB300"],
  modern: ["H100", "H200", "GH200", "A100", "L40S", "L40", "L4", "A10", "RTX 4090"],
  legacy: ["V100", "P100", "T4"]
};
const groupLabels = { modern: "Modern", "last-released": "Latest", legacy: "Legacy", other: "Other" };
const DAY_MS = 24 * 60 * 60 * 1000;
const LOOKBACKS = [
  { key: "day", label: "1D", days: 1 },
  { key: "week", label: "7D", days: 7 },
  { key: "month", label: "30D", days: 30 },
  { key: "quarter", label: "Q", days: 90 },
  { key: "year", label: "Y", days: 365 }
];
const REGION_GROUPS = ["North America", "Europe", "Asia Pacific", "Middle East & Africa", "South America", "Global / Other"];
const GPU_PRIORITY = ["H100", "H200", "B200", "B300", "GB200", "GB300", "GH200", "MI300X", "A100", "L40S", "L40", "L4", "A10", "RTX 5090", "RTX 4090", "T4", "V100", "P100"];

function groupForGpu(gpuModel) {
  return Object.entries(GROUPS).find(([, models]) => models.includes(gpuModel))?.[0] || "other";
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).toSorted((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted.length % 2
    ? sorted[Math.floor(sorted.length / 2)]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
}

function average(values) {
  const valid = values.filter((value) => Number.isFinite(value));
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function pctChange(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

function percent(value) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function formatMaybe(value, formatter) {
  return Number.isFinite(value) ? formatter(value) : "n/a";
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "n/a";
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 1 : 2)}s`;
  return `${Math.round(ms)}ms`;
}

function setLoadTime(text) {
  const el = $("#loadTime");
  if (el) el.textContent = text;
}

function reportLoadTime() {
  requestAnimationFrame(() => {
    const totalMs = performance.now();
    const apiMs = state.dashboardApiMs;
    setLoadTime(`${formatDuration(totalMs)} load / ${formatDuration(apiMs)} API`);
  });
}

function observedTime(row) {
  return new Date(row.observedAt).getTime();
}

function rateKey(row) {
  return [row.provider, row.gpuModel, row.gpuVariant || "", row.region, row.commitment].join("|");
}

function priceValue(row) {
  return Number(row.pricePerGpuHour);
}

function groupBy(values, keyFn) {
  const groups = new Map();
  for (const value of values) {
    const key = keyFn(value);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(value);
  }
  return groups;
}

function priorityIndex(gpuModel) {
  const index = GPU_PRIORITY.indexOf(gpuModel);
  return index === -1 ? GPU_PRIORITY.length : index;
}

function latestPriceTimestamp() {
  if (!state.ratesLoaded) return state.dashboard?.freshness?.latestPricePull || null;
  const validRows = state.rates.filter((row) => Number.isFinite(new Date(row.observedAt).getTime()));
  const liveRows = validRows.filter((row) => row.sourceKind === "live");
  const sourceRows = liveRows.length ? liveRows : validRows.filter((row) => row.sourceKind !== "benchmark-seed");
  const rows = sourceRows.length ? sourceRows : validRows;
  return rows.toSorted((a, b) => new Date(b.observedAt) - new Date(a.observedAt))[0]?.observedAt || null;
}

function commitmentLabel(value = "") {
  return value
    .replaceAll("-", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function aggregationText(value) {
  return (value || "median-of-provider-medians").replaceAll("-", " ");
}

async function request(url, options = {}) {
  const { timeoutMs = 30_000, headers = {}, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
      headers: { "content-type": "application/json", ...headers }
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Request failed");
    return data;
  } catch (error) {
    if (error.name === "AbortError") throw new Error(`${url} timed out after ${formatDuration(timeoutMs)}`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 4200);
}

async function load() {
  const apiStartedAt = performance.now();
  const dashboard = await request("/api/dashboard");
  state.dashboardApiMs = performance.now() - apiStartedAt;
  state.meta = dashboard.meta;
  state.dashboard = dashboard.dashboard;
  state.rates = [];
  state.ratesLoaded = false;
  state.indexMeta = dashboard.index.metadata;
  state.observations = dashboard.index.observations || [];
  state.indexLoaded = Boolean(dashboard.index.observations?.length);
  populateControls();
  render();
  reportLoadTime();
}

function showLoadError(error) {
  setLoadTime(`Load failed after ${formatDuration(performance.now())}`);
  $("#freshness").textContent = "Dashboard data unavailable";
  $("#chart").innerHTML = `<div class="empty">Dashboard data did not load. ${escapeHtml(error.message)}</div>`;
  $("#movementTable").innerHTML = `<div class="empty compact-empty">No data loaded.</div>`;
  $("#regionHeatmap").innerHTML = `<div class="empty compact-empty">No data loaded.</div>`;
  $("#topMovers").innerHTML = `<div class="empty compact-empty">No data loaded.</div>`;
  $("#cheapestRegions").innerHTML = `<div class="empty compact-empty">No data loaded.</div>`;
  $("#providerSpread").innerHTML = `<div class="empty compact-empty">No data loaded.</div>`;
  $("#commitmentDiscounts").innerHTML = `<div class="empty compact-empty">No data loaded.</div>`;
  $("#ratesTable").innerHTML = `<tr><td colspan="6">No data loaded.</td></tr>`;
}

async function ensureDashboardRates() {
  if (state.ratesLoaded) return state.rates;
  if (!state.ratesPromise) {
    state.ratesPromise = request("/api/dashboard-rates").then((rates) => {
      state.rates = rates;
      state.ratesLoaded = true;
      state.ratesPromise = null;
      render();
      return rates;
    }).catch((error) => {
      state.ratesPromise = null;
      throw error;
    });
  }
  return state.ratesPromise;
}

async function ensureModelIndex() {
  if (state.indexLoaded) return state.observations;
  if (!state.indexPromise) {
    state.indexPromise = request("/api/model-index").then((index) => {
      state.indexMeta = index.metadata;
      state.observations = index.observations;
      state.indexLoaded = true;
      state.indexPromise = null;
      render();
      return state.observations;
    }).catch((error) => {
      state.indexPromise = null;
      throw error;
    });
  }
  return state.indexPromise;
}

function populateControls() {
  const gpuCount = state.meta.gpus?.length || state.dashboard?.hero?.gpus || new Set(state.rates.map((row) => row.gpuModel)).size;
  const cohorts = [
    ["all", `All ${gpuCount} GPU models`],
    ["modern", "Modern · H100, H200, A100, L40S, RTX 4090"],
    ["last-released", "Latest · B200, B300, MI300X, RTX 5090"],
    ["legacy", "Legacy · V100, T4, P100"],
    ["other", "Other collected GPUs"]
  ];
  const gpu = $("#gpuFilter");
  const current = gpu.value || "all";
  gpu.innerHTML = cohorts.map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
  gpu.value = current;

  const provider = $("#providerFilter");
  const providerCurrent = provider.value || "all";
  const providerNames = [...new Set([
    ...state.meta.providers.map((row) => row.provider),
    ...state.meta.catalog.map((row) => row.name)
  ])].toSorted((a, b) => a.localeCompare(b));
  provider.innerHTML = `<option value="all">All providers</option>${providerNames
    .map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`)
    .join("")}`;
  provider.value = [...provider.options].some((option) => option.value === providerCurrent) ? providerCurrent : "all";

  const region = $("#regionFilter");
  const regionCurrent = region.value || "all";
  region.innerHTML = `<option value="all">All regions</option>${state.meta.regions
    .map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`)
    .join("")}`;
  region.value = [...region.options].some((option) => option.value === regionCurrent) ? regionCurrent : "all";

  const commitment = $("#commitmentFilter");
  const commitmentCurrent = commitment.value || "all";
  commitment.innerHTML = `<option value="all">All rate types</option>${state.meta.commitments
    .map((value) => `<option value="${escapeHtml(value)}">${commitmentLabel(value)}</option>`)
    .join("")}`;
  commitment.value = [...commitment.options].some((option) => option.value === commitmentCurrent) ? commitmentCurrent : "all";

  const latestPricePull = latestPriceTimestamp();
  $("#freshness").textContent = latestPricePull
    ? `Prices pulled ${fullDateTime(latestPricePull)}`
    : `Index updated ${fullDate(state.indexMeta.publishedAt)} · ${state.indexMeta.observationCount} monthly points`;
}

function filteredObservations() {
  const dataset = $("#datasetFilter").value;
  const cohort = $("#gpuFilter").value;
  const cutoff = state.months
    ? new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - state.months, 1))
    : new Date(0);
  const observations = dataset === "direct" ? directIndexObservations() : state.observations;
  $("#providerFilter").disabled = dataset !== "direct";
  $("#regionFilter").disabled = dataset !== "direct";
  $("#commitmentFilter").disabled = dataset !== "direct";
  return observations.filter((row) =>
    (cohort === "all" || row.group === cohort) &&
    new Date(row.observedAt) >= cutoff
  );
}

function filteredDirectRates() {
  const provider = $("#providerFilter").value;
  const region = $("#regionFilter").value;
  const commitment = $("#commitmentFilter").value;
  return state.rates.filter((row) =>
    (provider === "all" || row.provider === provider) &&
    (region === "all" || row.region === region) &&
    (commitment === "all" || row.commitment === commitment)
  );
}

function matchesSelectedCohort(row) {
  const cohort = $("#gpuFilter").value;
  return cohort === "all" || groupForGpu(row.gpuModel) === cohort;
}

function directPanelRates({ ignoreCommitment = false } = {}) {
  const dataset = $("#datasetFilter").value;
  const applyDirectFilters = dataset === "direct";
  const provider = $("#providerFilter").value;
  const region = $("#regionFilter").value;
  const commitment = $("#commitmentFilter").value;
  return state.rates.filter((row) =>
    Number.isFinite(priceValue(row)) &&
    matchesSelectedCohort(row) &&
    (!applyDirectFilters || provider === "all" || row.provider === provider) &&
    (!applyDirectFilters || region === "all" || row.region === region) &&
    (ignoreCommitment || !applyDirectFilters || commitment === "all" || row.commitment === commitment)
  );
}

function comparableRates(rates) {
  const selected = $("#datasetFilter").value === "direct" ? $("#commitmentFilter").value : "all";
  const commitment = selected === "all" ? "on-demand" : selected;
  return rates.filter((row) => row.commitment === commitment);
}

function latestRateMap(rates, cutoff = Infinity) {
  const latest = new Map();
  for (const row of rates) {
    const time = observedTime(row);
    if (!Number.isFinite(time) || time > cutoff) continue;
    const key = rateKey(row);
    const current = latest.get(key);
    if (!current || time > observedTime(current)) latest.set(key, row);
  }
  return latest;
}

function matchedComparison(currentRows, allRates, cutoff) {
  const previousByKey = latestRateMap(allRates, cutoff);
  const pairs = currentRows
    .map((row) => ({ current: row, previous: previousByKey.get(rateKey(row)) }))
    .filter((pair) => pair.previous);
  if (!pairs.length) return null;
  const currentAverage = average(pairs.map((pair) => priceValue(pair.current)));
  const previousAverage = average(pairs.map((pair) => priceValue(pair.previous)));
  return { change: pctChange(currentAverage, previousAverage), matched: pairs.length };
}

function previousRateMap(currentRows, allRates) {
  const currentTimes = new Map(currentRows.map((row) => [rateKey(row), observedTime(row)]));
  const previous = new Map();
  for (const row of allRates) {
    const key = rateKey(row);
    if (!currentTimes.has(key)) continue;
    const time = observedTime(row);
    if (!Number.isFinite(time) || time >= currentTimes.get(key)) continue;
    const existing = previous.get(key);
    if (!existing || time > existing.time) previous.set(key, { row, time });
  }
  return new Map([...previous.entries()].map(([key, value]) => [key, value.row]));
}

function regionGroup(region = "") {
  const value = region.toLowerCase();
  if (value === "global" || value === "north america") return value === "global" ? "Global / Other" : "North America";
  if (/^(us|ca|mx)-/.test(value) || value.includes("canada") || value.includes("eastus") || value.includes("westus") ||
      value.includes("centralus") || value.includes("southcentralus") || value.includes("northcentralus") ||
      value.includes("usgov") || value.includes("northamerica") || value.includes("mexico")) {
    return "North America";
  }
  if (/^(eu|europe)-/.test(value) || value.includes("europe") || value.includes("northeurope") || value.includes("westeurope") ||
      value.includes("uk") || value.includes("france") || value.includes("germany") || value.includes("norway") ||
      value.includes("poland") || value.includes("spain") || value.includes("sweden") || value.includes("switzerland") ||
      value.includes("italy")) {
    return "Europe";
  }
  if (/^(ap|asia|australia)-/.test(value) || value.includes("eastasia") || value.includes("southeastasia") ||
      value.includes("japan") || value.includes("korea") || value.includes("india") || value.includes("indonesia") ||
      value.includes("malaysia") || value.includes("australia") || value.includes("jioindia")) {
    return "Asia Pacific";
  }
  if (/^(me|africa)-/.test(value) || value.includes("uae") || value.includes("qatar") || value.includes("israel") ||
      value.includes("southafrica")) {
    return "Middle East & Africa";
  }
  if (/^(sa|southamerica)-/.test(value) || value.includes("brazil")) return "South America";
  return "Global / Other";
}

function directIndexObservations() {
  const groups = new Map();
  for (const row of filteredDirectRates()) {
    if (!Number.isFinite(Number(row.pricePerGpuHour))) continue;
    const month = monthKey(row.observedAt);
    const key = `${month}|${row.gpuModel}`;
    const group = groups.get(key) || {
      month,
      gpuModel: row.gpuModel,
      providerPrices: new Map(),
      sourceUrls: new Set(),
      regions: new Set(),
      commitments: new Set(),
      rows: 0
    };
    const providerRows = group.providerPrices.get(row.provider) || [];
    providerRows.push(Number(row.pricePerGpuHour));
    group.providerPrices.set(row.provider, providerRows);
    group.sourceUrls.add(row.sourceUrl);
    group.regions.add(row.region);
    group.commitments.add(row.commitment);
    group.rows += 1;
    groups.set(key, group);
  }

  return [...groups.values()].flatMap((group) => {
    const providerMedians = [...group.providerPrices.values()].map(median).filter((value) => value != null);
    const price = median(providerMedians);
    if (price == null) return [];
    const providerCount = group.providerPrices.size;
    const commitment = group.commitments.size === 1 ? [...group.commitments][0] : "mixed";
    return [{
      observedAt: `${group.month}-01T00:00:00.000Z`,
      gpuModel: group.gpuModel,
      group: groupForGpu(group.gpuModel),
      pricePerGpuHour: price,
      currency: "USD",
      aggregation: "median-of-provider-medians",
      billingType: commitment,
      sourceName: "Collected Source Index",
      sourceUrl: [...group.sourceUrls][0] || "",
      directObservationCount: group.rows,
      providerCount,
      regionCount: group.regions.size,
      commitment
    }];
  }).toSorted((a, b) =>
    new Date(a.observedAt) - new Date(b.observedAt) ||
    a.gpuModel.localeCompare(b.gpuModel)
  );
}

function latestByModel(rows) {
  const latest = new Map();
  for (const row of rows) {
    const existing = latest.get(row.gpuModel);
    if (!existing || new Date(row.observedAt) > new Date(existing.observedAt)) latest.set(row.gpuModel, row);
  }
  return [...latest.values()];
}

function monthKey(date) {
  return new Date(date).toISOString().slice(0, 7);
}

function monthBounds(date) {
  const observed = new Date(date);
  const start = new Date(Date.UTC(observed.getUTCFullYear(), observed.getUTCMonth(), 1));
  const end = new Date(Date.UTC(observed.getUTCFullYear(), observed.getUTCMonth() + 1, 1) - 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

async function directObservationsFor(indexRow) {
  const selectedMonth = monthKey(indexRow.observedAt);
  const { from, to } = monthBounds(indexRow.observedAt);
  const params = new URLSearchParams({ gpu: indexRow.gpuModel, from, to });
  const provider = $("#providerFilter").value;
  const region = $("#regionFilter").value;
  const commitment = $("#commitmentFilter").value;
  if (provider !== "all") params.set("provider", provider);
  if (region !== "all") params.set("region", region);
  if (commitment !== "all") params.set("commitment", commitment);
  const rows = await request(`/api/rates?${params}`);
  return rows.filter((row) =>
    row.gpuModel === indexRow.gpuModel &&
    monthKey(row.observedAt) === selectedMonth
  ).toSorted((a, b) => a.provider.localeCompare(b.provider) || a.pricePerGpuHour - b.pricePerGpuHour);
}

function providerSummaryFor(rows) {
  const providers = new Map();
  for (const row of rows) {
    const current = providers.get(row.provider) || {
      provider: row.provider,
      providerType: row.providerType,
      observations: 0,
      sourceKinds: new Set(),
      latestObservation: row.observedAt
    };
    current.observations += 1;
    current.sourceKinds.add(row.sourceKind);
    if (new Date(row.observedAt) > new Date(current.latestObservation)) current.latestObservation = row.observedAt;
    providers.set(row.provider, current);
  }
  return [...providers.values()].toSorted((a, b) => a.provider.localeCompare(b.provider));
}

function sourceCard({ name, type, meta, href }) {
  return `<div class="source-card">
    <div class="source-top"><span class="source-name">${escapeHtml(name)}</span><span class="badge">${escapeHtml(type)}</span></div>
    <div class="source-meta">${meta}</div>
    ${href ? `<a class="source-link" href="${escapeHtml(href)}" target="_blank" rel="noopener">Open source</a>` : ""}
  </div>`;
}

async function showSourceDetails(indexRow) {
  const dialog = $("#sourceDialog");
  $("#sourceDialogTitle").textContent = `${indexRow.gpuModel} · ${shortDate(indexRow.observedAt)}`;
  const aggregateMeta = indexRow.directObservationCount
    ? `${money(indexRow.pricePerGpuHour)} / GPU-hour<br>${indexRow.directObservationCount} direct point${indexRow.directObservationCount === 1 ? "" : "s"} · ${indexRow.providerCount} provider${indexRow.providerCount === 1 ? "" : "s"} · ${indexRow.regionCount} region${indexRow.regionCount === 1 ? "" : "s"}`
    : `${money(indexRow.pricePerGpuHour)} / GPU-hour<br>${escapeHtml(aggregationText(indexRow.aggregation))}`;

  const aggregateCard = sourceCard({
    name: indexRow.sourceName || "Collected Source Index",
    type: "aggregate",
    href: indexRow.sourceUrl,
    meta: aggregateMeta
  });

  const renderBody = (directRows, error) => {
    const directProviders = directRows ? providerSummaryFor(directRows) : [];
    const directSourceCards = directProviders.map((provider) => sourceCard({
      name: provider.provider,
      type: provider.providerType,
      meta: `${provider.observations} direct data point${provider.observations === 1 ? "" : "s"}<br>${escapeHtml([...provider.sourceKinds].join(", "))} · latest ${shortDate(provider.latestObservation)}`
    })).join("");
    const sourceList = error
      ? `<div class="empty-source">${escapeHtml(error.message)}</div>`
      : directRows == null
        ? `<div class="empty-source">Loading direct provider rows...</div>`
        : directSourceCards || `<div class="empty-source">No direct provider observations have been collected for this GPU and month yet.</div>`;

    const directTable = error
      ? `<div class="empty-source">${escapeHtml(error.message)}</div>`
      : directRows == null
        ? `<div class="empty-source">Loading direct data points...</div>`
        : directRows.length ? `<div class="table-wrap">
          <table>
            <thead><tr><th>Provider</th><th>Type</th><th>Observed</th><th>Region</th><th>Rate type</th><th>Rate</th><th>Kind</th><th>Source</th></tr></thead>
            <tbody>${directRows.map((row) => `<tr>
              <td><strong>${escapeHtml(row.provider)}</strong></td>
              <td>${escapeHtml(row.providerType)}</td>
              <td>${fullDate(row.observedAt)}</td>
              <td>${escapeHtml(row.region)}</td>
              <td>${escapeHtml(commitmentLabel(row.commitment))}</td>
              <td class="rate">${money(row.pricePerGpuHour)}</td>
              <td>${escapeHtml(row.sourceKind)}</td>
              <td><a href="${escapeHtml(row.sourceUrl)}" target="_blank" rel="noopener">Open</a></td>
            </tr>`).join("")}</tbody>
          </table>
        </div>` : `<div class="empty-source">Daily collection or archive imports will add direct provider rows for this month.</div>`;

    return `
      <section class="dialog-section">
        <h3>Index data point</h3>
        <div class="selected-point">
          <span>${escapeHtml(indexRow.gpuModel)}</span>
          <strong>${money(indexRow.pricePerGpuHour)}</strong>
          <span>${fullDate(indexRow.observedAt)}</span>
        </div>
        <div class="sources compact">${aggregateCard}</div>
      </section>
      <section class="dialog-section">
        <h3>Direct sources for the same GPU and month</h3>
        <div class="sources compact">${sourceList}</div>
      </section>
      <section class="dialog-section">
        <h3>Direct data points</h3>
        ${directTable}
      </section>
    `;
  };

  $("#sourceDialogBody").innerHTML = renderBody(null);
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  try {
    $("#sourceDialogBody").innerHTML = renderBody(await directObservationsFor(indexRow));
  } catch (error) {
    $("#sourceDialogBody").innerHTML = renderBody([], error);
  }
}

function buildVisualData() {
  const comparableHistory = comparableRates(directPanelRates());
  const currentRows = [...latestRateMap(comparableHistory).values()];
  const allCommitments = directPanelRates({ ignoreCommitment: true });
  return { comparableHistory, currentRows, allCommitments };
}

function movementRows(currentRows, allRates) {
  const generatedTime = Math.max(Date.now(), ...currentRows.map(observedTime).filter(Number.isFinite));
  return [...groupBy(currentRows, (row) => row.gpuModel).entries()].map(([gpuModel, rows]) => {
    const comparisons = Object.fromEntries(LOOKBACKS.map((lookback) => [
      lookback.key,
      matchedComparison(rows, allRates, generatedTime - lookback.days * DAY_MS)
    ]));
    return {
      gpuModel,
      averagePrice: average(rows.map(priceValue)),
      observations: rows.length,
      providerCount: new Set(rows.map((row) => row.provider)).size,
      regionCount: new Set(rows.map((row) => row.region)).size,
      comparisons
    };
  }).toSorted((a, b) =>
    priorityIndex(a.gpuModel) - priorityIndex(b.gpuModel) ||
    b.observations - a.observations ||
    a.gpuModel.localeCompare(b.gpuModel)
  );
}

function topMoverRows(currentRows, allRates) {
  const previousByKey = previousRateMap(currentRows, allRates);
  return currentRows.map((row) => {
    const previous = previousByKey.get(rateKey(row));
    const delta = previous ? priceValue(row) - priceValue(previous) : null;
    const deltaPercent = previous ? pctChange(priceValue(row), priceValue(previous)) : null;
    return { ...row, previous, delta, deltaPercent };
  }).filter((row) => Number.isFinite(row.deltaPercent))
    .toSorted((a, b) => Math.abs(b.deltaPercent) - Math.abs(a.deltaPercent))
    .slice(0, 8);
}

function regionalHeatmapRows(currentRows) {
  const gpuRows = [...groupBy(currentRows, (row) => row.gpuModel).entries()]
    .toSorted((a, b) => priorityIndex(a[0]) - priorityIndex(b[0]) || a[0].localeCompare(b[0]))
    .slice(0, 8);

  return gpuRows.map(([gpuModel, rows]) => {
    const modelMedian = median(rows.map(priceValue));
    const cells = Object.fromEntries(REGION_GROUPS.map((group) => {
      const groupAverage = average(rows
        .filter((row) => regionGroup(row.region) === group)
        .map(priceValue));
      return [group, {
        averagePrice: groupAverage,
        relativeToMedian: Number.isFinite(modelMedian) && Number.isFinite(groupAverage)
          ? groupAverage / modelMedian
          : null
      }];
    }));
    return { gpuModel, cells };
  });
}

function cheapestRegionRows(currentRows) {
  return [...groupBy(currentRows, (row) => row.gpuModel).entries()]
    .map(([gpuModel, rows]) => {
      const bestByRegion = new Map();
      for (const row of rows) {
        const key = row.region;
        const current = bestByRegion.get(key);
        if (!current || priceValue(row) < priceValue(current)) bestByRegion.set(key, row);
      }
      return {
        gpuModel,
        picks: [...bestByRegion.values()].toSorted((a, b) => priceValue(a) - priceValue(b)).slice(0, 3)
      };
    })
    .filter((row) => row.picks.length)
    .toSorted((a, b) => priorityIndex(a.gpuModel) - priorityIndex(b.gpuModel) || a.gpuModel.localeCompare(b.gpuModel))
    .slice(0, 7);
}

function providerSpreadRows(currentRows) {
  return [...groupBy(currentRows, (row) => row.gpuModel).entries()]
    .map(([gpuModel, rows]) => {
      const providers = [...groupBy(rows, (row) => row.provider).entries()]
        .map(([provider, providerRows]) => ({
          provider,
          medianPrice: median(providerRows.map(priceValue))
        }))
        .filter((row) => Number.isFinite(row.medianPrice))
        .toSorted((a, b) => a.medianPrice - b.medianPrice);
      const low = providers[0];
      const high = providers.at(-1);
      return {
        gpuModel,
        providers,
        low,
        high,
        rangePercent: low && high ? pctChange(high.medianPrice, low.medianPrice) : null
      };
    })
    .filter((row) => row.providers.length >= 2)
    .toSorted((a, b) =>
      Math.abs(b.rangePercent || 0) - Math.abs(a.rangePercent || 0) ||
      priorityIndex(a.gpuModel) - priorityIndex(b.gpuModel)
    )
    .slice(0, 7);
}

function commitmentDiscountRows(allRows) {
  const latestRows = [...latestRateMap(allRows).values()];
  return [...groupBy(latestRows, (row) => row.gpuModel).entries()]
    .map(([gpuModel, rows]) => {
      const onDemand = median(rows.filter((row) => row.commitment === "on-demand").map(priceValue));
      const bestCommitted = rows
        .filter((row) => row.commitment !== "on-demand")
        .toSorted((a, b) => priceValue(a) - priceValue(b))[0];
      const discount = bestCommitted && Number.isFinite(onDemand)
        ? (1 - priceValue(bestCommitted) / onDemand) * 100
        : null;
      return { gpuModel, onDemand, bestCommitted, discount };
    })
    .filter((row) => row.bestCommitted && Number.isFinite(row.discount))
    .toSorted((a, b) => b.discount - a.discount || priorityIndex(a.gpuModel) - priorityIndex(b.gpuModel))
    .slice(0, 7);
}

function changeClass(value) {
  if (!Number.isFinite(value)) return "neutral";
  if (value < -1) return "down";
  if (value > 1) return "up";
  return "flat";
}

function heatClass(ratio) {
  if (!Number.isFinite(ratio)) return "empty";
  if (ratio <= 0.85) return "cheap-2";
  if (ratio <= 0.95) return "cheap-1";
  if (ratio <= 1.05) return "mid";
  if (ratio <= 1.15) return "hot-1";
  return "hot-2";
}

function renderHeroMetrics() {
  const rows = directPanelRates({ ignoreCommitment: true });
  $("#heroRows").textContent = rows.length.toLocaleString();
  $("#heroGpus").textContent = new Set(rows.map((row) => row.gpuModel)).size.toLocaleString();
  $("#heroRegions").textContent = new Set(rows.map((row) => row.region)).size.toLocaleString();
  $("#heroSources").textContent = new Set(rows.map((row) => row.provider)).size.toLocaleString();
}

function renderHeroMetricsSummary(hero) {
  $("#heroRows").textContent = Number(hero?.observations || 0).toLocaleString();
  $("#heroGpus").textContent = Number(hero?.gpus || 0).toLocaleString();
  $("#heroRegions").textContent = Number(hero?.regions || 0).toLocaleString();
  $("#heroSources").textContent = Number(hero?.sources || 0).toLocaleString();
}

function renderMovementMatrix(rows) {
  $("#movementTable").innerHTML = rows.length ? `<div class="table-wrap tight-table">
    <table>
      <thead>
        <tr>
          <th>GPU</th>
          <th>Avg</th>
          <th>Rows</th>
          <th>Sources</th>
          ${LOOKBACKS.map((lookback) => `<th>${lookback.label}</th>`).join("")}
        </tr>
      </thead>
      <tbody>${rows.map((row) => `<tr>
        <td><strong>${escapeHtml(row.gpuModel)}</strong></td>
        <td class="rate">${formatMaybe(row.averagePrice, money)}</td>
        <td>${row.observations}</td>
        <td>${row.providerCount}</td>
        ${LOOKBACKS.map((lookback) => {
          const change = row.comparisons[lookback.key]?.change;
          return `<td><span class="delta ${changeClass(change)}">${formatMaybe(change, percent)}</span></td>`;
        }).join("")}
      </tr>`).join("")}</tbody>
    </table>
  </div>` : `<div class="empty compact-empty">No comparable direct-rate rows match these filters.</div>`;
}

function renderRegionHeatmap(rows) {
  $("#regionHeatmap").innerHTML = rows.length ? `<div class="heatmap-grid">
    <div class="heatmap-head">GPU</div>
    ${REGION_GROUPS.map((group) => `<div class="heatmap-head">${escapeHtml(group)}</div>`).join("")}
    ${rows.map((row) => `
      <div class="heatmap-gpu">${escapeHtml(row.gpuModel)}</div>
      ${REGION_GROUPS.map((group) => {
        const cell = row.cells[group];
        return `<div class="heat-cell ${heatClass(cell.relativeToMedian)}" title="${escapeHtml(group)}">${formatMaybe(cell.averagePrice, money)}</div>`;
      }).join("")}
    `).join("")}
  </div>` : `<div class="empty compact-empty">No regional rates match these filters.</div>`;
}

function renderTopMovers(rows) {
  $("#topMovers").innerHTML = rows.length ? rows.map((row) => `<div class="mover-row ${changeClass(row.deltaPercent)}">
    <div>
      <strong>${escapeHtml(row.gpuModel)}</strong>
      <span>${escapeHtml(row.provider)} · ${escapeHtml(row.region)}</span>
    </div>
    <div class="mover-rate">
      <span>${money(row.previous.pricePerGpuHour)} -> ${money(row.pricePerGpuHour)}</span>
      <strong>${percent(row.deltaPercent)}</strong>
    </div>
  </div>`).join("") : `<div class="empty compact-empty">No matched changes yet for the current filter set.</div>`;
}

function renderCheapestRegions(rows) {
  $("#cheapestRegions").innerHTML = rows.length ? rows.map((row) => `<div class="cheap-row">
    <strong>${escapeHtml(row.gpuModel)}</strong>
    <div class="cheap-pills">
      ${row.picks.map((pick) => `<span>
        <b>${escapeHtml(pick.region)}</b>
        ${money(pick.pricePerGpuHour)}
        <small>${escapeHtml(pick.provider)}</small>
      </span>`).join("")}
    </div>
  </div>`).join("") : `<div class="empty compact-empty">No cheapest-region view available for these filters.</div>`;
}

function renderProviderSpread(rows) {
  const maxRange = Math.max(1, ...rows.map((row) => Math.abs(row.rangePercent || 0)));
  $("#providerSpread").innerHTML = rows.length ? rows.map((row) => {
    const width = Math.max(8, Math.min(100, Math.abs(row.rangePercent || 0) / maxRange * 100));
    return `<div class="spread-row">
      <div class="spread-top">
        <strong>${escapeHtml(row.gpuModel)}</strong>
        <span>${money(row.low.medianPrice)} - ${money(row.high.medianPrice)}</span>
      </div>
      <div class="spread-track"><i style="width:${width}%"></i></div>
      <small>${escapeHtml(row.low.provider)} low · ${escapeHtml(row.high.provider)} high · ${row.providers.length} providers</small>
    </div>`;
  }).join("") : `<div class="empty compact-empty">At least two providers are needed for a spread.</div>`;
}

function renderCommitmentDiscounts(rows) {
  $("#commitmentDiscounts").innerHTML = rows.length ? rows.map((row) => {
    const width = Math.max(6, Math.min(100, Math.abs(row.discount)));
    const className = row.discount >= 0 ? "discount" : "premium";
    return `<div class="discount-row ${className}">
      <div>
        <strong>${escapeHtml(row.gpuModel)}</strong>
        <span>${escapeHtml(commitmentLabel(row.bestCommitted.commitment))} · ${escapeHtml(row.bestCommitted.provider)}</span>
      </div>
      <div class="discount-meter"><i style="width:${width}%"></i></div>
      <b>${row.discount >= 0 ? `${row.discount.toFixed(1)}% off` : `${Math.abs(row.discount).toFixed(1)}% higher`}</b>
    </div>`;
  }).join("") : `<div class="empty compact-empty">No committed-rate pairs match these filters.</div>`;
}

function renderVisualizations() {
  const { comparableHistory, currentRows, allCommitments } = buildVisualData();
  renderHeroMetrics();
  renderMovementMatrix(movementRows(currentRows, comparableHistory));
  renderRegionHeatmap(regionalHeatmapRows(currentRows));
  renderTopMovers(topMoverRows(currentRows, comparableHistory));
  renderCheapestRegions(cheapestRegionRows(currentRows));
  renderProviderSpread(providerSpreadRows(currentRows));
  renderCommitmentDiscounts(commitmentDiscountRows(allCommitments));
}

function isDefaultDashboardView() {
  return $("#datasetFilter").value === "direct" &&
    $("#gpuFilter").value === "all" &&
    $("#providerFilter").value === "all" &&
    $("#regionFilter").value === "all" &&
    $("#commitmentFilter").value === "all" &&
    state.months === 24;
}

function renderDashboardSummary(summary) {
  renderHeroMetricsSummary(summary.hero);
  renderMovementMatrix(summary.movementRows);
  renderRegionHeatmap(summary.heatmapRows);
  renderTopMovers(summary.topMoverRows);
  renderCheapestRegions(summary.cheapestRows);
  renderProviderSpread(summary.providerSpreadRows);
  renderCommitmentDiscounts(summary.commitmentRows);
  renderChart(summary.chartRows);
  renderTable(summary.tableRows);
}

function renderVisualizationLoadingPanels() {
  renderHeroMetricsSummary(state.dashboard?.hero);
  const loading = `<div class="empty compact-empty">Loading filtered data...</div>`;
  $("#movementTable").innerHTML = loading;
  $("#regionHeatmap").innerHTML = loading;
  $("#topMovers").innerHTML = loading;
  $("#cheapestRegions").innerHTML = loading;
  $("#providerSpread").innerHTML = loading;
  $("#commitmentDiscounts").innerHTML = loading;
}

function renderLoadingPanels() {
  renderVisualizationLoadingPanels();
  const loading = `<div class="empty compact-empty">Loading filtered data...</div>`;
  $("#chart").innerHTML = loading;
  $("#legend").innerHTML = "";
  $("#ratesTable").innerHTML = `<tr><td colspan="6">Loading filtered data...</td></tr>`;
}

function render() {
  const cohortLabel = $("#gpuFilter").selectedOptions[0]?.textContent.split(" · ")[0] || "All models";
  const datasetLabel = $("#datasetFilter").selectedOptions[0]?.textContent || "Collected source index";

  $("#chartTitle").textContent = `${cohortLabel} · ${datasetLabel}`;

  renderSources();
  renderRuns();
  if ($("#datasetFilter").value === "direct" && state.dashboard && isDefaultDashboardView()) {
    renderDashboardSummary(state.dashboard);
    return;
  }
  if ($("#datasetFilter").value === "aimultiple" && !state.indexLoaded) {
    renderLoadingPanels();
    ensureModelIndex().catch((error) => toast(error.message));
    return;
  }
  if (!state.ratesLoaded) {
    if ($("#datasetFilter").value === "aimultiple" && state.indexLoaded) {
      const rows = filteredObservations();
      renderVisualizationLoadingPanels();
      renderChart(rows);
      renderTable(rows);
    } else {
      renderLoadingPanels();
    }
    ensureDashboardRates().catch((error) => toast(error.message));
    return;
  }

  const rows = filteredObservations();
  renderVisualizations();
  renderChart(rows);
  renderTable(rows);
}

function renderChart(rows) {
  const chart = $("#chart");
  const legend = $("#legend");
  if (!rows.length) {
    chart.innerHTML = `<div class="empty">No observations match this cohort and date range.</div>`;
    legend.innerHTML = "";
    return;
  }

  const width = 1120;
  const height = 420;
  const pad = { left: 58, right: 24, top: 25, bottom: 42 };
  const dates = rows.map((row) => new Date(row.observedAt).getTime());
  const minX = Math.min(...dates);
  const maxX = Math.max(...dates);
  const maxPrice = Math.ceil(Math.max(...rows.map((row) => row.pricePerGpuHour)) * 1.1);
  const x = (value) => pad.left + ((value - minX) / (maxX - minX || 1)) * (width - pad.left - pad.right);
  const y = (value) => height - pad.bottom - (value / maxPrice) * (height - pad.top - pad.bottom);
  const models = [...new Set(rows.map((row) => row.gpuModel))];

  const grid = Array.from({ length: 6 }, (_, index) => {
    const value = (maxPrice / 5) * index;
    const yy = y(value);
    return `<line class="grid-line" x1="${pad.left}" x2="${width - pad.right}" y1="${yy}" y2="${yy}" />
      <text class="axis-label" x="${pad.left - 10}" y="${yy + 4}" text-anchor="end">${money(value)}</text>`;
  }).join("");

  const tickCount = Math.min(7, Math.max(2, new Set(dates).size));
  const xTicks = Array.from({ length: tickCount }, (_, index) => {
    const value = minX + ((maxX - minX) * index / (tickCount - 1 || 1));
    return `<text class="axis-label" x="${x(value)}" y="${height - 13}" text-anchor="middle">${shortDate(value)}</text>`;
  }).join("");

  const series = models.map((model, index) => {
    const color = state.colors[index % state.colors.length];
    const modelRows = rows
      .filter((row) => row.gpuModel === model)
      .toSorted((a, b) => new Date(a.observedAt) - new Date(b.observedAt));
    const path = modelRows.map((row, pointIndex) =>
      `${pointIndex ? "L" : "M"} ${x(new Date(row.observedAt).getTime())} ${y(row.pricePerGpuHour)}`
    ).join(" ");
    const points = modelRows.map((row) => `
      <circle class="point" cx="${x(new Date(row.observedAt).getTime())}" cy="${y(row.pricePerGpuHour)}" r="3.4"
        fill="${color}" data-rate='${JSON.stringify(row).replaceAll("'", "&#39;")}' />`).join("");
    return `<path class="series-line" d="${path}" stroke="${color}" />${points}`;
  }).join("");

  chart.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${grid}${xTicks}${series}</svg>`;
  legend.innerHTML = models.map((model, index) =>
    `<span class="legend-item"><i class="legend-dot" style="background:${state.colors[index % state.colors.length]}"></i>${model}</span>`
  ).join("");
  attachTooltips();
}

function attachTooltips() {
  document.querySelectorAll(".point").forEach((point) => {
    point.addEventListener("mouseenter", (event) => {
      const row = JSON.parse(event.target.dataset.rate);
      const tooltip = document.createElement("div");
      tooltip.className = "tooltip";
      tooltip.innerHTML = `<strong>${row.gpuModel}</strong>
        ${money(row.pricePerGpuHour)} / GPU-hour<br>
        ${shortDate(row.observedAt)}<br>
        <span style="color:#aeb6af">${escapeHtml(aggregationText(row.aggregation))}</span>`;
      document.body.appendChild(tooltip);
      point.tooltip = tooltip;
    });
    point.addEventListener("mousemove", (event) => {
      if (!point.tooltip) return;
      point.tooltip.style.left = `${Math.min(window.innerWidth - 240, event.clientX + 14)}px`;
      point.tooltip.style.top = `${Math.max(10, event.clientY - 80)}px`;
    });
    point.addEventListener("mouseleave", () => {
      point.tooltip?.remove();
      point.tooltip = null;
    });
    point.addEventListener("click", () => {
      const row = JSON.parse(point.dataset.rate);
      showSourceDetails(row);
    });
  });
}

function renderSources() {
  const observations = new Map(state.meta.providers.map((provider) => [provider.provider, provider]));
  const indexCard = `<div class="source-card">
    <div class="source-top"><span class="source-name">AIMultiple GPU Index</span><span class="badge">aggregate</span></div>
    <div class="source-meta">${state.indexMeta.observationCount} monthly points · 10 models<br>Median-of-provider-medians · Jul 2024–Jun 2026</div>
  </div>`;
  const collectorCards = state.meta.catalog.map((source) => {
    const tracked = observations.get(source.name);
    const lastRun = state.meta.runs.find((run) => run.provider === source.id);
    const status = lastRun?.status || (tracked ? "tracked" : "ready");
    return `<div class="source-card">
      <div class="source-top"><span class="source-name">${source.name}</span><span class="badge">${source.type}</span></div>
      <div class="source-meta">${tracked?.observations || 0} direct observations · ${status}<br>${source.archiveCapable ? "Live + archive parser" : "Official price API"}</div>
    </div>`;
  }).join("");
  $("#sources").innerHTML = indexCard + collectorCards;
}

function renderRuns() {
  const runs = state.meta.runs.slice(0, 8);
  $("#runList").innerHTML = runs.length ? runs.map((run) => `<div class="run-row ${escapeHtml(run.status)}">
    <div>
      <strong>${escapeHtml(run.provider)}</strong>
      <span>${run.finishedAt ? fullDate(run.finishedAt) : "Running"}</span>
    </div>
    <b>${escapeHtml(run.status)}</b>
  </div>`).join("") : `<div class="empty compact-empty">Daily collection runs will appear here.</div>`;
}

function renderTable(rows) {
  const latest = latestByModel(rows).toSorted((a, b) => b.pricePerGpuHour - a.pricePerGpuHour);
  $("#ratesTable").innerHTML = latest.map((row) => `<tr>
    <td><strong>${row.gpuModel}</strong></td>
    <td>${groupLabels[row.group] || row.group}</td>
    <td>${shortDate(row.observedAt)}</td>
    <td class="rate">${money(row.pricePerGpuHour)}</td>
    <td>${escapeHtml(aggregationText(row.aggregation))}${row.directObservationCount ? ` · ${row.directObservationCount} rows` : ""}</td>
    <td><button class="link-button" type="button" data-source-row='${JSON.stringify(row).replaceAll("'", "&#39;")}'>Inspect</button></td>
  </tr>`).join("") || `<tr><td colspan="6">No matching observations.</td></tr>`;
  document.querySelectorAll("[data-source-row]").forEach((button) => {
    button.addEventListener("click", () => showSourceDetails(JSON.parse(button.dataset.sourceRow)));
  });
}

["#gpuFilter", "#datasetFilter", "#providerFilter", "#regionFilter", "#commitmentFilter"].forEach((selector) => {
  $(selector).addEventListener("change", render);
});
document.querySelectorAll("[data-months]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-months]").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    state.months = Number(button.dataset.months);
    render();
  });
});

$("#closeSourceDialog").addEventListener("click", () => $("#sourceDialog").close());
$("#sourceDialog").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});

load().catch((error) => {
  showLoadError(error);
  toast(error.message);
});
