// netlify/functions/lib/auth.js
// Signed access tokens shared by verify-code.js (issues them) and
// generate-background.js (checks them). The signing secret is the existing
// BLOBS_TOKEN environment variable, so no new setup is needed (optionally set
// AUTH_SECRET in Netlify to use a separate secret).
const crypto = require('crypto');

function secret() {
  return process.env.AUTH_SECRET || process.env.BLOBS_TOKEN || '';
}

function sign(b64) {
  return crypto.createHmac('sha256', secret()).update(b64).digest('base64url');
}

function makeToken(payload) {
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return b64 + '.' + sign(b64);
}

function readToken(token) {
  if (!token || typeof token !== 'string' || !secret()) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const expected = sign(parts[0]);
  const a = Buffer.from(parts[1]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch (e) {
    return null;
  }
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

module.exports = { makeToken, readToken, sha256 };
