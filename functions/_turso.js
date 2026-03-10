import { createClient } from '@libsql/client';

export const getTursoConfig = (env) => ({
    org: env.TURSO_ORG || 'ishman',
    region: env.TURSO_REGION || 'aws-us-east-2',
    nodes: parseInt(env.TURSO_NODES || '3'),
    apiToken: env.TURSO_API_TOKEN
});

// Shard based on the shortId
export function getShardNode(shortId, nodes = 3) {
    if (!shortId) return 1;
    const charCode = shortId.charCodeAt(0);
    return (charCode % nodes) + 1;
}

// Fetch a node-specific auth token using the API token
async function fetchNodeToken(config, nodeName) {
    const url = `https://api.turso.tech/v1/organizations/${config.org}/databases/${nodeName}/auth/tokens`;
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${config.apiToken}`,
            'Content-Type': 'application/json'
        }
    });
    const data = await res.json();
    return data.jwt;
}

const tokenCache = new Map();

export async function getTursoClient(nodeNumber, env) {
    const config = getTursoConfig(env);
    const nodeName = `fileshare-node-${nodeNumber}`;
    const hostname = `${nodeName}-${config.org}.${config.region}.turso.io`;
    const url = `libsql://${hostname}`;

    let authToken = tokenCache.get(nodeName);
    if (!authToken) {
        authToken = await fetchNodeToken(config, nodeName);
        tokenCache.set(nodeName, authToken);
    }

    return createClient({ url, authToken });
}

export async function getClientById(shortId, env) {
    const config = getTursoConfig(env);
    const nodeNum = getShardNode(shortId, config.nodes);
    return await getTursoClient(nodeNum, env);
}

// ── Background Global Purge ──────────────────────────────────────────────────
export async function globalPurgeExpired(env, context, originShortId = null) {
    const config = getTursoConfig(env);

    // Pick a node to check for expired clusters
    const checkNode = originShortId ? getShardNode(originShortId, config.nodes) : 1;
    const client = await getTursoClient(checkNode, env);

    // 1. Find clusters that have just expired on this node
    const res = await client.execute({
        sql: "SELECT DISTINCT cluster_id FROM files WHERE expires_at < datetime('now') AND cluster_id IS NOT NULL",
        args: []
    });

    const expiredClusters = res.rows.map(r => r.cluster_id);
    if (expiredClusters.length === 0) {
        // Fallback: simple local cleanup if no clusters found
        context.waitUntil(client.execute("DELETE FROM files WHERE expires_at < datetime('now')"));
        return;
    }

    // 2. Multi-node broadcast: Scrub these clusters everywhere
    for (const clusterId of expiredClusters) {
        for (let i = 1; i <= config.nodes; i++) {
            const shardClient = await getTursoClient(i, env);
            context.waitUntil(
                shardClient.execute({
                    sql: 'DELETE FROM files WHERE cluster_id = ?',
                    args: [clusterId]
                })
            );
        }
    }
}
