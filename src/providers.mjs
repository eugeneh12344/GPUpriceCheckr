import { createHash, createHmac } from "node:crypto";

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
    requiresEnv: ["GOOGLE_CLOUD_API_KEY"]
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
const GOOGLE_COMPUTE_SERVICE = "6F81-5844-456A";
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
        headers: {
          "user-agent": "GPU-Rental-Rate-Index/0.1 (+local research tool)",
          ...(options.headers || {})
        },
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

function urlWithoutSecret(url, secretParam = "key") {
  const clean = new URL(url);
  clean.searchParams.delete(secretParam);
  return clean.toString();
}

function moneyValue(value) {
  if (!value) return 0;
  return Number(value.units || 0) + Number(value.nanos || 0) / 1_000_000_000;
}

function termLabel(term = "") {
  if (/3\s*year|3yr/i.test(term)) return "3-year";
  if (/1\s*year|1yr/i.test(term)) return "1-year";
  return String(term).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "committed";
}

function commitmentFromGoogleUsage(usageType = "") {
  if (/preemptible|spot/i.test(usageType)) return "spot";
  if (/commit.*3/i.test(usageType)) return "committed-3-year";
  if (/commit.*1/i.test(usageType)) return "committed-1-year";
  return "on-demand";
}

function isHourlyExpression(expression = {}) {
  return /(^h$|hour)/i.test([
    expression.usageUnit,
    expression.usageUnitDescription,
    expression.baseUnit,
    expression.baseUnitDescription
  ].filter(Boolean).join(" "));
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
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`AWS Pricing API ${response.status}: ${text.slice(0, 240)}`);
  }
  return response.json();
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

async function awsRegions() {
  const configured = configuredRegions("AWS_REGIONS");
  if (configured) return [...configured];
  try {
    const regions = await awsAttributeValues("regionCode");
    return regions.filter((region) => /^[a-z]{2}-/.test(region)).toSorted();
  } catch {
    return DEFAULT_AWS_REGIONS;
  }
}

async function awsProductsForRegion(region) {
  const priceList = [];
  let nextToken;
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
      MaxResults: 100,
      Filters: filters,
      ...(nextToken ? { NextToken: nextToken } : {})
    });
    priceList.push(...(data.PriceList || []).map((item) => JSON.parse(item)));
    nextToken = data.NextToken;
  } while (nextToken);

  return priceList;
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
  const results = [];
  for (const region of regions) {
    const products = await awsProductsForRegion(region);
    for (const product of products) results.push(...ratesFromAwsProduct(product, observedAt));
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

  const tier = expression.tieredRates?.find((rate) => moneyValue(rate.unitPrice) > 0);
  if (!tier) return [];
  const price = moneyValue(tier.unitPrice) / Number(expression.baseUnitConversionFactor || 1);
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

async function scrapeGoogleCloud(observedAt) {
  const key = process.env.GOOGLE_CLOUD_API_KEY || process.env.GCP_API_KEY;
  if (!key) {
    throw new Error("Google Cloud pricing requires GOOGLE_CLOUD_API_KEY in Render environment variables.");
  }

  const results = [];
  let pageToken;
  do {
    const url = new URL(`https://cloudbilling.googleapis.com/v1/services/${GOOGLE_COMPUTE_SERVICE}/skus`);
    url.searchParams.set("currencyCode", "USD");
    url.searchParams.set("pageSize", "5000");
    url.searchParams.set("key", key);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const data = await fetchJsonWithRetry(url.toString(), 3, { timeoutMs: 60_000 });
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
  ratesFromAzureRow,
  ratesFromAwsProduct,
  ratesFromGoogleSku
};
