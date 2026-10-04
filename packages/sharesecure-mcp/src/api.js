// Talks to ShareSecure. Two kinds of request:
//   - with your connection token (/api/agent): only for what's tied to your
//     account anyway: picking up anonymous tokens, your own sealed boxes, your
//     inbox and your file requests.
//   - anonymous: uploads, sends and deletes go to the regular endpoints with a
//     spent token or the link's delete key, never your connection token, so
//     the server can't tell they came from you.
export function makeApi({ url, token, fetchImpl = globalThis.fetch }) {
  const base = String(url).replace(/\/+$/, '');

  async function call(method, path, { json, form, auth = true, raw = false, headers: extra = {} } = {}) {
    const headers = { ...extra };
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
    if (!res.ok) throw Object.assign(new Error(data.error || `ShareSecure answered ${res.status}.`), { status: res.status, data });
    return data;
  }

  return {
    base,
    // tied to the account
    me: () => call('GET', '/api/agent/me'),
    tokenInfo: () => call('GET', '/api/agent/tokens'),
    tokenSign: (kind, blinded) => call('POST', '/api/agent/tokens', { json: { kind, blinded } }),
    vault: async () => (await call('GET', '/api/agent/vault')).vault || null,
    saveVault: vault => call('PUT', '/api/agent/vault', { json: { vault } }),
    rules: () => call('GET', '/api/agent/rules'),
    hold: box => call('POST', '/api/agent/hold', { json: { box } }),
    shares: async () => (await call('GET', '/api/agent/shares')).shares || [],
    deleteTagged: id => call('DELETE', `/api/agent/shares/${id}`),
    inbox: async () => (await call('GET', '/api/agent/inbox')).files || [],
    answer: (id, action) => call('POST', `/api/agent/inbox/${id}`, { json: { action } }),
    file: id => call('GET', `/api/agent/file/${id}`, { raw: true }),
    request: body => call('POST', '/api/agent/requests', { json: body }),

    // anonymous
    upload: (form, spend) => call('POST', '/api/upload', { form, auth: false, headers: { 'X-ShareSecure-Token': spend } }),
    send: (id, body, spend) => call('POST', `/api/send/${id}`, { json: body, auth: false, headers: { 'X-ShareSecure-Token': spend } }),
    deleteShare: (id, deleteToken) => call('POST', `/api/delete/${id}`, { json: { deleteToken }, auth: false }),

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
