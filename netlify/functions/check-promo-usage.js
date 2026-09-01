// netlify/functions/check-promo-usage.js
// Read-only check of how many redemptions each capped promo code (VIPACCESS, EARLYACCESS)
// has used so far, without incrementing anything. Protected by the same EXPORT_KEY used
// for the Greenprint log export — visit:
//   https://greenprints.smartscape.co/.netlify/functions/check-promo-usage?key=YOUR_KEY

const { getStore } = require('@netlify/blobs');

exports.handler = async function (event) {
  var providedKey = (event.queryStringParameters && event.queryStringParameters.key) || '';
  var realKey = process.env.EXPORT_KEY;

  if (!realKey || providedKey !== realKey) {
    return { statusCode: 401, body: 'Unauthorized. Add ?key=YOUR_EXPORT_KEY to the URL.' };
  }

  // Keep this in sync with the BYPASS_LIMITS object in verify-code.js
  var BYPASS_LIMITS = {
    'VIPACCESS': 55,
    'EARLYACCESS': 55
  };

  try {
    var store = getStore({
      name: 'promo-usage',
      siteID: '58059f0f-bc4f-4cec-8963-b609550a12e6',
      token: process.env.BLOBS_TOKEN
    });

    var results = {};
    for (var code in BYPASS_LIMITS) {
      var record = await store.get(code, { type: 'json' });
      var count = (record && record.count) || 0;
      var entries = (record && record.entries) || [];
      var limit = BYPASS_LIMITS[code];
      results[code] = { used: count, limit: limit, remaining: limit - count, entries: entries };
    }

    var lines = ['Promo code usage:\n'];
    for (var c in results) {
      var r = results[c];
      lines.push(c + ': ' + r.used + ' / ' + r.limit + ' used  (' + r.remaining + ' remaining)');

      if (r.entries.length) {
        for (var i = 0; i < r.entries.length; i++) {
          var e = r.entries[i];
          var loc = [e.city, e.region, e.country].filter(Boolean).join(', ') || 'Unknown location';
          lines.push('   - ' + e.time + '  ' + loc);
        }
      } else {
        lines.push('   (no per-use location data yet - logging started after this update; earlier redemptions aren\'t retroactively tracked)');
      }
      lines.push('');
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/plain' },
      body: lines.join('\n')
    };
  } catch (err) {
    return { statusCode: 500, body: 'Error checking promo usage: ' + err.message };
  }
};
