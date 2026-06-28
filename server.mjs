import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  finishRun,
  listRates,
  markInterruptedRuns,
  metadata,
  saveRates,
  seedBenchmarks,
  startRun
} from "./src/db.mjs";
import { collectProviders, summarizeCollection } from "./src/collection.mjs";
import { importArchive, providerCatalog } from "./src/providers.mjs";
import { modelIndex, modelIndexMetadata } from "./src/model-index.mjs";
import { runDailyReport } from "./src/report.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, "public");
const PORT = Number(process.env.PORT || 3000);
markInterruptedRuns();
seedBenchmarks();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function json(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
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
  json(res, 401, { error: "Unauthorized" });
  return true;
}

async function api(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/rates") {
    return json(res, 200, listRates(Object.fromEntries(url.searchParams)));
  }
  if (req.method === "GET" && url.pathname === "/api/meta") {
    return json(res, 200, { ...metadata(), catalog: providerCatalog() });
  }
  if (req.method === "GET" && url.pathname === "/api/model-index") {
    return json(res, 200, { metadata: modelIndexMetadata(), observations: modelIndex() });
  }
  if (req.method === "POST" && url.pathname === "/api/scrape") {
    if (requireAuth(req, res)) return;
    const input = await body(req);
    const ids = input.providers?.length ? input.providers : providerCatalog().map((p) => p.id);
    const results = await collectProviders(ids);
    return json(res, 200, { results: summarizeCollection(results) });
  }
  if (req.method === "POST" && url.pathname === "/api/archive") {
    if (requireAuth(req, res)) return;
    const input = await body(req);
    const runId = startRun(`${input.provider}:archive`);
    try {
      const rates = await importArchive(input.provider, input);
      saveRates(rates);
      finishRun(runId, "success", rates.length);
      return json(res, 200, { records: rates.length });
    } catch (error) {
      finishRun(runId, "failed", 0, error.message);
      return json(res, 422, { error: error.message });
    }
  }
  if (req.method === "POST" && url.pathname === "/api/daily-report") {
    if (requireAuth(req, res)) return;
    const input = await body(req);
    if (input.async) {
      runDailyReport({ ...input, async: undefined })
        .then((result) => console.log(JSON.stringify({ dailyReport: result })))
        .catch((error) => console.error(JSON.stringify({ dailyReportError: error.message })));
      return json(res, 202, { status: "started" });
    }
    return json(res, 200, await runDailyReport(input));
  }
  return json(res, 404, { error: "Not found" });
}

async function staticFile(req, res, url) {
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const safe = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const path = join(PUBLIC, safe);
  if (!path.startsWith(PUBLIC)) return json(res, 403, { error: "Forbidden" });
  try {
    const data = await readFile(path);
    res.writeHead(200, {
      "content-type": MIME[extname(path)] || "application/octet-stream",
      "cache-control": "no-cache"
    });
    res.end(data);
  } catch {
    json(res, 404, { error: "Not found" });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith("/api/")) await api(req, res, url);
    else await staticFile(req, res, url);
  } catch (error) {
    json(res, 500, { error: error.message });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`GPU Rental Rate Index running at http://localhost:${PORT}`);
});
