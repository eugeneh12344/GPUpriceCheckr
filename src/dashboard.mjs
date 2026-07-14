const DAY_MS = 24 * 60 * 60 * 1000;
const LOOKBACKS = [
  { key: "day", days: 1 },
  { key: "week", days: 7 },
  { key: "month", days: 30 },
  { key: "quarter", days: 90 },
  { key: "year", days: 365 }
];
const GROUPS = {
  "last-released": ["B200", "B300", "MI300X", "RTX 5090", "GB200", "GB300"],
  modern: ["H100", "H200", "GH200", "A100", "L40S", "L40", "L4", "A10", "RTX 4090"],
  legacy: ["V100", "P100", "T4"]
};
const DEFAULT_GPU_MODELS = ["H100", "H200", "GH200", "B200", "B300", "GB200", "GB300"];
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

function pctChange(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

function observedTime(row) {
  return new Date(row.observedAt).getTime();
}

function priceValue(row) {
  const price = Number(row.pricePerGpuHour);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function rateKey(row) {
  return [row.provider, row.gpuModel, row.gpuVariant || "", row.region, row.commitment].join("|");
}

function priorityIndex(gpuModel) {
  const index = GPU_PRIORITY.indexOf(gpuModel);
  return index === -1 ? GPU_PRIORITY.length : index;
}

function isDefaultGpu(gpuModel) {
  return DEFAULT_GPU_MODELS.includes(gpuModel);
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

function latestRateMap(rates, cutoff = Infinity) {
  const latest = new Map();
  for (const row of rates) {
    if (!Number.isFinite(priceValue(row))) continue;
    const time = observedTime(row);
    if (!Number.isFinite(time) || time > cutoff) continue;
    const key = rateKey(row);
    const current = latest.get(key);
    if (!current || time > observedTime(current)) latest.set(key, row);
  }
  return latest;
}

function dayKey(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function latestByModel(rows) {
  const latest = new Map();
  for (const row of rows) {
    const existing = latest.get(row.gpuModel);
    if (!existing || new Date(row.observedAt) > new Date(existing.observedAt)) latest.set(row.gpuModel, row);
  }
  return [...latest.values()];
}

function directIndexObservations(rates) {
  const groups = new Map();
  for (const row of rates) {
    if (!Number.isFinite(priceValue(row))) continue;
    const day = dayKey(row.observedAt);
    const key = `${day}|${row.gpuModel}`;
    const group = groups.get(key) || {
      day,
      gpuModel: row.gpuModel,
      providerPrices: new Map(),
      sourceUrls: new Set(),
      regions: new Set(),
      commitments: new Set(),
      rawRegionCount: 0,
      rows: 0
    };
    const providerRows = group.providerPrices.get(row.provider) || [];
    providerRows.push(priceValue(row));
    group.providerPrices.set(row.provider, providerRows);
    group.sourceUrls.add(row.sourceUrl);
    group.regions.add(row.region);
    group.commitments.add(row.commitment);
    group.rawRegionCount = Math.max(group.rawRegionCount, Number(row.regionCount || 0));
    group.rows += Number(row.directObservationCount || 1);
    groups.set(key, group);
  }

  return [...groups.values()].flatMap((group) => {
    const price = median([...group.providerPrices.values()].map(median).filter((value) => value != null));
    if (price == null) return [];
    const commitment = group.commitments.size === 1 ? [...group.commitments][0] : "mixed";
    return [{
      observedAt: `${group.day}T00:00:00.000Z`,
      gpuModel: group.gpuModel,
      group: groupForGpu(group.gpuModel),
      pricePerGpuHour: price,
      currency: "USD",
      aggregation: "daily-median-of-provider-medians",
      billingType: commitment,
      sourceName: "Collected Source Index",
      sourceUrl: [...group.sourceUrls][0] || "",
      directObservationCount: group.rows,
      providerCount: group.providerPrices.size,
      regionCount: group.rawRegionCount || group.regions.size,
      commitment
    }];
  }).toSorted((a, b) =>
    new Date(a.observedAt) - new Date(b.observedAt) ||
    a.gpuModel.localeCompare(b.gpuModel)
  );
}

function indexComparison(currentRow, indexRows, lookbackDays) {
  if (!currentRow) return null;
  const cutoff = observedTime(currentRow) - lookbackDays * DAY_MS;
  const previousRow = indexRows
    .filter((row) => row.gpuModel === currentRow.gpuModel && observedTime(row) <= cutoff)
    .toSorted((a, b) => observedTime(b) - observedTime(a))[0];
  if (!previousRow) return null;
  return {
    change: pctChange(priceValue(currentRow), priceValue(previousRow)),
    matched: Math.min(
      Number(currentRow.directObservationCount || 1),
      Number(previousRow.directObservationCount || 1)
    )
  };
}

function movementRows(currentRows, indexRows = []) {
  const currentIndexByModel = new Map(latestByModel(indexRows).map((row) => [row.gpuModel, row]));
  return [...groupBy(currentRows, (row) => row.gpuModel).entries()].map(([gpuModel, rows]) => {
    const indexRow = currentIndexByModel.get(gpuModel);
    return {
      gpuModel,
      averagePrice: Number.isFinite(priceValue(indexRow)) ? priceValue(indexRow) : providerBalancedPrice(rows),
      observations: Number(indexRow?.directObservationCount || rows.length),
      providerCount: Number(indexRow?.providerCount || new Set(rows.map((row) => row.provider)).size),
      regionCount: Number(indexRow?.regionCount || new Set(rows.map((row) => row.region)).size),
      comparisons: Object.fromEntries(LOOKBACKS.map((lookback) => [
        lookback.key,
        indexComparison(indexRow, indexRows, lookback.days)
      ]))
    };
  }).toSorted((a, b) =>
    priorityIndex(a.gpuModel) - priorityIndex(b.gpuModel) ||
    b.observations - a.observations ||
    a.gpuModel.localeCompare(b.gpuModel)
  );
}

function directDailyIndexObservations(rates, commitment = "spot", aggregation = "daily-median-of-provider-medians") {
  const groups = new Map();
  for (const row of rates) {
    if (!Number.isFinite(priceValue(row))) continue;
    const day = dayKey(row.observedAt);
    const key = `${day}|${row.gpuModel}`;
    const group = groups.get(key) || {
      day,
      gpuModel: row.gpuModel,
      providerPrices: new Map()
    };
    const providerRows = group.providerPrices.get(row.provider) || [];
    providerRows.push(priceValue(row));
    group.providerPrices.set(row.provider, providerRows);
    groups.set(key, group);
  }

  return [...groups.values()].flatMap((group) => {
    const price = median([...group.providerPrices.values()].map(median).filter((value) => value != null));
    if (price == null) return [];
    return [{
      observedAt: `${group.day}T00:00:00.000Z`,
      gpuModel: group.gpuModel,
      group: groupForGpu(group.gpuModel),
      pricePerGpuHour: price,
      currency: "USD",
      aggregation,
      billingType: commitment,
      directObservationCount: [...group.providerPrices.values()].reduce((sum, rows) => sum + rows.length, 0),
      providerCount: group.providerPrices.size,
      commitment
    }];
  }).toSorted((a, b) =>
    new Date(a.observedAt) - new Date(b.observedAt) ||
    a.gpuModel.localeCompare(b.gpuModel)
  );
}

function latestPriceTimestamp(rates) {
  const validRows = rates.filter((row) => Number.isFinite(observedTime(row)) && Number.isFinite(priceValue(row)));
  const liveRows = validRows.filter((row) => row.sourceKind === "live");
  const sourceRows = liveRows.length ? liveRows : validRows.filter((row) => row.sourceKind !== "benchmark-seed");
  const rows = sourceRows.length ? sourceRows : validRows;
  return rows.toSorted((a, b) => observedTime(b) - observedTime(a))[0]?.observedAt || null;
}

export function buildDashboardSummary({ meta, rates, chartRates = rates, panelRates = rates, generatedAt = new Date() }) {
  const directPanelRates = panelRates.filter((row) => row.sourceKind !== "benchmark-seed");
  const onDemandRows = directPanelRates.filter((row) => row.commitment === "on-demand");
  const currentRows = [...latestRateMap(onDemandRows).values()].filter((row) => isDefaultGpu(row.gpuModel));
  const spotRows = directPanelRates.filter((row) => row.commitment === "spot");
  const currentSpotRows = [...latestRateMap(spotRows).values()].filter((row) => isDefaultGpu(row.gpuModel));
  const chartCutoff = new Date(Date.UTC(generatedAt.getUTCFullYear(), generatedAt.getUTCMonth() - 24, 1));
  const fullChartRows = directIndexObservations(chartRates.filter((row) => row.commitment === "on-demand"))
    .filter((row) => isDefaultGpu(row.gpuModel) && new Date(row.observedAt) >= chartCutoff);
  const fullSpotChartRows = directDailyIndexObservations(chartRates.filter((row) => row.commitment === "spot"))
    .filter((row) => isDefaultGpu(row.gpuModel) && new Date(row.observedAt) >= chartCutoff);
  const fullMarketIndexRows = directDailyIndexObservations(
    chartRates.filter((row) => row.commitment === "market-index"),
    "market-index",
    "external-daily-market-index"
  ).filter((row) => isDefaultGpu(row.gpuModel) && new Date(row.observedAt) >= chartCutoff);
  const chartRows = fullChartRows.map((row) => ({
    observedAt: row.observedAt,
    gpuModel: row.gpuModel,
    group: row.group,
    pricePerGpuHour: row.pricePerGpuHour,
    period: "day",
    commitment: "on-demand"
  }));
  const spotChartRows = fullSpotChartRows.map((row) => ({
    observedAt: row.observedAt,
    gpuModel: row.gpuModel,
    group: row.group,
    pricePerGpuHour: row.pricePerGpuHour,
    period: "day",
    commitment: "spot"
  }));
  const marketIndexRows = fullMarketIndexRows.map((row) => ({
    observedAt: row.observedAt,
    gpuModel: row.gpuModel,
    group: row.group,
    pricePerGpuHour: row.pricePerGpuHour,
    period: "day",
    commitment: "market-index"
  }));
  return {
    freshness: { latestPricePull: latestPriceTimestamp(panelRates.length ? panelRates : rates) },
    hero: {
      observations: Number(meta.range?.count || rates.length),
      gpus: meta.gpus?.length || new Set(rates.map((row) => row.gpuModel)).size,
      regions: meta.regions?.length || new Set(rates.map((row) => row.region)).size,
      sources: meta.providers?.length || new Set(rates.map((row) => row.provider)).size
    },
    chartRows,
    tableRows: latestByModel(fullChartRows).toSorted((a, b) => priceValue(b) - priceValue(a)),
    movementRows: movementRows(currentRows, fullChartRows),
    spotChartRows,
    marketIndexRows,
    spotMovementRows: movementRows(currentSpotRows, fullSpotChartRows)
  };
}
