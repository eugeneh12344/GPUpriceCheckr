import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  finishRun,
  listRates,
  metadata,
  saveRates,
  seedBenchmarks,
  startRun
} from "./src/db.mjs";
import { importArchive, providerCatalog, scrapeProvider } from "./src/providers.mjs";
import { modelIndex, modelIndexMetadata } from "./src/model-index.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, "public");
const PORT = Number(process.env.PORT || 3000);
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
    const input = await body(req);
    const ids = input.providers?.length ? input.providers : providerCatalog().map((p) => p.id);
    const results = [];
    for (const id of ids) {
      const runId = startRun(id);
      try {
        const rates = await scrapeProvider(id);
        saveRates(rates);
        finishRun(runId, "success", rates.length);
        results.push({ provider: id, status: "success", records: rates.length });
      } catch (error) {
        finishRun(runId, "failed", 0, error.message);
        results.push({ provider: id, status: "failed", message: error.message });
      }
    }
    return json(res, 200, { results });
  }
  if (req.method === "POST" && url.pathname === "/api/archive") {
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
