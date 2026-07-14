import { createHash, createHmac, createSign } from "node:crypto";

const PROVIDERS = {
  lambda: {
    name: "Lambda",
    type: "neocloud",
    url: "https://lambda.ai/instances",
    parser: parseLambda
  },
  runpod: {
    name: "Runpod",
    type: "neocloud",
    url: "https://www.runpod.io/pricing",
    parser: parseRunpod
  },
  coreweave: {
    name: "CoreWeave",
    type: "neocloud",
    url: "https://www.coreweave.com/pricing",
    parser: parseCoreWeave
  },
  ornn: {
    name: "Ornn Market Index",
    type: "neocloud",
    url: "https://dashboard.ornnai.com/docs",
    parser: null
  },
  vast: {
    name: "Vast.ai Marketplace",
    type: "neocloud",
    url: "https://console.vast.ai/api/v0/search/asks/",
    parser: null
  },
  runpodMarket: {
    name: "RunPod Marketplace",
    type: "neocloud",
    url: "https://api.runpod.io/graphql",
    parser: null
  },
  tensorDock: {
    name: "TensorDock Marketplace",
    type: "neocloud",
    url: process.env.TENSORDOCK_MARKETPLACE_URL || "https://dashboard.tensordock.com/api/docs",
    parser: null,
    optional: true,
    requiresEnv: ["TENSORDOCK_MARKETPLACE_URL"]
  },
  aws: {
    name: "AWS",
    type: "hyperscaler",
    url: "https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/using-price-list-query-api.html",
    parser: null,
    requiresEnv: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]
  },
  googleCloud: {
    name: "Google Cloud",
    type: "hyperscaler",
    url: "https://cloud.google.com/billing/docs/reference/rest/v1/services.skus/list",
    parser: null,
    requiresEnv: ["GOOGLE_SERVICE_ACCOUNT_JSON"]
  },
  azure: {
    name: "Azure",
    type: "hyperscaler",
    url: "https://prices.azure.com/api/retail/prices",
    parser: null
  }
};

const GPU_ALIASES = [
  ["GB300", /\bGB300\b/i],
  ["GB200", /\bGB200\b/i],
  ["B300", /\bB300\b/i],
  ["B200", /\bB200\b/i],
  ["H200", /\bH200\b/i],
  ["H100", /\bH100\b/i],
  ["GH200", /\bGH200\b/i],
  ["MI300X", /\bMI300X\b/i],
  ["A100", /\bA100\b/i],
  ["L40S", /\bL40S\b/i],
  ["L40", /\bL40\b/i],
  ["A10", /\bA10G?\b/i],
  ["L4", /\bL4\b/i],
  ["T4", /\bT4\b/i],
  ["V100", /\bV100\b/i],
  ["P100", /\bP100\b/i],
  ["A6000", /\bA6000\b/i],
  ["RTX 6000 Ada", /RTX\s*6000\s*Ada/i],
  ["RTX Pro 6000", /RTX\s*Pro\s*6000/i]
];

const AWS_PRICE_ENDPOINT = "https://api.pricing.us-east-1.amazonaws.com";
const AWS_EC2_API_VERSION = "2016-11-15";
const GOOGLE_COMPUTE_SERVICE = "6F81-5844-456A";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_BILLING_SCOPE = "https://www.googleapis.com/auth/cloud-billing.readonly";
const ORNN_API_BASE = "https://api.ornnai.com/api/gpu";
const ORNN_GPU_TYPES = {
  H100: "H100 SXM",
  H200: "H200",
  B200: "B200",
  MI300X: "MI300X",
  A100: "A100 SXM4",
  "RTX 5090": "RTX 5090"
};
const DEFAULT_ORNN_GPU_TYPES = ["H100 SXM", "H200", "B200", "A100 SXM4", "RTX 5090"];
const DEFAULT_AWS_SPOT_REGIONS = ["us-east-1", "us-east-2", "us-west-2", "eu-west-1", "eu-central-1", "ap-northeast-1", "ap-southeast-1"];
const AWS_SPOT_INSTANCE_TYPES = {
  "p5.48xlarge": { gpuModel: "H100", count: 8 },
  "p5e.48xlarge": { gpuModel: "H200", count: 8 },
  "p5en.48xlarge": { gpuModel: "H200", count: 8 },
  "p4d.24xlarge": { gpuModel: "A100", count: 8 },
  "p4de.24xlarge": { gpuModel: "A100", count: 8 },
  "g6e.48xlarge": { gpuModel: "L40S", count: 8 },
  "g6.48xlarge": { gpuModel: "L4", count: 8 },
  "g5.48xlarge": { gpuModel: "A10", count: 8 },
  "g4dn.12xlarge": { gpuModel: "T4", count: 4 },
  "p3.16xlarge": { gpuModel: "V100", count: 8 }
};
const DEFAULT_AWS_SPOT_INSTANCE_TYPES = ["p5.48xlarge", "p5e.48xlarge", "p5en.48xlarge", "p4d.24xlarge", "p4de.24xlarge", "g6e.48xlarge", "g6.48xlarge", "g5.48xlarge"];
const DEFAULT_AWS_REGIONS = [
  "af-south-1",
  "ap-east-1",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-northeast-3",
  "ap-south-1",
  "ap-south-2",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-southeast-3",
  "ap-southeast-4",
  "ca-central-1",
  "ca-west-1",
  "eu-central-1",
  "eu-central-2",
  "eu-north-1",
  "eu-south-1",
  "eu-south-2",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "il-central-1",
  "me-central-1",
  "me-south-1",
  "sa-east-1",
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2"
];

function modelFrom(label) {
  return GPU_ALIASES.find(([, pattern]) => pattern.test(label))?.[0] || null;
}

function textFromHtml(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#36;|&dollar;/g, "$")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n");
}

function baseRate(provider, observedAt, sourceUrl, sourceKind, rawLabel, gpuModel, price, extras = {}) {
  return {
    observedAt,
    provider: provider.name,
    providerType: provider.type,
    gpuModel,
    gpuVariant: extras.gpuVariant || rawLabel,
    region: extras.region || "global",
    commitment: extras.commitment || "on-demand",
    pricePerGpuHour: Number(price),
    currency: extras.currency || "USD",
    sourceUrl,
    sourceKind,
    rawLabel
  };
}

function parseLambda(html, context) {
  const text = textFromHtml(html);
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const rates = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^NVIDIA\b/i.test(lines[i])) continue;
    const window = lines.slice(i, i + 8).join(" ");
    const match = window.match(/\$([0-9]+(?:\.[0-9]+)?)/);
    const gpuModel = modelFrom(lines[i]);
    if (gpuModel && match) {
      rates.push(baseRate(PROVIDERS.lambda, context.observedAt, context.sourceUrl, context.sourceKind, lines[i], gpuModel, match[1]));
    }
  }
  return dedupe(rates);
}

function parseRunpod(html, context) {
  const text = textFromHtml(html);
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const rates = [];
  for (let i = 0; i < lines.length; i += 1) {
    const gpuModel = modelFrom(lines[i]);
    if (!gpuModel || !/^(H|A|B|L|RTX|MI|GH|GB)/i.test(lines[i])) continue;
    const window = lines.slice(i + 1, i + 12).join(" ");
    const match = window.match(/\$?\s*([0-9]+(?:\.[0-9]+)?)\s*\/?hr\b/i);
    if (match) {
      rates.push(baseRate(PROVIDERS.runpod, context.observedAt, context.sourceUrl, context.sourceKind, lines[i], gpuModel, match[1]));
    }
  }
  return dedupe(rates);
}

function parseCoreWeave(html, context) {
  const text = textFromHtml(html);
  const rates = [];
  const pattern = /NVIDIA\s+([A-Z0-9 ]{2,50}?)\s+On-Demand Price:\s*\$([0-9.]+)\s*\/\s*Hour/gi;
  for (const match of text.matchAll(pattern)) {
    const rawLabel = `NVIDIA ${match[1].trim()}`;
    const gpuModel = modelFrom(rawLabel);
    if (!gpuModel) continue;
    const countMatch = text.slice(Math.max(0, match.index - 220), match.index).match(/(?:^|\n)([1248])(?:\^1)?(?:\n|$)/);
    const gpuCount = countMatch ? Number(countMatch[1]) : 1;
    rates.push(baseRate(
      PROVIDERS.coreweave,
      context.observedAt,
      context.sourceUrl,
      context.sourceKind,
      rawLabel,
      gpuModel,
      Number(match[2]) / gpuCount,
      { region: "North America" }
    ));
  }
  return dedupe(rates);
}

function dedupe(rates) {
  const map = new Map();
  for (const rate of rates) {
    const key = [
      rate.observedAt,
      rate.provider,
      rate.gpuModel,
      rate.gpuVariant,
      rate.region,
      rate.commitment,
      rate.sourceKind
    ].join("|");
    if (!map.has(key)) map.set(key, rate);
  }
  return [...map.values()];
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "GPU-Rental-Rate-Index/0.1 (+local research tool)",
      accept: "text/html,application/json"
    },
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.text();
}

async function fetchJsonWithRetry(url, attempts = 3, options = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: options.method || "GET",
        headers: {
          "user-agent": "GPU-Rental-Rate-Index/0.1 (+local research tool)",
          ...(options.headers || {})
        },
        ...(options.body ? { body: options.body } : {}),
        signal: AbortSignal.timeout(options.timeoutMs || 45_000)
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 1_500));
    }
  }
  throw lastError;
}

function configuredRegions(envName) {
  const value = process.env[envName];
  if (!value) return null;
  const regions = value.split(",").map((region) => region.trim()).filter(Boolean);
  return regions.length ? new Set(regions) : null;
}

function configuredList(envName, fallback = []) {
  const value = process.env[envName];
  if (!value) return fallback;
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length ? items : fallback;
}

function providerRequiredEnvSatisfied(provider) {
  return (provider.requiresEnv || []).every((envName) => Boolean(process.env[envName]));
}

export function defaultProviderIds() {
  return Object.entries(PROVIDERS)
    .filter(([, provider]) => !provider.optional || providerRequiredEnvSatisfied(provider))
    .map(([id]) => id);
}

function urlWithoutSecret(url, secretParam = "key") {
  const clean = new URL(url);
  clean.searchParams.delete(secretParam);
  return clean.toString();
}

function moneyValue(value) {
  if (!value) return 0;
  return Number(value.units || 0) + Number(value.nanos || 0) / 1_000_000_000;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index], index);
    }
  }

  const workerCount = Math.max(1, Math.min(values.length, concurrency));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function base64Url(value) {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value))
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}

function termLabel(term = "") {
  if (/3\s*year|3yr/i.test(term)) return "3-year";
  if (/1\s*year|1yr/i.test(term)) return "1-year";
  return String(term).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "committed";
}

function gpuModelFromOrnnType(gpuType) {
  return Object.entries(ORNN_GPU_TYPES).find(([, value]) => value === gpuType)?.[0] || modelFrom(gpuType);
}

async function scrapeOrnnMarketIndex() {
  const results = [];
  const gpuTypes = configuredList("ORNN_GPU_TYPES", DEFAULT_ORNN_GPU_TYPES);
  for (const gpuType of gpuTypes) {
    const gpuModel = gpuModelFromOrnnType(gpuType);
    if (!gpuModel) continue;
    const url = `${ORNN_API_BASE}/${encodeURIComponent(gpuType)}/index-history`;
    let data;
    try {
      data = await fetchJsonWithRetry(url, 3, { timeoutMs: 30_000 });
    } catch (error) {
      console.error(JSON.stringify({ provider: "ornn", gpuType, error: error.message }));
      continue;
    }
    const points = data.data || data.history || [];
    for (const point of points) {
      const price = Number(point.index_value ?? point.indexValue ?? point.pricePerGpuHour);
      const observedAt = point.timestamp || point.observedAt;
      if (!Number.isFinite(price) || price <= 0 || !observedAt) continue;
      results.push(baseRate(
        PROVIDERS.ornn,
        new Date(observedAt).toISOString(),
        url,
        "market-index",
        `${gpuType} Ornn compute index`,
        gpuModel,
        price,
        {
          gpuVariant: gpuType,
          region: "global",
          commitment: "market-index"
        }
      ));
    }
  }
  return dedupe(results);
}

function ratesFromVastOffer(offer, observedAt) {
  const gpuModel = modelFrom(offer.gpu_name || offer.gpuName || "");
  if (!gpuModel) return [];
  const gpuCount = Number(offer.num_gpus ?? offer.gpuCount ?? 1);
  if (!Number.isFinite(gpuCount) || gpuCount <= 0) return [];
  const price = Number(offer.discounted_dph_total ?? offer.dph_total ?? offer.dph_base ?? offer.hourly_price);
  if (!Number.isFinite(price) || price <= 0) return [];
  const id = offer.ask_contract_id || offer.id || "";
  return [baseRate(
    PROVIDERS.vast,
    observedAt,
    PROVIDERS.vast.url,
    "marketplace-api",
    `${offer.gpu_name || gpuModel} Vast ask ${id}`.trim(),
    gpuModel,
    price / gpuCount,
    {
      gpuVariant: String(offer.gpu_name || gpuModel),
      region: offer.geolocation || offer.country || "global",
      commitment: "spot"
    }
  )];
}

async function scrapeVastMarketplace(observedAt) {
  const data = await fetchJsonWithRetry(PROVIDERS.vast.url, 3, { timeoutMs: 45_000 });
  return dedupe((data.offers || []).flatMap((offer) => ratesFromVastOffer(offer, observedAt)));
}

function ratesFromRunpodGpu(gpu, observedAt) {
  const label = [gpu.displayName, gpu.id].filter(Boolean).join(" ");
  const gpuModel = modelFrom(label);
  if (!gpuModel) return [];
  const rows = [];
  const lowest = gpu.lowestPrice || {};
  const baseExtras = {
    gpuVariant: gpu.id || gpu.displayName || gpuModel,
    region: gpu.secureCloud && gpu.communityCloud
      ? "secure + community"
      : gpu.secureCloud
        ? "secure cloud"
        : gpu.communityCloud
          ? "community cloud"
          : "global"
  };
  const bid = Number(lowest.minimumBidPrice);
  if (Number.isFinite(bid) && bid > 0) {
    rows.push(baseRate(
      PROVIDERS.runpodMarket,
      observedAt,
      PROVIDERS.runpodMarket.url,
      "marketplace-api",
      `${label} minimum bid`,
      gpuModel,
      bid,
      { ...baseExtras, commitment: "spot" }
    ));
  }
  const uninterruptible = Number(lowest.uninterruptablePrice ?? lowest.uninterruptiblePrice);
  if (Number.isFinite(uninterruptible) && uninterruptible > 0) {
    rows.push(baseRate(
      PROVIDERS.runpodMarket,
      observedAt,
      PROVIDERS.runpodMarket.url,
      "marketplace-api",
      `${label} uninterruptible`,
      gpuModel,
      uninterruptible,
      { ...baseExtras, commitment: "on-demand" }
    ));
  }
  return rows;
}

async function scrapeRunpodMarketplace(observedAt) {
  const query = `query GpuTypes {
    gpuTypes {
      id
      displayName
      memoryInGb
      secureCloud
      communityCloud
      lowestPrice(input: { gpuCount: 1 }) {
        minimumBidPrice
        uninterruptablePrice
      }
    }
  }`;
  const data = await fetchJsonWithRetry(PROVIDERS.runpodMarket.url, 3, {
    method: "POST",
    timeoutMs: 45_000,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query })
  });
  if (data.errors?.length) throw new Error(data.errors.map((error) => error.message).join("; "));
  return dedupe((data.data?.gpuTypes || []).flatMap((gpu) => ratesFromRunpodGpu(gpu, observedAt)));
}

function tensorDockRowsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ["offers", "gpus", "data", "resources", "availability", "instances"]) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

function ratesFromTensorDockRow(row, observedAt) {
  const label = row.gpuModel || row.gpu_model || row.gpuName || row.gpu_name || row.displayName || row.name || row.model || "";
  const gpuModel = modelFrom(label);
  if (!gpuModel) return [];
  const gpuCount = Number(row.gpuCount ?? row.gpu_count ?? row.numGpus ?? row.num_gpus ?? 1);
  if (!Number.isFinite(gpuCount) || gpuCount <= 0) return [];
  const perGpuPrice = row.pricePerGpuHour ?? row.price_per_gpu_hour;
  const price = Number(perGpuPrice ?? row.hourlyPrice ?? row.hourly_price ?? row.price ?? row.minPrice);
  if (!Number.isFinite(price) || price <= 0) return [];
  return [baseRate(
    PROVIDERS.tensorDock,
    observedAt,
    PROVIDERS.tensorDock.url,
    "marketplace-api",
    `${label} TensorDock marketplace`,
    gpuModel,
    perGpuPrice == null ? price / gpuCount : price,
    {
      gpuVariant: String(row.gpuVariant || row.gpu_variant || label),
      region: row.region || row.location || row.datacenter || "global",
      commitment: row.commitment || "spot"
    }
  )];
}

async function scrapeTensorDockMarketplace(observedAt) {
  if (!process.env.TENSORDOCK_MARKETPLACE_URL) {
    throw new Error("Set TENSORDOCK_MARKETPLACE_URL to a TensorDock marketplace JSON feed before enabling this optional collector.");
  }
  const data = await fetchJsonWithRetry(process.env.TENSORDOCK_MARKETPLACE_URL, 3, { timeoutMs: 45_000 });
  return dedupe(tensorDockRowsFromPayload(data).flatMap((row) => ratesFromTensorDockRow(row, observedAt)));
}

function commitmentFromGoogleUsage(usageType = "") {
  if (/preemptible|spot/i.test(usageType)) return "spot";
  if (/commit.*3/i.test(usageType)) return "committed-3-year";
  if (/commit.*1/i.test(usageType)) return "committed-1-year";
  return "on-demand";
}

function isHourlyExpression(expression = {}) {
  return [
    expression.usageUnit,
    expression.usageUnitDescription,
    expression.baseUnit,
    expression.baseUnitDescription
  ].filter(Boolean).some((value) => /(^h$|hour)/i.test(value));
}

function googleHourlyPrice(expression = {}) {
  const tier = expression.tieredRates?.find((rate) => moneyValue(rate.unitPrice) > 0);
  if (!tier) return null;
  const unitPrice = moneyValue(tier.unitPrice);
  const usageUnit = [expression.usageUnit, expression.usageUnitDescription].filter(Boolean).join(" ");
  const baseUnit = [expression.baseUnit, expression.baseUnitDescription].filter(Boolean).join(" ");
  const conversion = Number(expression.baseUnitConversionFactor || 1);
  if (/(^h$|hour)/i.test(usageUnit)) return unitPrice;
  if (/(^s$|second)/i.test(usageUnit)) return unitPrice * 3_600;
  if (/(^h$|hour)/i.test(baseUnit) && Number.isFinite(conversion) && conversion > 0) return unitPrice / conversion;
  return unitPrice;
}

function gpuInfoFromAzure(row) {
  const label = [row.armSkuName, row.productName, row.skuName, row.meterName].filter(Boolean).join(" ");
  const gpuModel = modelFrom(label);
  if (!gpuModel) return null;

  const armSku = row.armSkuName || "";
  let count = 1;
  const ncA100 = armSku.match(/NC(\d+)ads_A100/i);
  const ncH100 = armSku.match(/NC(\d+)ads_H100/i);
  const ncRtxPro6000 = armSku.match(/NC(\d+).*RTXPRO6000/i);
  if (ncA100) count = Math.max(1, Math.round(Number(ncA100[1]) / 24));
  else if (ncH100) count = Math.max(1, Math.round(Number(ncH100[1]) / 40));
  else if (ncRtxPro6000) {
    const size = Number(ncRtxPro6000[1]);
    count = size >= 288 ? 8 : size >= 144 ? 4 : size >= 72 ? 2 : 1;
  }
  else if (/ND\d+.*(?:A100|H100|H200|MI300X)/i.test(label)) count = 8;
  else if (/NV\d+.*A10/i.test(label)) count = Math.max(1, Math.round((Number(armSku.match(/NV(\d+)/i)?.[1]) || 6) / 6));

  return { gpuModel, count };
}

function ratesFromAzureRow(row, observedAt) {
  const info = gpuInfoFromAzure(row);
  if (!info) return [];
  if (/windows/i.test(`${row.productName} ${row.skuName} ${row.meterName}`)) return [];

  const price = Number(row.retailPrice);
  if (!Number.isFinite(price) || price <= 0) return [];

  const label = row.armSkuName || row.skuName || row.meterName;
  const region = row.armRegionName || row.location || "global";
  const rates = [];

  if (row.type === "Reservation" || row.priceType === "Reservation") {
    const hours = termLabel(row.reservationTerm) === "3-year" ? 3 * 365 * 24 : 365 * 24;
    rates.push(baseRate(
      PROVIDERS.azure,
      observedAt,
      PROVIDERS.azure.url,
      "api",
      `${label} ${row.reservationTerm || "reservation"}`,
      info.gpuModel,
      price / hours / info.count,
      {
        region,
        gpuVariant: label,
        commitment: `reserved-${termLabel(row.reservationTerm)}`
      }
    ));
    return rates;
  }

  const commitment = /spot|low priority/i.test(`${row.skuName} ${row.meterName}`) ? "spot" : "on-demand";
  rates.push(baseRate(
    PROVIDERS.azure,
    observedAt,
    PROVIDERS.azure.url,
    "api",
    label,
    info.gpuModel,
    price / info.count,
    {
      region,
      gpuVariant: label,
      commitment
    }
  ));

  for (const plan of row.savingsPlan || []) {
    const planPrice = Number(plan.retailPrice ?? plan.unitPrice);
    if (!Number.isFinite(planPrice) || planPrice <= 0) continue;
    rates.push(baseRate(
      PROVIDERS.azure,
      observedAt,
      PROVIDERS.azure.url,
      "api",
      `${label} ${plan.term || "savings plan"}`,
      info.gpuModel,
      planPrice / info.count,
      {
        region,
        gpuVariant: label,
        commitment: `savings-plan-${termLabel(plan.term)}`
      }
    ));
  }

  return rates;
}

async function fetchAzureRows(priceType, familyPrefix) {
  const url = new URL(PROVIDERS.azure.url);
  url.searchParams.set("currencyCode", "USD");
  url.searchParams.set("api-version", "2023-01-01-preview");
  url.searchParams.set("$filter", [
    "serviceName eq 'Virtual Machines'",
    "serviceFamily eq 'Compute'",
    `priceType eq '${priceType}'`,
    `contains(armSkuName, '${familyPrefix}')`
  ].join(" and "));

  const rows = [];
  let next = url.toString();
  while (next) {
    const data = await fetchJsonWithRetry(next, 3, { timeoutMs: 60_000 });
    rows.push(...(data.Items || []));
    next = data.NextPageLink || null;
  }
  return rows;
}

async function scrapeAzure(observedAt) {
  const regionFilter = configuredRegions("AZURE_REGIONS");
  const families = ["Standard_NC", "Standard_ND", "Standard_NV", "Standard_NG"];
  const results = [];

  for (const priceType of ["Consumption", "Reservation"]) {
    for (const family of families) {
      const rows = await fetchAzureRows(priceType, family);
      for (const row of rows) {
        if (regionFilter && !regionFilter.has(row.armRegionName)) continue;
        results.push(...ratesFromAzureRow(row, observedAt));
      }
    }
  }

  return dedupe(results);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key, value, encoding) {
  return createHmac("sha256", key).update(value, "utf8").digest(encoding);
}

function awsCredentials() {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = process.env.AWS_SESSION_TOKEN;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("AWS Pricing API requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in Render environment variables.");
  }
  return { accessKeyId, secretAccessKey, sessionToken };
}

async function awsPricingRequest(target, body) {
  const requestDelayMs = Number(process.env.AWS_PRICE_REQUEST_DELAY_MS || 350);
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    if (requestDelayMs) await sleep(requestDelayMs);

    const endpoint = new URL(AWS_PRICE_ENDPOINT);
    const credentials = awsCredentials();
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const payload = JSON.stringify(body);
    const headers = {
      "content-type": "application/x-amz-json-1.1",
      host: endpoint.host,
      "x-amz-date": amzDate,
      "x-amz-target": `AWSPriceListService.${target}`
    };
    if (credentials.sessionToken) headers["x-amz-security-token"] = credentials.sessionToken;

    const signedHeaderNames = Object.keys(headers).sort();
    const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name]}\n`).join("");
    const signedHeaders = signedHeaderNames.join(";");
    const canonicalRequest = ["POST", "/", "", canonicalHeaders, signedHeaders, sha256(payload)].join("\n");
    const credentialScope = `${dateStamp}/us-east-1/pricing/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      sha256(canonicalRequest)
    ].join("\n");

    const signingKey = hmac(
      hmac(
        hmac(
          hmac(`AWS4${credentials.secretAccessKey}`, dateStamp),
          "us-east-1"
        ),
        "pricing"
      ),
      "aws4_request"
    );
    const signature = hmac(signingKey, stringToSign, "hex");
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: payload,
      signal: AbortSignal.timeout(60_000)
    });
    if (response.ok) return response.json();

    const text = await response.text();
    const throttled = response.status === 429 || /Throttling|Rate exceeded/i.test(text);
    if (throttled && attempt < 8) {
      await sleep((2 ** attempt) * 1_000);
      continue;
    }
    throw new Error(`AWS Pricing API ${response.status}: ${text.slice(0, 240)}`);
  }
  throw new Error("AWS Pricing API retries exhausted.");
}

function awsEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function awsCanonicalQuery(params) {
  return [...params.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${awsEncode(key)}=${awsEncode(value)}`)
    .join("&");
}

async function awsEc2QueryRequest(region, params) {
  const endpoint = new URL(`https://ec2.${region}.amazonaws.com/`);
  const credentials = awsCredentials();
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const headers = {
    host: endpoint.host,
    "x-amz-date": amzDate
  };
  if (credentials.sessionToken) headers["x-amz-security-token"] = credentials.sessionToken;

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name]}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalQuery = awsCanonicalQuery(params);
  const canonicalRequest = ["GET", "/", canonicalQuery, canonicalHeaders, signedHeaders, sha256("")].join("\n");
  const credentialScope = `${dateStamp}/${region}/ec2/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256(canonicalRequest)
  ].join("\n");
  const signingKey = hmac(
    hmac(
      hmac(
        hmac(`AWS4${credentials.secretAccessKey}`, dateStamp),
        region
      ),
      "ec2"
    ),
    "aws4_request"
  );
  const signature = hmac(signingKey, stringToSign, "hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  endpoint.search = canonicalQuery;

  const response = await fetch(endpoint, {
    headers,
    signal: AbortSignal.timeout(60_000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`AWS EC2 ${region} ${response.status}: ${text.slice(0, 240)}`);
  return text;
}

function xmlTag(xml, tagName) {
  const match = xml.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`));
  return match ? match[1].replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">") : "";
}

function ratesFromAwsSpotHistoryXml(xml, region) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].flatMap((match) => {
    const item = match[1];
    const instanceType = xmlTag(item, "instanceType");
    const info = AWS_SPOT_INSTANCE_TYPES[instanceType];
    if (!info) return [];
    const price = Number(xmlTag(item, "spotPrice"));
    const observedAt = xmlTag(item, "timestamp");
    if (!Number.isFinite(price) || price <= 0 || !observedAt) return [];
    const availabilityZone = xmlTag(item, "availabilityZone") || region;
    return [baseRate(
      PROVIDERS.aws,
      new Date(observedAt).toISOString(),
      "https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DescribeSpotPriceHistory.html",
      "api",
      `${instanceType} ${xmlTag(item, "productDescription") || "spot"}`,
      info.gpuModel,
      price / info.count,
      {
        gpuVariant: instanceType,
        region: availabilityZone,
        commitment: "spot"
      }
    )];
  });
}

async function scrapeAwsSpotHistory() {
  const regions = configuredList("AWS_SPOT_REGIONS", [...(configuredRegions("AWS_REGIONS") || DEFAULT_AWS_SPOT_REGIONS)]);
  const instanceTypes = configuredList("AWS_SPOT_INSTANCE_TYPES", DEFAULT_AWS_SPOT_INSTANCE_TYPES)
    .filter((instanceType) => AWS_SPOT_INSTANCE_TYPES[instanceType]);
  const days = Math.max(1, Math.min(90, Number(process.env.AWS_SPOT_HISTORY_DAYS || 14)));
  const startTime = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const endTime = new Date().toISOString();
  const results = [];

  for (const region of regions) {
    let nextToken;
    do {
      const params = new URLSearchParams({
        Action: "DescribeSpotPriceHistory",
        Version: AWS_EC2_API_VERSION,
        StartTime: startTime,
        EndTime: endTime,
        MaxResults: "1000"
      });
      params.set("ProductDescription.1", "Linux/UNIX");
      instanceTypes.forEach((instanceType, index) => {
        params.set(`InstanceType.${index + 1}`, instanceType);
      });
      if (nextToken) params.set("NextToken", nextToken);
      const xml = await awsEc2QueryRequest(region, params);
      results.push(...ratesFromAwsSpotHistoryXml(xml, region));
      nextToken = xmlTag(xml, "nextToken") || null;
    } while (nextToken);
  }

  return dedupe(results);
}

async function awsAttributeValues(attributeName) {
  const values = [];
  let nextToken;
  do {
    const data = await awsPricingRequest("GetAttributeValues", {
      ServiceCode: "AmazonEC2",
      AttributeName: attributeName,
      ...(nextToken ? { NextToken: nextToken } : {})
    });
    values.push(...(data.AttributeValues || []).map((item) => item.Value).filter(Boolean));
    nextToken = data.NextToken;
  } while (nextToken);
  return values;
}

function isAwsRegionCode(value = "") {
  return /^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(value);
}

async function awsRegions() {
  const configured = configuredRegions("AWS_REGIONS");
  if (configured) return [...configured];
  try {
    const regions = await awsAttributeValues("regionCode");
    return regions.filter(isAwsRegionCode).toSorted();
  } catch {
    return DEFAULT_AWS_REGIONS;
  }
}

async function awsRatesForRegion(region, observedAt) {
  const rates = [];
  let nextToken;
  const pageSize = Math.max(1, Math.min(100, Number(process.env.AWS_PRICE_PAGE_SIZE || 50)));
  const filters = [
    ["productFamily", "Compute Instance"],
    ["regionCode", region],
    ["locationType", "AWS Region"],
    ["operatingSystem", "Linux"],
    ["tenancy", "Shared"],
    ["preInstalledSw", "NA"]
  ].map(([Field, Value]) => ({ Type: "TERM_MATCH", Field, Value }));

  do {
    const data = await awsPricingRequest("GetProducts", {
      ServiceCode: "AmazonEC2",
      FormatVersion: "aws_v1",
      MaxResults: pageSize,
      Filters: filters,
      ...(nextToken ? { NextToken: nextToken } : {})
    });
    for (const item of data.PriceList || []) {
      rates.push(...ratesFromAwsProduct(JSON.parse(item), observedAt));
    }
    nextToken = data.NextToken;
  } while (nextToken);

  return rates;
}

function gpuInfoFromAwsAttributes(attributes = {}) {
  const label = [
    attributes.instanceType,
    attributes.physicalProcessor,
    attributes.processorFeatures,
    attributes.gpuMemory
  ].filter(Boolean).join(" ");
  let gpuModel = modelFrom(label);
  const instanceType = attributes.instanceType || "";

  if (!gpuModel) {
    if (/^p5e?n?\./i.test(instanceType)) gpuModel = /^p5e|^p5en/i.test(instanceType) ? "H200" : "H100";
    else if (/^p4d/i.test(instanceType)) gpuModel = "A100";
    else if (/^p3/i.test(instanceType)) gpuModel = "V100";
    else if (/^g6e/i.test(instanceType)) gpuModel = "L40S";
    else if (/^g6/i.test(instanceType)) gpuModel = "L4";
    else if (/^g5/i.test(instanceType)) gpuModel = "A10";
    else if (/^g4dn/i.test(instanceType)) gpuModel = "T4";
  }
  if (!gpuModel) return null;

  const count = Number(attributes.gpu || 0);
  return {
    gpuModel,
    count: Number.isFinite(count) && count > 0 ? count : 1
  };
}

function hourlyPriceFromDimensions(dimensions = {}) {
  for (const dimension of Object.values(dimensions)) {
    const price = Number(dimension.pricePerUnit?.USD);
    if (/hrs?/i.test(dimension.unit || "") && Number.isFinite(price) && price > 0) return price;
  }
  return null;
}

function awsTermHours(leaseContractLength = "") {
  return /3yr|3\s*year/i.test(leaseContractLength) ? 3 * 365 * 24 : 365 * 24;
}

function ratesFromAwsProduct(product, observedAt) {
  const attributes = product.product?.attributes || {};
  if (attributes.capacitystatus && attributes.capacitystatus !== "Used") return [];
  const info = gpuInfoFromAwsAttributes(attributes);
  if (!info) return [];

  const label = `${attributes.instanceType} ${attributes.physicalProcessor || info.gpuModel}`.trim();
  const region = attributes.regionCode || attributes.location || "global";
  const rates = [];

  for (const term of Object.values(product.terms?.OnDemand || {})) {
    const hourly = hourlyPriceFromDimensions(term.priceDimensions);
    if (!hourly) continue;
    rates.push(baseRate(
      PROVIDERS.aws,
      observedAt,
      PROVIDERS.aws.url,
      "api",
      label,
      info.gpuModel,
      hourly / info.count,
      {
        region,
        gpuVariant: attributes.instanceType,
        commitment: "on-demand"
      }
    ));
  }

  for (const term of Object.values(product.terms?.Reserved || {})) {
    const attrs = term.termAttributes || {};
    const hours = awsTermHours(attrs.LeaseContractLength);
    let hourly = 0;
    let upfront = 0;
    for (const dimension of Object.values(term.priceDimensions || {})) {
      const price = Number(dimension.pricePerUnit?.USD);
      if (!Number.isFinite(price) || price <= 0) continue;
      if (/hrs?/i.test(dimension.unit || "")) hourly += price;
      else if (/quantity/i.test(dimension.unit || "")) upfront += price;
    }
    const effectiveHourly = hourly + upfront / hours;
    if (!effectiveHourly) continue;
    const purchase = String(attrs.PurchaseOption || "reserved").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    rates.push(baseRate(
      PROVIDERS.aws,
      observedAt,
      PROVIDERS.aws.url,
      "api",
      `${label} ${attrs.LeaseContractLength || ""} ${attrs.PurchaseOption || ""}`.trim(),
      info.gpuModel,
      effectiveHourly / info.count,
      {
        region,
        gpuVariant: attributes.instanceType,
        commitment: `reserved-${termLabel(attrs.LeaseContractLength)}-${purchase}`
      }
    ));
  }

  return rates;
}

async function scrapeAws(observedAt) {
  const regions = await awsRegions();
  const configuredConcurrency = Number(process.env.AWS_REGION_CONCURRENCY || 4);
  const concurrency = Number.isFinite(configuredConcurrency)
    ? Math.max(1, Math.min(8, Math.floor(configuredConcurrency)))
    : 4;
  const regionalRates = await mapWithConcurrency(regions, concurrency, async (region) => {
    const rates = await awsRatesForRegion(region, observedAt);
    console.log(JSON.stringify({ provider: "aws", region, records: rates.length }));
    return rates;
  });
  const results = regionalRates.flat();
  try {
    results.push(...await scrapeAwsSpotHistory());
  } catch (error) {
    console.error(JSON.stringify({ provider: "aws", spotHistoryError: error.message }));
  }
  return dedupe(results);
}

function ratesFromGoogleSku(sku, observedAt, sourceUrl) {
  const label = sku.description || sku.name || "";
  const gpuModel = modelFrom(label);
  if (!gpuModel) return [];
  if (!/(gpu|accelerator)/i.test(label)) return [];

  const expression = sku.pricingInfo?.at(-1)?.pricingExpression;
  if (!expression || !isHourlyExpression(expression)) return [];

  const price = googleHourlyPrice(expression);
  if (!Number.isFinite(price) || price <= 0) return [];

  const regionFilter = configuredRegions("GOOGLE_CLOUD_REGIONS");
  const regions = (sku.serviceRegions || []).filter((region) => region && region !== "global");
  const commitment = commitmentFromGoogleUsage(sku.category?.usageType);
  return regions.flatMap((region) => {
    if (regionFilter && !regionFilter.has(region)) return [];
    return [baseRate(
      PROVIDERS.googleCloud,
      observedAt,
      sourceUrl,
      "api",
      label,
      gpuModel,
      price,
      {
        region,
        gpuVariant: sku.skuId || label,
        commitment
      }
    )];
  });
}

function googleServiceAccount() {
  const rawJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GCP_SERVICE_ACCOUNT_JSON;
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson);
      if (parsed.client_email && parsed.private_key) return parsed;
    } catch {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is set but is not valid service-account JSON.");
    }
  }

  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL || process.env.GCP_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY || process.env.GCP_PRIVATE_KEY;
  if (clientEmail && privateKey) {
    return {
      client_email: clientEmail,
      private_key: privateKey.replaceAll("\\n", "\n"),
      token_uri: GOOGLE_TOKEN_URL
    };
  }

  if (process.env.GOOGLE_CLOUD_API_KEY || process.env.GCP_API_KEY) {
    throw new Error("Google Cloud Billing Catalog rejected API-key auth. Add GOOGLE_SERVICE_ACCOUNT_JSON for OAuth access.");
  }
  throw new Error("Google Cloud pricing requires GOOGLE_SERVICE_ACCOUNT_JSON in Render environment variables.");
}

async function googleAccessToken() {
  const account = googleServiceAccount();
  const tokenUrl = account.token_uri || GOOGLE_TOKEN_URL;
  const now = Math.floor(Date.now() / 1_000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: account.client_email,
    scope: GOOGLE_BILLING_SCOPE,
    aud: tokenUrl,
    exp: now + 3_600,
    iat: now
  };
  const unsigned = `${base64Url(header)}.${base64Url(claims)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(account.private_key.replaceAll("\\n", "\n"), "base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
  const assertion = `${unsigned}.${signature}`;

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    }),
    signal: AbortSignal.timeout(30_000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(`Google OAuth token request failed: ${data.error_description || data.error || response.statusText}`);
  }
  return data.access_token;
}

async function scrapeGoogleCloud(observedAt) {
  const token = await googleAccessToken();
  const results = [];
  let pageToken;
  do {
    const url = new URL(`https://cloudbilling.googleapis.com/v1/services/${GOOGLE_COMPUTE_SERVICE}/skus`);
    url.searchParams.set("currencyCode", "USD");
    url.searchParams.set("pageSize", "5000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const data = await fetchJsonWithRetry(url.toString(), 3, {
      timeoutMs: 60_000,
      headers: { authorization: `Bearer ${token}` }
    });
    const sourceUrl = urlWithoutSecret(url.toString());
    for (const sku of data.skus || []) {
      results.push(...ratesFromGoogleSku(sku, observedAt, sourceUrl));
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  return dedupe(results);
}

export function providerCatalog() {
  return Object.entries(PROVIDERS).map(([id, provider]) => ({
    id,
    name: provider.name,
    type: provider.type,
    url: provider.url,
    archiveCapable: Boolean(provider.parser),
    optional: Boolean(provider.optional),
    defaultEnabled: !provider.optional || providerRequiredEnvSatisfied(provider),
    requiresEnv: provider.requiresEnv || []
  }));
}

export async function scrapeProvider(id) {
  const provider = PROVIDERS[id];
  if (!provider) throw new Error(`Unknown provider: ${id}`);
  const observedAt = new Date().toISOString();
  if (id === "azure") {
    const rates = await scrapeAzure(observedAt);
    if (!rates.length) throw new Error("The Azure API returned no matching GPU SKUs for the configured regions.");
    return rates;
  }
  if (id === "aws") {
    const rates = await scrapeAws(observedAt);
    if (!rates.length) throw new Error("The AWS Pricing API returned no matching GPU SKUs for the configured regions.");
    return rates;
  }
  if (id === "googleCloud") {
    const rates = await scrapeGoogleCloud(observedAt);
    if (!rates.length) throw new Error("The Google Cloud Billing Catalog returned no matching GPU SKUs for the configured regions.");
    return rates;
  }
  if (id === "ornn") {
    const rates = await scrapeOrnnMarketIndex();
    if (!rates.length) throw new Error("The Ornn market index returned no usable GPU history.");
    return rates;
  }
  if (id === "vast") {
    const rates = await scrapeVastMarketplace(observedAt);
    if (!rates.length) throw new Error("The Vast.ai marketplace API returned no recognizable GPU offers.");
    return rates;
  }
  if (id === "runpodMarket") {
    const rates = await scrapeRunpodMarketplace(observedAt);
    if (!rates.length) throw new Error("The RunPod marketplace API returned no recognizable GPU prices.");
    return rates;
  }
  if (id === "tensorDock") {
    const rates = await scrapeTensorDockMarketplace(observedAt);
    if (!rates.length) throw new Error("The TensorDock marketplace feed returned no recognizable GPU prices.");
    return rates;
  }
  const html = await fetchText(provider.url);
  const rates = provider.parser(html, {
    observedAt,
    sourceUrl: provider.url,
    sourceKind: "live"
  });
  if (!rates.length) throw new Error("The page loaded, but no recognizable GPU prices were found.");
  return rates;
}

export async function importArchive(id, options = {}) {
  const provider = PROVIDERS[id];
  if (!provider?.parser) throw new Error(`${id} does not have an archive parser.`);
  const from = (options.from || "2023").replaceAll("-", "");
  const to = (options.to || new Date().getUTCFullYear().toString()).replaceAll("-", "");
  const cdx = new URL("https://web.archive.org/cdx/search/cdx");
  cdx.searchParams.set("url", provider.url);
  cdx.searchParams.set("from", from);
  cdx.searchParams.set("to", to);
  cdx.searchParams.set("output", "json");
  cdx.searchParams.set("filter", "statuscode:200");
  cdx.searchParams.set("filter", "mimetype:text/html");
  cdx.searchParams.set("fl", "timestamp,original,digest");
  cdx.searchParams.set("collapse", "timestamp:6");

  let rows;
  try {
    rows = await fetchJsonWithRetry(cdx);
  } catch (error) {
    throw new Error(`Archive index unavailable after retries: ${error.message}`);
  }
  const snapshots = rows.slice(1).slice(-Number(options.limit || 24));
  const allRates = [];

  for (const [timestamp, original] of snapshots) {
    const archiveUrl = `https://web.archive.org/web/${timestamp}id_/${original}`;
    try {
      const html = await fetchText(archiveUrl);
      const observedAt = `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}T${timestamp.slice(8, 10)}:${timestamp.slice(10, 12)}:${timestamp.slice(12, 14)}.000Z`;
      allRates.push(...provider.parser(html, {
        observedAt,
        sourceUrl: archiveUrl,
        sourceKind: "internet-archive"
      }));
    } catch {
      // Archived assets occasionally disappear; keep importing the usable captures.
    }
  }
  if (!allRates.length) throw new Error("No parsable archived snapshots were found for that range.");
  return allRates;
}

export const __test = {
  modelFrom,
  defaultProviderIds,
  ratesFromAzureRow,
  ratesFromAwsProduct,
  ratesFromAwsSpotHistoryXml,
  isAwsRegionCode,
  ratesFromGoogleSku,
  ratesFromRunpodGpu,
  ratesFromTensorDockRow,
  ratesFromVastOffer
};
