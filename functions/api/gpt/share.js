// POST /api/gpt/share — share files from a ChatGPT conversation: ones the user
// attached and ones ChatGPT made itself (Code Interpreter output, images).
// ChatGPT fills openaiFileIdRefs with {name, id, mime_type, download_link} for
// each file; the links are short-lived and hosted by OpenAI.
import { upload, shareOptions, fetchFile, fileFor } from '../../_mcp.js';
import { gptUser, unauthorized } from './_auth.js';

// only fetch from OpenAI's file hosts, so this can't be pointed at anything
// else, and every redirect has to stay on them too
const OPENAI_HOST = /(^|\.)(oaiusercontent\.com|openai\.com)$/i;

export async function onRequestPost(context) {
  const user = await gptUser(context);
  if (!user) return unauthorized();

  let body;
  try { body = await context.request.json(); } catch { return Response.json({ error: 'Send JSON.' }, { status: 400 }); }
  const refs = (Array.isArray(body?.openaiFileIdRefs) ? body.openaiFileIdRefs : []).slice(0, 5);
  if (!refs.length) {
    return Response.json({ error: 'No file was provided; include the file (attached or generated) in openaiFileIdRefs.' }, { status: 400 });
  }

  const opts = shareOptions({ ...body, name: null });
  const shares = [], errors = [];
  for (const ref of refs) {
    const name = String(ref?.name || 'file');
    try {
      const got = await fetchFile(ref?.download_link, context, { hostOk: host => OPENAI_HOST.test(host) });
      if (got.error) { errors.push({ file: name, error: got.error }); continue; }
      const result = await upload(user, fileFor(got.bytes, name),
        { ...opts, name: refs.length === 1 && body.name ? String(body.name).slice(0, 200) : null }, context);
      if (result.error) errors.push({ file: name, error: result.error });
      else shares.push(result);
    } catch (err) {
      console.error('gpt share failed', err);
      errors.push({ file: name, error: 'Something went wrong. Try again.' });
    }
  }
  return Response.json({ shares, errors }, { status: shares.length ? 200 : 400 });
}
