// netlify/functions/verify-code.js
// Verifies a Gumroad license key for the Greenprint Generator Beta Access product.
// Uses Gumroad's built-in uses count to enforce a 3-device cap.

const { getStore } = require('@netlify/blobs');

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ valid: false, error: 'Method not allowed' }) };
  }

  let code;
  try {
    var body = JSON.parse(event.body);
    code = (body.code || '').trim().toUpperCase();
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ valid: false, error: 'Bad request' }) };
  }

  if (!code) {
    return { statusCode: 400, body: JSON.stringify({ valid: false, error: 'No code provided' }) };
  }

  // Capped promo codes — total redemptions tracked via Netlify Blobs, matching the
  // usage limits set on their Gumroad discount codes (VIPACCESS 55, EARLYACCESS 55)
  var BYPASS_LIMITS = {
    'VIPACCESS': 55,
    'EARLYACCESS': 55
  };

  if (BYPASS_LIMITS.hasOwnProperty(code)) {
    var limit = BYPASS_LIMITS[code];
    try {
      // Explicitly pass siteID and token so Blobs works regardless of automatic
      // environment injection (fixes MissingBlobsEnvironmentError).
      var store = getStore({
        name: 'promo-usage',
        siteID: '58059f0f-bc4f-4cec-8963-b609550a12e6',
        token: process.env.BLOBS_TOKEN
      });
      var record = await store.get(code, { type: 'json' });
      var count = (record && record.count) || 0;
      var entries = (record && record.entries) || [];

      if (count >= limit) {
        return {
          statusCode: 200,
          body: JSON.stringify({ valid: false, error: 'This promo code has reached its usage limit. Email smartscapeapp@gmail.com for options.' })
        };
      }

      // Capture a rough location from Netlify's built-in geo header, if available.
      // This is best-effort — if it's missing or fails to parse, we still log the
      // use, just without a location attached.
      var geo = {};
      try {
        var geoHeader = event.headers && (event.headers['x-nf-geo'] || event.headers['X-Nf-Geo']);
        if (geoHeader) {
          geo = JSON.parse(Buffer.from(geoHeader, 'base64').toString('utf8')) || {};
        }
      } catch (geoErr) {
        geo = {};
      }

      entries.push({
        time: new Date().toISOString(),
        city: (geo.city || 'Unknown'),
        region: (geo.subdivision && geo.subdivision.name) || '',
        country: (geo.country && geo.country.name) || ''
      });

      await store.setJSON(code, { count: count + 1, entries: entries });
      return { statusCode: 200, body: JSON.stringify({ valid: true }) };
    } catch (err) {
      console.error('promo blobs error:', err);
      return {
        statusCode: 200,
        body: JSON.stringify({ valid: false, error: 'Something went wrong checking that code. Please try again in a moment.' })
      };
    }
  }

  // Hardcoded bypass keys for beta testers — exempt from device cap
  var BYPASS_KEYS = [
    'GREENPRINT-BETA',
    'AD5A44A6-CC614F98-AA0AF0DC-DD75F64E'
  ];

  if (BYPASS_KEYS.indexOf(code) !== -1) {
    return { statusCode: 200, body: JSON.stringify({ valid: true }) };
  }

  // Your Gumroad Product ID for "Greenprint Generator - Beta Access"
  var PRODUCT_ID = 'FNqEFzXXRqr-uM1-cgu0iQ==';

  try {
    // First call WITHOUT incrementing — just to check current uses count
    var checkParams = new URLSearchParams();
    checkParams.append('product_id', PRODUCT_ID);
    checkParams.append('license_key', code);
    checkParams.append('increment_uses_count', 'false');

    var checkResp = await fetch('https://api.gumroad.com/v2/licenses/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: checkParams.toString()
    });

    var checkData = await checkResp.json();

    if (!checkData.success) {
      return {
        statusCode: 200,
        body: JSON.stringify({ valid: false, error: 'License key not recognized, or you have reached the 3-device limit. Email smartscapeapp@gmail.com for options.' })
      };
    }

    // Check uses count BEFORE incrementing
    var uses = checkData.uses || 0;
    if (uses >= 5) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          valid: false,
          error: 'This license key has reached its 3-device limit. Email smartscapeapp@gmail.com for options.'
        })
      };
    }

    // Under the limit — now increment
    var incrParams = new URLSearchParams();
    incrParams.append('product_id', PRODUCT_ID);
    incrParams.append('license_key', code);
    incrParams.append('increment_uses_count', 'true');

    await fetch('https://api.gumroad.com/v2/licenses/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: incrParams.toString()
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ valid: true })
    };

  } catch (err) {
    console.error('verify-code error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ valid: false, error: 'Verification service unavailable, please try again.' })
    };
  }
};
