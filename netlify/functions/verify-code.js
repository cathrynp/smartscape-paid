// netlify/functions/verify-code.js
// Verifies a Gumroad license key for the Greenprint Generator Beta Access product.
// Tracks usage count per key using Netlify Blobs — cap at 3 devices.

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
    var params = new URLSearchParams();
    params.append('product_id', PRODUCT_ID);
    params.append('license_key', code);
    params.append('increment_uses_count', 'false');

    var resp = await fetch('https://api.gumroad.com/v2/licenses/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    var data = await resp.json();

    if (!data.success) {
      return {
        statusCode: 200,
        body: JSON.stringify({ valid: false, error: 'License key not recognized.' })
      };
    }

    // Check and increment device count using Netlify Blobs
    const store = getStore({ name: 'license-keys', consistency: 'strong' });
    const existing = await store.get(code, { type: 'json' });
    const count = existing ? existing.count : 0;

    if (count >= 3) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          valid: false,
          error: 'This license key has reached its 3-device limit. Email smartscapeapp@gmail.com for options.'
        })
      };
    }

    // Increment and save
    await store.setJSON(code, { count: count + 1 });

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
