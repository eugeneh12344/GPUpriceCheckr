const DAY_MS = 24 * 60 * 60 * 1000;
const LOOKBACKS = [
  { key: "day", days: 1 },
  { key: "week", days: 7 },
  { key: "month", days: 30 },
  { key: "quarter", days: 90 },
  { key: "year", days: 365 }
];
const REGION_GROUPS = ["North America", "Europe", "Asia Pacific", "Middle East & Africa", "South America", "Global / Other"];
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

function matchedComparison(currentRows, allRates, cutoff) {
  const previousByKey = latestRateMap(allRates, cutoff);
  const pairs = currentRows
    .map((row) => ({ current: row, previous: previousByKey.get(rateKey(row)) }))
    .filter((pair) => pair.previous);
  if (!pairs.length) return null;
  return {
    change: pctChange(
      providerBalancedPrice(pairs.map((pair) => pair.current)),
      providerBalancedPrice(pairs.map((pair) => pair.previous))
    ),
    matched: pairs.length
  };
}

function regionGroup(region = "") {
  const value = region.toLowerCase();
  if (value === "global" || value === "north america") return value === "global" ? "Global / Other" : "North America";
  if (/^(us|ca|mx)-/.test(value) || value.includes("canada") || value.includes("eastus") || value.includes("westus") ||
      value.includes("centralus") || value.includes("southcentralus") || value.includes("northcentralus") ||
      value.includes("usgov") || value.includes("northamerica") || value.includes("mexico")) return "North America";
  if (/^(eu|europe)-/.test(value) || value.includes("europe") || value.includes("northeurope") || value.includes("westeurope") ||
      value.includes("uk") || value.includes("france") || value.includes("germany") || value.includes("norway") ||
      value.includes("poland") || value.includes("spain") || value.includes("sweden") || value.includes("switzerland") ||
      value.includes("italy")) return "Europe";
  if (/^(ap|asia|australia)-/.test(value) || value.includes("eastasia") || value.includes("southeastasia") ||
      value.includes("japan") || value.includes("korea") || value.includes("india") || value.includes("indonesia") ||
      value.includes("malaysia") || value.includes("australia") || value.includes("jioindia")) return "Asia Pacific";
  if (/^(me|africa)-/.test(value) || value.includes("uae") || value.includes("qatar") || value.includes("israel") ||
      value.includes("southafrica")) return "Middle East & Africa";
  if (/^(sa|southamerica)-/.test(value) || value.includes("brazil")) return "South America";
  return "Global / Other";
}

function monthKey(date) {
  return new Date(date).toISOString().slice(0, 7);
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
    const month = monthKey(row.observedAt);
    const key = `${month}|${row.gpuModel}`;
    const group = groups.get(key) || {
      month,
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
      providerCount: group.providerPrices.size,
      regionCount: group.rawRegionCount || group.regions.size,
      commitment
    }];
  }).toSorted((a, b) =>
    new Date(a.observedAt) - new Date(b.observedAt) ||
    a.gpuModel.localeCompare(b.gpuModel)
  );
}

function movementRows(currentRows, allRates, generatedAt) {
  const generatedTime = generatedAt.getTime();
  return [...groupBy(currentRows, (row) => row.gpuModel).entries()].map(([gpuModel, rows]) => ({
    gpuModel,
    averagePrice: providerBalancedPrice(rows),
    observations: rows.length,
    providerCount: new Set(rows.map((row) => row.provider)).size,
    regionCount: new Set(rows.map((row) => row.region)).size,
    comparisons: Object.fromEntries(LOOKBACKS.map((lookback) => [
      lookback.key,
      matchedComparison(rows, allRates, generatedTime - lookback.days * DAY_MS)
    ]))
  })).toSorted((a, b) =>
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

function topMoverRows(currentRows, allRates) {
  const previousByKey = previousRateMap(currentRows, allRates);
  return [...groupBy(currentRows, (row) => row.gpuModel).entries()].map(([gpuModel, rows]) => {
    const pairs = rows
      .map((current) => ({ current, previous: previousByKey.get(rateKey(current)) }))
      .filter((pair) => pair.previous);
    const currentPrice = providerBalancedPrice(pairs.map((pair) => pair.current));
    const previousPrice = providerBalancedPrice(pairs.map((pair) => pair.previous));
    return {
      gpuModel,
      pricePerGpuHour: currentPrice,
      previousPrice,
      deltaPercent: pctChange(currentPrice, previousPrice),
      providerCount: new Set(pairs.map((pair) => pair.current.provider)).size,
      observations: pairs.length
    };
  }).filter((row) => Number.isFinite(row.deltaPercent))
    .toSorted((a, b) => Math.abs(b.deltaPercent) - Math.abs(a.deltaPercent))
    .slice(0, 8);
}

function regionalHeatmapRows(currentRows) {
  return [...groupBy(currentRows, (row) => row.gpuModel).entries()]
    .toSorted((a, b) => priorityIndex(a[0]) - priorityIndex(b[0]) || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([gpuModel, rows]) => {
      const modelMedian = providerBalancedPrice(rows);
      const cells = Object.fromEntries(REGION_GROUPS.map((group) => {
        const groupAverage = providerBalancedPrice(rows.filter((row) => regionGroup(row.region) === group));
        return [group, {
          averagePrice: groupAverage,
          relativeToMedian: Number.isFinite(modelMedian) && Number.isFinite(groupAverage)
            ? groupAverage / modelMedian
            : null
        }];
      }));
      const prices = Object.values(cells).map((cell) => cell.averagePrice).filter(Number.isFinite);
      const minPrice = prices.length ? Math.min(...prices) : null;
      const maxPrice = prices.length ? Math.max(...prices) : null;
      for (const cell of Object.values(cells)) {
        cell.priceScore = Number.isFinite(cell.averagePrice) && Number.isFinite(minPrice) && Number.isFinite(maxPrice)
          ? maxPrice > minPrice
            ? (cell.averagePrice - minPrice) / (maxPrice - minPrice)
            : 0.5
          : null;
      }
      return { gpuModel, cells };
    });
}

function cheapestRegionRows(currentRows) {
  return [...groupBy(currentRows, (row) => row.gpuModel).entries()]
    .map(([gpuModel, rows]) => {
      const regions = [...groupBy(rows, (row) => row.region).entries()].map(([region, regionRows]) => ({
        region,
        pricePerGpuHour: providerBalancedPrice(regionRows),
        provider: "Provider-balanced index",
        providerCount: new Set(regionRows.map((row) => row.provider)).size
      }));
      return {
        gpuModel,
        picks: regions.filter((row) => Number.isFinite(priceValue(row)))
          .toSorted((a, b) => priceValue(a) - priceValue(b))
          .slice(0, 3)
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
        .map(([provider, providerRows]) => ({ provider, medianPrice: median(providerRows.map(priceValue)) }))
        .filter((row) => Number.isFinite(row.medianPrice))
        .toSorted((a, b) => a.medianPrice - b.medianPrice);
      const low = providers[0];
      const high = providers.at(-1);
      return { gpuModel, providers, low, high, rangePercent: low && high ? pctChange(high.medianPrice, low.medianPrice) : null };
    })
    .filter((row) => row.providers.length >= 2)
    .toSorted((a, b) => Math.abs(b.rangePercent || 0) - Math.abs(a.rangePercent || 0) || priorityIndex(a.gpuModel) - priorityIndex(b.gpuModel))
    .slice(0, 7);
}

function commitmentDiscountRows(rows) {
  return [...groupBy([...latestRateMap(rows).values()], (row) => row.gpuModel).entries()]
    .map(([gpuModel, gpuRows]) => {
      const onDemand = providerBalancedPrice(gpuRows.filter((row) => row.commitment === "on-demand"));
      const bestCommitted = [...groupBy(
        gpuRows.filter((row) => row.commitment !== "on-demand"),
        (row) => row.commitment
      ).entries()].map(([commitment, commitmentRows]) => ({
        commitment,
        provider: "Provider-balanced index",
        pricePerGpuHour: providerBalancedPrice(commitmentRows)
      })).filter((row) => Number.isFinite(priceValue(row)))
        .toSorted((a, b) => priceValue(a) - priceValue(b))[0];
      return {
        gpuModel,
        onDemand,
        bestCommitted,
        discount: bestCommitted && Number.isFinite(onDemand)
          ? (1 - priceValue(bestCommitted) / onDemand) * 100
          : null
      };
    })
    .filter((row) => row.bestCommitted && Number.isFinite(row.discount))
    .toSorted((a, b) => b.discount - a.discount || priorityIndex(a.gpuModel) - priorityIndex(b.gpuModel))
    .slice(0, 7);
}

function latestPriceTimestamp(rates) {
  const validRows = rates.filter((row) => Number.isFinite(observedTime(row)) && Number.isFinite(priceValue(row)));
  const liveRows = validRows.filter((row) => row.sourceKind === "live");
  const sourceRows = liveRows.length ? liveRows : validRows.filter((row) => row.sourceKind !== "benchmark-seed");
  const rows = sourceRows.length ? sourceRows : validRows;
  return rows.toSorted((a, b) => observedTime(b) - observedTime(a))[0]?.observedAt || null;
}

function isDiscountCandidate(row) {
  return row.commitment !== "market-index" && row.sourceKind !== "market-index";
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
    pricePerGpuHour: row.pricePerGpuHour
  }));
  const spotChartRows = fullSpotChartRows.map((row) => ({
    observedAt: row.observedAt,
    gpuModel: row.gpuModel,
    group: row.group,
    pricePerGpuHour: row.pricePerGpuHour
  }));
  const marketIndexRows = fullMarketIndexRows.map((row) => ({
    observedAt: row.observedAt,
    gpuModel: row.gpuModel,
    group: row.group,
    pricePerGpuHour: row.pricePerGpuHour
  }));
  const defaultPanelRates = directPanelRates.filter((row) => isDefaultGpu(row.gpuModel));

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
    movementRows: movementRows(currentRows, onDemandRows, generatedAt),
    spotChartRows,
    marketIndexRows,
    spotMovementRows: movementRows(currentSpotRows, spotRows, generatedAt),
    heatmapRows: regionalHeatmapRows(currentRows),
    topMoverRows: topMoverRows(currentRows, onDemandRows),
    cheapestRows: cheapestRegionRows(currentRows),
    providerSpreadRows: providerSpreadRows(currentRows),
    commitmentRows: commitmentDiscountRows(defaultPanelRates.filter(isDiscountCandidate))
  };
}
