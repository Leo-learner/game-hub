// Usage: GAME_HUB_MCP_TOKEN=... node scripts/mcp-upload.mjs SLUG ZIP_PATH
// Prints only release metadata. Credentials never appear in command arguments or output.
import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
const [slug, file] = process.argv.slice(2);
const token = process.env.GAME_HUB_MCP_TOKEN;
const endpoint = new URL(process.env.GAME_HUB_MCP_URL ?? 'https://games.dkz12345.com/mcp');
if (!slug || !file || !token || endpoint.protocol !== 'https:') throw new Error('Set GAME_HUB_MCP_TOKEN and provide SLUG ZIP_PATH; HTTPS required');
const bytes = (await stat(file)).size;
const rpc = await fetch(endpoint, {method: 'POST', headers: {
  Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26',
}, body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'prepare_game_upload', arguments: {slug}}})});
if (!rpc.ok) throw new Error(`MCP request failed (${rpc.status})`);
const response = await rpc.json();
if (response.error || response.result?.isError) throw new Error('prepare_game_upload failed; check slug, credentials and content scope');
const ticket = response.result.structuredContent.data;
const uploadUrl = new URL(ticket.uploadUrl);
if (uploadUrl.origin !== endpoint.origin || !uploadUrl.pathname.startsWith('/mcp/uploads/')) throw new Error('Unexpected upload URL');
if (bytes > ticket.maxBytes) throw new Error(`ZIP exceeds ${ticket.maxBytes} bytes`);
const upload = await fetch(uploadUrl, {method: 'PUT', headers: {
  Authorization: `Bearer ${ticket.uploadToken}`, 'Content-Type': 'application/zip', 'Content-Length': String(bytes),
}, body: createReadStream(file), duplex: 'half', redirect: 'error', signal: AbortSignal.timeout(120000)});
if (!upload.ok) throw new Error(`ZIP upload failed (${upload.status}); inspect get_game before retrying`);
console.log(JSON.stringify(await upload.json(), null, 2));
