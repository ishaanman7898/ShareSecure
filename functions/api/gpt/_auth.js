// ChatGPT (custom GPT) actions authenticate with the same personal token as MCP,
// sent by ChatGPT as "Authorization: Bearer ss_…".
import { userForToken } from '../../_mcp.js';

export async function gptUser(context) {
  return userForToken(context.request.headers.get('Authorization'), context.env);
}

export const unauthorized = () => Response.json(
  { error: 'Missing or invalid ShareSecure token. Create one in the account menu under Connect an AI assistant.' },
  { status: 401 }
);
