# GPU Rental Rate Index

A local-first web app that collects, normalizes, stores, and charts GPU rental prices from hyperscalers and neocloud providers.

## What it does

- Scrapes public pricing pages for Lambda, Runpod, and CoreWeave.
- Queries Microsoft's official Azure Retail Prices API.
- Queries the AWS Price List Query API for EC2 GPU VM pricing.
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
- `GOOGLE_CLOUD_API_KEY`

If Render assigns a different public URL than `https://gpupricecheckr.onrender.com`, update the cron job's `APP_BASE_URL` environment variable to the actual web service URL.

Azure pricing does not require a secret key. AWS credentials only need permission to call the Pricing API actions `pricing:GetProducts` and `pricing:GetAttributeValues`; do not use an admin key. Google Cloud requires an API key with access to the Cloud Billing Catalog API.

By default, the hyperscaler collectors pull every available region returned by each pricing API. To limit collection during testing or reduce API volume, set comma-separated region allowlists:

- `AWS_REGIONS=us-east-1,us-west-2`
- `AZURE_REGIONS=eastus,eastus2,westus3`
- `GOOGLE_CLOUD_REGIONS=us-central1,us-east4`

Mutation endpoints are protected when `CRON_SECRET` is set:

```bash
curl -X POST "$APP_BASE_URL/api/daily-report" \
  -H "Authorization: Bearer $CRON_SECRET"
```

## API

- `GET /api/meta` — source, GPU, region, commitment, collection-run, and date-range metadata.
- `GET /api/model-index` — 199 monthly cross-provider observations for 10 GPU models.
- `GET /api/rates?gpu=H100&providerType=neocloud&region=us-east-1&commitment=on-demand` — normalized observations.
- `POST /api/scrape` — collect all current sources; pass `{"providers":["lambda"]}` to limit it.
- `POST /api/archive` — import archived pages, e.g. `{"provider":"lambda","from":"2023-01","to":"2026-06","limit":24}`.
- `POST /api/daily-report` — collect current sources and email a rate-change report.

## Production scheduling

Call `POST /api/scrape` daily or weekly from cron, GitHub Actions, or a serverless scheduler. Keep the SQLite file on persistent storage. Before exposing the app publicly, add authentication to mutation endpoints and honor each provider's robots.txt and terms.

## Adding providers

Add an entry and parser in `src/providers.mjs`. A parser receives HTML plus an observation context and returns normalized records. The same parser can then process both live and archived pages.

Good next adapters:

- Oracle Cloud GPU pricing.
- Vast.ai marketplace API (for a market-floor or median series rather than a list price).
