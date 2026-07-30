// netlify/functions/sync-usda-symbols.js
// One-time (and occasionally re-run) sync of the FULL USDA PLANTS Database checklist
// into Netlify Blobs, so plant links can be looked up automatically for any species
// the AI recommends, with zero manual curation. USDA has no live API, but they do
// publish a complete bulk checklist file (symbol + scientific name for ~50,000+
// species) at a stable URL — this function downloads that once and stores a
// compact name -> symbol index for fast runtime lookups.
//
// Run by visiting (protected by the same EXPORT_KEY used elsewhere):
//   https://greenprint-subscriber.netlify.app/.netlify/functions/sync-usda-symbols?key=YOUR_KEY
// Safe to re-run periodically to pick up USDA taxonomy updates; each run fully
// replaces the stored index.

const { getStore } = require('@netlify/blobs');

const CHECKLIST_URL = 'https://plants.sc.egov.usda.gov/DocumentLibrary/Txt/plantlst.txt';

// Parses one CSV line of the form: "SYMBOL","SYNONYM_SYMBOL","Scientific Name with Author","Common Name","Family"
// Handles quoted fields (no embedded commas expected inside quotes in this file, but be tolerant).
function parseCsvLine(line) {
  var fields = [];
  var cur = '';
  var inQuotes = false;
  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

// Extracts just the leading "Genus species" binomial from a full scientific name
// with author citation, e.g. "Acer macrophyllum Pursh" -> "acer macrophyllum".
function extractBinomial(sciNameWithAuthor) {
  var m = sciNameWithAuthor.trim().match(/^([A-Z][a-z]+)\s+(?:×\s*)?([a-z-]+)/);
  if (!m) return null;
  return (m[1] + ' ' + m[2]).toLowerCase();
}

exports.handler = async function (event) {
  var providedKey = (event.queryStringParameters && event.queryStringParameters.key) || '';
  var realKey = process.env.EXPORT_KEY;

  if (!realKey || providedKey !== realKey) {
    return { statusCode: 401, body: 'Unauthorized. Add ?key=YOUR_EXPORT_KEY to the URL.' };
  }

  try {
    var response = await fetch(CHECKLIST_URL);
    if (!response.ok) {
      return { statusCode: 502, body: 'Could not fetch USDA checklist file (status ' + response.status + ').' };
    }
    var text = await response.text();
    var lines = text.split('\n');

    var index = {};
    var rowCount = 0;
    // Skip header line (line 0).
    for (var i = 1; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      var fields = parseCsvLine(line);
      if (fields.length < 3) continue;
      var symbol = fields[0].trim();
      var sciNameWithAuthor = fields[2].trim();
      if (!symbol || !sciNameWithAuthor) continue;
      var binomial = extractBinomial(sciNameWithAuthor);
      if (!binomial) continue;
      // First symbol seen for a given binomial wins (accepted-name rows generally
      // appear before their synonym cross-references in this file).
      if (!index[binomial]) {
        index[binomial] = symbol;
      }
      rowCount++;
    }

    var store = getStore({
      name: 'usda-symbols',
      siteID: '58059f0f-bc4f-4cec-8963-b609550a12e6',
      token: process.env.BLOBS_TOKEN
    });
    await store.setJSON('index', index);

    var entryCount = Object.keys(index).length;
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/plain' },
      body: 'USDA PLANTS symbol sync complete.\nRows processed: ' + rowCount + '\nUnique species/synonyms indexed: ' + entryCount
    };
  } catch (err) {
    return { statusCode: 500, body: 'Error syncing USDA symbols: ' + err.message };
  }
};
