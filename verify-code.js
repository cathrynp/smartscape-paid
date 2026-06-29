// netlify/functions/verify-code.js
// Verifies a Gumroad license key for the Greenprint Generator Beta Access product.
// Uses Gumroad's built-in uses_count to enforce a 3-device cap.

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
    params.append('increment_uses_count', 'true');

    var resp = await fetch('https://api.gumroad.com/v2/licenses/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    var data = await resp.json();
    console.log("Gumroad response:", JSON.stringify(data));

    if (!data.success) {
      return {
        statusCode: 200,
        body: JSON.stringify({ valid: false, error: 'License key not recognized.' })
      };
    }

    // Check Gumroad's built-in uses count — cap at 3
    var uses = data.uses || 0;
    if (uses > 3) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          valid: false,
          error: 'This license key has reached its 3-device limit. Email smartscapeapp@gmail.com for options.'
        })
      };
    }

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
