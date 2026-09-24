// /mcp — the MCP endpoint assistants connect to. See _mcp.js.
import { handleMcp } from './_mcp.js';

export const onRequest = handleMcp;
