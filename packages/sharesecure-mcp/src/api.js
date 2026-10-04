// Talks to ShareSecure's /api/agent endpoints with the personal token. Only
// sealed data goes over it: files, names and keys are encrypted here first.
export function makeApi({ url, token, fetchImpl = globalThis.fetch }) {
  const base = String(url).replace(/\/+$/, '');

  async function call(method, path, { json, form, auth = true, raw = false } = {}) {
    const headers = {};
    if (auth) headers.Authorization = `Bearer ${token}`;
    if (json) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetchImpl(base + path, { method, headers, body: json ? JSON.stringify(json) : form });
    } catch (err) {
      throw new Error(`Couldn’t reach ShareSecure at ${base} (${err.message}).`);
    }
    if (raw && res.ok) return new Uint8Array(await res.arrayBuffer());
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text.slice(0, 200) }; }
    if (!res.ok) throw Object.assign(new Error(data.error || `ShareSecure answered ${res.status}.`), { status: res.status });
    return data;
  }

  return {
    base,
    me: () => call('GET', '/api/agent/me'),
    upload: form => call('POST', '/api/agent/upload', { form }),
    send: (id, recipients, note) => call('POST', `/api/agent/send/${id}`, { json: { recipients, ...(note ? { note } : {}) } }),
    shares: async () => (await call('GET', '/api/agent/shares')).shares || [],
    deleteShare: id => call('DELETE', `/api/agent/shares/${id}`),
    inbox: async () => (await call('GET', '/api/agent/inbox')).files || [],
    answer: (id, action) => call('POST', `/api/agent/inbox/${id}`, { json: { action } }),
    file: id => call('GET', `/api/agent/file/${id}`, { raw: true }),
    request: body => call('POST', '/api/agent/requests', { json: body }),

    // someone's public key → string, null (no key yet) or undefined (no such user)
    async publicKey(username) {
      try {
        return (await call('GET', `/api/keys?username=${encodeURIComponent(username)}`, { auth: false })).publicKey || null;
      } catch (err) {
        if (err.status === 404) return undefined;
        throw err;
      }
    },
  };
}
