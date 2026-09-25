import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import yazl from 'yazl';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createConfig } from '../src/config.js';
import { openDb, migrate } from '../src/db/index.js';
import { migrateMcp, McpStore, newSecret, type Scope } from '../src/mcp/store.js';
import { buildMcpApp } from '../src/mcp/app.js';

async function fixture() {
  await mkdir('.work/tests', {recursive: true});
  const dir = await mkdtemp(path.resolve('.work/tests/mcp-'));
  let now = Date.now();
  const config = createConfig({dataDir: dir, logger: false, publicOrigin: 'http://game-hub.test', now: () => now}, {});
  const db = openDb(dir); migrate(db); migrateMcp(db); migrateMcp(db); db.close();
  const calls: string[] = [];
  const app = await buildMcpApp(config, {control: async action => {calls.push(action); return action === 'status' ? '{"test":true}' : 'website log';}});
  const address = await app.listen({host: '127.0.0.1', port: 0});
  config.publicOrigin = address;
  const {store, auth, games} = app.mcpServices;
  const clients: Client[] = [];
  function token(scopes: Scope[] = ['read', 'content', 'accounts', 'ops'], days = 90) {
    const secret = newSecret();
    return {secret, actor: store.createToken('test-client', secret, scopes, days)};
  }
  function headers(secret: string, extra: Record<string, string> = {}) {return {host: new URL(address).host, authorization: 'Bearer ' + secret, ...extra};}
  async function client(secret: string) {
    const c = new Client({name: 'game-hub-integration-test', version: '1.0.0'});
    clients.push(c);
    await c.connect(new StreamableHTTPClientTransport(new URL(address + '/mcp'), {requestInit: {headers: headers(secret)}}));
    return c;
  }
  async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
    const result = await c.callTool({name, arguments: args});
    return {raw: result, data: (result.structuredContent as {data: any} | undefined)?.data};
  }
  async function upload(ticket: {uploadId: string; uploadToken: string}, data: Buffer, extra: Record<string, string> = {}) {
    return fetch(address + '/mcp/uploads/' + ticket.uploadId, {method: 'PUT', headers: headers(ticket.uploadToken, {'content-type': 'application/zip', ...extra}), body: new Uint8Array(data)});
  }
  return {app, dir, address, token, client, headers, call, upload, store, auth, games, calls, advance(ms: number) {now += ms;},
    async close() {await Promise.all(clients.map(c => c.close())); await app.close(); await rm(dir, {recursive: true, force: true});}};
}
async function zip(files: Record<string, string>) {
  const z = new yazl.ZipFile();
  for (const [name, value] of Object.entries(files)) z.addBuffer(Buffer.from(value), name);
  z.end(); const chunks: Buffer[] = [];
  for await (const chunk of z.outputStream as Readable) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test('MCP official client discovers tools/resources/prompts; scopes, expiry and revocation apply to every request', async () => {
  const f = await fixture();
  try {
    const full = f.token(), read = f.token(['read']);
    const client = await f.client(full.secret), viewer = await f.client(read.secret);
    assert.equal((await client.listTools()).tools.length, 17);
    assert.deepEqual((await viewer.listTools()).tools.map(t => t.name).sort(), ['get_game', 'get_site_status', 'list_backups', 'list_games']);
    await assert.rejects(() => f.call(viewer, 'create_game', {slug: 'blocked', title: 'blocked'}), /not found/);
    assert.equal(f.games.list({}, true).total, 0);
    assert.equal((await client.listResources()).resources[0].uri, 'gamehub://operations');
    assert.ok((await client.readResource({uri: 'gamehub://operations'})).contents.length);
    assert.equal((await client.listPrompts()).prompts[0].name, 'site_check');
    assert.ok((await client.getPrompt({name: 'site_check'})).messages.length);
    assert.equal((await f.call(client, 'get_site_status')).data.counts.players, 0);
    f.store.revoke(full.actor.id);
    await assert.rejects(() => client.listTools());
    f.advance(91 * 86400000);
    await assert.rejects(() => viewer.listTools());
  } finally {await f.close();}
});

test('HTTP rejects anonymous, wrong host/origin, cookie auth and oversized JSON; legacy MCP negotiation works', async () => {
  const f = await fixture();
  try {
    const {secret} = f.token();
    for (const headers of [{host: 'game-hub.test'}, {host: 'game-hub.test', cookie: 'gamehub_sid=not-a-key'}, f.headers('ghu_' + 'x'.repeat(43))] as Record<string, string>[]) {
      const r = await fetch(f.address + '/mcp', {method: 'POST', headers: {...headers, 'content-type': 'application/json'}, body: '{}'});
      assert.equal(r.status, 401); assert.match(r.headers.get('www-authenticate')!, /Bearer/);
    }
    for (const extra of [{host: 'evil.example'}, {origin: 'null'}, {origin: 'http://game-hub.test.evil'}] as Record<string, string>[]) {
      assert.equal((await f.app.inject({url: '/mcp', method: 'POST', headers: f.headers(secret, extra), payload: {}})).statusCode, 403);
    }
    const init = await fetch(f.address + '/mcp', {method: 'POST', headers: f.headers(secret, {'content-type': 'application/json', accept: 'application/json, text/event-stream'}),
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-03-26', capabilities: {}, clientInfo: {name: 'legacy-client', version: '1'}}})});
    assert.equal(init.status, 200); assert.equal((await init.json() as any).result.protocolVersion, '2025-03-26');
    assert.equal((await fetch(f.address + '/mcp', {method: 'POST', headers: f.headers(secret, {'content-type': 'application/json'}), body: JSON.stringify({big: 'x'.repeat(300000)})})).status, 413);
  } finally {await f.close();}
});

test('stateless endpoint answers GET/DELETE with 405 instead of holding an SSE stream open', async () => {
  const f = await fixture();
  try {
    const {secret} = f.token();
    assert.equal((await fetch(f.address + '/mcp', {headers: {accept: 'text/event-stream'}, signal: AbortSignal.timeout(5000)})).status, 401);
    for (const method of ['GET', 'DELETE']) {
      const r = await fetch(f.address + '/mcp', {method, headers: f.headers(secret, {accept: 'text/event-stream'}), signal: AbortSignal.timeout(5000)});
      assert.equal(r.status, 405); assert.equal(r.headers.get('allow'), 'POST');
      assert.equal((await r.json() as any).error.code, 'METHOD_NOT_ALLOWED');
    }
  } finally {await f.close();}
});

test('ZIP ticket is one-use and creates a draft; publishing and rollback preserve versions', async () => {
  const f = await fixture();
  try {
    const client = await f.client(f.token().secret);
    assert.equal((await f.call(client, 'create_game', {slug: 'puzzle', title: 'Puzzle'})).raw.isError, undefined);
    const ticket = (await f.call(client, 'prepare_game_upload', {slug: 'puzzle'})).data;
    const bytes = await zip({'index.html': '<title>Puzzle</title>', 'game.json': '{"manifestVersion":1,"saveSlots":3,"saveSchemaVersion":1}'});
    const response = await f.upload(ticket, bytes); assert.equal(response.status, 201);
    const release = (await response.json() as any).release;
    assert.equal(f.games.get('puzzle').published, 0);
    assert.equal((await f.upload(ticket, bytes)).status, 401);
    assert.equal((await f.call(client, 'publish_game', {slug: 'puzzle', releaseId: release.id})).data.published, true);
    const t2 = (await f.call(client, 'prepare_game_upload', {slug: 'puzzle'})).data;
    const r2 = (await (await f.upload(t2, bytes)).json() as any).release;
    await f.call(client, 'publish_game', {slug: 'puzzle', releaseId: r2.id});
    assert.equal((await f.call(client, 'publish_game', {slug: 'puzzle', releaseId: release.id})).data.currentReleaseId, release.id);
    const game = (await f.call(client, 'get_game', {slug: 'puzzle'})).data;
    assert.equal(game.totalReleases, 2); assert.equal(game.uploads[0].status, 'complete');
    assert.equal((await f.call(client, 'unpublish_game', {slug: 'puzzle'})).data.published, false);
    assert.equal((await f.call(client, 'update_game', {slug: 'puzzle', tags: ['same', 'same']})).raw.isError, true);
    assert.equal((await f.call(client, 'update_game', {slug: 'puzzle', unexpected: 'x'})).raw.isError, true);
    const audit = JSON.stringify(f.store.db.prepare('SELECT * FROM mcp_audit').all());
    assert.ok(!audit.includes(ticket.uploadToken)); assert.match(audit, /upload_game_zip/);
  } finally {await f.close();}
});

test('Expired/revoked upload tickets and invalid ZIPs fail without publication', async () => {
  const f = await fixture();
  try {
    const credential = f.token(), client = await f.client(credential.secret);
    f.games.create({slug: 'draft', title: 'draft'});
    const invalid = (await f.call(client, 'prepare_game_upload', {slug: 'draft'})).data;
    assert.equal((await f.upload(invalid, Buffer.from('not a zip'))).status, 400);
    assert.equal((await f.upload(invalid, Buffer.from('again'))).status, 401);
    const expired = (await f.call(client, 'prepare_game_upload', {slug: 'draft'})).data;
    f.advance(11 * 60000);
    assert.equal((await f.upload(expired, Buffer.from('x'))).status, 401);
    const revoked = (await f.call(client, 'prepare_game_upload', {slug: 'draft'})).data;
    f.store.revoke(credential.actor.id);
    assert.equal((await f.upload(revoked, Buffer.from('x'))).status, 401);
    assert.equal(f.games.get('draft').published, 0);
  } finally {await f.close();}
});

test('Player maintenance cannot target admins; reset revokes sessions and never audits passwords', async () => {
  const f = await fixture();
  try {
    const credential = f.token(['accounts']), client = await f.client(credential.secret);
    const player = await f.auth.create('mcp_player', 'old-password-1'), admin = await f.auth.create('admin', 'admin-password-1', 'Admin', 'admin');
    const session = f.auth.issue(player.id);
    const listing = (await f.call(client, 'list_players')).data;
    assert.equal(listing.total, 1); assert.ok(!JSON.stringify(listing).includes('password'));
    const password = 'new-secret-password-29';
    assert.equal((await f.call(client, 'reset_player_password', {playerId: player.id, newPassword: password})).data.reset, true);
    assert.equal(f.auth.lookup(session), null);
    assert.equal((await f.auth.login(player.username, password)).id, player.id);
    const session2 = f.auth.issue(player.id);
    assert.equal((await f.call(client, 'revoke_player_sessions', {playerId: player.id})).data.revoked, true);
    assert.equal(f.auth.lookup(session2), null);
    assert.equal((await f.call(client, 'reset_player_password', {playerId: admin.id, newPassword: password})).raw.isError, true);
    const audit = JSON.stringify(f.store.db.prepare('SELECT * FROM mcp_audit').all());
    assert.ok(!audit.includes(password)); assert.ok(!audit.includes(credential.secret));
    assert.match(audit, /PLAYER_NOT_FOUND/);
  } finally {await f.close();}
});

test('Backups include MCP credentials hashes/audit, verification rejects escaped paths; log and restart controls are fixed', async () => {
  const f = await fixture();
  try {
    const client = await f.client(f.token().secret);
    const backup = (await f.call(client, 'create_backup')).data;
    assert.equal(backup.verified, true);
    assert.equal((await f.call(client, 'list_backups')).data.items[0].id, backup.id);
    assert.equal((await f.call(client, 'verify_backup', {backupId: backup.id})).data.verified, true);
    assert.equal((await f.call(client, 'verify_backup', {backupId: '../game-hub.sqlite'})).raw.isError, true);
    const escapeId = '2000-01-01T00-00-00-000Z';
    await symlink(f.dir, path.join(f.dir, 'backups', escapeId));
    assert.equal((await f.call(client, 'verify_backup', {backupId: escapeId})).raw.isError, true);
    assert.equal((await f.call(client, 'read_service_logs', {lines: 201})).raw.isError, true);
    assert.equal((await f.call(client, 'read_service_logs', {service: 'nginx'})).raw.isError, true);
    assert.equal((await f.call(client, 'read_service_logs')).data.text, 'website log');
    f.app.mcpServices.operations.apiHealthy = async () => true;
    assert.equal((await f.call(client, 'restart_website')).data.ready, true);
    assert.deepEqual(f.calls, ['logs', 'restart']);
    assert.ok((await f.call(client, 'read_audit_log')).data.items.length);
    const restored = openDb(path.join(f.dir, 'backups', backup.id));
    try {assert.equal(new McpStore(restored).listTokens().length, 1);} finally {restored.close();}
  } finally {await f.close();}
});
