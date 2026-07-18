// netlify/functions/export-greenprint-log.js
// Lets Cat pull the full Greenprint generation log as a CSV file for aggregate
// analysis. Protected by a simple shared key so the data isn't publicly scrapeable —
// set EXPORT_KEY in Netlify's environment variables, then visit:
//   https://greenprint-subscriber.netlify.app/.netlify/functions/export-greenprint-log?key=YOUR_KEY

const { getStore } = require('@netlify/blobs');

exports.handler = async function (event) {
  var providedKey = (event.queryStringParameters && event.queryStringParameters.key) || '';
  var realKey = process.env.EXPORT_KEY;

  if (!realKey || providedKey !== realKey) {
    return { statusCode: 401, body: 'Unauthorized. Add ?key=YOUR_EXPORT_KEY to the URL.' };
  }

  try {
    var store = getStore({
      name: 'greenprint-log',
      siteID: '58059f0f-bc4f-4cec-8963-b609550a12e6',
      token: process.env.BLOBS_TOKEN
    });

    var { blobs } = await store.list();
    var rows = [['timestamp', 'zip', 'goals', 'sizeLabel', 'sun', 'elevation']];
    var total = 0;

    for (var i = 0; i < blobs.length; i++) {
      var key = blobs[i].key;
      if (key === '_total_count') {
        var counterRec = await store.get(key, { type: 'json' });
        total = (counterRec && counterRec.count) || 0;
        continue;
      }
      var entry = await store.get(key, { type: 'json' });
      if (entry) {
        rows.push([
          entry.timestamp || '',
          entry.zip || '',
          '"' + (entry.goals || '').replace(/"/g, '""') + '"',
          entry.sizeLabel || '',
          entry.sun || '',
          entry.elevation || ''
        ]);
      }
    }

    var csv = rows.map(function (r) { return r.join(','); }).join('\n');
    csv += '\n\nTotal Greenprints generated (running counter): ' + total;

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename="greenprint-log.csv"'
      },
      body: csv
    };
  } catch (err) {
    return { statusCode: 500, body: 'Export error: ' + err.message };
  }
};
