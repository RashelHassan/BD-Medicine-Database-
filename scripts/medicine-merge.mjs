/**
 * medicineDbService.ts
 *
 * Core service for parsing, scraping, deduplicating, and syncing
 * the allopathic medicine registry with GitHub and Firestore settings.
 */
/**
 * Parses a standard GitHub repository URL into component parts and raw download URL.
 */
export function parseGitHubUrl(url) {
    if (!url)
        return null;
    try {
        // Support formats:
        // https://github.com/owner/repo/blob/branch/path/to/file.csv
        // https://raw.githubusercontent.com/owner/repo/branch/path/to/file.csv
        const cleaned = url.trim();
        if (cleaned.includes('raw.githubusercontent.com')) {
            const match = cleaned.match(/raw\.githubusercontent\.com\/([^\/]+)\/([^\/]+)\/([^\/]+)\/(.+)/);
            if (match) {
                return {
                    owner: match[1],
                    repo: match[2],
                    branch: match[3],
                    path: match[4],
                    rawUrl: cleaned,
                };
            }
        }
        const githubMatch = cleaned.match(/github\.com\/([^\/]+)\/([^\/]+)(?:\/blob\/([^\/]+)\/(.+))?/);
        if (githubMatch) {
            const owner = githubMatch[1];
            const repo = githubMatch[2].replace(/\.git$/, '');
            const branch = githubMatch[3] || 'main';
            const path = githubMatch[4] || 'medicine_information_export.csv';
            const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
            return { owner, repo, branch, path, rawUrl };
        }
    }
    catch (err) {
        console.error('Error parsing GitHub URL:', err);
    }
    return null;
}
/**
 * Derives the direct CSV export endpoint from the user-provided DGDA portal URL.
 */
export function deriveSourceExportUrl(sourceUrl) {
    if (!sourceUrl)
        return '';
    const trimmed = sourceUrl.trim();
    // If already directly targeting the export action or csv
    if (trimmed.includes('Medicine_Information_Ajax.php?action=export') || trimmed.endsWith('.csv')) {
        return trimmed;
    }
    // If URL has query parameters like ?Medicine_Information
    const parsed = new URL(trimmed);
    let pathname = parsed.pathname;
    if (!pathname.endsWith('/')) {
        pathname = pathname.substring(0, pathname.lastIndexOf('/') + 1);
    }
    return `${parsed.protocol}//${parsed.host}${pathname}Medicine_Information_Ajax.php?action=export`;
}
/**
 * Robust CSV Line Splitter that handles quoted fields containing commas and quotes.
 */
export function parseCsvLine(line) {
    const values = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            if (inQuotes && line[i + 1] === '"') {
                current += '"';
                i++; // skip escaped quote
            }
            else {
                inQuotes = !inQuotes;
            }
        }
        else if (char === ',' && !inQuotes) {
            values.push(current.trim());
            current = '';
        }
        else {
            current += char;
        }
    }
    values.push(current.trim());
    return values;
}
/**
 * Formats an array of cell strings back into a compliant CSV line.
 */
export function formatCsvLine(cells) {
    return cells
        .map(cell => {
        const str = String(cell ?? '');
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
    })
        .join(',');
}
/**
 * Merges scraped live CSV rows into the existing GitHub CSV without touching existing records.
 */
export function mergeMedicineDatasets(existingCsvContent, scrapedCsvContent) {
    // Normalize line breaks
    const existingLines = existingCsvContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim().length > 0);
    const scrapedLines = scrapedCsvContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim().length > 0);
    if (existingLines.length === 0) {
        return {
            mergedCsv: scrapedCsvContent,
            existingCount: 0,
            scrapedCount: scrapedLines.length > 0 ? scrapedLines.length - 1 : 0,
            newRowsCount: scrapedLines.length > 0 ? scrapedLines.length - 1 : 0,
            totalCount: scrapedLines.length > 0 ? scrapedLines.length - 1 : 0,
            sampleNewRows: [],
        };
    }
    const existingHeaderLine = existingLines[0];
    const existingHeaders = parseCsvLine(existingHeaderLine).map(h => h.replace(/^"|"$/g, '').trim());
    const existingDataLines = existingLines.slice(1);
    // Identify column indices in existing CSV
    const darIndexExisting = existingHeaders.findIndex(h => h.toLowerCase().includes('dar'));
    const tradeIndexExisting = existingHeaders.findIndex(h => h.toLowerCase().includes('trade'));
    const companyIndexExisting = existingHeaders.findIndex(h => h.toLowerCase().includes('company'));
    const genericIndexExisting = existingHeaders.findIndex(h => h.toLowerCase().includes('generic'));
    const dosageIndexExisting = existingHeaders.findIndex(h => h.toLowerCase().includes('dosage'));
    // Build existing lookup set
    const existingKeys = new Set();
    for (const line of existingDataLines) {
        const cols = parseCsvLine(line);
        const dar = darIndexExisting !== -1 ? cols[darIndexExisting]?.trim() : '';
        if (dar && dar.length > 2) {
            existingKeys.add(`dar:${dar.toLowerCase()}`);
        }
        else {
            const fallbackKey = `${cols[companyIndexExisting] || ''}|${cols[tradeIndexExisting] || ''}|${cols[genericIndexExisting] || ''}|${cols[dosageIndexExisting] || ''}`.toLowerCase();
            if (fallbackKey.replace(/\|/g, '').length > 0) {
                existingKeys.add(`fallback:${fallbackKey}`);
            }
        }
    }
    // Scraped CSV processing
    const scrapedHeaders = parseCsvLine(scrapedLines[0]).map(h => h.replace(/^"|"$/g, '').trim());
    const scrapedDataLines = scrapedLines.slice(1);
    const darIndexScraped = scrapedHeaders.findIndex(h => h.toLowerCase().includes('dar'));
    const tradeIndexScraped = scrapedHeaders.findIndex(h => h.toLowerCase().includes('trade'));
    const companyIndexScraped = scrapedHeaders.findIndex(h => h.toLowerCase().includes('company'));
    const genericIndexScraped = scrapedHeaders.findIndex(h => h.toLowerCase().includes('generic'));
    const dosageIndexScraped = scrapedHeaders.findIndex(h => h.toLowerCase().includes('dosage'));
    let currentSl = existingDataLines.length;
    const newLinesToAppend = [];
    const sampleNewRows = [];
    for (const line of scrapedDataLines) {
        const cols = parseCsvLine(line);
        const dar = darIndexScraped !== -1 ? cols[darIndexScraped]?.trim() : '';
        let isPresent = false;
        if (dar && dar.length > 2) {
            if (existingKeys.has(`dar:${dar.toLowerCase()}`)) {
                isPresent = true;
            }
        }
        else {
            const fallbackKey = `${cols[companyIndexScraped] || ''}|${cols[tradeIndexScraped] || ''}|${cols[genericIndexScraped] || ''}|${cols[dosageIndexScraped] || ''}`.toLowerCase();
            if (existingKeys.has(`fallback:${fallbackKey}`)) {
                isPresent = true;
            }
        }
        if (!isPresent) {
            currentSl++;
            // Re-map cols into existing schema structure: SL, Company, Trade Name, Generic Name With Strength, Dosage Form, DAR No
            const companyVal = cols[companyIndexScraped] || '';
            const tradeVal = cols[tradeIndexScraped] || '';
            const genericVal = cols[genericIndexScraped] || '';
            const dosageVal = cols[dosageIndexScraped] || '';
            const darVal = dar || (darIndexScraped !== -1 ? cols[darIndexScraped] : '') || '';
            const formattedLine = formatCsvLine([currentSl, companyVal, tradeVal, genericVal, dosageVal, darVal]);
            newLinesToAppend.push(formattedLine);
            // Record key in existing set so duplicates in the scraped dataset are also de-duped
            if (dar && dar.length > 2) {
                existingKeys.add(`dar:${dar.toLowerCase()}`);
            }
            if (sampleNewRows.length < 5) {
                sampleNewRows.push({
                    company: companyVal,
                    tradeName: tradeVal,
                    generic: genericVal,
                    dosage: dosageVal,
                    darNo: darVal,
                });
            }
        }
    }
    const allLines = [existingHeaderLine, ...existingDataLines, ...newLinesToAppend];
    const mergedCsv = allLines.join('\n') + '\n';
    return {
        mergedCsv,
        existingCount: existingDataLines.length,
        scrapedCount: scrapedDataLines.length,
        newRowsCount: newLinesToAppend.length,
        totalCount: existingDataLines.length + newLinesToAppend.length,
        sampleNewRows,
    };
}
