import { getClientById, getEncKey, encryptStr, decryptStr, verifyToken } from '../../_turso.js';

export async function onRequestGet(context) {
  const { params, env } = context;
  const client = await getClientById(params.shortId, env);

  const res = await client.execute({
    sql: 'SELECT annotations, allow_annotations FROM files WHERE short_id = ? AND is_active = 1',
    args: [params.shortId]
  });

  const file = res.rows[0];
  if (!file) return Response.json({ error: 'File not found' }, { status: 404 });

  const encKey = await getEncKey(env);
  const raw = await decryptStr(file.annotations, encKey, env, params.shortId);

  return Response.json({
    annotations: raw ? JSON.parse(raw) : [],
    allow_annotations: file.allow_annotations !== 0
  });
}

export async function onRequestPost(context) {
  const { params, env, request } = context;

  // Verify the file allows annotations before accepting writes
  const client = await getClientById(params.shortId, env);
  const check = await client.execute({
    sql: 'SELECT short_id, allow_annotations FROM files WHERE short_id = ? AND is_active = 1',
    args: [params.shortId]
  });
  const file = check.rows[0];
  if (!file) return Response.json({ error: 'File not found' }, { status: 404 });
  if (file.allow_annotations === 0) {
    return Response.json({ error: 'Annotations are disabled for this file' }, { status: 403 });
  }

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

  // Validate each annotation has required fields and sane types
  for (const ann of annotations) {
    if (typeof ann !== 'object' || ann === null) {
      return Response.json({ error: 'Invalid annotation object' }, { status: 400 });
    }
  }

  const annotStr = JSON.stringify(annotations);
  if (annotStr.length > 1024 * 1024) {
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
