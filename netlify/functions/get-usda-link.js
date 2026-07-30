// netlify/functions/get-usda-link.js
// Runtime lookup: given a list of scientific names from a Greenprint, returns a
// USDA PLANTS profile link for each one that's in the synced index (see
// sync-usda-symbols.js). Falls back to a small hardcoded list for common species
// in case the full index hasn't been synced yet. Never guesses a symbol — a
// species not found in either source simply returns null (no link).

const { getStore } = require('@netlify/blobs');

// Small safety-net list, only used if the full synced index is unavailable.
var FALLBACK_SYMBOLS = {
  'quercus garryana': 'QUGA4',
  'frangula purshiana': 'FRPU7',
  'pseudotsuga menziesii': 'PSME',
  'thuja plicata': 'THPL',
  'acer macrophyllum': 'ACMA3',
  'acer circinatum': 'ACCI'
};

exports.handler = async function (event) {
  try {
    var body = JSON.parse(event.body || '{}');
    var names = Array.isArray(body.names) ? body.names : [];

    var index = null;
    try {
      var store = getStore({
        name: 'usda-symbols',
        siteID: '58059f0f-bc4f-4cec-8963-b609550a12e6',
        token: process.env.BLOBS_TOKEN
      });
      index = await store.get('index', { type: 'json' });
    } catch (e) {
      index = null; // fall through to FALLBACK_SYMBOLS only
    }

    var results = {};
    names.forEach(function (name) {
      var key = (name || '').trim().toLowerCase();
      var symbol = (index && index[key]) || FALLBACK_SYMBOLS[key] || null;
      results[name] = symbol ? { symbol: symbol, url: 'https://plants.usda.gov/plant-profile/' + symbol } : null;
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ results: results })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
