// /connect/<token> — the MCP connector URL for apps that only accept a URL
// (Claude's "Add custom connector", ChatGPT connectors). Treat it like a password.
import { handleMcp } from '../_mcp.js';

export async function onRequest(context) {
  return handleMcp(context, context.params.token);
}
