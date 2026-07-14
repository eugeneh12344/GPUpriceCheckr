import { finishRun, saveRates, startRun } from "./db.mjs";
import { defaultProviderIds, scrapeProvider } from "./providers.mjs";

function validRateRows(rates) {
  return rates.filter((rate) => {
    const price = Number(rate.pricePerGpuHour);
    return Number.isFinite(price) && price > 0;
  });
}

export async function collectProviders(providerIds = defaultProviderIds()) {
  const results = [];
  for (const id of providerIds) {
    const runId = startRun(id);
    const startedAt = Date.now();
    console.log(JSON.stringify({ collection: "started", provider: id }));
    try {
      const rates = await scrapeProvider(id);
      const validRates = validRateRows(rates);
      const saved = saveRates(validRates);
      finishRun(runId, "success", saved);
      console.log(JSON.stringify({
        collection: "finished",
        provider: id,
        status: "success",
        records: saved,
        durationMs: Date.now() - startedAt
      }));
      results.push({ provider: id, status: "success", records: saved, rates: validRates });
    } catch (error) {
      finishRun(runId, "failed", 0, error.message);
      console.error(JSON.stringify({
        collection: "finished",
        provider: id,
        status: "failed",
        error: error.message,
        durationMs: Date.now() - startedAt
      }));
      results.push({ provider: id, status: "failed", records: 0, message: error.message, rates: [] });
    }
  }
  return results;
}

export function summarizeCollection(results) {
  return results.map(({ rates, ...result }) => result);
}
