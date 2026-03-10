import { createClient } from '@libsql/client/web';

// files db — uses turso_token directly (no api token needed)
export function getFilesClient(env) {
  return createClient({
    url: 'libsql://fileshare-node-1-ishman.aws-us-east-2.turso.io',
    authToken: env.TURSO_TOKEN
  });
}

// auth db — users table lives on node-1, same turso_token
export function getAuthClient(env) {
  return createClient({
    url: 'libsql://fileshare-node-1-ishman.aws-us-east-2.turso.io',
    authToken: env.TURSO_TOKEN
  });
}

// backward-compat aliases used by existing functions
export function getShardNode(shortId, nodes = 3) {
  if (!shortId) return 1;
  return (shortId.charCodeAt(0) % nodes) + 1;
}

export async function getTursoClient(nodeNum, env) {
  return getFilesClient(env);
}

export async function getClientById(shortId, env) {
  return getFilesClient(env);
}

export async function globalPurgeExpired(env, context, originShortId = null) {
  const client = getFilesClient(env);
  context.waitUntil(
    client.execute(
      "UPDATE files SET is_active = 0 WHERE expires_at < datetime('now') AND is_active = 1"
    ).catch(() => {})
  );
}

// sha-256 using web crypto api (no node.js crypto needed)
export async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray).map(b => b.toString(16).padStart(2, '0')).join('');
}

// decode auth bearer token → { username, userId } or null
export function decodeToken(authHeader) {
  if (!authHeader) return null;
  try {
    const tokenPart = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    const decoded = atob(tokenPart);
    const parts = decoded.split(':');
    if (parts.length < 2) return null;
    const userId = parseInt(parts[parts.length - 1], 10);
    if (isNaN(userId)) return null;
    const username = parts.slice(0, -1).join(':');
    return { username, userId };
  } catch {
    return null;
  }
}
