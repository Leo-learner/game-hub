// Read-only verification against the deployed server; credentials come from the environment.
import assert from 'node:assert/strict';
import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
const url = new URL(process.env.GAME_HUB_MCP_URL ?? 'https://games.dkz12345.com/mcp');
const token = process.env.GAME_HUB_MCP_TOKEN;
if (!token) throw new Error('Set GAME_HUB_MCP_TOKEN');
const client = new Client({name: 'game-hub-smoke', version: '1.1.0'});
try {
  await client.connect(new StreamableHTTPClientTransport(url, {requestInit: {headers: {Authorization: `Bearer ${token}`}}}));
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 17);
  const status = await client.callTool({name: 'get_site_status', arguments: {}});
  assert.ok(!status.isError);
  assert.equal(status.structuredContent.data.website.ready, true);
  const games = await client.callTool({name: 'list_games', arguments: {pageSize: 5}});
  assert.ok(!games.isError);
  assert.equal((await client.listResources()).resources.length, 1);
  assert.equal((await client.listPrompts()).prompts.length, 1);
  console.log(JSON.stringify({connected: true, tools: tools.length, ready: true, counts: status.structuredContent.data.counts,
    services: status.structuredContent.data.website.services, games: games.structuredContent.data.total}, null, 2));
} finally {await client.close();}
