import { collectProviders, summarizeCollection } from "./collection.mjs";
import { listReportRates } from "./db.mjs";
import { sendEmail } from "./email.mjs";
import { defaultProviderIds } from "./providers.mjs";

const DAILY_REPORT_EMAIL_VERSION = "2026-07-18";
const DASHBOARD_URL = process.env.PUBLIC_BASE_URL || "https://gpupricecheckr-i8kp.onrender.com";

const DAY_MS = 24 * 60 * 60 * 1000;
const ANALYSIS_COMMITMENT = "on-demand";
const LOOKBACKS = [
  { key: "day", label: "1D", days: 1 },
  { key: "week", label: "7D", days: 7 },
  { key: "month", label: "30D", days: 30 },
  { key: "quarter", label: "Q", days: 90 },
  { key: "year", label: "Y", days: 365 }
];
const REGION_GROUPS = ["North America", "Europe", "Asia Pacific", "Middle East & Africa", "South America", "Global / Other"];
const GPU_PRIORITY = ["H100", "H200", "B200", "B300", "GB200", "GH200", "A100", "L40S", "L40", "L4", "A10", "T4", "V100"];
const CHART_COLORS = ["#174f3a", "#e57b42", "#5677df", "#8d65c5", "#b18b2f", "#d34f6b", "#2f9294", "#3e63a8"];

const money = (value) => `$${Number(value).toFixed(2)}`;
const percent = (value) => `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;

function priceValue(rate) {
  const price = Number(rate.pricePerGpuHour);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function rateKey(rate) {
  return [rate.provider, rate.gpuModel, rate.gpuVariant, rate.region, rate.commitment].join("|");
}

function observedTime(rate) {
  return new Date(rate.observedAt).getTime();
}

function isAnalysisRate(rate) {
  return rate.commitment === ANALYSIS_COMMITMENT && Number.isFinite(priceValue(rate));
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).toSorted((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function pctChange(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

function latestRateMap(rates, cutoff = Infinity) {
  const latest = new Map();
  for (const rate of rates) {
    if (!Number.isFinite(priceValue(rate))) continue;
    const time = observedTime(rate);
    if (time > cutoff) continue;
    const key = rateKey(rate);
    const current = latest.get(key);
    if (!current || time > observedTime(current)) latest.set(key, rate);
  }
  return latest;
}

function enrichChanges(scrapedRates, previousRates) {
  const previousByKey = latestRateMap(previousRates);
  return scrapedRates.map((rate) => {
    const previous = previousByKey.get(rateKey(rate));
    const currentPrice = priceValue(rate);
    const previousPrice = previous ? priceValue(previous) : null;
    const delta = Number.isFinite(currentPrice) && Number.isFinite(previousPrice) ? currentPrice - previousPrice : null;
    const deltaPercent = Number.isFinite(delta) && Number.isFinite(previousPrice)
      ? (delta / previousPrice) * 100
      : null;
    return { ...rate, previous, delta, deltaPercent };
  }).toSorted((a, b) =>
    a.provider.localeCompare(b.provider) ||
    a.gpuModel.localeCompare(b.gpuModel) ||
    (priceValue(a) ?? Infinity) - (priceValue(b) ?? Infinity)
  );
}

function htmlEscape(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[char]);
}

function formatMaybe(value, formatter) {
  return Number.isFinite(value) ? formatter(value) : "n/a";
}

function priorityIndex(gpuModel) {
  const index = GPU_PRIORITY.indexOf(gpuModel);
  return index === -1 ? GPU_PRIORITY.length : index;
}

function matchedComparison(rows, previousRates, cutoff) {
  const previousByKey = latestRateMap(previousRates.filter(isAnalysisRate), cutoff);
  const pairs = rows
    .map((rate) => ({ current: rate, previous: previousByKey.get(rateKey(rate)) }))
    .filter((pair) => pair.previous);
  if (!pairs.length) return null;

  const currentAverage = providerBalancedPrice(pairs.map((pair) => pair.current));
  const previousAverage = providerBalancedPrice(pairs.map((pair) => pair.previous));
  return {
    change: pctChange(currentAverage, previousAverage),
    matched: pairs.length
  };
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

function providerBalancedPrice(rows) {
  const providerMedians = [...groupBy(
    rows.filter((row) => Number.isFinite(priceValue(row))),
    (row) => row.provider
  ).values()].map((providerRows) => median(providerRows.map(priceValue)));
  return median(providerMedians);
}

function gpuMovementRows(currentRows, previousRates, generatedAt, indexRates = currentRows) {
  const generatedTime = new Date(generatedAt).getTime();
  return [...groupBy(currentRows, (rate) => rate.gpuModel).entries()].map(([gpuModel, rows]) => {
    const modelIndexRates = indexRates.filter((rate) => rate.gpuModel === gpuModel);
    const providers = new Set(modelIndexRates.map((rate) => rate.provider));
    const regions = new Set(modelIndexRates.map((rate) => rate.region));
    const comparisons = Object.fromEntries(LOOKBACKS.map((lookback) => {
      const comparison = matchedComparison(rows, previousRates, generatedTime - lookback.days * DAY_MS);
      return [lookback.key, comparison];
    }));
    return {
      gpuModel,
      averagePrice: providerBalancedPrice(modelIndexRates),
      observations: modelIndexRates.length,
      providerCount: providers.size,
      regionCount: regions.size,
      comparisons
    };
  }).toSorted((a, b) =>
    priorityIndex(a.gpuModel) - priorityIndex(b.gpuModel) ||
    b.observations - a.observations ||
    a.gpuModel.localeCompare(b.gpuModel)
  );
}

function topMovers(changes) {
  const matched = [...groupBy(changes.filter(isAnalysisRate), (rate) => rate.gpuModel).entries()]
    .map(([gpuModel, rows]) => {
      const pairs = rows.filter((rate) => rate.previous);
      const currentPrice = providerBalancedPrice(pairs);
      const previousPrice = providerBalancedPrice(pairs.map((rate) => rate.previous));
      return {
        gpuModel,
        currentPrice,
        previousPrice,
        deltaPercent: pctChange(currentPrice, previousPrice),
        providerCount: new Set(pairs.map((rate) => rate.provider)).size,
        observations: pairs.length
      };
    })
    .filter((row) => Number.isFinite(row.deltaPercent))
    .toSorted((a, b) => Math.abs(b.deltaPercent) - Math.abs(a.deltaPercent));
  return {
    drops: matched.filter((rate) => rate.deltaPercent < 0).slice(0, 5),
    increases: matched.filter((rate) => rate.deltaPercent > 0).slice(0, 5),
    newRows: changes.filter((rate) => isAnalysisRate(rate) && !rate.previous).length
  };
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

function regionalHeatmap(currentRows, gpuOrder) {
  return gpuOrder.slice(0, 10).map((gpuModel) => {
    const rows = currentRows.filter((rate) => rate.gpuModel === gpuModel);
    const modelMedian = providerBalancedPrice(rows);
    const cells = Object.fromEntries(REGION_GROUPS.map((group) => {
      const groupAverage = providerBalancedPrice(rows.filter((rate) => regionGroup(rate.region) === group));
      return [group, {
        averagePrice: groupAverage,
        relativeToMedian: modelMedian && groupAverage ? groupAverage / modelMedian : null
      }];
    }));
    return { gpuModel, modelMedian, cells };
  }).filter((row) => Number.isFinite(row.modelMedian));
}

function recentDayKeys(generatedAt, count = 90) {
  const date = new Date(generatedAt);
  const days = [];
  for (let index = count - 1; index >= 0; index -= 1) {
    const current = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - index));
    days.push(current.toISOString().slice(0, 10));
  }
  return days;
}

function trendSeries(allRates, gpuModels, generatedAt) {
  const days = recentDayKeys(generatedAt);
  const daySet = new Set(days);
  const selected = new Set(gpuModels);
  const buckets = new Map();
  for (const rate of allRates.filter((item) => isAnalysisRate(item) && selected.has(item.gpuModel))) {
    const day = rate.observedAt.slice(0, 10);
    if (!daySet.has(day)) continue;
    const key = `${rate.gpuModel}|${day}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(rate);
  }

  return {
    days,
    series: gpuModels.map((gpuModel, index) => ({
      gpuModel,
      color: CHART_COLORS[index % CHART_COLORS.length],
      values: days.map((day) => providerBalancedPrice(buckets.get(`${gpuModel}|${day}`) || []))
    }))
  };
}

function buildDigest({ scrapedRates, previousRates, changes, generatedAt }) {
  const currentRows = [...latestRateMap(scrapedRates.filter(isAnalysisRate)).values()];
  const allRates = [...previousRates, ...scrapedRates];
  const currentDay = new Date(generatedAt).toISOString().slice(0, 10);
  const currentDayRates = allRates.filter((rate) =>
    isAnalysisRate(rate) && rate.observedAt.slice(0, 10) === currentDay
  );
  const movementRows = gpuMovementRows(currentRows, previousRates, generatedAt, currentDayRates);
  const trendGpus = movementRows.slice(0, 6).map((row) => row.gpuModel);
  return {
    currentRows,
    movementRows,
    movers: topMovers(changes),
    heatmapRows: regionalHeatmap(currentRows, movementRows.map((row) => row.gpuModel)),
    trend: trendSeries(allRates, trendGpus, generatedAt)
  };
}

function pctCellStyle(value) {
  if (!Number.isFinite(value)) return "color:#65717a;background:#111a1f;";
  if (value < -1) return "color:#a7ed18;background:#17251b;";
  if (value > 1) return "color:#ff8095;background:#29171d;";
  return "color:#cbd3d8;background:#151f24;";
}

function heatCellStyle(ratio) {
  if (!Number.isFinite(ratio)) return "background:#111a1f;color:#65717a;";
  if (ratio <= 0.85) return "background:#1f3a22;color:#c8f66d;";
  if (ratio <= 0.95) return "background:#192b20;color:#b8e961;";
  if (ratio <= 1.05) return "background:#151f24;color:#dbe1e4;";
  if (ratio <= 1.15) return "background:#35251a;color:#ffc27f;";
  return "background:#3b1c24;color:#ff9aac;";
}

function renderMovementTable(rows) {
  const body = rows.map((row) => `<tr>
    <td style="padding:10px 8px;border-bottom:1px solid #263138;font-weight:700;color:#f0f3f5;">${htmlEscape(row.gpuModel)}</td>
    <td style="padding:10px 8px;border-bottom:1px solid #263138;text-align:right;color:#a7ed18;font-weight:700;">${formatMaybe(row.averagePrice, money)}</td>
    <td style="padding:10px 8px;border-bottom:1px solid #263138;text-align:right;color:#aab4ba;">${row.observations}</td>
    <td style="padding:10px 8px;border-bottom:1px solid #263138;text-align:right;color:#aab4ba;">${row.providerCount}</td>
    ${LOOKBACKS.map((lookback) => {
      const change = row.comparisons[lookback.key]?.change;
      return `<td style="padding:10px 8px;border-bottom:1px solid #263138;text-align:right;${pctCellStyle(change)}">${formatMaybe(change, percent)}</td>`;
    }).join("")}
  </tr>`).join("");

  return `<table cellpadding="0" cellspacing="0" role="presentation" style="width:100%;border-collapse:collapse;font-size:13px;background:#0e1519;border:1px solid #263138;">
    <thead>
      <tr style="background:#151f24;color:#8e9aa3;">
        <th align="left" style="padding:8px;">GPU</th>
        <th align="right" style="padding:8px;">Index</th>
        <th align="right" style="padding:8px;">Rows</th>
        <th align="right" style="padding:8px;">Sources</th>
        ${LOOKBACKS.map((lookback) => `<th align="right" style="padding:8px;">${lookback.label}</th>`).join("")}
      </tr>
    </thead>
    <tbody>${body || `<tr><td colspan="9" style="padding:12px;color:#8e9aa3;">No on-demand rows collected in this run.</td></tr>`}</tbody>
  </table>`;
}

function moverLabel(rate) {
  const movement = `${formatMaybe(rate.previousPrice, money)} -> ${formatMaybe(rate.currentPrice, money)} (${percent(rate.deltaPercent)})`;
  return `${rate.gpuModel} provider-balanced index across ${rate.providerCount} providers: ${movement}`;
}

function renderMoverTable(title, rows) {
  const body = rows.map((rate) => `<tr>
    <td style="padding:8px;border-bottom:1px solid #263138;font-weight:700;color:#f0f3f5;">${htmlEscape(rate.gpuModel)}</td>
    <td style="padding:8px;border-bottom:1px solid #263138;text-align:right;color:#aab4ba;">${rate.providerCount}</td>
    <td style="padding:8px;border-bottom:1px solid #263138;text-align:right;color:#aab4ba;">${formatMaybe(rate.previousPrice, money)}</td>
    <td style="padding:8px;border-bottom:1px solid #263138;text-align:right;color:#f0f3f5;">${formatMaybe(rate.currentPrice, money)}</td>
    <td style="padding:8px;border-bottom:1px solid #263138;text-align:right;${pctCellStyle(rate.deltaPercent)}">${percent(rate.deltaPercent)}</td>
  </tr>`).join("");

  return `<h3 style="margin:18px 0 8px 0;font-size:14px;color:#dbe1e4;">${htmlEscape(title)}</h3>
  <table cellpadding="0" cellspacing="0" role="presentation" style="width:100%;border-collapse:collapse;font-size:13px;background:#0e1519;border:1px solid #263138;">
    <thead><tr style="background:#151f24;color:#8e9aa3;">
      <th align="left" style="padding:7px;">GPU</th>
      <th align="right" style="padding:7px;">Providers</th>
      <th align="right" style="padding:7px;">Was</th>
      <th align="right" style="padding:7px;">Now</th>
      <th align="right" style="padding:7px;">Move</th>
    </tr></thead>
    <tbody>${body || `<tr><td colspan="5" style="padding:10px;color:#8e9aa3;">No matched on-demand index rows.</td></tr>`}</tbody>
  </table>`;
}

function renderHeatmap(rows) {
  const body = rows.map((row) => `<tr>
    <td style="padding:8px;border-bottom:1px solid #263138;font-weight:700;color:#f0f3f5;">${htmlEscape(row.gpuModel)}</td>
    ${REGION_GROUPS.map((group) => {
      const cell = row.cells[group];
      return `<td style="padding:8px;border-bottom:1px solid #263138;text-align:center;${heatCellStyle(cell.relativeToMedian)}">${formatMaybe(cell.averagePrice, money)}</td>`;
    }).join("")}
  </tr>`).join("");

  return `<table cellpadding="0" cellspacing="0" role="presentation" style="width:100%;border-collapse:collapse;font-size:12px;background:#0e1519;border:1px solid #263138;">
    <thead><tr style="background:#151f24;color:#8e9aa3;">
      <th align="left" style="padding:8px;">GPU</th>
      ${REGION_GROUPS.map((group) => `<th align="center" style="padding:8px;">${htmlEscape(group)}</th>`).join("")}
    </tr></thead>
    <tbody>${body || `<tr><td colspan="7" style="padding:12px;color:#8e9aa3;">No regional on-demand rows collected.</td></tr>`}</tbody>
  </table>
  <p style="margin:8px 0 0 0;color:#8e9aa3;font-size:12px;">Cells use the provider-balanced index and are colored relative to each GPU's index: green is cheaper, red is more expensive.</p>`;
}

function renderTrendChart(trend) {
  const width = 640;
  const height = 280;
  const margin = { top: 22, right: 24, bottom: 42, left: 58 };
  const values = trend.series.flatMap((series) => series.values).filter(Number.isFinite);
  if (values.length < 2) {
    return `<p style="color:#7d827b;">Not enough on-demand history yet for a trend chart.</p>`;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max((max - min) * 0.08, 0.25);
  const yMin = Math.max(0, min - pad);
  const yMax = max + pad;
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const xFor = (index) => margin.left + (trend.days.length === 1 ? plotWidth : (index / (trend.days.length - 1)) * plotWidth);
  const yFor = (value) => margin.top + (1 - ((value - yMin) / (yMax - yMin))) * plotHeight;
  const ticks = [0, 0.5, 1].map((ratio) => yMin + (yMax - yMin) * ratio);
  const grid = ticks.map((tick) => {
    const y = yFor(tick);
    return `<line x1="${margin.left}" y1="${y.toFixed(1)}" x2="${width - margin.right}" y2="${y.toFixed(1)}" stroke="#263138" />
      <text x="${margin.left - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#8e9aa3">${money(tick)}</text>`;
  }).join("");
  const labelInterval = Math.max(1, Math.ceil(trend.days.length / 6));
  const dayLabels = trend.days.map((day, index) => {
    if (index % labelInterval && index !== trend.days.length - 1) return "";
    return `<text x="${xFor(index).toFixed(1)}" y="${height - 16}" text-anchor="middle" font-size="10" fill="#8e9aa3">${htmlEscape(day.slice(5))}</text>`;
  }).join("");
  const polylines = trend.series.map((series) => {
    const points = series.values
      .map((value, index) => Number.isFinite(value) ? `${xFor(index).toFixed(1)},${yFor(value).toFixed(1)}` : null)
      .filter(Boolean);
    if (points.length < 2) return "";
    return `<polyline points="${points.join(" ")}" fill="none" stroke="${series.color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />`;
  }).join("");
  const legend = trend.series.map((series) => `<span style="display:inline-block;margin:0 14px 6px 0;font-size:12px;color:#cbd3d8;">
    <span style="display:inline-block;width:10px;height:10px;background:${series.color};border-radius:10px;margin-right:5px;"></span>${htmlEscape(series.gpuModel)}
  </span>`).join("");

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="GPU provider-balanced price index trend over time" style="max-width:100%;height:auto;border:1px solid #263138;background:#0e1519;">
    <rect width="${width}" height="${height}" fill="#0e1519" />
    ${grid}
    ${polylines}
    ${dayLabels}
    <text x="${margin.left}" y="16" font-size="12" fill="#cbd3d8">Daily provider-balanced on-demand index per GPU-hour</text>
  </svg>
  <div style="margin-top:8px;">${legend}</div>`;
}

function renderHtml({ digest, failures, generatedAt, results, collected }) {
  const failuresHtml = failures.length
    ? `<h2 style="font-size:18px;margin:28px 0 10px;color:#f0f3f5;">Needs attention</h2><ul style="color:#ff8095;">${failures.map((failure) =>
      `<li>${htmlEscape(failure.provider)}: ${htmlEscape(failure.message)}</li>`
    ).join("")}</ul>`
    : "";
  const successfulProviders = results.filter((result) => result.status === "success").length;
  const cardStyle = "padding:14px;border:1px solid #263138;background:#111a1f;";
  const sectionStyle = "font-size:18px;margin:30px 0 10px;color:#f0f3f5;letter-spacing:-0.01em;";

  return `<!doctype html>
  <html lang="en">
    <head><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"></head>
    <body style="margin:0;padding:0;background:#070c0f;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#f0f3f5;">
      <div style="display:none;max-height:0;overflow:hidden;opacity:0;">Today's provider-balanced GPU rental price index and market movement.</div>
      <div style="max-width:760px;margin:0 auto;padding:28px 20px 40px;">
        <table cellpadding="0" cellspacing="0" role="presentation" style="width:100%;margin-bottom:26px;border-bottom:1px solid #263138;">
          <tr>
            <td style="padding:0 0 16px;color:#ffffff;font-size:20px;font-weight:800;letter-spacing:-0.02em;">GPU Rental Rate Index</td>
            <td align="right" style="padding:0 0 16px;color:#a7ed18;font-size:11px;font-weight:750;text-transform:uppercase;letter-spacing:0.08em;">Daily market brief</td>
          </tr>
        </table>
        <p style="margin:0 0 7px;color:#a7ed18;font-size:11px;font-weight:750;text-transform:uppercase;letter-spacing:0.1em;">Provider-balanced pricing</p>
        <h1 style="margin:0 0 8px;font-size:30px;line-height:1.15;letter-spacing:-0.03em;color:#ffffff;">Daily GPU market snapshot</h1>
        <p style="margin:0 0 22px;color:#8e9aa3;line-height:1.55;">Generated ${htmlEscape(generatedAt)}. Cross-provider prices use the median of provider-level medians.</p>
        <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;border-spacing:8px;margin:0 -8px 18px -8px;">
          <tr>
            <td style="${cardStyle}"><strong style="font-size:22px;color:#ffffff;">${collected}</strong><br><span style="color:#8e9aa3;font-size:12px;">rows collected</span></td>
            <td style="${cardStyle}"><strong style="font-size:22px;color:#ffffff;">${digest.movementRows.length}</strong><br><span style="color:#8e9aa3;font-size:12px;">GPU models</span></td>
            <td style="${cardStyle}"><strong style="font-size:22px;color:#a7ed18;">${successfulProviders}/${results.length}</strong><br><span style="color:#8e9aa3;font-size:12px;">sources succeeded</span></td>
            <td style="${cardStyle}"><strong style="font-size:22px;color:#ffffff;">${digest.movers.newRows}</strong><br><span style="color:#8e9aa3;font-size:12px;">new rows</span></td>
          </tr>
        </table>
        ${failuresHtml}
        <h2 style="${sectionStyle}">Current daily index</h2>
        ${renderMovementTable(digest.movementRows)}
        <h2 style="${sectionStyle}">Top movers</h2>
        ${renderMoverTable("Biggest price drops", digest.movers.drops)}
        ${renderMoverTable("Biggest price increases", digest.movers.increases)}
        <h2 style="${sectionStyle}">Regional price heatmap</h2>
        ${renderHeatmap(digest.heatmapRows)}
        <h2 style="${sectionStyle}">Price trend</h2>
        ${renderTrendChart(digest.trend)}
        <p style="margin:28px 0 0;"><a href="${htmlEscape(DASHBOARD_URL)}" style="display:inline-block;padding:11px 16px;background:#a7ed18;color:#0a0f0c;text-decoration:none;font-size:13px;font-weight:800;border-radius:4px;">Open live dashboard</a></p>
        <p style="margin:28px 0 0;padding-top:18px;border-top:1px solid #263138;color:#65717a;font-size:11px;line-height:1.55;">Direct collected observations only. Committed and reserved prices remain available through dashboard filters. Email template ${DAILY_REPORT_EMAIL_VERSION}.</p>
      </div>
    </body>
  </html>`;
}

function renderText({ digest, failures, generatedAt, collected }) {
  const movementLines = digest.movementRows.map((row) => {
    const moves = LOOKBACKS.map((lookback) => `${lookback.label}: ${formatMaybe(row.comparisons[lookback.key]?.change, percent)}`).join(", ");
    return `- ${row.gpuModel}: ${formatMaybe(row.averagePrice, money)} provider-balanced index across ${row.providerCount} providers (${moves})`;
  });
  const dropLines = digest.movers.drops.map((rate) => `- ${moverLabel(rate)}`);
  const increaseLines = digest.movers.increases.map((rate) => `- ${moverLabel(rate)}`);

  return [
    "GPU rental rate daily report",
    `Generated ${generatedAt}`,
    `${collected} rows collected. ${digest.movementRows.length} GPU models summarized.`,
    "",
    failures.length ? `Needs attention:\n${failures.map((failure) => `- ${failure.provider}: ${failure.message}`).join("\n")}` : "No collection failures.",
    "",
    "Provider-balanced index by GPU",
    movementLines.length ? movementLines.join("\n") : "No on-demand rows collected.",
    "",
    "Biggest price drops",
    dropLines.length ? dropLines.join("\n") : "No matched drops.",
    "",
    "Biggest price increases",
    increaseLines.length ? increaseLines.join("\n") : "No matched increases."
  ].join("\n");
}

export async function runDailyReport(options = {}) {
  const generatedAt = new Date().toISOString();
  const providerIds = options.providers?.length
    ? options.providers
    : defaultProviderIds();
  const before = listReportRates(generatedAt);
  const results = await collectProviders(providerIds);
  const scrapedRates = results.flatMap((result) => result.rates);
  const changes = enrichChanges(scrapedRates, before);
  const failures = results.filter((result) => result.status === "failed");
  const digest = buildDigest({ scrapedRates, previousRates: before, changes, generatedAt });
  const subject = `GPU Rental Rate Index daily: ${digest.movementRows.length} GPUs, ${failures.length} failures`;
  const text = renderText({ digest, failures, generatedAt, collected: scrapedRates.length });
  const html = renderHtml({
    digest,
    failures,
    generatedAt,
    results: summarizeCollection(results),
    collected: scrapedRates.length
  });
  const email = await sendEmail({
    subject,
    text,
    html,
    idempotencyKey: `gpu-rate-daily-${DAILY_REPORT_EMAIL_VERSION}-${generatedAt.slice(0, 10)}`
  });

  return {
    generatedAt,
    providers: providerIds,
    results: summarizeCollection(results),
    collected: scrapedRates.length,
    failures: failures.length,
    email
  };
}

export const __test = {
  buildDigest,
  enrichChanges,
  regionGroup,
  renderHtml,
  renderText
};
