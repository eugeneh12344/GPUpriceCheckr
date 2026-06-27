const state = {
  meta: null,
  rates: [],
  indexMeta: null,
  observations: [],
  months: 24,
  colors: ["#174f3a", "#e57b42", "#5677df", "#8d65c5", "#b18b2f", "#d34f6b", "#2f9294", "#7a877d", "#e0a31a", "#3e63a8"]
};

const $ = (selector) => document.querySelector(selector);
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
    ["legacy", "Legacy · V100"]
  ];
  const gpu = $("#gpuFilter");
  const current = gpu.value || "all";
  gpu.innerHTML = cohorts.map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
  gpu.value = current;

  const archive = $("#archiveProvider");
  archive.innerHTML = state.meta.catalog.filter((provider) => provider.archiveCapable)
    .map((provider) => `<option value="${provider.id}">${provider.name}</option>`).join("");
  $("#archiveTo").value = new Date().toISOString().slice(0, 7);
  $("#freshness").textContent = `Index updated ${fullDate(state.indexMeta.publishedAt)} · ${state.indexMeta.observationCount} monthly points`;
}

function filteredObservations() {
  const cohort = $("#gpuFilter").value;
  const cutoff = state.months
    ? new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - state.months, 1))
    : new Date(0);
  return state.observations.filter((row) =>
    (cohort === "all" || row.group === cohort) &&
    new Date(row.observedAt) >= cutoff
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

function render() {
  const rows = filteredObservations();
  const latest = latestByModel(rows);
  const prices = latest.map((row) => row.pricePerGpuHour).sort((a, b) => a - b);
  const median = prices.length
    ? prices.length % 2
      ? prices[Math.floor(prices.length / 2)]
      : (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2
    : null;
  const lowest = latest.toSorted((a, b) => a.pricePerGpuHour - b.pricePerGpuHour)[0];
  const highest = latest.toSorted((a, b) => b.pricePerGpuHour - a.pricePerGpuHour)[0];
  const cohortLabel = $("#gpuFilter").selectedOptions[0]?.textContent.split(" · ")[0] || "All models";

  $("#chartTitle").textContent = `${cohortLabel} · cross-provider price by GPU model`;
  $("#medianRate").textContent = median == null ? "—" : money(median);
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
        <span style="color:#aeb6af">Median across provider medians</span>`;
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
      window.open(row.sourceUrl, "_blank", "noopener");
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
  const groupLabels = { modern: "Modern", "last-released": "Latest", legacy: "Legacy" };
  $("#ratesTable").innerHTML = latest.map((row) => `<tr>
    <td><strong>${row.gpuModel}</strong></td>
    <td>${groupLabels[row.group]}</td>
    <td>${shortDate(row.observedAt)}</td>
    <td class="rate">${money(row.pricePerGpuHour)}</td>
    <td>Provider medians</td>
    <td><a href="${row.sourceUrl}" target="_blank" rel="noopener">View ↗</a></td>
  </tr>`).join("") || `<tr><td colspan="6">No matching observations.</td></tr>`;
}

$("#gpuFilter").addEventListener("change", render);
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

load().catch((error) => toast(error.message));
