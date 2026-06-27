import { collectProviders, summarizeCollection } from "./collection.mjs";
import { listRates } from "./db.mjs";
import { sendEmail } from "./email.mjs";
import { providerCatalog } from "./providers.mjs";

const money = (value) => `$${Number(value).toFixed(2)}`;
const percent = (value) => `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;

function rateKey(rate) {
  return [rate.provider, rate.gpuModel, rate.gpuVariant, rate.region, rate.commitment].join("|");
}

function latestRateMap(rates) {
  const latest = new Map();
  for (const rate of rates) {
    const key = rateKey(rate);
    const current = latest.get(key);
    if (!current || new Date(rate.observedAt) > new Date(current.observedAt)) latest.set(key, rate);
  }
  return latest;
}

function enrichChanges(scrapedRates, previousRates) {
  const previousByKey = latestRateMap(previousRates);
  return scrapedRates.map((rate) => {
    const previous = previousByKey.get(rateKey(rate));
    const delta = previous ? rate.pricePerGpuHour - previous.pricePerGpuHour : null;
    const deltaPercent = previous && previous.pricePerGpuHour
      ? (delta / previous.pricePerGpuHour) * 100
      : null;
    return { ...rate, previous, delta, deltaPercent };
  }).toSorted((a, b) =>
    a.provider.localeCompare(b.provider) ||
    a.gpuModel.localeCompare(b.gpuModel) ||
    a.pricePerGpuHour - b.pricePerGpuHour
  );
}

function changeLine(rate) {
  const movement = rate.previous
    ? `${rate.delta >= 0 ? "+" : ""}${money(rate.delta)} (${percent(rate.deltaPercent)}) from ${money(rate.previous.pricePerGpuHour)}`
    : "new tracked row";
  return `${rate.provider} ${rate.gpuModel} ${rate.region}: ${money(rate.pricePerGpuHour)} / GPU-hour, ${movement}`;
}

function htmlEscape(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[char]);
}

function renderHtml({ changes, failures, generatedAt }) {
  const rows = changes.map((rate) => `<tr>
    <td>${htmlEscape(rate.provider)}</td>
    <td>${htmlEscape(rate.gpuModel)}</td>
    <td>${htmlEscape(rate.region)}</td>
    <td>${money(rate.pricePerGpuHour)}</td>
    <td>${rate.previous ? `${rate.delta >= 0 ? "+" : ""}${money(rate.delta)} (${percent(rate.deltaPercent)})` : "new"}</td>
    <td><a href="${htmlEscape(rate.sourceUrl)}">source</a></td>
  </tr>`).join("");
  const failureList = failures.length
    ? `<h2>Needs attention</h2><ul>${failures.map((failure) =>
      `<li>${htmlEscape(failure.provider)}: ${htmlEscape(failure.message)}</li>`
    ).join("")}</ul>`
    : "";

  return `<!doctype html>
  <html>
    <body style="font-family:Arial,sans-serif;color:#171a17">
      <h1>GPU rental rate daily report</h1>
      <p>Generated ${htmlEscape(generatedAt)}.</p>
      ${failureList}
      <h2>Collected rates</h2>
      <table cellpadding="8" cellspacing="0" border="1" style="border-collapse:collapse;border-color:#d8d8ce">
        <thead><tr><th>Provider</th><th>GPU</th><th>Region</th><th>Rate</th><th>Change</th><th>Source</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="6">No rates collected.</td></tr>`}</tbody>
      </table>
    </body>
  </html>`;
}

export async function runDailyReport(options = {}) {
  const providerIds = options.providers?.length
    ? options.providers
    : providerCatalog().map((provider) => provider.id);
  const before = listRates();
  const results = await collectProviders(providerIds);
  const scrapedRates = results.flatMap((result) => result.rates);
  const changes = enrichChanges(scrapedRates, before);
  const failures = results.filter((result) => result.status === "failed");
  const generatedAt = new Date().toISOString();
  const subject = `GPU rates: ${scrapedRates.length} rows collected, ${failures.length} failures`;
  const text = [
    `GPU rental rate daily report`,
    `Generated ${generatedAt}`,
    "",
    failures.length ? `Needs attention:\n${failures.map((failure) => `- ${failure.provider}: ${failure.message}`).join("\n")}` : "No collection failures.",
    "",
    changes.length ? changes.map((rate) => `- ${changeLine(rate)}\n  ${rate.sourceUrl}`).join("\n") : "No rates collected."
  ].join("\n");
  const html = renderHtml({ changes, failures, generatedAt });
  const email = await sendEmail({ subject, text, html });

  return {
    generatedAt,
    providers: providerIds,
    results: summarizeCollection(results),
    collected: scrapedRates.length,
    failures: failures.length,
    email
  };
}
