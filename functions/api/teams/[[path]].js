// /api/teams — teams (see _teams.js). Everything here needs signing in.
//   GET    /api/teams                              your teams, with your sealed copy of each team's keys
//   POST   /api/teams                              make one: { name, color?, logo?, public_key, key_box }
//   PATCH  /api/teams/:id                          admins: { name?, color?, logo?, requests_by? }
//   DELETE /api/teams/:id                          admins: the team, its request links and its inbox
//   GET    /api/teams/:id/members                  who's in
//   POST   /api/teams/:id/members                  admins: { username, role, key_box }
//   PATCH  /api/teams/:id/members/:username        admins: { role }
//   DELETE /api/teams/:id/members/:username        admins, or yourself to leave
//   PUT    /api/teams/:id/keys                     admins: { public_key, boxes: { username: key_box } }
//   GET    /api/teams/:id/inbox                    files sent through the team's request links
//   POST   /api/teams/:id/inbox                    any member: add a file sealed to the team (multipart: file, meta, inbox_key, note?, hours?)
//   DELETE /api/teams/:id/inbox/:shortId           any member
import { verifyToken } from '../../_turso.js';
import {
  myTeams, createTeam, updateTeam, deleteTeam, listMembers, addMember, setRole, removeMember, rotateKeys, teamInbox, addTeamFile, deleteTeamFile,
} from '../../_teams.js';

const ID = /^[A-Za-z0-9]{6,32}$/;
const fail = (error, status) => Response.json({ error }, { status });
const reply = out => (out.error ? fail(out.error, out.status || 400) : Response.json(out));

export async function onRequest(context) {
  const { request, env } = context;
  const [id, section, item, ...rest] = Array.isArray(context.params.path) ? context.params.path : [];
  if (rest.length || (id !== undefined && !ID.test(id))) return fail('Not found', 404);
  const method = request.method;
  if (method !== 'GET') {
    const origin = request.headers.get('Origin');
    if (origin && origin !== new URL(request.url).origin) return fail('Origin not allowed', 403);
  }
  const auth = await verifyToken(request.headers.get('Authorization'), env);
  if (!auth) return fail('Sign in first.', 401);
  // a file added to the team inbox comes as a form; everything else is JSON
  const isUpload = section === 'inbox' && !item && method === 'POST';
  const body = ['POST', 'PATCH', 'PUT'].includes(method) && !isUpload ? await request.json().catch(() => null) : null;
  if (['POST', 'PATCH', 'PUT'].includes(method) && !isUpload && !body) return fail('Send JSON.', 400);
  const me = auth.userId;

  try {
    if (!id) {
      if (method === 'GET') return Response.json({ teams: await myTeams(env, me) });
      if (method === 'POST') return reply(await createTeam(env, me, body));
    } else if (!section) {
      if (method === 'PATCH') return reply(await updateTeam(env, me, id, body));
      if (method === 'DELETE') return reply(await deleteTeam(env, me, id));
    } else if (section === 'members') {
      if (!item && method === 'GET') return reply(await listMembers(env, me, id));
      if (!item && method === 'POST') return reply(await addMember(env, me, id, body));
      if (item && method === 'PATCH') return reply(await setRole(env, me, id, decodeURIComponent(item), body.role));
      if (item && method === 'DELETE') return reply(await removeMember(env, me, id, decodeURIComponent(item)));
    } else if (section === 'keys' && !item && method === 'PUT') {
      return reply(await rotateKeys(env, me, id, body));
    } else if (section === 'inbox') {
      if (!item && method === 'GET') return reply(await teamInbox(env, me, id));
      if (isUpload) {
        const form = await request.formData().catch(() => null);
        if (!form) return fail('Send the file as a form.', 400);
        return reply(await addTeamFile(env, me, id, form));
      }
      if (item && method === 'DELETE' && ID.test(item)) return reply(await deleteTeamFile(env, me, id, item));
    }
  } catch (err) {
    console.error('teams api failed', err);
    return fail('Something went wrong. Try again.', 500);
  }
  return fail('Not found', 404);
}
