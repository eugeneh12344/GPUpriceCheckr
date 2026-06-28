import test from "node:test";
import assert from "node:assert/strict";
import { __test, providerCatalog } from "../src/providers.mjs";
import { modelIndex, modelIndexMetadata } from "../src/model-index.mjs";

test("provider catalog includes both market classes", () => {
  const catalog = providerCatalog();
  assert.ok(catalog.some((provider) => provider.type === "hyperscaler"));
  assert.ok(catalog.some((provider) => provider.type === "neocloud"));
  assert.ok(catalog.some((provider) => provider.id === "aws"));
  assert.ok(catalog.some((provider) => provider.id === "googleCloud"));
  assert.ok(catalog.filter((provider) => provider.archiveCapable).length >= 3);
});

test("Azure rows normalize VM prices to per-GPU hourly rates", () => {
  const rates = __test.ratesFromAzureRow({
    type: "Consumption",
    armSkuName: "Standard_NC48ads_A100_v4",
    productName: "Virtual Machines NCadsA100v4 Series",
    skuName: "NC48ads A100 v4",
    meterName: "NC48ads A100 v4",
    armRegionName: "eastus2",
    retailPrice: 7.346,
    savingsPlan: [{ term: "3 Years", retailPrice: 4.5317474 }]
  }, "2026-06-27T00:00:00.000Z");

  assert.equal(rates.find((rate) => rate.commitment === "on-demand").pricePerGpuHour, 3.673);
  assert.equal(rates.find((rate) => rate.commitment === "savings-plan-3-year").pricePerGpuHour, 2.2658737);

  const rtxRates = __test.ratesFromAzureRow({
    type: "Consumption",
    armSkuName: "Standard_NC320lds_xl_RTXPRO6000BSE_v6",
    productName: "Virtual Machines NCv6 RTX Pro 6000 Series",
    skuName: "NC320lds xl RTXPRO6000BSE v6",
    meterName: "NC320lds xl RTXPRO6000BSE v6",
    armRegionName: "eastus2",
    retailPrice: 22.88
  }, "2026-06-27T00:00:00.000Z");

  assert.equal(rtxRates[0].pricePerGpuHour, 2.86);
});

test("AWS products emit on-demand and reserved per-GPU rates", () => {
  const rates = __test.ratesFromAwsProduct({
    product: {
      attributes: {
        instanceType: "p5.48xlarge",
        physicalProcessor: "NVIDIA H100 Tensor Core GPU",
        gpu: "8",
        regionCode: "us-east-1",
        capacitystatus: "Used"
      }
    },
    terms: {
      OnDemand: {
        abc: { priceDimensions: { one: { unit: "Hrs", pricePerUnit: { USD: "98.32" } } } }
      },
      Reserved: {
        def: {
          termAttributes: { LeaseContractLength: "1yr", PurchaseOption: "No Upfront" },
          priceDimensions: { one: { unit: "Hrs", pricePerUnit: { USD: "64" } } }
        }
      }
    }
  }, "2026-06-27T00:00:00.000Z");

  assert.equal(rates.find((rate) => rate.commitment === "on-demand").pricePerGpuHour, 12.29);
  assert.equal(rates.find((rate) => rate.commitment === "reserved-1-year-no-upfront").pricePerGpuHour, 8);
});

test("Google Cloud SKUs map hourly accelerator prices across service regions", () => {
  const rates = __test.ratesFromGoogleSku({
    skuId: "abc123",
    description: "Nvidia Tesla H100 GPU running in Americas",
    serviceRegions: ["us-central1", "us-east1"],
    category: { usageType: "Commit1Yr" },
    pricingInfo: [{
      pricingExpression: {
        usageUnit: "h",
        baseUnitConversionFactor: 1,
        tieredRates: [{ unitPrice: { units: "4", nanos: 500000000 } }]
      }
    }]
  }, "2026-06-27T00:00:00.000Z", "https://cloudbilling.googleapis.com/v1/services/6F81-5844-456A/skus?currencyCode=USD");

  assert.equal(rates.length, 2);
  assert.equal(rates[0].provider, "Google Cloud");
  assert.equal(rates[0].gpuModel, "H100");
  assert.equal(rates[0].commitment, "committed-1-year");
  assert.equal(rates[0].pricePerGpuHour, 4.5);
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
