import Fastify, { LogController } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { Readable } from 'node:stream';
import { AppError, fail } from '../errors.js';
import { openDb, assertMigrated } from '../db/index.js';
import type { Config } from '../config.js';
import { AuthService } from '../modules/auth.js';
import { GameService } from '../modules/games.js';
import { ReleaseService } from '../modules/releases.js';
import { McpStore } from './store.js';
import { Operations, type Control } from './operations.js';
import { createMcpServer, type ToolServices } from './tools.js';

declare module 'fastify' {
  interface FastifyInstance {mcpServices: ToolServices & {releases: ReleaseService}}
}

export async function buildMcpApp(config: Config, options: {control?: Control; allowedHosts?: string[]} = {}) {
  const db = openDb(config.dataDir);
  try {assertMigrated(db); new McpStore(db, config.now);} catch (e) {db.close(); throw e;}
  const store = new McpStore(db, config.now), games = new GameService(db, config);
  const auth = new AuthService(db, config), releases = new ReleaseService(db, config, games);
  const operations = new Operations(db, config, options.control);
  const app = Fastify({
    bodyLimit: 256 * 1024, requestTimeout: 120000, connectionTimeout: 125000,
    trustProxy: config.trustProxy ? ['127.0.0.1', '::1'] : false,
    logger: config.logger ? {level: config.logLevel, redact: ['req.headers.authorization', 'req.headers.cookie', 'req.body']} : false,
    logController: new LogController({disableRequestLogging: true}),
  });
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    const localHealth = req.url === '/healthz' && ['127.0.0.1', '::1'].includes(req.raw.socket.remoteAddress ?? '') && /^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host ?? '');
    const hosts = options.allowedHosts ?? [new URL(config.publicOrigin).host];
    if (!localHealth && !hosts.includes(req.headers.host ?? '')) fail(403, 'HOST_REJECTED', 'Host 不在允许列表');
    if (req.headers.origin !== undefined && req.headers.origin !== config.publicOrigin) fail(403, 'ORIGIN_REJECTED', 'Origin 不在允许列表');
  });
  await app.register(rateLimit, {max: 120, timeWindow: '1 minute', errorResponseBuilder: () => ({error: {code: 'RATE_LIMITED', message: '请求过于频繁'}})});
  app.addHook('onRequest', async req => {
    // Fail before parsing the body, after rate limiting anonymous attempts.
    if (req.url === '/mcp' || req.url.startsWith('/mcp?')) store.authenticate(bearer(req.headers.authorization));
  });
  app.setErrorHandler((err, _req, reply) => {
    const httpCode = (err as {statusCode?: number}).statusCode;
    const status = err instanceof AppError ? err.status : httpCode && httpCode < 500 ? httpCode : 500;
    if (status === 401) reply.header('WWW-Authenticate', 'Bearer realm="game-hub"');
    reply.code(status).send({error: {code: err instanceof AppError ? err.code : 'REQUEST_FAILED', message: err instanceof AppError ? err.message : '请求失败'}});
  });
  app.get('/healthz', async () => ({ok: true}));
  app.get('/mcp/healthz', async () => ({ok: true}));
  app.route({method: ['POST', 'GET', 'DELETE'], url: '/mcp', handler: async (req, reply) => {
    const actor = store.authenticate(bearer(req.headers.authorization));
    const server = createMcpServer({db, config, store, games, auth, operations}, actor);
    const transport = new NodeStreamableHTTPServerTransport({sessionIdGenerator: undefined, enableJsonResponse: true});
    await server.connect(transport);
    reply.hijack();
    // Hijacked responses bypass Fastify's header serialization.
    reply.raw.setHeader('Cache-Control', 'no-store');
    reply.raw.setHeader('X-Content-Type-Options', 'nosniff');
    try {await transport.handleRequest(req.raw, reply.raw, req.body);} finally {await server.close();}
  }});
  // Streaming parser: ReleaseService enforces the compressed/uncompressed size caps.
  app.addContentTypeParser('application/zip', (request, payload, done) => done(null, payload));
  app.put<{Params: {id: string}}>('/mcp/uploads/:id', {
    bodyLimit: config.uploadMaxBytes,
    onRequest: async req => {
      if (req.headers['content-type']?.split(';')[0] !== 'application/zip') fail(415, 'ZIP_REQUIRED', '请以 application/zip 上传 ZIP 文件');
      const length = Number(req.headers['content-length'] ?? 0);
      if (length > config.uploadMaxBytes) fail(413, 'UPLOAD_TOO_LARGE', 'ZIP 超过大小限制');
      const claimed = store.claimUpload(req.params.id, bearer(req.headers.authorization));
      Object.assign(req, {uploadClaim: claimed});
    },
  }, async (req, reply) => {
    const claim = (req as typeof req & {uploadClaim: ReturnType<McpStore['claimUpload']>}).uploadClaim;
    const auditId = store.startAudit(claim.actor, 'upload_game_zip', claim.slug);
    try {
      if (!req.headers['content-type']?.startsWith('application/zip') || !(req.body instanceof Readable)) fail(415, 'ZIP_REQUIRED', '请以 application/zip 上传 ZIP 文件');
      const release = await releases.importZip(claim.slug, req.body);
      store.finishUpload(req.params.id, release.id);
      store.finishAudit(auditId, 'success');
      return reply.code(201).send({release, published: false});
    } catch (e) {
      const code = e instanceof AppError ? e.code : 'UPLOAD_FAILED';
      store.finishUpload(req.params.id, undefined, code);
      store.finishAudit(auditId, 'error', code);
      throw e;
    }
  });
  app.addHook('onClose', async () => {db.close();});
  app.decorate('mcpServices', {db, config, store, games, auth, releases, operations});
  return app;
}
function bearer(header?: string) {
  return header?.match(/^Bearer ([A-Za-z0-9_-]+)$/i)?.[1] ?? '';
}
