const state = {
  meta: null,
  rates: [],
  indexMeta: null,
  observations: [],
  months: 24,
  colors: ["#174f3a", "#e57b42", "#5677df", "#8d65c5", "#b18b2f", "#d34f6b", "#2f9294", "#7a877d", "#e0a31a", "#3e63a8"]
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
const GROUPS = {
  "last-released": ["B200", "B300", "MI300X", "RTX 5090", "GB200", "GB300"],
  modern: ["H100", "H200", "GH200", "A100", "L40S", "L40", "L4", "A10", "RTX 4090"],
  legacy: ["V100", "P100", "T4"]
};
const groupLabels = { modern: "Modern", "last-released": "Latest", legacy: "Legacy", other: "Other" };

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

function commitmentLabel(value = "") {
  return value
    .replaceAll("-", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

async function request(url, options) {
  const response = await fetch(url, {
    headers: { "content-type": "application/json" },
    ...options
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 4200);
}

async function load() {
  const [meta, rates, index] = await Promise.all([
    request("/api/meta"),
    request("/api/rates"),
    request("/api/model-index")
  ]);
  state.meta = meta;
  state.rates = rates;
  state.indexMeta = index.metadata;
  state.observations = index.observations;
  populateControls();
  render();
}

function populateControls() {
  const cohorts = [
    ["all", "All 10 GPU models"],
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

  const archive = $("#archiveProvider");
  archive.innerHTML = state.meta.catalog.filter((provider) => provider.archiveCapable)
    .map((provider) => `<option value="${provider.id}">${provider.name}</option>`).join("");
  $("#archiveTo").value = new Date().toISOString().slice(0, 7);
  $("#freshness").textContent = `Index updated ${fullDate(state.indexMeta.publishedAt)} · ${state.indexMeta.observationCount} monthly points`;
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

function directObservationsFor(indexRow) {
  const selectedMonth = monthKey(indexRow.observedAt);
  return filteredDirectRates().filter((row) =>
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

function showSourceDetails(indexRow) {
  const directRows = directObservationsFor(indexRow);
  const directProviders = providerSummaryFor(directRows);
  const dialog = $("#sourceDialog");
  $("#sourceDialogTitle").textContent = `${indexRow.gpuModel} · ${shortDate(indexRow.observedAt)}`;
  const aggregateMeta = indexRow.directObservationCount
    ? `${money(indexRow.pricePerGpuHour)} / GPU-hour<br>${indexRow.directObservationCount} direct point${indexRow.directObservationCount === 1 ? "" : "s"} · ${indexRow.providerCount} provider${indexRow.providerCount === 1 ? "" : "s"} · ${indexRow.regionCount} region${indexRow.regionCount === 1 ? "" : "s"}`
    : `${money(indexRow.pricePerGpuHour)} / GPU-hour<br>${escapeHtml(indexRow.aggregation.replaceAll("-", " "))}`;

  const aggregateCard = sourceCard({
    name: indexRow.sourceName,
    type: "aggregate",
    href: indexRow.sourceUrl,
    meta: aggregateMeta
  });
  const directSourceCards = directProviders.map((provider) => sourceCard({
    name: provider.provider,
    type: provider.providerType,
    meta: `${provider.observations} direct data point${provider.observations === 1 ? "" : "s"}<br>${escapeHtml([...provider.sourceKinds].join(", "))} · latest ${shortDate(provider.latestObservation)}`
  })).join("");
  const sourceList = directSourceCards || `<div class="empty-source">No direct provider observations have been collected for this GPU and month yet.</div>`;

  const directTable = directRows.length ? `<div class="table-wrap">
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
  </div>` : `<div class="empty-source">Collect latest rates or import archive snapshots to add direct provider rows for this month.</div>`;

  $("#sourceDialogBody").innerHTML = `
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
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function render() {
  const rows = filteredObservations();
  const latest = latestByModel(rows);
  const modelMedian = median(latest.map((row) => row.pricePerGpuHour));
  const lowest = latest.toSorted((a, b) => a.pricePerGpuHour - b.pricePerGpuHour)[0];
  const highest = latest.toSorted((a, b) => b.pricePerGpuHour - a.pricePerGpuHour)[0];
  const cohortLabel = $("#gpuFilter").selectedOptions[0]?.textContent.split(" · ")[0] || "All models";
  const datasetLabel = $("#datasetFilter").selectedOptions[0]?.textContent || "Collected source index";

  $("#chartTitle").textContent = `${cohortLabel} · ${datasetLabel}`;
  $("#medianRate").textContent = modelMedian == null ? "—" : money(modelMedian);
  $("#lowestRate").textContent = lowest ? money(lowest.pricePerGpuHour) : "—";
  $("#lowestProvider").textContent = lowest?.gpuModel || "No matching data";
  $("#providerCount").textContent = new Set(rows.map((row) => row.gpuModel)).size;
  $("#observationCount").textContent = rows.length;
  $("#dateCoverage").textContent = rows.length
    ? `${shortDate(rows[0].observedAt)} – ${shortDate(rows.at(-1).observedAt)}`
    : "No matching data";
  $("#marketSpread").textContent = lowest && highest
    ? `${(highest.pricePerGpuHour / lowest.pricePerGpuHour).toFixed(1)}×`
    : "—";
  $("#marketSpreadNote").textContent = lowest && highest
    ? `${lowest.gpuModel} to ${highest.gpuModel}`
    : "Select another range";

  renderChart(rows);
  renderSources();
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
        <span style="color:#aeb6af">${escapeHtml(row.aggregation.replaceAll("-", " "))}</span>`;
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

function renderTable(rows) {
  const latest = latestByModel(rows).toSorted((a, b) => b.pricePerGpuHour - a.pricePerGpuHour);
  $("#ratesTable").innerHTML = latest.map((row) => `<tr>
    <td><strong>${row.gpuModel}</strong></td>
    <td>${groupLabels[row.group] || row.group}</td>
    <td>${shortDate(row.observedAt)}</td>
    <td class="rate">${money(row.pricePerGpuHour)}</td>
    <td>${escapeHtml(row.aggregation.replaceAll("-", " "))}${row.directObservationCount ? ` · ${row.directObservationCount} rows` : ""}</td>
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

$("#scrapeAll").addEventListener("click", async () => {
  const button = $("#scrapeAll");
  button.disabled = true;
  button.textContent = "Collecting…";
  try {
    const data = await request("/api/scrape", { method: "POST", body: JSON.stringify({}) });
    const successes = data.results.filter((result) => result.status === "success");
    const failures = data.results.filter((result) => result.status === "failed");
    toast(`${successes.length} direct sources collected${failures.length ? `; ${failures.length} need attention` : ""}.`);
    await load();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Collect latest rates";
  }
});

$("#archiveForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  const status = $("#archiveStatus");
  button.disabled = true;
  status.textContent = "Querying the archive and replaying snapshots…";
  try {
    const data = await request("/api/archive", {
      method: "POST",
      body: JSON.stringify({
        provider: $("#archiveProvider").value,
        from: $("#archiveFrom").value,
        to: $("#archiveTo").value,
        limit: 24
      })
    });
    status.textContent = `Imported ${data.records} historical direct observations.`;
    toast("Historical provider snapshots added.");
    await load();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$("#closeSourceDialog").addEventListener("click", () => $("#sourceDialog").close());
$("#sourceDialog").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});

load().catch((error) => toast(error.message));
