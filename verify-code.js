// netlify/functions/verify-code.js
// Verifies a Gumroad license key for the Greenprint Generator Beta Access product.

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ valid: false, error: 'Method not allowed' }) };
  }

  let code;
  try {
    var body = JSON.parse(event.body);
    code = (body.code || '').trim();
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ valid: false, error: 'Bad request' }) };
  }

  if (!code) {
    return { statusCode: 400, body: JSON.stringify({ valid: false, error: 'No code provided' }) };
  }

  // Your Gumroad Product ID for "Greenprint Generator - Beta Access"
  var PRODUCT_ID = 'FNqEFzXXRqr-uM1-cgu0iQ==';

  try {
    var params = new URLSearchParams();
    params.append('product_id', PRODUCT_ID);
    params.append('license_key', code);
    params.append('increment_uses_count', 'false'); // don't count this as a "use" — just checking

    var resp = await fetch('https://api.gumroad.com/v2/licenses/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    var data = await resp.json();

    if (data.success) {
      return {
        statusCode: 200,
        body: JSON.stringify({ valid: true })
      };
    } else {
      return {
        statusCode: 200,
        body: JSON.stringify({ valid: false, error: 'Code not recognized' })
      };
    }
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ valid: false, error: 'Verification service unavailable, please try again' })
    };
  }
};
