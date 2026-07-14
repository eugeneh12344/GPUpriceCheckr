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
  assert.ok(catalog.some((provider) => provider.id === "ornn"));
  assert.ok(catalog.some((provider) => provider.id === "vast"));
  assert.ok(catalog.some((provider) => provider.id === "runpodMarket"));
  assert.ok(catalog.some((provider) => provider.id === "tensorDock" && provider.optional));
  assert.ok(catalog.filter((provider) => provider.archiveCapable).length >= 3);
  assert.equal(__test.defaultProviderIds().includes("tensorDock"), false);
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

test("AWS region discovery excludes Local and Wavelength Zones", () => {
  assert.equal(__test.isAwsRegionCode("us-east-1"), true);
  assert.equal(__test.isAwsRegionCode("us-gov-west-1"), true);
  assert.equal(__test.isAwsRegionCode("ap-northeast-1-tpe-1"), false);
  assert.equal(__test.isAwsRegionCode("us-east-1-wl1-bos-wlz-1"), false);
});

test("AWS spot history rows normalize instance spot prices to per-GPU hourly rates", () => {
  const rates = __test.ratesFromAwsSpotHistoryXml(`
    <DescribeSpotPriceHistoryResponse>
      <spotPriceHistorySet>
        <item>
          <instanceType>p5.48xlarge</instanceType>
          <productDescription>Linux/UNIX</productDescription>
          <spotPrice>32.00</spotPrice>
          <timestamp>2026-07-05T20:00:00.000Z</timestamp>
          <availabilityZone>us-east-1a</availabilityZone>
        </item>
      </spotPriceHistorySet>
    </DescribeSpotPriceHistoryResponse>
  `, "us-east-1");

  assert.equal(rates.length, 1);
  assert.equal(rates[0].gpuModel, "H100");
  assert.equal(rates[0].commitment, "spot");
  assert.equal(rates[0].pricePerGpuHour, 4);
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

  const baseSecondRates = __test.ratesFromGoogleSku({
    skuId: "def456",
    description: "Nvidia Tesla H100 GPU Spot running in Americas",
    serviceRegions: ["us-central1"],
    category: { usageType: "Spot" },
    pricingInfo: [{
      pricingExpression: {
        usageUnit: "h",
        baseUnit: "s",
        baseUnitConversionFactor: 3600,
        tieredRates: [{ unitPrice: { units: "2", nanos: 500000000 } }]
      }
    }]
  }, "2026-06-27T00:00:00.000Z", "https://cloudbilling.googleapis.com/v1/services/6F81-5844-456A/skus?currencyCode=USD");

  assert.equal(baseSecondRates[0].commitment, "spot");
  assert.equal(baseSecondRates[0].pricePerGpuHour, 2.5);
});

test("marketplace provider rows normalize dynamic asks", () => {
  const vast = __test.ratesFromVastOffer({
    id: 123,
    gpu_name: "NVIDIA H100 SXM",
    num_gpus: 8,
    dph_total: 24,
    geolocation: "Texas, US"
  }, "2026-07-05T20:00:00.000Z");
  assert.equal(vast[0].provider, "Vast.ai Marketplace");
  assert.equal(vast[0].gpuModel, "H100");
  assert.equal(vast[0].commitment, "spot");
  assert.equal(vast[0].pricePerGpuHour, 3);

  const runpod = __test.ratesFromRunpodGpu({
    id: "NVIDIA H200 SXM",
    displayName: "H200 SXM",
    secureCloud: true,
    communityCloud: true,
    lowestPrice: { minimumBidPrice: 2.25, uninterruptablePrice: 2.8 }
  }, "2026-07-05T20:00:00.000Z");
  assert.equal(runpod.length, 2);
  assert.equal(runpod.find((rate) => rate.commitment === "spot").pricePerGpuHour, 2.25);
  assert.equal(runpod.find((rate) => rate.commitment === "on-demand").pricePerGpuHour, 2.8);

  const tensorDock = __test.ratesFromTensorDockRow({
    gpuName: "B200",
    gpuCount: 2,
    pricePerGpuHour: 12,
    region: "us-east"
  }, "2026-07-05T20:00:00.000Z");
  assert.equal(tensorDock[0].provider, "TensorDock Marketplace");
  assert.equal(tensorDock[0].gpuModel, "B200");
  assert.equal(tensorDock[0].pricePerGpuHour, 12);
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
