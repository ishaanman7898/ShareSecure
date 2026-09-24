// POST /api/gpt/share — share files attached in a ChatGPT conversation.
// ChatGPT fills openaiFileIdRefs with {name, id, mime_type, download_link} for
// each attached file; the links are short-lived and hosted by OpenAI.
import { upload, toRecipients } from '../../_mcp.js';
import { gptUser, unauthorized } from './_auth.js';

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED = /\.(pdf|docx|png|jpe?g)$/i;
// only fetch from OpenAI's file hosts, so this can't be pointed at anything else
const OPENAI_HOST = /(^|\.)(oaiusercontent\.com|openai\.com)$/i;

async function fetchAttachment(ref) {
  let url;
  try { url = new URL(ref.download_link); } catch { throw new Error('bad download link'); }
  if (url.protocol !== 'https:' || !OPENAI_HOST.test(url.hostname)) throw new Error('download link isn’t from ChatGPT');
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`couldn’t download it (${res.status})`);
  if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new Error('it’s over 10 MB');
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) throw new Error('it’s over 10 MB');
  return buf;
}

export async function onRequestPost(context) {
  const user = await gptUser(context);
  if (!user) return unauthorized();

  let body;
  try { body = await context.request.json(); } catch { return Response.json({ error: 'Send JSON.' }, { status: 400 }); }
  const refs = (Array.isArray(body.openaiFileIdRefs) ? body.openaiFileIdRefs : []).slice(0, 5);
  if (!refs.length) return Response.json({ error: 'Attach a file to the conversation first, then ask me to share it.' }, { status: 400 });

  const opts = {
    expires_hours: Math.min(Math.max(Number(body.expires_hours) || 24, 1), 240),
    allow_download: Boolean(body.allow_download),
    require_account: Boolean(body.require_account),
    send_to: toRecipients(body.send_to),
  };

  const shares = [], errors = [];
  for (const ref of refs) {
    const name = String(ref?.name || 'file');
    if (!ALLOWED.test(name)) { errors.push({ file: name, error: 'Only PDF, DOCX, PNG and JPG files can be shared.' }); continue; }
    try {
      const bytes = await fetchAttachment(ref);
      const result = await upload(user, new File([bytes], name, { type: ref.mime_type || 'application/octet-stream' }),
        { ...opts, name: refs.length === 1 && body.name ? String(body.name).slice(0, 200) : null }, context);
      if (result.error) errors.push({ file: name, error: result.error });
      else shares.push(result);
    } catch (err) {
      errors.push({ file: name, error: `Couldn’t share it: ${err.message}` });
    }
  }
  return Response.json({ shares, errors }, { status: shares.length ? 200 : 400 });
}
