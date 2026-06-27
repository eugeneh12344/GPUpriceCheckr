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
  ["A100", /\bA100\b/i],
  ["L40S", /\bL40S\b/i],
  ["L40", /\bL40\b/i],
  ["A10", /\bA10\b/i],
  ["V100", /\bV100\b/i],
  ["A6000", /\bA6000\b/i],
  ["RTX 6000 Ada", /RTX\s*6000\s*Ada/i],
  ["RTX Pro 6000", /RTX\s*Pro\s*6000/i]
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
    currency: "USD",
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
    const key = [rate.provider, rate.gpuModel, rate.gpuVariant, rate.region, rate.commitment].join("|");
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

async function fetchJsonWithRetry(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "user-agent": "GPU-Rental-Rate-Index/0.1 (+local research tool)" },
        signal: AbortSignal.timeout(30_000)
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

async function scrapeAzure(observedAt) {
  const skuMap = [
    { pattern: "NC24ads_A100_v4", gpu: "A100", count: 1 },
    { pattern: "NC40ads_H100_v5", gpu: "H100", count: 1 },
    { pattern: "ND96isr_H100_v5", gpu: "H100", count: 8 },
    { pattern: "ND96isr_H200_v5", gpu: "H200", count: 8 }
  ];
  const results = [];
  for (const sku of skuMap) {
    const filter = `serviceName eq 'Virtual Machines' and armRegionName eq 'eastus' and armSkuName eq '${sku.pattern}' and priceType eq 'Consumption'`;
    const url = `${PROVIDERS.azure.url}?$filter=${encodeURIComponent(filter)}&currencyCode=USD`;
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Azure ${response.status} ${response.statusText}`);
    const data = await response.json();
    const item = data.Items?.find((row) =>
      row.type === "Consumption" &&
      !/spot|low priority/i.test(`${row.skuName} ${row.meterName}`) &&
      Number(row.retailPrice) > 0
    );
    if (!item) continue;
    results.push(baseRate(
      PROVIDERS.azure,
      observedAt,
      url,
      "api",
      item.armSkuName,
      sku.gpu,
      Number(item.retailPrice) / sku.count,
      { region: item.armRegionName, gpuVariant: item.armSkuName }
    ));
  }
  return results;
}

export function providerCatalog() {
  return Object.entries(PROVIDERS).map(([id, provider]) => ({
    id,
    name: provider.name,
    type: provider.type,
    url: provider.url,
    archiveCapable: Boolean(provider.parser)
  }));
}

export async function scrapeProvider(id) {
  const provider = PROVIDERS[id];
  if (!provider) throw new Error(`Unknown provider: ${id}`);
  const observedAt = new Date().toISOString();
  if (id === "azure") {
    const rates = await scrapeAzure(observedAt);
    if (!rates.length) throw new Error("The Azure API returned no matching GPU SKUs for the configured region.");
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
