// GET /api/transparency — the public key log (see public/kt.js).
//   (nothing)            { size, root }: the log as it is now
//   ?from=m&to=n         { from, to, path }: proof the log at size m is the start of the log at size n
//   ?start=i&count=k     { entries: [...] }: entries in order, at most 1000, for monitors
// Anyone can ask: the log is public by design.
import { head, consistency, entries } from '../_kt.js';

const fail = (error, status) => Response.json({ error }, { status });
const int = v => (v === null || v === '' || !/^\d+$/.test(v) ? null : Number(v));

export async function onRequestGet(context) {
  const q = new URL(context.request.url).searchParams;
  try {
    if (q.has('from') || q.has('to')) {
      const out = await consistency(context.env, int(q.get('from')), int(q.get('to')));
      return out ? Response.json(out) : fail('from and to must be sizes the log has had, from ≤ to.', 400);
    }
    if (q.has('start')) return Response.json({ entries: await entries(context.env, int(q.get('start')) ?? 0, int(q.get('count')) ?? 1000) });
    return Response.json(await head(context.env));
  } catch (err) {
    console.error('transparency failed', err);
    return fail('Something went wrong. Try again.', 500);
  }
}
