import test from "node:test";
import assert from "node:assert/strict";
import { __test } from "../src/report.mjs";

const baseRate = (overrides) => ({
  observedAt: "2026-06-28T12:00:00.000Z",
  provider: "AWS",
  providerType: "hyperscaler",
  gpuModel: "H100",
  gpuVariant: "",
  region: "us-east-1",
  commitment: "on-demand",
  pricePerGpuHour: 4.2,
  currency: "USD",
  sourceUrl: "https://example.com/source",
  sourceKind: "live",
  rawLabel: "",
  ...overrides
});

test("daily report digest summarizes movement and new rows", () => {
  const generatedAt = "2026-06-28T12:00:00.000Z";
  const previousRates = [
    baseRate({ observedAt: "2026-06-20T00:00:00.000Z", pricePerGpuHour: 5 }),
    baseRate({ observedAt: "2026-06-27T00:00:00.000Z", pricePerGpuHour: 4.8 })
  ];
  const scrapedRates = [
    baseRate({ pricePerGpuHour: 4.2 }),
    baseRate({ provider: "Zero Cloud", region: "us-west-2", pricePerGpuHour: 0 }),
    baseRate({ provider: "Google Cloud", region: "us-central1", pricePerGpuHour: 4.8 }),
    baseRate({ provider: "Azure", gpuModel: "B200", region: "eastus", pricePerGpuHour: 6.2 })
  ];
  const changes = __test.enrichChanges(scrapedRates, previousRates);
  const digest = __test.buildDigest({ scrapedRates, previousRates, changes, generatedAt });

  const h100 = digest.movementRows.find((row) => row.gpuModel === "H100");
  assert.equal(h100.observations, 2);
  assert.equal(h100.providerCount, 2);
  assert.equal(h100.averagePrice, 4.5);
  assert.equal(h100.averagePrice, digest.trend.series[0].values.at(-1));
  assert.deepEqual(
    ["2026-06-20", "2026-06-27", "2026-06-28"].map((day) =>
      digest.trend.series[0].values[digest.trend.days.indexOf(day)]
    ),
    [5, 4.8, 4.5]
  );
  assert.equal(Math.round(h100.comparisons.day.change * 10) / 10, -12.5);
  assert.equal(Math.round(h100.comparisons.week.change * 10) / 10, -16);
  assert.equal(digest.movers.drops.length, 1);
  assert.equal(digest.movers.newRows, 2);
  assert.equal(__test.regionGroup("europe-west4"), "Europe");
  assert.equal(__test.regionGroup("asia-southeast1"), "Asia Pacific");

  const html = __test.renderHtml({
    digest,
    failures: [],
    generatedAt,
    results: [{ provider: "googleCloud", status: "success", records: 2 }],
    collected: scrapedRates.length
  });
  assert.match(html, /Provider-Balanced Index By GPU/);
  assert.match(html, /Regional Price Heatmap/);
  assert.match(html, /Price Trend/);
  assert.doesNotMatch(html, /Collected rates<\/h2>/);
});

test("daily email graphics use the provider-balanced index", () => {
  const generatedAt = "2026-06-28T12:00:00.000Z";
  const scrapedRates = [
    baseRate({ provider: "AWS", region: "us-east-1", pricePerGpuHour: 4 }),
    baseRate({ provider: "AWS", region: "us-west-2", pricePerGpuHour: 100 }),
    baseRate({ provider: "Google Cloud", region: "europe-west1", pricePerGpuHour: 6 })
  ];
  const changes = __test.enrichChanges(scrapedRates, []);
  const digest = __test.buildDigest({ scrapedRates, previousRates: [], changes, generatedAt });

  const movement = digest.movementRows.find((row) => row.gpuModel === "H100");
  assert.equal(movement.averagePrice, 29);
  assert.notEqual(movement.averagePrice, (4 + 100 + 6) / 3);
  assert.equal(digest.heatmapRows[0].cells["North America"].averagePrice, 52);
  assert.equal(digest.heatmapRows[0].cells.Europe.averagePrice, 6);
  assert.equal(digest.trend.series[0].values.at(-1), 29);
});
