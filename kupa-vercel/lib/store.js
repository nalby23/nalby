'use strict';
const crypto = require('crypto');

const HASH = 'kupa:entries';
const CATS = ['pitch', 'gear', 'snacks', 'ref', 'other'];
const SESSION_MS = 30 * 24 * 3600 * 1000;
const MAX_IMAGE = 3 * 1000 * 1000;

function httpErr(status, code) {
  const e = new Error(code);
  e.status = status;
  e.code = code;
  return e;
}

/* ---------- Redis (Upstash REST) ---------- */
async function redis(cmd) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw httpErr(500, 'redis_not_configured');
  const r = await fetch(url.replace(/\/+$/, ''), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    console.error('redis error', r.status, j.error);
    throw httpErr(502, 'redis_error');
  }
  return j.result;
}

/* ---------- auth ---------- */
function digest(s) {
  return crypto.createHash('sha256').update(String(s)).digest();
}
function safeEq(a, b) {
  return crypto.timingSafeEqual(digest(a), digest(b));
}
function secret() {
  const s = process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD;
  if (!s) throw httpErr(500, 'admin_not_configured');
  return s;
}
function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}
function checkPassword(pw) {
  const real = process.env.ADMIN_PASSWORD;
  if (!real) throw httpErr(500, 'admin_not_configured');
  return safeEq(String(pw || ''), real);
}
function makeToken() {
  const exp = String(Date.now() + SESSION_MS);
  return exp + '.' + sign(exp);
}
function verifyToken(t) {
  const parts = String(t || '').split('.');
  if (parts.length !== 2) return false;
  const exp = Number(parts[0]);
  if (!(exp > Date.now())) return false;
  return safeEq(parts[1], sign(parts[0]));
}
function requireAuth(req) {
  const h = String(req.headers.authorization || '');
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!verifyToken(t)) throw httpErr(401, 'unauthorized');
}

/* ---------- request helpers ---------- */
function readJson(req) {
  let b = req.body;
  if (Buffer.isBuffer(b)) b = b.toString('utf8');
  if (typeof b === 'string') {
    try {
      b = JSON.parse(b);
    } catch (e) {
      throw httpErr(400, 'bad_json');
    }
  }
  return b && typeof b === 'object' ? b : {};
}
async function readRaw(req, limit) {
  if (Buffer.isBuffer(req.body)) {
    if (req.body.length > limit) throw httpErr(413, 'too_large');
    return req.body;
  }
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw httpErr(413, 'too_large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
function route(methods, fn) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!methods.includes(req.method)) {
        res.setHeader('Allow', methods.join(', '));
        throw httpErr(405, 'method_not_allowed');
      }
      await fn(req, res);
    } catch (e) {
      const status = e.status || 500;
      if (!e.status) console.error(e);
      res.status(status).json({ error: e.code || 'server_error' });
    }
  };
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ---------- validation ---------- */
function validReceipt(u) {
  if (typeof u !== 'string' || u.length > 500) return null;
  try {
    const url = new URL(u);
    if (url.protocol !== 'https:') return null;
    if (!url.hostname.endsWith('.blob.vercel-storage.com')) return null;
    return url.toString();
  } catch (e) {
    return null;
  }
}
function cleanId(id) {
  id = String(id || '');
  if (!/^[\w-]{8,64}$/.test(id)) throw httpErr(400, 'bad_id');
  return id;
}
function cleanEntry(b) {
  const kind = b.kind === 'income' || b.kind === 'expense' ? b.kind : null;
  if (!kind) throw httpErr(400, 'bad_kind');
  const amount = Math.round(Number(b.amount) * 100) / 100;
  if (!(amount > 0 && amount <= 10000000)) throw httpErr(400, 'bad_amount');
  const date = String(b.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(new Date(date + 'T00:00:00Z').getTime())) {
    throw httpErr(400, 'bad_date');
  }
  const title = String(b.title || '').trim().slice(0, 120);
  if (kind === 'expense' && !title) throw httpErr(400, 'bad_title');
  return {
    id: crypto.randomUUID(),
    kind,
    date,
    title,
    category: kind === 'expense' && CATS.includes(b.category) ? b.category : 'other',
    amount,
    receipt: kind === 'expense' ? validReceipt(b.receipt) : null,
    created: Date.now(),
  };
}

/* ---------- storage ---------- */
async function listEntries() {
  const raw = (await redis(['HGETALL', HASH])) || [];
  const vals = Array.isArray(raw) ? raw.filter((_, i) => i % 2 === 1) : Object.values(raw);
  const out = [];
  for (const v of vals) {
    try {
      out.push(typeof v === 'string' ? JSON.parse(v) : v);
    } catch (e) {
      /* skip a corrupt row */
    }
  }
  return out;
}
async function getEntry(id) {
  const v = await redis(['HGET', HASH, id]);
  if (!v) return null;
  try {
    return typeof v === 'string' ? JSON.parse(v) : v;
  } catch (e) {
    return null;
  }
}
async function saveEntry(e) {
  await redis(['HSET', HASH, e.id, JSON.stringify(e)]);
}
async function removeEntry(id) {
  await redis(['HDEL', HASH, id]);
}
async function deleteBlob(url) {
  if (!validReceipt(url)) return;
  try {
    const { del } = await import('@vercel/blob');
    await del(url);
  } catch (e) {
    console.error('blob delete failed');
  }
}
async function putReceipt(buf) {
  const { put } = await import('@vercel/blob');
  const r = await put('receipts/receipt.jpg', buf, {
    access: 'public',
    contentType: 'image/jpeg',
    addRandomSuffix: true,
  });
  return r.url;
}

module.exports = {
  MAX_IMAGE,
  httpErr,
  route,
  sleep,
  checkPassword,
  makeToken,
  requireAuth,
  readJson,
  readRaw,
  validReceipt,
  cleanId,
  cleanEntry,
  listEntries,
  getEntry,
  saveEntry,
  removeEntry,
  deleteBlob,
  putReceipt,
};
