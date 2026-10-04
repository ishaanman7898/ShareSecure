// POST /api/reshare/:shortId — a new link to the same file, owned by whoever
// made it. It points at the original's bytes instead of copying them, and it's
// a branch of the link it came from: deleting that link deletes this one too.
// Which link it came from isn't stored in the clear (see branchFrom).
import { getDb, decryptStr, encryptStr, ensureFileColumns, signInRequired, branchFrom, randomId, findLiveFile } from '../../_turso.js';

export async function onRequestPost(context) {
  const { params, env, request } = context;
  const db = getDb(env);
  await ensureFileColumns(db);

  const file = await findLiveFile(db, params.shortId);
  if (!file) return Response.json({ error: 'File not found' }, { status: 404 });
  if (file.expired) return Response.json({ error: 'Link expired' }, { status: 410 });
  const denied = await signInRequired(file, request, env);
  if (denied) return denied;
  if (file.recipient_user_tag) {
    return Response.json({ error: 'This file was sent privately. Ask the sender for a shareable link.', code: 'recipient_only' }, { status: 403 });
  }
  if (file.max_views) {
    return Response.json({ error: 'This link works once, so it can’t be shared on.', code: 'once' }, { status: 403 });
  }

  const newId = randomId(8);
  const deleteToken = randomId(24);
  // The name and type are re-encrypted under the new link's key. A sealed
  // (end-to-end) name is copied as it is: the same file key opens it.
  const copy = async col => file.e2e ? file[col] : encryptStr(await decryptStr(file[col], null, env, params.shortId), null, env, newId);
  const branch = await branchFrom(file, newId, env);

  await db.execute({
    sql: `INSERT INTO files (short_id, original_filename, mime_type, size_bytes, file_data, data_ref,
            expires_at, delete_token, integrity_hash, cluster_id, parent_key, uploaded_at,
            compressed, allow_annotations, allow_download, require_account, e2e, passcode_salt)
          VALUES (?, ?, ?, ?, '', ?, ?, ?, '', ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    args: [
      newId, await copy('original_filename'), await copy('mime_type'), file.size_bytes, branch.data_ref,
      file.expires_at, deleteToken,
      newId,               // its own group: nothing in the row points back at the original
      branch.parent_key, new Date().toISOString(),
      file.allow_annotations ?? 1, file.allow_download ?? 0, file.require_account ?? 0, file.e2e ? 1 : 0, file.passcode_salt || null,
    ]
  });

  const baseUrl = env.BASE_URL || new URL(request.url).origin;
  return Response.json({ shortId: newId, shortUrl: `${baseUrl}/r/${newId}`, deleteToken, e2e: Boolean(file.e2e) });
}
