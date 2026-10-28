// GET /api/info/:shortId — what the viewer needs to know about a link.
// For an end-to-end encrypted file, `filename` is still sealed ("e2e:…") and
// the viewer opens it with the key from the link.
import { getDb, purgeExpired, decryptStr, ensureFileColumns, signInRequired, findLiveFile } from '../../_turso.js';
import { noteTry } from '../../_burn.js';
import { overPublicLimit } from '../../_auth.js';

export async function onRequestGet(context) {
  const { params, env, request } = context;
  const limited = await overPublicLimit(context, 'lookup');
  if (limited) return limited;
  const db = getDb(env);
  await ensureFileColumns(db);
  purgeExpired(env, context);

  const file = await findLiveFile(db, params.shortId,
    'short_id, original_filename, mime_type, size_bytes, uploaded_at, expires_at, download_count, parent_short_id, parent_key, allow_annotations, allow_download, require_account, recipient_user_tag, e2e, passcode_salt, max_views, receipt_key, team_id, view_opts');
  if (!file) {
    // a link that worked once: this try is counted, so its owner hears of it
    if (await noteTry(db, params.shortId)) return Response.json({ error: 'This link worked once, and it has already been opened.', code: 'burned' }, { status: 410 });
    return Response.json({ error: 'File not found' }, { status: 404 });
  }
  if (file.expired) return Response.json({ error: 'Link expired' }, { status: 410 });
  const denied = await signInRequired(file, request, env);
  if (denied) return denied;

  return Response.json({
    filename: await decryptStr(file.original_filename, null, env, params.shortId),
    mimeType: file.e2e ? null : await decryptStr(file.mime_type, null, env, params.shortId),
    e2e: Boolean(file.e2e),
    // set when the link also needs a passcode to open
    passcodeSalt: file.passcode_salt || null,
    size: file.size_bytes,
    uploadedAt: file.uploaded_at,
    expiresAt: file.expires_at,
    views: file.download_count,
    // the original upload: deleting it removes every link to the file
    isRoot: !file.parent_short_id && !file.parent_key,
    requireAccount: Boolean(file.require_account),
    recipientOnly: Boolean(file.recipient_user_tag),
    allowAnnotations: file.allow_annotations ?? 1,
    allowDownload: file.allow_download ?? 0,
    // erased the moment it's opened, so the viewer asks first
    burnAfterReading: Boolean(file.max_views),
    // the sender asked to hear when it's opened; the viewer seals a receipt to this
    receiptKey: file.receipt_key || null,
    // watermark / discourage screenshots, for a share that isn't end to end
    // (an end-to-end one keeps them in its sealed name)
    viewOpts: file.view_opts ? JSON.parse(await decryptStr(file.view_opts, null, env, params.shortId).catch(() => 'null')) : null,
  });
}
