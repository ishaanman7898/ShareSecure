// Annotations are the private notes of whoever owns a link. Every viewer who
// isn't the owner gets a fresh link of their own before annotations load (see
// assignFreshId in viewer.js), so nobody is meant to read or write the notes
// on someone else's link. Reading and saving both need that link's delete
// token, which only its owner holds, sent in the X-Delete-Token header.
import { getClientById, getEncKey, encryptStr, decryptStr, ensureFileColumns, signInRequired, tokensMatch } from '../../_turso.js';

const MAX_BYTES = 1024 * 1024;
const MAX_STROKES = 5000;
const MAX_POINTS = 20000;
const COLOR = /^(#[0-9a-f]{6}|rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(0|1|0?\.\d+)\s*\))$/i;

const isNum = n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 1e6;

// Keep only well-formed strokes, rebuilt with known fields, or null if any is bad.
function cleanStrokes(list) {
  if (!Array.isArray(list) || list.length > MAX_STROKES) return null;
  const out = [];
  for (const s of list) {
    if (typeof s !== 'object' || s === null) return null;
    if (!Number.isInteger(s.page) || s.page < 1 || s.page > 10000) return null;
    if (typeof s.color !== 'string' || !COLOR.test(s.color)) return null;
    if (!isNum(s.width) || s.width <= 0 || s.width > 64) return null;
    if (!Array.isArray(s.points) || s.points.length > MAX_POINTS) return null;
    if (!s.points.every(p => typeof p === 'object' && p !== null && isNum(p.x) && isNum(p.y))) return null;
    out.push({
      page: s.page,
      color: s.color,
      width: s.width,
      eraser: s.eraser === true,
      highlight: s.highlight === true,
      points: s.points.map(p => ({ x: p.x, y: p.y })),
    });
  }
  return out;
}

async function findFile(client, shortId) {
  await ensureFileColumns(client);
  return (await client.execute({
    sql: 'SELECT short_id, annotations, allow_annotations, require_account, recipient_user_tag, expires_at, delete_token FROM files WHERE short_id = ? AND is_active = 1',
    args: [shortId]
  })).rows[0];
}

// The response to send when this request can't use the link's annotations.
async function refuse(file, request, env) {
  if (!file) return Response.json({ error: 'File not found' }, { status: 404 });
  if (file.expires_at && new Date(file.expires_at) < new Date()) {
    return Response.json({ error: 'Link expired' }, { status: 410 });
  }
  const denied = await signInRequired(file, request, env);
  if (denied) return denied;
  if (!(await tokensMatch(request.headers.get('X-Delete-Token'), file.delete_token))) {
    return Response.json({ error: 'Only the owner of this link can use its annotations' }, { status: 403 });
  }
  return null;
}

export async function onRequestGet(context) {
  const { params, env, request } = context;
  const client = await getClientById(params.shortId, env);
  const file = await findFile(client, params.shortId);
  const refused = await refuse(file, request, env);
  if (refused) return refused;

  const encKey = await getEncKey(env);
  const raw = await decryptStr(file.annotations, encKey, env, params.shortId);
  let annotations = [];
  try { annotations = raw ? JSON.parse(raw) : []; } catch {}

  return Response.json({
    annotations,
    allow_annotations: file.allow_annotations !== 0
  });
}

export async function onRequestPost(context) {
  const { params, env, request } = context;
  const client = await getClientById(params.shortId, env);
  const file = await findFile(client, params.shortId);
  const refused = await refuse(file, request, env);
  if (refused) return refused;
  if (file.allow_annotations === 0) {
    return Response.json({ error: 'Annotations are disabled for this file' }, { status: 403 });
  }

  const text = await request.text();
  if (text.length > MAX_BYTES * 2) {
    return Response.json({ error: 'Annotations data too large' }, { status: 413 });
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const annotations = cleanStrokes(body?.annotations);
  if (!annotations) {
    return Response.json({ error: 'Invalid annotations' }, { status: 400 });
  }

  const annotStr = JSON.stringify(annotations);
  if (annotStr.length > MAX_BYTES) {
    return Response.json({ error: 'Annotations data too large' }, { status: 413 });
  }

  const encKey = await getEncKey(env);
  const encAnnot = await encryptStr(annotStr, encKey, env, params.shortId);

  await client.execute({
    sql: 'UPDATE files SET annotations = ? WHERE short_id = ?',
    args: [encAnnot, params.shortId]
  });

  return Response.json({ saved: true });
}
