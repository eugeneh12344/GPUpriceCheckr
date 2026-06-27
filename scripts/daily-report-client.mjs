const baseUrl = process.env.APP_BASE_URL;
const secret = process.env.CRON_SECRET;

if (!baseUrl) throw new Error("APP_BASE_URL is required.");
if (!secret) throw new Error("CRON_SECRET is required.");

const response = await fetch(new URL("/api/daily-report", baseUrl), {
  method: "POST",
  headers: {
    authorization: `Bearer ${secret}`,
    "content-type": "application/json"
  },
  body: JSON.stringify({})
});
const data = await response.json().catch(() => ({}));
if (!response.ok) throw new Error(data.error || `Daily report failed with HTTP ${response.status}`);

console.log(JSON.stringify(data, null, 2));
