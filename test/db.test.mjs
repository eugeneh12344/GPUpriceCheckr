import test from "node:test";
import assert from "node:assert/strict";
import { listReportRates, saveRates } from "../src/db.mjs";

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
