import { getClientById } from '../../_turso.js';

export async function onRequestGet(context) {
    const { params, env } = context;
    const client = await getClientById(params.shortId, env);

    const res = await client.execute({
        sql: 'SELECT annotations FROM files WHERE short_id = ? AND is_active = 1',
        args: [params.shortId]
    });

    const file = res.rows[0];

    if (!file) return Response.json({ error: 'File not found' }, { status: 404 });

    return Response.json({
        annotations: file.annotations ? JSON.parse(file.annotations) : []
    });
}

export async function onRequestPost(context) {
    const { params, env, request } = context;

    let body;
    try {
        body = await request.json();
    } catch {
        return Response.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { annotations } = body;
    if (!Array.isArray(annotations)) {
        return Response.json({ error: 'Annotations must be an array' }, { status: 400 });
    }

    // Limit annotations size to prevent abuse (max 1MB of annotation data)
    const annotStr = JSON.stringify(annotations);
    if (annotStr.length > 1024 * 1024) {
        return Response.json({ error: 'Annotations data too large' }, { status: 413 });
    }

    const client = await getClientById(params.shortId, env);

    const res = await client.execute({
        sql: 'SELECT short_id FROM files WHERE short_id = ? AND is_active = 1',
        args: [params.shortId]
    });

    if (!res.rows[0]) return Response.json({ error: 'File not found' }, { status: 404 });

    await client.execute({
        sql: 'UPDATE files SET annotations = ? WHERE short_id = ?',
        args: [annotStr, params.shortId]
    });

    return Response.json({ saved: true });
}
