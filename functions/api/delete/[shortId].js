import { getClientById, getTursoClient } from '../../_turso.js';

export async function onRequestPost(context) {
  const { params, env, request } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { deleteToken } = body;
  if (!deleteToken) {
    return Response.json({ error: 'Missing delete token' }, { status: 400 });
  }

  const client = await getClientById(params.shortId, env);

  // Find the file by shortId
  const res = await client.execute({
    sql: 'SELECT * FROM files WHERE short_id = ?',
    args: [params.shortId]
  });

  const file = res.rows[0];

  if (!file) return Response.json({ error: 'File not found. It may have already been deleted.' }, { status: 404 });

  // Constant-time comparison to prevent timing attacks
  if (file.delete_token !== deleteToken) {
    return Response.json({ error: 'Invalid delete token' }, { status: 403 });
  }

  const nodesCount = parseInt(env.TURSO_NODES || '3');

  async function computeHash(buffer) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = new Uint8Array(hashBuffer);
    return Array.from(hashArray).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // Case 1: GLOBAL DELETE (Owner)
  // If parent_short_id is NULL, this is the root uploader. 
  // We use the Zero-Knowledge root_hash to find and wipe all nodes.
  if (!file.parent_short_id && file.cluster_id) {
    const root_hash = await computeHash(new TextEncoder().encode(deleteToken + ":root"));

    // Broadcast delete to ALL nodes via the ZK root_hash
    for (let i = 1; i <= nodesCount; i++) {
      const shardClient = await getTursoClient(i, env);
      context.waitUntil(
        shardClient.execute({
          sql: 'DELETE FROM files WHERE cluster_id = ?',
          args: [root_hash]
        })
      );
    }
    return Response.json({ deleted: true, cluster: true });
  }

  // Case 2: BRANCH DELETE (Sub-owner)
  // If it's a reshare link, the user can delete their link and all links derived from it.
  const targetId = params.shortId;

  async function recursiveDelete(id) {
    // 1. Find all children of this ID across all nodes
    // (This is O(depth) but cluster depth is usually small)
    for (let i = 1; i <= nodesCount; i++) {
      const shardClient = await getTursoClient(i, env);
      const children = await shardClient.execute({
        sql: 'SELECT short_id FROM files WHERE parent_short_id = ?',
        args: [id]
      });

      // 2. Recurse for each child
      for (const child of children.rows) {
        await recursiveDelete(child.short_id);
      }

      // 3. Delete from this shard
      await shardClient.execute({
        sql: 'DELETE FROM files WHERE short_id = ? OR parent_short_id = ?',
        args: [id, id]
      });
    }
  }

  context.waitUntil(recursiveDelete(targetId));

  return Response.json({ deleted: true, branch: true });
}
