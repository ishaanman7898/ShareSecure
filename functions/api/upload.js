// POST /api/upload — share a file and get its link back.
//
// Two kinds of upload:
//   normal  the server checks the file type and encrypts it with its own key
//   e2e=1   the browser already encrypted it (see public/sealed.js); the server
//           stores a box it can't open, plus the name and type sealed the same way
//
// And two ways to be allowed to upload:
//   signed in               the row is tagged to the account (Your shares)
//   X-ShareSecure-Token     an anonymous upload token (end-to-end only): the
//                           server knows a real account sent it, not which one
import {
  getDb, purgeExpired, verifyToken, encryptField, encryptStr, getUserTag,
  countUploadsToday, ensureFileColumns, randomId, bufToB64
} from '../_turso.js';
import { spendToken, issuerAccount, issuedToday, DAILY } from '../_tokens.js';
import { detectType, nameFor, NOT_UTF8, TYPES_ERROR, ENCODING_ERROR } from '../../public/filetypes.js';
import { isSealed, MAX_FILE, MAX_SEALED_FILE, BOX_OVERHEAD } from '../../public/sealed.js';

const limitReached = () => Response.json({ error: `Upload limit reached (${DAILY.upload} files per 24h)` }, { status: 429 });

// uploads an account made today: tagged ones, plus anonymous tokens it was given
async function usedToday(db, auth, userTag, env) {
  return await countUploadsToday(auth.userId, userTag, env) + await issuedToday(db, await issuerAccount(auth.userId, env), 'upload');
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!/^[0-9a-f]{64}$/i.test(env.ENCRYPTION_KEY || '')) {
    return Response.json({ error: 'Encrypted uploads are unavailable until the server encryption key is configured.' }, { status: 503 });
  }

  let form;
  try { form = await request.formData(); } catch {
    return Response.json({ error: 'Invalid form data' }, { status: 400 });
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') return Response.json({ error: 'No file provided' }, { status: 400 });

  const e2e = form.get('e2e') === '1';
  if (file.size > (e2e ? MAX_SEALED_FILE : MAX_FILE)) return Response.json({ error: 'File too large. Max 10MB.' }, { status: 413 });

  // a signed-in account, or (end to end only) an anonymous token
  const auth = await verifyToken(request.headers.get('Authorization'), env);
  const anonymous = !auth && e2e && await spendToken(request, env, 'upload');
  if (!auth && !anonymous) return Response.json({ error: 'Sign in to share files.' }, { status: 401 });

  const buffer = await file.arrayBuffer();
  const shortId = randomId(8);
  let row;

  if (e2e) {
    // The name and type arrive sealed. The server can't check the type, so the
    // viewer checks it after decrypting, and the bytes are only ever served as
    // a download of unknown type.
    const meta = String(form.get('meta') || '');
    const ownerKey = String(form.get('owner_key') || '');
    const salt = String(form.get('passcode_salt') || '');
    if (!isSealed(meta) || meta.length > 2000 || (ownerKey && (!isSealed(ownerKey) || ownerKey.length > 300))
      || (salt && !/^[A-Za-z0-9_-]{22}$/.test(salt))) {
      return Response.json({ error: 'Sealed uploads need their name and type sealed too.' }, { status: 400 });
    }
    if (new Uint8Array(buffer)[0] !== 1 || buffer.byteLength < BOX_OVERHEAD + 4) {
      return Response.json({ error: 'That isn’t a sealed file.' }, { status: 400 });
    }
    // the size people see is the padded size; the real one is inside the box
    row = { name: meta, type: 'e2e', size: buffer.byteLength - BOX_OVERHEAD, data: 'e2e:' + bufToB64(buffer), ownerKey: ownerKey || null, salt: salt || null };
  } else {
    // the type comes from the bytes; the name only says which kind of text it is
    const type = detectType(new Uint8Array(buffer), file.name, file.type);
    if (!type || type === NOT_UTF8) {
      return Response.json({ error: type ? ENCODING_ERROR : TYPES_ERROR }, { status: 415 });
    }
    const name = nameFor(form.get('display_name'), file.name, type);
    row = {
      name: await encryptStr(name, null, env, shortId),
      type: await encryptStr(type, null, env, shortId),
      size: file.size,
      data: await encryptField(buffer, null, env, shortId),
      ownerKey: null,
      salt: null,
      plainName: name,
    };
  }

  const db = getDb(env);
  await ensureFileColumns(db);

  const userTag = auth ? await getUserTag(auth.userId, env) : null;
  if (auth && await usedToday(db, auth, userTag, env) >= DAILY.upload) return limitReached();

  // anything from a minute to 10 days
  const hours = Math.min(Math.max(parseFloat(form.get('expires_hours')) || 1, 1 / 60), 240);
  const expiresAt = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  const flag = name => form.get(name) === '1' ? 1 : 0;
  const deleteToken = randomId(24);

  purgeExpired(env, context);

  // The row stores the account's tag (never its id), or nothing at all.
  await db.execute({
    sql: `INSERT INTO files (short_id, original_filename, mime_type, size_bytes, file_data, expires_at, delete_token,
            user_id, user_tag, integrity_hash, compressed, cluster_id, allow_annotations, allow_download, require_account,
            e2e, owner_key, passcode_salt)
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, '', 0, ?, ?, ?, ?, ?, ?, ?)`,
    args: [shortId, row.name, row.type, row.size, row.data, expiresAt, deleteToken,
      userTag, shortId, flag('allow_annotations'), flag('allow_download'), flag('require_account'),
      e2e ? 1 : 0, row.ownerKey, row.salt]
  });

  // Count again now this one is in, so several uploads at once can't all slip
  // under the limit. One that went over is taken back out.
  if (auth && await usedToday(db, auth, userTag, env) > DAILY.upload) {
    await db.execute({ sql: 'DELETE FROM files WHERE short_id = ?', args: [shortId] });
    return limitReached();
  }

  const baseUrl = env.BASE_URL || new URL(request.url).origin;
  return Response.json({
    shortId,
    shortUrl: `${baseUrl}/r/${shortId}`,
    filename: e2e ? null : file.name,
    displayName: row.plainName || null,
    size: row.size,
    expiresAt,
    deleteToken,
    e2e,
    anonymous: Boolean(anonymous),
  });
}
