// netlify/functions/log-greenprint.js
// Logs the inputs of every successfully generated Greenprint (zip, goals, yard size,
// sun exposure, elevation) plus a running total count, for later aggregate market
// analysis / product refinement. Fire-and-forget from the client — never blocks the UI.

const { getStore } = require('@netlify/blobs');

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: '' };
  }

  try {
    var body = JSON.parse(event.body);

    var store = getStore({
      name: 'greenprint-log',
      siteID: '58059f0f-bc4f-4cec-8963-b609550a12e6',
      token: process.env.BLOBS_TOKEN
    });

    var entry = {
      zip: body.zip || '',
      goals: body.goals || '',
      sizeLabel: body.sizeLabel || '',
      sun: body.sun || '',
      elevation: body.elevation || '',
      timestamp: new Date().toISOString()
    };

    var entryId = 'entry_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    await store.setJSON(entryId, entry);

    // Running total counter, so the count can be read without listing every entry
    var counterRec = await store.get('_total_count', { type: 'json' });
    var total = (counterRec && counterRec.count) || 0;
    await store.setJSON('_total_count', { count: total + 1 });
  } catch (err) {
    console.log('log-greenprint error:', err.message);
    // Never fail the user's flow over logging — swallow the error.
  }

  return { statusCode: 202, body: '' };
};
