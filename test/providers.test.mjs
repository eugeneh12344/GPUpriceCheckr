import test from "node:test";
import assert from "node:assert/strict";
import { providerCatalog } from "../src/providers.mjs";
import { modelIndex, modelIndexMetadata } from "../src/model-index.mjs";

test("provider catalog includes both market classes", () => {
  const catalog = providerCatalog();
  assert.ok(catalog.some((provider) => provider.type === "hyperscaler"));
  assert.ok(catalog.some((provider) => provider.type === "neocloud"));
  assert.ok(catalog.filter((provider) => provider.archiveCapable).length >= 3);
});

test("AIMultiple model index contains the extracted 24-month series", () => {
  const observations = modelIndex();
  const metadata = modelIndexMetadata();
  assert.equal(observations.length, 199);
  assert.equal(metadata.models.length, 10);
  assert.deepEqual(
    observations
      .filter((row) => row.observedAt.startsWith("2026-06"))
      .reduce((prices, row) => ({ ...prices, [row.gpuModel]: row.pricePerGpuHour }), {}),
    {
      V100: 0.99,
      "RTX 5090": 0.66,
      MI300X: 2.72,
      B300: 7.92,
      B200: 6.11,
      "RTX 4090": 0.52,
      L40S: 1.56,
      A100: 1.79,
      H200: 4,
      H100: 2.99
    }
  );
});
