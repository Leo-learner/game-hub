import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import { fail } from '../errors.js';

export const scopes = ['read', 'content', 'accounts', 'ops'] as const;
export type Scope = typeof scopes[number];
export interface Actor { id: string; label: string; scopes: Scope[]; expiresAt: number }
interface TokenRow { id: string; label: string; scopes_json: string; expires_at: number }
export const hashSecret = (secret: string) => createHash('sha256').update(secret).digest('hex');
export const newSecret = (prefix = 'ghm') => `${prefix}_${randomBytes(32).toString('base64url')}`;

// Keep the API schema compatible with earlier website releases. MCP owns its tables.
export function migrateMcp(db: Db) {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_schema (version INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS mcp_tokens (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL,
        scopes_json TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        revoked_at INTEGER, last_used_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS mcp_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER NOT NULL, finished_at INTEGER,
        actor_id TEXT NOT NULL, actor_label TEXT NOT NULL, action TEXT NOT NULL, target TEXT,
        status TEXT NOT NULL, error_code TEXT
      );
      CREATE INDEX IF NOT EXISTS mcp_audit_time ON mcp_audit(started_at);
      CREATE TABLE IF NOT EXISTS mcp_uploads (
        id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, actor_id TEXT NOT NULL REFERENCES mcp_tokens(id),
        game_id TEXT NOT NULL REFERENCES games(id), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        status TEXT NOT NULL, release_id TEXT REFERENCES game_releases(id), error_code TEXT
      );
      CREATE INDEX IF NOT EXISTS mcp_uploads_game ON mcp_uploads(game_id, created_at);
      INSERT OR IGNORE INTO mcp_schema(version) VALUES (1);
    `);
  }).immediate();
}

export class McpStore {
  constructor(public db: Db, public now = Date.now) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='mcp_schema'").get() ||
        (db.prepare('SELECT MAX(version) AS v FROM mcp_schema').get() as {v: number}).v !== 1) {
      throw new Error('Run npm run mcp:admin -- migrate before starting MCP');
    }
  }
  createToken(label: string, secret: string, permissions: Scope[], days = 90) {
    if (!/^[A-Za-z0-9_-]{1,48}$/.test(label) || !/^ghm_[A-Za-z0-9_-]{43}$/.test(secret) ||
        !permissions.length || permissions.some(s => !scopes.includes(s)) || !Number.isInteger(days) || days < 1 || days > 365) {
      fail(400, 'INVALID_TOKEN_OPTIONS', '密钥名称、范围或有效期不合法');
    }
    const existing = this.db.prepare('SELECT id FROM mcp_tokens WHERE token_hash=?').get(hashSecret(secret)) as {id: string} | undefined;
    if (existing) {
      const actor = this.actor(existing.id);
      if (actor.label !== label || [...actor.scopes].sort().join() !== [...new Set(permissions)].sort().join()) fail(409, 'TOKEN_OPTIONS_CHANGED', '同一密钥不能用于不同名称或权限');
      return actor; // Safe retry after an uncertain SSH result; does not extend expiry.
    }
    const id = randomUUID(), expiresAt = this.now() + days * 86400000;
    this.db.prepare('INSERT INTO mcp_tokens(id,label,token_hash,scopes_json,created_at,expires_at) VALUES(?,?,?,?,?,?)')
      .run(id, label, hashSecret(secret), JSON.stringify([...new Set(permissions)]), this.now(), expiresAt);
    return {id, label, scopes: permissions, expiresAt};
  }
  actor(id: string, scope?: Scope): Actor {
    const row = this.db.prepare('SELECT id,label,scopes_json,expires_at FROM mcp_tokens WHERE id=? AND revoked_at IS NULL AND expires_at>?')
      .get(id, this.now()) as TokenRow | undefined;
    if (!row) fail(401, 'TOKEN_INACTIVE', 'MCP 密钥已失效');
    const actor: Actor = {id: row.id, label: row.label, scopes: JSON.parse(row.scopes_json), expiresAt: row.expires_at};
    if (scope && !actor.scopes.includes(scope)) fail(403, 'SCOPE_REQUIRED', `需要 ${scope} 权限`);
    return actor;
  }
  authenticate(secret: string): Actor {
    if (!/^ghm_[A-Za-z0-9_-]{43}$/.test(secret)) fail(401, 'UNAUTHORIZED', '需要有效的 MCP Bearer 密钥');
    const row = this.db.prepare('SELECT id FROM mcp_tokens WHERE token_hash=?').get(hashSecret(secret)) as {id: string} | undefined;
    if (!row) fail(401, 'UNAUTHORIZED', '需要有效的 MCP Bearer 密钥');
    const actor = this.actor(row.id);
    this.db.prepare('UPDATE mcp_tokens SET last_used_at=? WHERE id=? AND (last_used_at IS NULL OR last_used_at<?)')
      .run(this.now(), actor.id, this.now() - 60000);
    return actor;
  }
  revoke(id: string) {
    return this.db.prepare('UPDATE mcp_tokens SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(this.now(), id).changes;
  }
  listTokens() {
    return this.db.prepare('SELECT id,label,scopes_json,created_at,expires_at,revoked_at,last_used_at FROM mcp_tokens ORDER BY created_at DESC').all();
  }
  startAudit(actor: Actor, action: string, target?: string) {
    // Never persist arguments, password inputs, authorization headers, tool output, or ZIP data.
    return Number(this.db.prepare('INSERT INTO mcp_audit(started_at,actor_id,actor_label,action,target,status) VALUES(?,?,?,?,?,?)')
      .run(this.now(), actor.id, actor.label, action, target?.slice(0, 100) ?? null, 'running').lastInsertRowid);
  }
  finishAudit(id: number, status: 'success' | 'error', errorCode?: string) {
    this.db.prepare('UPDATE mcp_audit SET finished_at=?,status=?,error_code=? WHERE id=?').run(this.now(), status, errorCode ?? null, id);
  }
  prepareUpload(actor: Actor, gameId: string) {
    this.actor(actor.id, 'content');
    const id = randomUUID(), secret = newSecret('ghu'), expiresAt = this.now() + 10 * 60000;
    this.db.prepare('INSERT INTO mcp_uploads(id,token_hash,actor_id,game_id,created_at,expires_at,status) VALUES(?,?,?,?,?,?,?)')
      .run(id, hashSecret(secret), actor.id, gameId, this.now(), expiresAt, 'prepared');
    return {id, secret, expiresAt};
  }
  claimUpload(id: string, secret: string) {
    if (!/^ghu_[A-Za-z0-9_-]{43}$/.test(secret)) fail(401, 'INVALID_UPLOAD_TICKET', '上传凭证无效');
    return this.db.transaction(() => {
      const row = this.db.prepare(`SELECT u.actor_id,g.slug FROM mcp_uploads u JOIN games g ON g.id=u.game_id
        WHERE u.id=? AND u.token_hash=? AND u.status='prepared' AND u.expires_at>?`)
        .get(id, hashSecret(secret), this.now()) as {actor_id: string; slug: string} | undefined;
      if (!row) fail(401, 'INVALID_UPLOAD_TICKET', '上传凭证无效、已使用或已过期');
      const actor = this.actor(row.actor_id, 'content');
      this.db.prepare("UPDATE mcp_uploads SET status='uploading' WHERE id=?").run(id);
      return {...row, actor};
    }).immediate();
  }
  finishUpload(id: string, releaseId?: string, errorCode?: string) {
    this.db.prepare('UPDATE mcp_uploads SET status=?,release_id=?,error_code=? WHERE id=?')
      .run(releaseId ? 'complete' : 'failed', releaseId ?? null, errorCode ?? null, id);
  }
}
