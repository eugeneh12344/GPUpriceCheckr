import { collectProviders, summarizeCollection } from "./collection.mjs";
import { listReportRates } from "./db.mjs";
import { sendEmail } from "./email.mjs";
import { defaultProviderIds } from "./providers.mjs";

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

function average(values) {
  const valid = values.filter((value) => Number.isFinite(value));
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
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

  const currentAverage = average(pairs.map((pair) => priceValue(pair.current)));
  const previousAverage = average(pairs.map((pair) => priceValue(pair.previous)));
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

function gpuMovementRows(currentRows, previousRates, generatedAt) {
  const generatedTime = new Date(generatedAt).getTime();
  return [...groupBy(currentRows, (rate) => rate.gpuModel).entries()].map(([gpuModel, rows]) => {
    const providers = new Set(rows.map((rate) => rate.provider));
    const regions = new Set(rows.map((rate) => rate.region));
    const comparisons = Object.fromEntries(LOOKBACKS.map((lookback) => {
      const comparison = matchedComparison(rows, previousRates, generatedTime - lookback.days * DAY_MS);
      return [lookback.key, comparison];
    }));
    return {
      gpuModel,
      averagePrice: average(rows.map(priceValue)),
      observations: rows.length,
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
  const matched = changes
    .filter((rate) => isAnalysisRate(rate) && rate.previous && Number.isFinite(rate.deltaPercent))
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
    const modelMedian = median(rows.map(priceValue));
    const cells = Object.fromEntries(REGION_GROUPS.map((group) => {
      const groupAverage = average(rows
        .filter((rate) => regionGroup(rate.region) === group)
        .map(priceValue));
      return [group, {
        averagePrice: groupAverage,
        relativeToMedian: modelMedian && groupAverage ? groupAverage / modelMedian : null
      }];
    }));
    return { gpuModel, modelMedian, cells };
  }).filter((row) => Number.isFinite(row.modelMedian));
}

function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function recentMonthKeys(generatedAt, count = 12) {
  const date = new Date(generatedAt);
  date.setUTCDate(1);
  const months = [];
  for (let index = count - 1; index >= 0; index -= 1) {
    const current = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - index, 1));
    months.push(monthKey(current));
  }
  return months;
}

function trendSeries(allRates, gpuModels, generatedAt) {
  const months = recentMonthKeys(generatedAt);
  const monthSet = new Set(months);
  const selected = new Set(gpuModels);
  const latestByMonthKey = new Map();

  for (const rate of allRates.filter((item) => isAnalysisRate(item) && selected.has(item.gpuModel))) {
    const month = rate.observedAt.slice(0, 7);
    if (!monthSet.has(month)) continue;
    const key = [rate.gpuModel, month, rateKey(rate)].join("|");
    const current = latestByMonthKey.get(key);
    if (!current || observedTime(rate) > observedTime(current)) latestByMonthKey.set(key, rate);
  }

  const buckets = new Map();
  for (const rate of latestByMonthKey.values()) {
    const key = `${rate.gpuModel}|${rate.observedAt.slice(0, 7)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(priceValue(rate));
  }

  return {
    months,
    series: gpuModels.map((gpuModel, index) => ({
      gpuModel,
      color: CHART_COLORS[index % CHART_COLORS.length],
      values: months.map((month) => average(buckets.get(`${gpuModel}|${month}`) || []))
    }))
  };
}

function buildDigest({ scrapedRates, previousRates, changes, generatedAt }) {
  const currentRows = [...latestRateMap(scrapedRates.filter(isAnalysisRate)).values()];
  const movementRows = gpuMovementRows(currentRows, previousRates, generatedAt);
  const trendGpus = movementRows.slice(0, 6).map((row) => row.gpuModel);
  return {
    currentRows,
    movementRows,
    movers: topMovers(changes),
    heatmapRows: regionalHeatmap(currentRows, movementRows.map((row) => row.gpuModel)),
    trend: trendSeries([...previousRates, ...scrapedRates], trendGpus, generatedAt)
  };
}

function pctCellStyle(value) {
  if (!Number.isFinite(value)) return "color:#7d827b;background:#f5f5ef;";
  if (value < -1) return "color:#0f5f4a;background:#e7f4ee;";
  if (value > 1) return "color:#9f3322;background:#f8e9e4;";
  return "color:#4e554f;background:#f3f0df;";
}

function heatCellStyle(ratio) {
  if (!Number.isFinite(ratio)) return "background:#f5f5ef;color:#8a8f87;";
  if (ratio <= 0.85) return "background:#cdebdc;color:#123e31;";
  if (ratio <= 0.95) return "background:#e4f4eb;color:#123e31;";
  if (ratio <= 1.05) return "background:#f3f0df;color:#343b34;";
  if (ratio <= 1.15) return "background:#f7dcc4;color:#5b321a;";
  return "background:#f0b6aa;color:#5c2018;";
}

function renderMovementTable(rows) {
  const body = rows.map((row) => `<tr>
    <td style="padding:8px;border-bottom:1px solid #e5e2d6;font-weight:700;">${htmlEscape(row.gpuModel)}</td>
    <td style="padding:8px;border-bottom:1px solid #e5e2d6;text-align:right;">${formatMaybe(row.averagePrice, money)}</td>
    <td style="padding:8px;border-bottom:1px solid #e5e2d6;text-align:right;">${row.observations}</td>
    <td style="padding:8px;border-bottom:1px solid #e5e2d6;text-align:right;">${row.providerCount}</td>
    ${LOOKBACKS.map((lookback) => {
      const change = row.comparisons[lookback.key]?.change;
      return `<td style="padding:8px;border-bottom:1px solid #e5e2d6;text-align:right;${pctCellStyle(change)}">${formatMaybe(change, percent)}</td>`;
    }).join("")}
  </tr>`).join("");

  return `<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:13px;">
    <thead>
      <tr style="background:#171a17;color:#ffffff;">
        <th align="left" style="padding:8px;">GPU</th>
        <th align="right" style="padding:8px;">Avg</th>
        <th align="right" style="padding:8px;">Rows</th>
        <th align="right" style="padding:8px;">Sources</th>
        ${LOOKBACKS.map((lookback) => `<th align="right" style="padding:8px;">${lookback.label}</th>`).join("")}
      </tr>
    </thead>
    <tbody>${body || `<tr><td colspan="9" style="padding:12px;color:#7d827b;">No on-demand rows collected in this run.</td></tr>`}</tbody>
  </table>`;
}

function moverLabel(rate) {
  const movement = `${formatMaybe(priceValue(rate.previous), money)} -> ${formatMaybe(priceValue(rate), money)} (${percent(rate.deltaPercent)})`;
  return `${rate.provider} ${rate.gpuModel} ${rate.region}: ${movement}`;
}

function renderMoverTable(title, rows) {
  const body = rows.map((rate) => `<tr>
    <td style="padding:7px;border-bottom:1px solid #e5e2d6;">${htmlEscape(rate.provider)}</td>
    <td style="padding:7px;border-bottom:1px solid #e5e2d6;font-weight:700;">${htmlEscape(rate.gpuModel)}</td>
    <td style="padding:7px;border-bottom:1px solid #e5e2d6;">${htmlEscape(rate.region)}</td>
    <td style="padding:7px;border-bottom:1px solid #e5e2d6;text-align:right;">${formatMaybe(priceValue(rate.previous), money)}</td>
    <td style="padding:7px;border-bottom:1px solid #e5e2d6;text-align:right;">${formatMaybe(priceValue(rate), money)}</td>
    <td style="padding:7px;border-bottom:1px solid #e5e2d6;text-align:right;${pctCellStyle(rate.deltaPercent)}">${percent(rate.deltaPercent)}</td>
  </tr>`).join("");

  return `<h3 style="margin:18px 0 8px 0;font-size:15px;">${htmlEscape(title)}</h3>
  <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:13px;">
    <thead><tr style="background:#ede9d8;">
      <th align="left" style="padding:7px;">Provider</th>
      <th align="left" style="padding:7px;">GPU</th>
      <th align="left" style="padding:7px;">Region</th>
      <th align="right" style="padding:7px;">Was</th>
      <th align="right" style="padding:7px;">Now</th>
      <th align="right" style="padding:7px;">Move</th>
    </tr></thead>
    <tbody>${body || `<tr><td colspan="6" style="padding:10px;color:#7d827b;">No matched on-demand rows.</td></tr>`}</tbody>
  </table>`;
}

function renderHeatmap(rows) {
  const body = rows.map((row) => `<tr>
    <td style="padding:8px;border-bottom:1px solid #e5e2d6;font-weight:700;">${htmlEscape(row.gpuModel)}</td>
    ${REGION_GROUPS.map((group) => {
      const cell = row.cells[group];
      return `<td style="padding:8px;border-bottom:1px solid #e5e2d6;text-align:center;${heatCellStyle(cell.relativeToMedian)}">${formatMaybe(cell.averagePrice, money)}</td>`;
    }).join("")}
  </tr>`).join("");

  return `<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:12px;">
    <thead><tr style="background:#171a17;color:#ffffff;">
      <th align="left" style="padding:8px;">GPU</th>
      ${REGION_GROUPS.map((group) => `<th align="center" style="padding:8px;">${htmlEscape(group)}</th>`).join("")}
    </tr></thead>
    <tbody>${body || `<tr><td colspan="7" style="padding:12px;color:#7d827b;">No regional on-demand rows collected.</td></tr>`}</tbody>
  </table>
  <p style="margin:8px 0 0 0;color:#6d746d;font-size:12px;">Cells are colored relative to each GPU's collected median: green is cheaper, red is more expensive.</p>`;
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
  const xFor = (index) => margin.left + (trend.months.length === 1 ? plotWidth : (index / (trend.months.length - 1)) * plotWidth);
  const yFor = (value) => margin.top + (1 - ((value - yMin) / (yMax - yMin))) * plotHeight;
  const ticks = [0, 0.5, 1].map((ratio) => yMin + (yMax - yMin) * ratio);
  const grid = ticks.map((tick) => {
    const y = yFor(tick);
    return `<line x1="${margin.left}" y1="${y.toFixed(1)}" x2="${width - margin.right}" y2="${y.toFixed(1)}" stroke="#e5e2d6" />
      <text x="${margin.left - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#6d746d">${money(tick)}</text>`;
  }).join("");
  const monthLabels = trend.months.map((month, index) => {
    if (index % 2 && index !== trend.months.length - 1) return "";
    return `<text x="${xFor(index).toFixed(1)}" y="${height - 16}" text-anchor="middle" font-size="10" fill="#6d746d">${htmlEscape(month.slice(2))}</text>`;
  }).join("");
  const polylines = trend.series.map((series) => {
    const points = series.values
      .map((value, index) => Number.isFinite(value) ? `${xFor(index).toFixed(1)},${yFor(value).toFixed(1)}` : null)
      .filter(Boolean);
    if (points.length < 2) return "";
    return `<polyline points="${points.join(" ")}" fill="none" stroke="${series.color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />`;
  }).join("");
  const legend = trend.series.map((series) => `<span style="display:inline-block;margin:0 14px 6px 0;font-size:12px;color:#343b34;">
    <span style="display:inline-block;width:10px;height:10px;background:${series.color};border-radius:10px;margin-right:5px;"></span>${htmlEscape(series.gpuModel)}
  </span>`).join("");

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="GPU average price trend over time" style="max-width:100%;height:auto;border:1px solid #e5e2d6;background:#fffefa;">
    <rect width="${width}" height="${height}" fill="#fffefa" />
    ${grid}
    ${polylines}
    ${monthLabels}
    <text x="${margin.left}" y="16" font-size="12" fill="#343b34">Monthly average on-demand price per GPU-hour</text>
  </svg>
  <div style="margin-top:8px;">${legend}</div>`;
}

function renderHtml({ digest, failures, generatedAt, results, collected }) {
  const failuresHtml = failures.length
    ? `<h2 style="font-size:18px;margin:24px 0 8px 0;">Needs attention</h2><ul>${failures.map((failure) =>
      `<li>${htmlEscape(failure.provider)}: ${htmlEscape(failure.message)}</li>`
    ).join("")}</ul>`
    : "";
  const successfulProviders = results.filter((result) => result.status === "success").length;
  const cardStyle = "padding:12px;border:1px solid #e0dccf;background:#fffefa;";

  return `<!doctype html>
  <html>
    <body style="margin:0;padding:0;background:#f7f5ec;font-family:Arial,sans-serif;color:#171a17;">
      <div style="max-width:760px;margin:0 auto;padding:24px;">
        <h1 style="margin:0 0 6px 0;font-size:26px;">GPU rental rate daily report</h1>
        <p style="margin:0 0 18px 0;color:#5f665f;">Generated ${htmlEscape(generatedAt)}. On-demand rows drive the movement tables and charts.</p>
        <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;border-spacing:8px;margin:0 -8px 18px -8px;">
          <tr>
            <td style="${cardStyle}"><strong style="font-size:20px;">${collected}</strong><br><span style="color:#6d746d;">rows collected</span></td>
            <td style="${cardStyle}"><strong style="font-size:20px;">${digest.movementRows.length}</strong><br><span style="color:#6d746d;">GPU models</span></td>
            <td style="${cardStyle}"><strong style="font-size:20px;">${successfulProviders}/${results.length}</strong><br><span style="color:#6d746d;">sources succeeded</span></td>
            <td style="${cardStyle}"><strong style="font-size:20px;">${digest.movers.newRows}</strong><br><span style="color:#6d746d;">new rows</span></td>
          </tr>
        </table>
        ${failuresHtml}
        <h2 style="font-size:18px;margin:24px 0 8px 0;">Average Price By GPU</h2>
        ${renderMovementTable(digest.movementRows)}
        <h2 style="font-size:18px;margin:24px 0 8px 0;">Top Movers</h2>
        ${renderMoverTable("Biggest price drops", digest.movers.drops)}
        ${renderMoverTable("Biggest price increases", digest.movers.increases)}
        <h2 style="font-size:18px;margin:24px 0 8px 0;">Regional Price Heatmap</h2>
        ${renderHeatmap(digest.heatmapRows)}
        <h2 style="font-size:18px;margin:24px 0 8px 0;">Price Trend</h2>
        ${renderTrendChart(digest.trend)}
        <p style="margin:24px 0 0 0;color:#6d746d;font-size:12px;">This digest aggregates direct collected observations. Committed and reserved prices are stored in the app and available through filters, but omitted here to keep the morning email readable.</p>
      </div>
    </body>
  </html>`;
}

function renderText({ digest, failures, generatedAt, collected }) {
  const movementLines = digest.movementRows.map((row) => {
    const moves = LOOKBACKS.map((lookback) => `${lookback.label}: ${formatMaybe(row.comparisons[lookback.key]?.change, percent)}`).join(", ");
    return `- ${row.gpuModel}: ${formatMaybe(row.averagePrice, money)} avg across ${row.observations} rows (${moves})`;
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
    "Average price by GPU",
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
  const subject = `GPU rates: ${digest.movementRows.length} GPUs, ${scrapedRates.length} rows collected, ${failures.length} failures`;
  const text = renderText({ digest, failures, generatedAt, collected: scrapedRates.length });
  const html = renderHtml({
    digest,
    failures,
    generatedAt,
    results: summarizeCollection(results),
    collected: scrapedRates.length
  });
  const email = await sendEmail({ subject, text, html });

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
