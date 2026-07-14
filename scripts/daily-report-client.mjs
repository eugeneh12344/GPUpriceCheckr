const baseUrl = process.env.APP_BASE_URL;
const secret = process.env.CRON_SECRET;

if (!baseUrl) throw new Error("APP_BASE_URL is required.");
if (!secret) throw new Error("CRON_SECRET is required.");

function csv(value = "") {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

const cliProviders = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const providers = cliProviders.length
  ? cliProviders.flatMap(csv)
  : csv(process.env.PROVIDERS || process.env.PROVIDER_IDS || "");
const collectOnly = /^(1|true|yes)$/i.test(process.env.COLLECT_ONLY || "")
  || process.argv.includes("--collect-only");
const pathname = collectOnly ? "/api/scrape" : "/api/daily-report";
const body = {
  ...(collectOnly ? {} : { async: true }),
  ...(providers.length ? { providers } : {})
};
const timeoutMs = Number(process.env.REPORT_TIMEOUT_MS || 50 * 60 * 1000);

async function request(path, options = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    ...options,
    headers: {
      authorization: `Bearer ${secret}`,
      ...(options.body ? { "content-type": "application/json" } : {})
    },
    signal: AbortSignal.timeout(30_000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed with HTTP ${response.status}`);
  return data;
}

const data = await request(pathname, {
  method: "POST",
  body: JSON.stringify(body)
});

let result = data;
if (!collectOnly) {
  if (!data.jobId) throw new Error("Daily report did not return a job ID.");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    const status = await request(`/api/daily-report/status?jobId=${encodeURIComponent(data.jobId)}`);
    if (status.status === "failed") throw new Error(status.error || "Daily report failed.");
    if (status.status === "success") {
      result = status.result;
      break;
    }
  }
  if (result === data) throw new Error(`Daily report did not finish within ${timeoutMs}ms.`);
}

console.log(JSON.stringify({
  mode: collectOnly ? "collect-only" : "daily-report",
  endpoint: pathname,
  providers: providers.length ? providers : "all",
  response: result
}, null, 2));
