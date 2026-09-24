// POST /api/mcp/upload/:ticket — the one-time upload command share_file hands out.
import { redeemTicket } from '../../../_mcp.js';

export async function onRequestPost(context) {
  return redeemTicket(context.params.ticket, context);
}
