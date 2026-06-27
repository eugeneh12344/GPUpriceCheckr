import { finishRun, saveRates, startRun } from "./db.mjs";
import { providerCatalog, scrapeProvider } from "./providers.mjs";

export async function collectProviders(providerIds = providerCatalog().map((provider) => provider.id)) {
  const results = [];
  for (const id of providerIds) {
    const runId = startRun(id);
    try {
      const rates = await scrapeProvider(id);
      saveRates(rates);
      finishRun(runId, "success", rates.length);
      results.push({ provider: id, status: "success", records: rates.length, rates });
    } catch (error) {
      finishRun(runId, "failed", 0, error.message);
      results.push({ provider: id, status: "failed", records: 0, message: error.message, rates: [] });
    }
  }
  return results;
}

export function summarizeCollection(results) {
  return results.map(({ rates, ...result }) => result);
}
