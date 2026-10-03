// MCP over stdio: one JSON-RPC message per line in, one per line out. Anything
// meant for a person goes to stderr, so it never mixes with the protocol.
import readline from 'node:readline';
import { TOOLS, INSTRUCTIONS } from './tools.js';

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export async function handle(msg, tools, version) {
  const { id, method, params = {} } = msg || {};
  if (id === undefined || id === null) return null;   // a notification
  const reply = result => ({ jsonrpc: '2.0', id, result });
  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'sharesecure-local', title: 'ShareSecure (this computer)', version },
        instructions: INSTRUCTIONS,
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call':
      try {
        const out = await tools.call(params.name, params.arguments && typeof params.arguments === 'object' ? params.arguments : {});
        // some clients show the model only the structured result, so the words go in it too
        return reply({ content: [{ type: 'text', text: out.text }], ...(out.data ? { structuredContent: { ...out.data, message: out.text } } : {}) });
      } catch (err) {
        return reply({ content: [{ type: 'text', text: err.message || String(err) }], isError: true });
      }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

export function serve(tools, version) {
  const out = msg => process.stdout.write(JSON.stringify(msg) + '\n');
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  // one at a time, in order, so sends and uploads see each other's results
  let queue = Promise.resolve();
  rl.on('line', line => {
    if (!line.trim()) return;
    queue = queue.then(async () => {
      let msg;
      try { msg = JSON.parse(line); } catch { out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
      const messages = Array.isArray(msg) ? msg : [msg];
      const replies = [];
      for (const m of messages) { const r = await handle(m, tools, version); if (r) replies.push(r); }
      if (replies.length) out(Array.isArray(msg) ? replies : replies[0]);
    });
  });
  // once the client hangs up, finish what's queued and let Node end by itself
  // (process.exit() with requests still closing crashes Node on Windows)
  rl.on('close', () => { queue.then(() => { process.stdin.unref?.(); }); });
}
