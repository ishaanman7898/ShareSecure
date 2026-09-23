'use strict';
// Owner sign-in for the self-hosted server: scrypt password hashes and
// HMAC-signed, expiring session tokens.
const crypto = require('crypto');
const settings = require('./settings');

const SESSION_TTL_S = 12 * 60 * 60; // 12 hours
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

const b64url = buf => Buffer.from(buf).toString('base64url');

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${b64url(salt)}$${b64url(hash)}`;
}

// Constant-time check of a password against a stored scrypt hash.
function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.startsWith('scrypt$')) return { ok: false };
  const [, N, r, p, salt, hash] = stored.split('$');
  const expected = Buffer.from(hash, 'base64url');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64url'), expected.length, { N: +N, r: +r, p: +p });
  return { ok: crypto.timingSafeEqual(actual, expected) };
}

function sign(payloadB64) {
  return b64url(crypto.createHmac('sha256', settings.get('sessionSecret')).update(payloadB64).digest());
}

function issueToken(user) {
  const payload = b64url(JSON.stringify({
    username: user.username,
    userId: user.id,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S,
  }));
  return `${payload}.${sign(payload)}`;
}

// "Bearer <token>" → { username, userId } or null.
function verifyToken(authHeader) {
  if (!authHeader) return null;
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.exp || data.exp < Date.now() / 1000) return null;
    return { username: data.username, userId: data.userId };
  } catch {
    return null;
  }
}

// Express middleware: only the signed-in owner may continue.
function requireOwner(req, res, next) {
  const auth = verifyToken(req.headers.authorization);
  if (!auth) return res.status(401).json({ error: 'Sign in to continue' });
  req.auth = auth;
  next();
}

// Slow down password guessing: after 5 failures, lock sign-in for a growing period.
let failures = 0;
let lockedUntil = 0;

function lockoutRemainingMs() {
  return Math.max(0, lockedUntil - Date.now());
}

function recordFailure() {
  failures++;
  if (failures >= 5) {
    lockedUntil = Date.now() + Math.min(15 * 60, 30 * 2 ** (failures - 5)) * 1000;
  }
}

function recordSuccess() {
  failures = 0;
  lockedUntil = 0;
}

module.exports = {
  hashPassword, verifyPassword, issueToken, verifyToken, requireOwner,
  lockoutRemainingMs, recordFailure, recordSuccess,
};
