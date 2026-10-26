// Daily/manual medicine database sync. Runs inside GitHub Actions (see .github/workflows).
// Adds new medicines from the DGDA source to the CSV. Existing rows are never changed or removed.
import { readFileSync, writeFileSync } from 'node:fs';
import { deriveSourceExportUrl, mergeMedicineDatasets } from './medicine-merge.mjs';

const CSV_PATH = process.env.MEDICINE_CSV_PATH || 'medicine_information_export.csv';
const SOURCE_URL = process.env.MEDICINE_SOURCE_URL || 'http://180.211.137.202:9310/Allopathic/?Medicine_Information';
const TRIGGER = process.env.TRIGGER || 'unknown';

async function download(url) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
        signal: AbortSignal.timeout(120000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      console.log(`Attempt ${attempt} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
  throw new Error(`Could not download ${url}: ${lastErr?.message}`);
}

const existing = readFileSync(CSV_PATH, 'utf8');
const exportUrl = deriveSourceExportUrl(SOURCE_URL);
console.log(`Downloading ${exportUrl}`);
const scraped = await download(exportUrl);

// Sanity checks so a bad answer from the source can never damage the database.
const header = (scraped.split(/\r?\n/)[0] || '').toLowerCase();
if (!header.includes('trade') || scraped.length < 10000) {
  throw new Error('The source answer does not look like the medicine export. Nothing was changed.');
}

const result = mergeMedicineDatasets(existing, scraped);
if (result.totalCount < result.existingCount) throw new Error('Merge would remove rows. Nothing was changed.');
if (result.newRowsCount > 0) writeFileSync(CSV_PATH, result.mergedCsv);

const summary = {
  lastRunAt: new Date().toISOString(),
  trigger: TRIGGER,
  existing: result.existingCount,
  fromSource: result.scrapedCount,
  added: result.newRowsCount,
  total: result.totalCount,
};
writeFileSync('last-sync.json', JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary));
