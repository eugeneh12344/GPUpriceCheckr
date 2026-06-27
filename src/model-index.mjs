const SOURCE_URL = "https://aimultiple.com/gpu-index#price-trends-by-gpu-model";

const SERIES = {
  V100: [1.84, 1.37, 1.37, 1.86, 1.16, 1.16, 1.16, 1.16, 1.16, 1.36, 1.16, 1.16, 1.37, 0.94, 0.9, 0.9, 0.9, 1.16, 1.16, 1.37, 0.94, 0.97, 0.97, 0.99],
  "RTX 5090": [null, null, null, null, null, null, null, null, null, 0.89, 0.9, 0.9, 0.88, 0.69, 0.59, 0.59, 0.5, 0.5, 0.63, 0.55, 0.47, 0.65, 0.67, 0.66],
  MI300X: [null, null, 3.99, 2.12, 2.12, 1.87, 1.87, 1.87, 1.87, 2.99, 2.99, 2.99, 3.07, 3, 3, 3, 3, 3, 3, 2.72, 3.45, 2.72, 2.72, 2.72],
  B300: [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 5.45, 5.45, 5.45, 6.12, 7.62, 6.99, 7.82, 7.92],
  B200: [null, null, null, null, null, null, null, null, null, 4.9, 5.31, 5.11, 6.36, 5.75, 5.74, 5.74, 5.45, 5.45, 5.43, 5.32, 5.5, 5.5, 5.5, 6.11],
  "RTX 4090": [null, null, 0.44, 0.44, 0.44, 0.56, 0.56, 0.56, 0.56, 0.58, 0.64, 0.65, 0.6, 0.56, 0.52, 0.52, 0.55, 0.53, 0.49, 0.49, 0.46, 0.47, 0.51, 0.52],
  L40S: [1.79, 1.79, 1.45, 1.41, 1.45, 1.45, 1.45, 1.45, 1.45, 1.41, 1.45, 1.5, 1.55, 1.29, 1.28, 1.28, 1.41, 1.54, 1.41, 1.57, 1.57, 1.57, 1.56, 1.56],
  A100: [3.07, 2.7, 2.6, 2.34, 2.08, 2.08, 2.08, 2.08, 2.08, 1.96, 1.83, 1.77, 1.75, 1.69, 1.67, 1.67, 1.71, 1.67, 1.67, 1.76, 1.76, 1.82, 1.82, 1.79],
  H200: [null, null, null, 3.59, 3.09, 2.81, 2.81, 2.75, 2.75, 2.89, 3.51, 3.3, 3.58, 3.5, 3.5, 3.5, 3.5, 3.5, 3.5, 3.5, 3.5, 3.5, 3.5, 4],
  H100: [3.02, 3.13, 3.02, 2.99, 2.98, 2.98, 2.99, 2.99, 2.99, 2.98, 2.99, 2.99, 2.99, 3, 2.98, 2.99, 2.99, 2.99, 2.99, 2.98, 2.91, 2.98, 2.99, 2.99]
};

const GROUPS = {
  "last-released": ["B200", "B300", "MI300X", "RTX 5090"],
  modern: ["H100", "H200", "A100", "L40S", "RTX 4090"],
  legacy: ["V100"]
};

function monthAt(index) {
  return new Date(Date.UTC(2024, 6 + index, 1)).toISOString();
}

export function modelIndex() {
  const modelGroup = Object.fromEntries(
    Object.entries(GROUPS).flatMap(([group, models]) => models.map((model) => [model, group]))
  );
  return Object.entries(SERIES).flatMap(([gpuModel, prices]) =>
    prices.flatMap((price, index) => price == null ? [] : [{
      observedAt: monthAt(index),
      gpuModel,
      group: modelGroup[gpuModel],
      pricePerGpuHour: price,
      currency: "USD",
      aggregation: "median-of-provider-medians",
      billingType: "on-demand",
      sourceName: "AIMultiple GPU Index",
      sourceUrl: SOURCE_URL
    }])
  );
}

export function modelIndexMetadata() {
  const observations = modelIndex();
  return {
    sourceName: "AIMultiple GPU Index",
    sourceUrl: SOURCE_URL,
    publishedAt: "2026-06-17T00:00:00.000Z",
    period: {
      first: observations[0].observedAt,
      last: observations.at(-1).observedAt
    },
    models: Object.keys(SERIES),
    groups: GROUPS,
    observationCount: observations.length,
    methodology: "Monthly on-demand median across provider-level medians. Physical variants of a model are grouped under one GPU name."
  };
}
