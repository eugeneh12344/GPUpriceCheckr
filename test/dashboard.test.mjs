import test from "node:test";
import assert from "node:assert/strict";
import { buildDashboardSummary } from "../src/dashboard.mjs";

const rate = (overrides) => ({
  observedAt: "2026-06-28T12:00:00.000Z",
  provider: "AWS",
  providerType: "hyperscaler",
  gpuModel: "H100",
  gpuVariant: "",
  region: "us-east-1",
  commitment: "on-demand",
  pricePerGpuHour: 4,
  currency: "USD",
  sourceUrl: "https://example.com/source",
  sourceKind: "live",
  rawLabel: "",
  ...overrides
});

test("dashboard summary keeps first-load chart payload slim", () => {
  const rates = [
    rate({ observedAt: "2026-05-28T12:00:00.000Z", pricePerGpuHour: 5 }),
    rate({ pricePerGpuHour: 4 }),
    rate({ provider: "Zero Cloud", region: "us-west-2", pricePerGpuHour: 0 }),
    rate({ provider: "Google Cloud", region: "europe-west1", pricePerGpuHour: 6 }),
    rate({ provider: "Azure", gpuModel: "B200", region: "eastus", pricePerGpuHour: 8 }),
    rate({ provider: "AWS", gpuModel: "A100", region: "us-east-1", pricePerGpuHour: 2 }),
    rate({ provider: "Google Cloud", observedAt: "2026-06-27T12:00:00.000Z", commitment: "spot", pricePerGpuHour: 3.5 }),
    rate({ provider: "Google Cloud", commitment: "spot", pricePerGpuHour: 3 }),
    rate({ provider: "Ornn Market Index", providerType: "neocloud", observedAt: "2026-06-27T20:00:00.000Z", commitment: "market-index", sourceKind: "market-index", pricePerGpuHour: 2.5 }),
    rate({ provider: "Ornn Market Index", providerType: "neocloud", commitment: "market-index", sourceKind: "market-index", pricePerGpuHour: 2.7 })
  ];
  const meta = {
    range: { count: rates.length - 1 },
    gpus: ["H100", "B200", "A100"],
    regions: ["us-east-1", "europe-west1", "eastus"],
    providers: [{ provider: "AWS" }, { provider: "Google Cloud" }, { provider: "Azure" }]
  };

  const summary = buildDashboardSummary({
    meta,
    rates,
    generatedAt: new Date("2026-06-28T12:00:00.000Z")
  });

  assert.equal(summary.freshness.latestPricePull, "2026-06-28T12:00:00.000Z");
  assert.equal(summary.hero.observations, rates.length - 1);
  assert.equal(summary.hero.gpus, 3);
  assert.ok(summary.chartRows.length);
  assert.equal(summary.chartRows.some((row) => row.gpuModel === "A100"), false);
  assert.equal(summary.chartRows.some((row) => "sourceName" in row), false);
  assert.equal(summary.chartRows.some((row) => "aggregation" in row), false);
  assert.ok(summary.chartRows.every((row) => row.period === "day" && row.commitment === "on-demand"));
  assert.ok(summary.spotChartRows.every((row) => row.period === "day" && row.commitment === "spot"));
  assert.ok(summary.marketIndexRows.every((row) => row.period === "day" && row.commitment === "market-index"));
  assert.equal("heatmapRows" in summary, false);
  assert.equal("topMoverRows" in summary, false);
  assert.equal("cheapestRows" in summary, false);
  assert.equal("providerSpreadRows" in summary, false);
  assert.equal("commitmentRows" in summary, false);

  const h100 = summary.tableRows.find((row) => row.gpuModel === "H100");
  assert.equal(h100.directObservationCount, 2);
  assert.equal(h100.providerCount, 2);
  const h100Movement = summary.movementRows.find((row) => row.gpuModel === "H100");
  assert.equal(h100Movement.observations, 2);
  assert.equal(h100Movement.averagePrice, 5);
  assert.equal(summary.movementRows.some((row) => row.gpuModel === "A100"), false);
  assert.deepEqual(
    summary.spotChartRows.map((row) => [row.observedAt, row.gpuModel, row.pricePerGpuHour]),
    [
      ["2026-06-27T00:00:00.000Z", "H100", 3.5],
      ["2026-06-28T00:00:00.000Z", "H100", 3]
    ]
  );
  assert.deepEqual(
    summary.marketIndexRows.map((row) => [row.observedAt, row.gpuModel, row.pricePerGpuHour]),
    [
      ["2026-06-27T00:00:00.000Z", "H100", 2.5],
      ["2026-06-28T00:00:00.000Z", "H100", 2.7]
    ]
  );

});

test("dashboard graphics balance providers before combining prices", () => {
  const rates = [
    rate({ observedAt: "2026-06-20T12:00:00.000Z", provider: "AWS", region: "us-east-1", pricePerGpuHour: 2 }),
    rate({ provider: "AWS", region: "us-east-1", pricePerGpuHour: 4 }),
    rate({ provider: "AWS", region: "us-west-2", pricePerGpuHour: 100 }),
    rate({ provider: "Google Cloud", region: "europe-west1", pricePerGpuHour: 6 })
  ];
  const summary = buildDashboardSummary({
    meta: { range: { count: rates.length }, gpus: ["H100"], regions: [], providers: [] },
    rates,
    generatedAt: new Date("2026-06-28T12:00:00.000Z")
  });

  const movement = summary.movementRows.find((row) => row.gpuModel === "H100");
  const trendLatest = summary.tableRows.find((row) => row.gpuModel === "H100");
  assert.equal(movement.averagePrice, 29);
  assert.equal(movement.averagePrice, trendLatest.pricePerGpuHour);
  assert.notEqual(movement.averagePrice, (4 + 100 + 6) / 3);
  assert.deepEqual(
    summary.chartRows.filter((row) => row.gpuModel === "H100").map((row) => [row.observedAt, row.pricePerGpuHour]),
    [
      ["2026-06-20T00:00:00.000Z", 2],
      ["2026-06-28T00:00:00.000Z", 29]
    ]
  );
});

test("daily movement is anchored to the latest indexed day, not dashboard generation time", () => {
  const rates = [
    rate({ observedAt: "2026-06-27T12:00:00.000Z", pricePerGpuHour: 5 }),
    rate({ observedAt: "2026-06-28T12:00:00.000Z", pricePerGpuHour: 4 })
  ];
  const summary = buildDashboardSummary({
    meta: { range: { count: rates.length }, gpus: ["H100"], regions: ["us-east-1"], providers: [{ provider: "AWS" }] },
    rates,
    generatedAt: new Date("2026-06-30T12:00:00.000Z")
  });

  const movement = summary.movementRows.find((row) => row.gpuModel === "H100");
  assert.equal(movement.averagePrice, 4);
  assert.equal(movement.comparisons.day.change, -20);
});
