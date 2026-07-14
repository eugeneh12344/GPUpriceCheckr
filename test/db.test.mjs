import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "gpu-rate-index-test-"));
const {
  backfillConfirmedAwsCatalogGaps,
  dashboardSummaryData,
  listRates,
  listReportRates,
  saveRates
} = await import("../src/db.mjs");

const reportRate = (observedAt, commitment = "on-demand") => ({
  observedAt,
  provider: "Report Query Test",
  providerType: "neocloud",
  gpuModel: "H100",
  gpuVariant: "test",
  region: "test-region",
  commitment,
  pricePerGpuHour: 1,
  currency: "USD",
  sourceUrl: "https://example.com/report-query-test",
  sourceKind: "test",
  rawLabel: "report query test"
});

test("report history keeps one baseline plus one year of on-demand rows", () => {
  saveRates([
    reportRate("2028-01-01T00:00:00.000Z"),
    reportRate("2028-12-31T00:00:00.000Z"),
    reportRate("2029-06-01T00:00:00.000Z"),
    reportRate("2029-06-01T00:00:00.000Z", "reserved-1-year")
  ]);

  const rows = listReportRates("2030-01-01T00:00:00.000Z")
    .filter((rate) => rate.provider === "Report Query Test");

  assert.deepEqual(rows.map((rate) => rate.observedAt), [
    "2028-12-31T00:00:00.000Z",
    "2029-06-01T00:00:00.000Z"
  ]);
  assert.ok(rows.every((rate) => rate.commitment === "on-demand"));
});

test("dashboard chart rows calculate provider medians before the cross-provider index", () => {
  saveRates([
    { ...reportRate("2030-06-01T00:00:00.000Z"), provider: "Chart Provider A", region: "a-1", pricePerGpuHour: 4 },
    { ...reportRate("2030-06-01T00:00:00.000Z"), provider: "Chart Provider A", region: "a-2", pricePerGpuHour: 100 },
    { ...reportRate("2030-06-01T00:00:00.000Z"), provider: "Chart Provider B", region: "b-1", pricePerGpuHour: 6 }
  ]);

  const providerRows = dashboardSummaryData(new Date("2030-06-15T00:00:00.000Z")).chartRates
    .filter((row) => row.observedAt === "2030-06-01T00:00:00.000Z" && row.gpuModel === "H100")
    .filter((row) => row.provider.startsWith("Chart Provider"));

  assert.deepEqual(
    providerRows.map((row) => [row.provider, row.pricePerGpuHour]),
    [["Chart Provider A", 52], ["Chart Provider B", 6]]
  );
});

test("AWS catalog gaps are backfilled only when surrounding prices confirm no change", () => {
  const awsRate = (observedAt, pricePerGpuHour, region = "us-east-1") => ({
    observedAt,
    provider: "AWS",
    providerType: "hyperscaler",
    gpuModel: "B300",
    gpuVariant: "p6-b300.48xlarge",
    region,
    commitment: "on-demand",
    pricePerGpuHour,
    currency: "USD",
    sourceUrl: "https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/using-price-list-query-api.html",
    sourceKind: "api",
    rawLabel: "p6-b300.48xlarge"
  });
  saveRates([
    awsRate("2030-07-11T12:00:00.000Z", 17.802),
    awsRate("2030-07-14T12:00:00.000Z", 17.802),
    awsRate("2030-07-11T12:00:00.000Z", 20, "us-west-2"),
    awsRate("2030-07-14T12:00:00.000Z", 21, "us-west-2")
  ]);

  assert.equal(backfillConfirmedAwsCatalogGaps({ now: "2030-07-15T00:00:00.000Z" }), 2);
  const backfills = listRates({ provider: "AWS", gpu: "B300" })
    .filter((row) => row.sourceKind === "confirmed-backfill");

  assert.deepEqual(
    backfills.map((row) => [row.observedAt, row.region, row.pricePerGpuHour]),
    [
      ["2030-07-12T12:00:00.000Z", "us-east-1", 17.802],
      ["2030-07-13T12:00:00.000Z", "us-east-1", 17.802]
    ]
  );
});
