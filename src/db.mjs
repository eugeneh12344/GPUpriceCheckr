import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const DATA_DIR = process.env.DATA_DIR || join(ROOT, "data");
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
  CREATE INDEX IF NOT EXISTS idx_rates_region ON rates(region);
  CREATE INDEX IF NOT EXISTS idx_rates_commitment ON rates(commitment);
  CREATE INDEX IF NOT EXISTS idx_rates_exact_lookup
    ON rates(provider, gpu_model, gpu_variant, region, commitment, observed_at);
  CREATE INDEX IF NOT EXISTS idx_rates_filter_lookup
    ON rates(gpu_model, observed_at, provider, region, commitment);
  CREATE INDEX IF NOT EXISTS idx_rates_commitment_observed_lookup
    ON rates(commitment, observed_at, provider, gpu_model);

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
  const validRates = rates.filter((rate) => {
    const price = Number(rate.pricePerGpuHour);
    return Number.isFinite(price) && price > 0;
  });
  db.exec("BEGIN");
  try {
    for (const rate of validRates) {
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
  return validRates.length;
}

export function listRates(filters = {}) {
  const clauses = [];
  const values = [];
  clauses.push("price_per_gpu_hour > 0");
  for (const [column, value] of [
    ["gpu_model", filters.gpu],
    ["provider", filters.provider],
    ["provider_type", filters.providerType],
    ["region", filters.region],
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
  const where = `WHERE ${clauses.join(" AND ")}`;
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

const DASHBOARD_RATE_COLUMNS = `
  id, observed_at AS observedAt, provider, provider_type AS providerType,
  gpu_model AS gpuModel, gpu_variant AS gpuVariant, region, commitment,
  price_per_gpu_hour AS pricePerGpuHour, currency, source_url AS sourceUrl,
  source_kind AS sourceKind
`;

const DASHBOARD_RATE_SELECT = `
  id, observedAt, provider, providerType, gpuModel, gpuVariant, region,
  commitment, pricePerGpuHour, currency, sourceUrl, sourceKind
`;

function dashboardExactRows(whereClause = "", values = [], rankLimit = 1) {
  const validWhereClause = whereClause
    ? `${whereClause} AND price_per_gpu_hour > 0`
    : "WHERE price_per_gpu_hour > 0";
  return db.prepare(`
    WITH ranked AS (
      SELECT ${DASHBOARD_RATE_COLUMNS},
             ROW_NUMBER() OVER (
               PARTITION BY provider, gpu_model, gpu_variant, region, commitment
               ORDER BY observed_at DESC, id DESC
             ) AS rank
      FROM rates
      ${validWhereClause}
    )
    SELECT ${DASHBOARD_RATE_SELECT}
    FROM ranked
    WHERE rank <= ?
  `).all(...values, rankLimit);
}

function dashboardMonthlyRows() {
  return db.prepare(`
    WITH ranked AS (
      SELECT ${DASHBOARD_RATE_COLUMNS},
             ROW_NUMBER() OVER (
               PARTITION BY substr(observed_at, 1, 7), provider, gpu_model, gpu_variant, region, commitment
               ORDER BY observed_at DESC, id DESC
             ) AS rank
      FROM rates
      WHERE price_per_gpu_hour > 0
    )
    SELECT ${DASHBOARD_RATE_SELECT}
    FROM ranked
    WHERE rank = 1
  `).all();
}

function dashboardChartAggregateRows(generatedAt, commitment = "on-demand", bucket = "month") {
  const cutoff = new Date(Date.UTC(
    generatedAt.getUTCFullYear(),
    generatedAt.getUTCMonth() - 25,
    1
  )).toISOString();
  const observedBucket = bucket === "day"
    ? "substr(observed_at, 1, 10) || 'T00:00:00.000Z'"
    : "substr(observed_at, 1, 7) || '-01T00:00:00.000Z'";

  return db.prepare(`
    SELECT
      ${observedBucket} AS observedAt,
      provider,
      provider_type AS providerType,
      gpu_model AS gpuModel,
      '' AS gpuVariant,
      'dashboard aggregate' AS region,
      ? AS commitment,
      AVG(price_per_gpu_hour) AS pricePerGpuHour,
      'USD' AS currency,
      MIN(source_url) AS sourceUrl,
      'dashboard-aggregate' AS sourceKind,
      COUNT(*) AS directObservationCount,
      COUNT(DISTINCT region) AS regionCount
    FROM rates
    WHERE commitment = ? AND observed_at >= ? AND price_per_gpu_hour > 0
    GROUP BY ${observedBucket}, provider, provider_type, gpu_model
    ORDER BY observedAt, provider, gpuModel
  `).all(commitment, commitment, cutoff);
}

function dashboardSummaryPanelRows(generatedAt) {
  const rowsById = new Map();
  const addRows = (rows) => {
    for (const row of rows) rowsById.set(row.id, row);
  };

  addRows(dashboardExactRows("", [], 1));
  addRows(dashboardExactRows("WHERE commitment = 'on-demand'", [], 2));

  for (const days of [1, 7, 30, 90, 365]) {
    const cutoff = new Date(generatedAt.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
    addRows(dashboardExactRows("WHERE commitment = 'on-demand' AND observed_at <= ?", [cutoff], 1));
  }

  return [...rowsById.values()]
    .map(({ id, ...row }) => row)
    .toSorted((a, b) =>
      new Date(a.observedAt) - new Date(b.observedAt) ||
      a.provider.localeCompare(b.provider) ||
      a.gpuModel.localeCompare(b.gpuModel) ||
      a.pricePerGpuHour - b.pricePerGpuHour
    );
}

export function dashboardRates(generatedAt = new Date()) {
  const rowsById = new Map();
  const addRows = (rows) => {
    for (const row of rows) rowsById.set(row.id, row);
  };

  addRows(dashboardExactRows("", [], 2));
  addRows(dashboardMonthlyRows());

  for (const days of [1, 7, 30, 90, 365]) {
    const cutoff = new Date(generatedAt.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
    addRows(dashboardExactRows("WHERE observed_at <= ?", [cutoff], 1));
  }

  return [...rowsById.values()]
    .map(({ id, ...row }) => row)
    .toSorted((a, b) =>
      new Date(a.observedAt) - new Date(b.observedAt) ||
      a.provider.localeCompare(b.provider) ||
      a.gpuModel.localeCompare(b.gpuModel) ||
      a.pricePerGpuHour - b.pricePerGpuHour
    );
}

export function dashboardSummaryData(generatedAt = new Date()) {
  return {
    chartRates: [
      ...dashboardChartAggregateRows(generatedAt, "on-demand"),
      ...dashboardChartAggregateRows(generatedAt, "spot", "day"),
      ...dashboardChartAggregateRows(generatedAt, "market-index", "day")
    ],
    panelRates: dashboardSummaryPanelRows(generatedAt)
  };
}

export function metadata() {
  const providers = db.prepare(`
    SELECT provider, provider_type AS providerType, COUNT(*) AS observations,
           MAX(observed_at) AS latestObservation
    FROM rates WHERE price_per_gpu_hour > 0 GROUP BY provider ORDER BY provider_type, provider
  `).all();
  const gpus = db.prepare("SELECT DISTINCT gpu_model AS gpuModel FROM rates WHERE price_per_gpu_hour > 0 ORDER BY gpu_model").all();
  const regions = db.prepare("SELECT DISTINCT region FROM rates WHERE price_per_gpu_hour > 0 ORDER BY region").all();
  const commitments = db.prepare("SELECT DISTINCT commitment FROM rates WHERE price_per_gpu_hour > 0 ORDER BY commitment").all();
  const range = db.prepare("SELECT MIN(observed_at) AS first, MAX(observed_at) AS last, COUNT(*) AS count FROM rates WHERE price_per_gpu_hour > 0").get();
  const runs = db.prepare(`
    SELECT provider, started_at AS startedAt, finished_at AS finishedAt, status,
           records_found AS recordsFound, message
    FROM scrape_runs ORDER BY id DESC LIMIT 20
  `).all();
  return {
    providers,
    gpus: gpus.map((row) => row.gpuModel),
    regions: regions.map((row) => row.region),
    commitments: commitments.map((row) => row.commitment),
    range,
    runs
  };
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

export function markInterruptedRuns() {
  db.prepare(`
    UPDATE scrape_runs
    SET finished_at = ?, status = 'failed', message = 'Interrupted by process restart before completion.'
    WHERE status = 'running' AND finished_at IS NULL
  `).run(new Date().toISOString());
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
