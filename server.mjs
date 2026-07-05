import http from "node:http";
import { readFile, rename, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import {
  DATA_DIR,
  dashboardRates,
  dashboardSummaryData,
  finishRun,
  listRates,
  markInterruptedRuns,
  metadata,
  saveRates,
  seedBenchmarks,
  startRun
} from "./src/db.mjs";
import { collectProviders, summarizeCollection } from "./src/collection.mjs";
import { buildDashboardSummary } from "./src/dashboard.mjs";
import { importArchive, providerCatalog } from "./src/providers.mjs";
import { modelIndex, modelIndexMetadata } from "./src/model-index.mjs";
import { runDailyReport } from "./src/report.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, "public");
const PORT = Number(process.env.PORT || 3000);
const DASHBOARD_CACHE_MS = 5 * 60 * 1000;
const DASHBOARD_CACHE_FILE = join(DATA_DIR, "dashboard-payload-cache.json");
const DASHBOARD_CACHE_VERSION = 4;
const BROTLI_OPTIONS = { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } };
const GZIP_OPTIONS = { level: 6 };
let dashboardCache = null;
let dashboardRatesCache = null;
let dashboardRefreshPromise = null;
let dashboardCacheGeneration = 0;
let dashboardRefreshGeneration = -1;
markInterruptedRuns();
seedBenchmarks();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

function json(req, res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  };
  const accepted = req.headers["accept-encoding"] || "";
  if (body.length > 1024 && /\bbr\b/.test(accepted)) {
    headers["content-encoding"] = "br";
    headers.vary = "accept-encoding";
    res.writeHead(status, headers);
    res.end(brotliCompressSync(body, BROTLI_OPTIONS));
    return;
  }
  if (body.length > 1024 && /\bgzip\b/.test(accepted)) {
    headers["content-encoding"] = "gzip";
    headers.vary = "accept-encoding";
    res.writeHead(status, headers);
    res.end(gzipSync(body, GZIP_OPTIONS));
    return;
  }
  res.writeHead(status, headers);
  res.end(body);
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return req.headers.authorization === `Bearer ${secret}` || req.headers["x-cron-secret"] === secret;
}

function requireAuth(req, res) {
  if (isAuthorized(req)) return false;
  json(req, res, 401, { error: "Unauthorized" });
  return true;
}

function clearDashboardCache() {
  dashboardCacheGeneration += 1;
  dashboardCache = null;
  dashboardRatesCache = null;
}

function buildDashboardPayload(now = Date.now()) {
  const generatedAt = new Date(now);
  const meta = { ...metadata(), catalog: providerCatalog() };
  const index = { metadata: modelIndexMetadata() };
  const { chartRates, panelRates } = dashboardSummaryData(generatedAt);
  return {
    meta,
    index,
    dashboard: buildDashboardSummary({
      meta,
      rates: panelRates,
      chartRates,
      panelRates,
      generatedAt
    })
  };
}

function cachedPayloadIsFresh(cache, now = Date.now()) {
  return cache?.payload && now - cache.createdAt <= DASHBOARD_CACHE_MS;
}

async function readPersistedDashboardCache() {
  try {
    const raw = await readFile(DASHBOARD_CACHE_FILE, "utf8");
    const cache = JSON.parse(raw);
    if (cache.version !== DASHBOARD_CACHE_VERSION || !cache.createdAt || !cache.payload?.dashboard) return null;
    return cache;
  } catch {
    return null;
  }
}

async function writePersistedDashboardCache(cache) {
  const tempPath = `${DASHBOARD_CACHE_FILE}.${process.pid}.tmp`;
  await writeFile(tempPath, JSON.stringify(cache));
  await rename(tempPath, DASHBOARD_CACHE_FILE);
}

async function refreshDashboardCache() {
  if (!dashboardRefreshPromise || dashboardRefreshGeneration !== dashboardCacheGeneration) {
    const generation = dashboardCacheGeneration;
    dashboardRefreshGeneration = generation;
    dashboardRefreshPromise = (async () => {
      const cache = {
        version: DASHBOARD_CACHE_VERSION,
        createdAt: Date.now(),
        payload: buildDashboardPayload()
      };
      if (generation !== dashboardCacheGeneration) return refreshDashboardCache();
      dashboardCache = cache;
      try {
        await writePersistedDashboardCache(cache);
      } catch (error) {
        console.error(JSON.stringify({ dashboardCachePersistError: error.message }));
      }
      return cache.payload;
    })().finally(() => {
      if (generation === dashboardRefreshGeneration) dashboardRefreshPromise = null;
    });
  }
  return dashboardRefreshPromise;
}

function scheduleDashboardRefresh(label) {
  refreshDashboardCache()
    .then(() => console.log(JSON.stringify({ dashboardCache: "refreshed", label })))
    .catch((error) => console.error(JSON.stringify({ dashboardCacheError: error.message, label })));
}

function getDashboardRates() {
  const now = Date.now();
  if (!dashboardRatesCache || now - dashboardRatesCache.createdAt > DASHBOARD_CACHE_MS) {
    dashboardRatesCache = { createdAt: now, rates: dashboardRates(new Date(now)) };
  }
  return dashboardRatesCache.rates;
}

async function getDashboardPayload() {
  const now = Date.now();
  if (cachedPayloadIsFresh(dashboardCache, now)) return dashboardCache.payload;

  const persistedCache = await readPersistedDashboardCache();
  if (persistedCache?.payload) {
    dashboardCache = persistedCache;
    if (!cachedPayloadIsFresh(persistedCache, now)) scheduleDashboardRefresh("stale-read");
    return persistedCache.payload;
  }

  return refreshDashboardCache();
}

async function api(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/dashboard") {
    return json(req, res, 200, await getDashboardPayload());
  }
  if (req.method === "GET" && url.pathname === "/api/dashboard-rates") {
    return json(req, res, 200, getDashboardRates());
  }
  if (req.method === "GET" && url.pathname === "/api/rates") {
    return json(req, res, 200, listRates(Object.fromEntries(url.searchParams)));
  }
  if (req.method === "GET" && url.pathname === "/api/meta") {
    return json(req, res, 200, { ...metadata(), catalog: providerCatalog() });
  }
  if (req.method === "GET" && url.pathname === "/api/model-index") {
    return json(req, res, 200, { metadata: modelIndexMetadata(), observations: modelIndex() });
  }
  if (req.method === "POST" && url.pathname === "/api/scrape") {
    if (requireAuth(req, res)) return;
    const input = await body(req);
    const ids = input.providers?.length ? input.providers : providerCatalog().map((p) => p.id);
    const results = await collectProviders(ids);
    clearDashboardCache();
    await refreshDashboardCache();
    return json(req, res, 200, { results: summarizeCollection(results) });
  }
  if (req.method === "POST" && url.pathname === "/api/archive") {
    if (requireAuth(req, res)) return;
    const input = await body(req);
    const runId = startRun(`${input.provider}:archive`);
    try {
      const rates = await importArchive(input.provider, input);
      const saved = saveRates(rates);
      finishRun(runId, "success", saved);
      clearDashboardCache();
      await refreshDashboardCache();
      return json(req, res, 200, { records: saved });
    } catch (error) {
      finishRun(runId, "failed", 0, error.message);
      return json(req, res, 422, { error: error.message });
    }
  }
  if (req.method === "POST" && url.pathname === "/api/daily-report") {
    if (requireAuth(req, res)) return;
    const input = await body(req);
    if (input.async) {
      runDailyReport({ ...input, async: undefined })
        .then((result) => {
          clearDashboardCache();
          scheduleDashboardRefresh("daily-report");
          console.log(JSON.stringify({ dailyReport: result }));
        })
        .catch((error) => console.error(JSON.stringify({ dailyReportError: error.message })));
      return json(req, res, 202, { status: "started" });
    }
    const result = await runDailyReport(input);
    clearDashboardCache();
    await refreshDashboardCache();
    return json(req, res, 200, result);
  }
  return json(req, res, 404, { error: "Not found" });
}

async function staticFile(req, res, url) {
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const safe = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const path = join(PUBLIC, safe);
  if (!path.startsWith(PUBLIC)) return json(req, res, 403, { error: "Forbidden" });
  try {
    const data = await readFile(path);
    const type = extname(path);
    const isHtml = type === ".html";
    res.writeHead(200, {
      "content-type": MIME[type] || "application/octet-stream",
      "cache-control": isHtml ? "no-cache" : "public, max-age=3600, stale-while-revalidate=86400"
    });
    res.end(data);
  } catch {
    json(req, res, 404, { error: "Not found" });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith("/api/")) await api(req, res, url);
    else await staticFile(req, res, url);
  } catch (error) {
    json(req, res, 500, { error: error.message });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`GPU Rental Rate Index running at http://localhost:${PORT}`);
  scheduleDashboardRefresh("startup");
});
