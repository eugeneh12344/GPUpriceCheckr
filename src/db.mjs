import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = join(ROOT, "data");
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(join(DATA_DIR, "gpu-rates.sqlite"));

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS rates (
    id INTEGER PRIMARY KEY,
    observed_at TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_type TEXT NOT NULL CHECK(provider_type IN ('hyperscaler', 'neocloud')),
    gpu_model TEXT NOT NULL,
    gpu_variant TEXT NOT NULL DEFAULT '',
    region TEXT NOT NULL DEFAULT 'global',
    commitment TEXT NOT NULL DEFAULT 'on-demand',
    price_per_gpu_hour REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    source_url TEXT NOT NULL,
    source_kind TEXT NOT NULL DEFAULT 'live',
    raw_label TEXT NOT NULL DEFAULT '',
    UNIQUE(observed_at, provider, gpu_model, gpu_variant, region, commitment, source_kind)
  );

  CREATE INDEX IF NOT EXISTS idx_rates_observed_at ON rates(observed_at);
  CREATE INDEX IF NOT EXISTS idx_rates_gpu_model ON rates(gpu_model);
  CREATE INDEX IF NOT EXISTS idx_rates_provider ON rates(provider);

  CREATE TABLE IF NOT EXISTS scrape_runs (
    id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,
    records_found INTEGER NOT NULL DEFAULT 0,
    message TEXT NOT NULL DEFAULT ''
  );
`);

const insert = db.prepare(`
  INSERT INTO rates (
    observed_at, provider, provider_type, gpu_model, gpu_variant, region,
    commitment, price_per_gpu_hour, currency, source_url, source_kind, raw_label
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(observed_at, provider, gpu_model, gpu_variant, region, commitment, source_kind)
  DO UPDATE SET
    price_per_gpu_hour = excluded.price_per_gpu_hour,
    source_url = excluded.source_url,
    raw_label = excluded.raw_label
`);

export function saveRates(rates) {
  db.exec("BEGIN");
  try {
    for (const rate of rates) {
      insert.run(
        rate.observedAt,
        rate.provider,
        rate.providerType,
        rate.gpuModel,
        rate.gpuVariant || "",
        rate.region || "global",
        rate.commitment || "on-demand",
        rate.pricePerGpuHour,
        rate.currency || "USD",
        rate.sourceUrl,
        rate.sourceKind || "live",
        rate.rawLabel || ""
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return rates.length;
}

export function listRates(filters = {}) {
  const clauses = [];
  const values = [];
  for (const [column, value] of [
    ["gpu_model", filters.gpu],
    ["provider", filters.provider],
    ["provider_type", filters.providerType],
    ["commitment", filters.commitment]
  ]) {
    if (value) {
      clauses.push(`${column} = ?`);
      values.push(value);
    }
  }
  if (filters.from) {
    clauses.push("observed_at >= ?");
    values.push(filters.from);
  }
  if (filters.to) {
    clauses.push("observed_at <= ?");
    values.push(filters.to);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`
    SELECT
      id, observed_at AS observedAt, provider, provider_type AS providerType,
      gpu_model AS gpuModel, gpu_variant AS gpuVariant, region, commitment,
      price_per_gpu_hour AS pricePerGpuHour, currency, source_url AS sourceUrl,
      source_kind AS sourceKind, raw_label AS rawLabel
    FROM rates
    ${where}
    ORDER BY observed_at, provider, gpu_model, price_per_gpu_hour
  `).all(...values);
}

export function metadata() {
  const providers = db.prepare(`
    SELECT provider, provider_type AS providerType, COUNT(*) AS observations,
           MAX(observed_at) AS latestObservation
    FROM rates GROUP BY provider ORDER BY provider_type, provider
  `).all();
  const gpus = db.prepare("SELECT DISTINCT gpu_model AS gpuModel FROM rates ORDER BY gpu_model").all();
  const range = db.prepare("SELECT MIN(observed_at) AS first, MAX(observed_at) AS last, COUNT(*) AS count FROM rates").get();
  const runs = db.prepare(`
    SELECT provider, started_at AS startedAt, finished_at AS finishedAt, status,
           records_found AS recordsFound, message
    FROM scrape_runs ORDER BY id DESC LIMIT 20
  `).all();
  return { providers, gpus: gpus.map((row) => row.gpuModel), range, runs };
}

export function startRun(provider) {
  const result = db.prepare(
    "INSERT INTO scrape_runs(provider, started_at, status) VALUES (?, ?, 'running')"
  ).run(provider, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

export function finishRun(id, status, recordsFound, message = "") {
  db.prepare(`
    UPDATE scrape_runs
    SET finished_at = ?, status = ?, records_found = ?, message = ?
    WHERE id = ?
  `).run(new Date().toISOString(), status, recordsFound, message, id);
}

export function seedBenchmarks() {
  const existing = db.prepare("SELECT COUNT(*) AS count FROM rates").get().count;
  if (existing) return;

  const seed = [
    ["2025-01-01", "AWS", "hyperscaler", "H100", 12.29],
    ["2025-04-01", "AWS", "hyperscaler", "H100", 12.29],
    ["2025-07-01", "AWS", "hyperscaler", "H100", 12.29],
    ["2025-10-01", "AWS", "hyperscaler", "H100", 10.98],
    ["2026-01-01", "Hyperscaler index", "hyperscaler", "H100", 7.26],
    ["2026-04-01", "Hyperscaler index", "hyperscaler", "H100", 7.46],
    ["2025-01-01", "Lambda", "neocloud", "H100", 2.49],
    ["2025-04-01", "Lambda", "neocloud", "H100", 2.99],
    ["2025-07-01", "Lambda", "neocloud", "H100", 2.99],
    ["2025-10-01", "Lambda", "neocloud", "H100", 3.29],
    ["2026-01-01", "Neocloud index", "neocloud", "H100", 2.20],
    ["2026-04-01", "Neocloud index", "neocloud", "H100", 2.64],
    ["2026-01-01", "Neocloud index", "neocloud", "B200", 4.40],
    ["2026-04-01", "Neocloud index", "neocloud", "B200", 5.35]
  ].map(([observedAt, provider, providerType, gpuModel, pricePerGpuHour]) => ({
    observedAt: `${observedAt}T00:00:00.000Z`,
    provider,
    providerType,
    gpuModel,
    pricePerGpuHour,
    region: provider === "AWS" ? "us-east-1" : "global",
    sourceUrl: provider.includes("index")
      ? "https://www.businessinsider.com/ai-demand-boosts-gpu-prices-silicon-data-ceo-carmen-li-2026-4"
      : provider === "Lambda"
        ? "https://lambda.ai/instances"
        : "https://aws.amazon.com/ec2/instance-types/p5/",
    sourceKind: "benchmark-seed",
    rawLabel: "Starter benchmark; replace or supplement with archived observations."
  }));
  saveRates(seed);
}
