// netlify/functions/verify-code.js
// Verifies a Greenprint Generator access code and returns a signed token.
//  - Gumroad license keys: valid, not refunded/charged back, max 3 devices (tracked here).
//  - Promo codes (VIPACCESS / EARLYACCESS): 55 redemptions each; every redemption is one
//    device/browser and gets its own 10-Greenprint allowance (enforced in generate-background).
//  - Beta keys: stored only as hashes.

const { getStore } = require('@netlify/blobs');
const { makeToken, sha256 } = require('./lib/auth');

const SITE_ID = '58059f0f-bc4f-4cec-8963-b609550a12e6';
const PRODUCT_ID = 'FNqEFzXXRqr-uM1-cgu0iQ==';
const DEVICE_CAP = 3;
const PROMO_LIMITS = { 'VIPACCESS': 55, 'EARLYACCESS': 55 };
const ADMIN_HASHES = ['0cfd7533e3803b1237823abae718a13b6ff2b01f52be2ea16382ddd81115898a'];
const BETA_HASHES = [
  'e8a6ce7f75e52647ef6e7364cc6cf50ba137649178ce0e37967775dda177150a',
  'a9962213c985e1392ef26046b0d96d936f7cdd21a0339ac646678d9ae4e2329e'
];

function reply(obj, status) {
  return { statusCode: status || 200, body: JSON.stringify(obj) };
}

function blobs(name) {
  return getStore({ name: name, siteID: SITE_ID, token: process.env.BLOBS_TOKEN });
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return reply({ valid: false, error: 'Method not allowed' }, 405);

  let code, deviceId;
  try {
    const body = JSON.parse(event.body);
    code = (body.code || '').trim().toUpperCase();
    deviceId = String(body.deviceId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  } catch (e) {
    return reply({ valid: false, error: 'Bad request' }, 400);
  }
  if (!code) return reply({ valid: false, error: 'No code provided' }, 400);
  if (!deviceId) return reply({ valid: false, error: 'Something went wrong — please refresh the page and try again.' });
  if (!process.env.BLOBS_TOKEN && !process.env.AUTH_SECRET) {
    return reply({ valid: false, error: 'Verification service unavailable, please try again.' }, 500);
  }

  try {
    // ---------- Promo codes ----------
    if (Object.prototype.hasOwnProperty.call(PROMO_LIMITS, code)) {
      const store = blobs('promo-usage');
      const record = await store.get(code, { type: 'json' });
      const count = (record && record.count) || 0;
      const entries = (record && record.entries) || [];
      if (count >= PROMO_LIMITS[code]) {
        return reply({ valid: false, error: 'This promo code has reached its usage limit. Email smartscapeapp@gmail.com for options.' });
      }
      let geo = {};
      try {
        const h = event.headers && (event.headers['x-nf-geo'] || event.headers['X-Nf-Geo']);
        if (h) geo = JSON.parse(Buffer.from(h, 'base64').toString('utf8')) || {};
      } catch (e) { geo = {}; }
      const redemptionId = code + '-' + (count + 1);
      entries.push({
        time: new Date().toISOString(),
        city: geo.city || 'Unknown',
        region: (geo.subdivision && geo.subdivision.name) || '',
        country: (geo.country && geo.country.name) || ''
      });
      await store.setJSON(code, { count: count + 1, entries: entries });
      return reply({
        valid: true,
        kind: 'promo',
        token: makeToken({ k: 'promo', id: redemptionId, d: deviceId, t: Date.now() })
      });
    }

    // ---------- Beta keys (hashed) ----------
    const hash = sha256(code);
    if (ADMIN_HASHES.indexOf(hash) !== -1) {
      return reply({ valid: true, kind: 'admin', token: makeToken({ k: 'admin', id: 'admin', d: deviceId, t: Date.now() }) });
    }
    if (BETA_HASHES.indexOf(hash) !== -1) {
      return reply({
        valid: true,
        kind: 'beta',
        token: makeToken({ k: 'lic', id: hash.slice(0, 24), d: deviceId, t: Date.now() })
      });
    }

    // ---------- Gumroad license keys ----------
    const params = new URLSearchParams();
    params.append('product_id', PRODUCT_ID);
    params.append('license_key', code);
    params.append('increment_uses_count', 'false');
    const resp = await fetch('https://api.gumroad.com/v2/licenses/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    const data = await resp.json();
    if (!data.success) {
      return reply({ valid: false, error: 'License key not recognized. Please check it and try again. Email smartscapeapp@gmail.com if you need help.' });
    }
    const purchase = data.purchase || {};
    if (purchase.refunded || purchase.chargebacked || purchase.disputed) {
      return reply({ valid: false, error: 'This license key is no longer active. Email smartscapeapp@gmail.com if you think this is a mistake.' });
    }

    const licId = hash.slice(0, 24);
    const devStore = blobs('license-devices');
    const rec = await devStore.get(licId, { type: 'json' });
    const devices = (rec && rec.devices) || [];
    if (devices.indexOf(deviceId) === -1) {
      if (devices.length >= DEVICE_CAP) {
        return reply({ valid: false, error: 'This license key has reached its 3-device limit. Email smartscapeapp@gmail.com for options.' });
      }
      devices.push(deviceId);
      await devStore.setJSON(licId, { devices: devices, updated: new Date().toISOString() });
    }
    return reply({
      valid: true,
      kind: 'license',
      token: makeToken({ k: 'lic', id: licId, d: deviceId, t: Date.now() })
    });
  } catch (err) {
    console.error('verify-code error:', err);
    return reply({ valid: false, error: 'Verification service unavailable, please try again.' }, 500);
  }
};
