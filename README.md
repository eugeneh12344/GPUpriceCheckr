# GPU Rental Rate Index

A local-first web app that collects, normalizes, stores, and charts GPU rental prices from hyperscalers and neocloud providers.

## What it does

- Scrapes public pricing pages for Lambda, Runpod, and CoreWeave.
- Pulls dynamic market data from Ornn, Vast.ai, and RunPod marketplace feeds.
- Supports an optional TensorDock marketplace JSON feed via `TENSORDOCK_MARKETPLACE_URL`.
- Queries Microsoft's official Azure Retail Prices API.
- Queries the AWS Price List Query API for EC2 GPU VM pricing plus EC2 Spot Price History.
- Queries the Google Cloud Billing Catalog API for Compute Engine GPU pricing.
- Stores immutable, source-linked observations in SQLite.
- Normalizes multi-GPU instance prices to USD per physical GPU-hour.
- Imports historical pricing pages through the Internet Archive CDX API.
- Includes the 24-month AIMultiple GPU model index (July 2024–June 2026).
- Charts a provider-weighted collected-source index by GPU model and exposes an auditable model index table.

The starter dataset is intentionally labeled `benchmark-seed`. It gives the interface useful context before the first live/archive collection, but should not be treated as a comprehensive market history. Archive imports and recurring live collections are the primary evidence base.

## Run

Requires Node.js 22 or newer. There are no third-party runtime dependencies.

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000).

Set `DATA_DIR` to move the SQLite database outside the repo, for example to a persistent disk mount in production.

## Deploy on Render

This repo includes `render.yaml` for a Render Blueprint:

- `gpupricecheckr` web service runs the app.
- A 1 GB persistent disk is mounted at `/var/data`.
- `DATA_DIR=/var/data` stores SQLite on that disk.
- `gpupricecheckr-daily-report` cron job runs every day at 12:00 UTC and calls the web service.
- `gpu-rate-index-secrets` shares `CRON_SECRET`, Resend, and report email settings between the web service and cron job.

After creating the Blueprint in Render, set these secret values:

- `RESEND_API_KEY`
- `REPORT_TO_EMAIL`
- `REPORT_FROM_EMAIL`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `GOOGLE_SERVICE_ACCOUNT_JSON`

If Render assigns a different public URL than `https://gpupricecheckr.onrender.com`, update the cron job's `APP_BASE_URL` environment variable to the actual web service URL.

Azure pricing does not require a secret key. AWS credentials only need permission to call the Pricing API actions `pricing:GetProducts` and `pricing:GetAttributeValues`; do not use an admin key. Google Cloud requires a service account JSON key because the Cloud Billing Catalog API uses OAuth scopes rather than simple API-key auth for `services.skus.list`.

For AWS spot movement, the same AWS credentials should also allow `ec2:DescribeSpotPriceHistory`. The collector defaults to a compact set of major GPU regions and recent spot history; tune it with:

- `AWS_SPOT_REGIONS=us-east-1,us-west-2`
- `AWS_SPOT_INSTANCE_TYPES=p5.48xlarge,p5e.48xlarge`
- `AWS_SPOT_HISTORY_DAYS=14`

AWS catalog results are processed incrementally to keep memory bounded. `AWS_PRICE_PAGE_SIZE` controls the maximum products parsed at once and defaults to `50`. The daily cron starts a tracked report job and polls it with short requests until collection and email delivery finish; `REPORT_TIMEOUT_MS` defaults to 50 minutes.

AWS regions are collected with bounded concurrency so a full catalog refresh does not serialize every region. Region discovery excludes Local and Wavelength Zones, whose catalog codes otherwise look like regions but do not return the regional GPU price set. `AWS_REGION_CONCURRENCY` defaults to `4` and can be lowered if the AWS Pricing API throttles the account. Email delivery is capped by `EMAIL_TIMEOUT_MS`, which defaults to 30 seconds.

The Ornn market index collector defaults to H100 SXM, H200, B200, A100 SXM4, and RTX 5090. Override with comma-separated Ornn GPU names using `ORNN_GPU_TYPES`.

TensorDock is listed as an optional connector. It is skipped during default collection until `TENSORDOCK_MARKETPLACE_URL` points to a JSON feed with GPU labels and hourly prices.

By default, the hyperscaler collectors pull every available region returned by each pricing API. To limit collection during testing or reduce API volume, set comma-separated region allowlists:

- `AWS_REGIONS=us-east-1,us-west-2`
- `AZURE_REGIONS=eastus,eastus2,westus3`
- `GOOGLE_CLOUD_REGIONS=us-central1,us-east4`

Mutation endpoints are protected when `CRON_SECRET` is set:

```bash
curl -X POST "$APP_BASE_URL/api/daily-report" \
  -H "Authorization: Bearer $CRON_SECRET"
```

For one-provider setup checks, run the cron client in collection-only mode so it
does not send a report email or re-pull every provider:

```bash
COLLECT_ONLY=true PROVIDERS=googleCloud npm run daily-report
```

`PROVIDERS` accepts a comma-separated list such as `aws,googleCloud,azure`.
Without `COLLECT_ONLY=true`, the same provider filter sends a normal daily
report email for only those providers.

Daily report emails are digest-style: they summarize the on-demand provider-balanced
index by GPU, index-level movers, regional relative-price heatmaps, and compact
multi-GPU trend charts instead of listing every collected observation.

Every cross-provider price shown in site graphics and email digests uses the same provider-balanced index: the median price is calculated within each provider first, then the median is calculated across providers. This prevents providers with more regions or SKUs from receiving extra weight.

AWS on-demand catalog gaps of up to three days are backfilled only when matching observations on both sides of the gap have the same product, region, price, currency, label, and source URL. These rows are stored as `confirmed-backfill` so point inspection remains explicit and auditable. Unbounded gaps and gaps containing a price change are never filled.

## API

- `GET /api/meta` — source, GPU, region, commitment, collection-run, and date-range metadata.
- `GET /api/model-index` — 199 monthly cross-provider observations for 10 GPU models.
- `GET /api/dashboard` — fast homepage payload with metadata, model index metadata, and precomputed dashboard panels.
- `GET /api/dashboard-rates` — deferred compact direct-rate rows for interactive filters.
- `GET /api/rates?gpu=H100&providerType=neocloud&region=us-east-1&commitment=on-demand` — normalized observations.
- `POST /api/scrape` — authenticated collection endpoint for cron and setup tasks; pass `{"providers":["lambda"]}` to limit it.
- `POST /api/archive` — authenticated archived-page import, e.g. `{"provider":"lambda","from":"2023-01","to":"2026-06","limit":24}`.
- `POST /api/daily-report` — authenticated daily collection and email report endpoint.

## Production scheduling

Render cron calls `POST /api/daily-report` with `CRON_SECRET` and can call `POST /api/scrape` with `COLLECT_ONLY=true` for provider-specific setup runs. Keep the SQLite file on persistent storage, keep mutation endpoints behind `CRON_SECRET`, and honor each provider's robots.txt and terms.

## Adding providers

Add an entry and parser in `src/providers.mjs`. A parser receives HTML plus an observation context and returns normalized records. The same parser can then process both live and archived pages.

Good next adapters:

- Oracle Cloud GPU pricing.
- Additional exchange-style marketplaces with public price/availability APIs.
