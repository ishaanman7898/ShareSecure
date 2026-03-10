import { getClientById, getEncKey, encryptStr, decryptStr } from '../../_turso.js';

export async function onRequestGet(context) {
  const { params, env } = context;
  const client = await getClientById(params.shortId, env);

  const res = await client.execute({
    sql: 'SELECT annotations FROM files WHERE short_id = ? AND is_active = 1',
    args: [params.shortId]
  });

  const file = res.rows[0];
  if (!file) return Response.json({ error: 'File not found' }, { status: 404 });

  const encKey = await getEncKey(env);
  const raw = await decryptStr(file.annotations, encKey);

  return Response.json({
    annotations: raw ? JSON.parse(raw) : []
  });
}

export async function onRequestPost(context) {
  const { params, env, request } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { annotations } = body;
  if (!Array.isArray(annotations)) {
    return Response.json({ error: 'Annotations must be an array' }, { status: 400 });
  }

  const annotStr = JSON.stringify(annotations);
  if (annotStr.length > 1024 * 1024) {
    return Response.json({ error: 'Annotations data too large' }, { status: 413 });
  }

  const client = await getClientById(params.shortId, env);

  const res = await client.execute({
    sql: 'SELECT short_id FROM files WHERE short_id = ? AND is_active = 1',
    args: [params.shortId]
  });
  if (!res.rows[0]) return Response.json({ error: 'File not found' }, { status: 404 });

  const encKey = await getEncKey(env);
  const encAnnot = await encryptStr(annotStr, encKey);

  await client.execute({
    sql: 'UPDATE files SET annotations = ? WHERE short_id = ?',
    args: [encAnnot, params.shortId]
  });

  return Response.json({ saved: true });
}
