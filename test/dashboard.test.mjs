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
    rate({ provider: "Google Cloud", region: "us-central1", pricePerGpuHour: 6 }),
    rate({ provider: "Azure", gpuModel: "B200", region: "eastus", pricePerGpuHour: 8 })
  ];
  const meta = {
    range: { count: rates.length },
    gpus: ["H100", "B200"],
    regions: ["us-east-1", "us-central1", "eastus"],
    providers: [{ provider: "AWS" }, { provider: "Google Cloud" }, { provider: "Azure" }]
  };

  const summary = buildDashboardSummary({
    meta,
    rates,
    generatedAt: new Date("2026-06-28T12:00:00.000Z")
  });

  assert.equal(summary.freshness.latestPricePull, "2026-06-28T12:00:00.000Z");
  assert.equal(summary.hero.observations, rates.length);
  assert.equal(summary.hero.gpus, 2);
  assert.ok(summary.chartRows.length);
  assert.equal(summary.chartRows.some((row) => "sourceName" in row), false);
  assert.equal(summary.chartRows.some((row) => "aggregation" in row), false);

  const h100 = summary.tableRows.find((row) => row.gpuModel === "H100");
  assert.equal(h100.directObservationCount, 2);
  assert.equal(h100.providerCount, 2);
  assert.ok(summary.movementRows.some((row) => row.gpuModel === "H100"));
});
