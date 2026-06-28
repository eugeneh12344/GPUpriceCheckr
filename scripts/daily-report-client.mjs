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

const response = await fetch(new URL(pathname, baseUrl), {
  method: "POST",
  headers: {
    authorization: `Bearer ${secret}`,
    "content-type": "application/json"
  },
  body: JSON.stringify(body)
});
const data = await response.json().catch(() => ({}));
if (!response.ok) throw new Error(data.error || `Collection request failed with HTTP ${response.status}`);

console.log(JSON.stringify({
  mode: collectOnly ? "collect-only" : "daily-report",
  endpoint: pathname,
  providers: providers.length ? providers : "all",
  response: data
}, null, 2));
