import Database from 'better-sqlite3';
import { mkdirSync, chmodSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Db = Database.Database;
export const schemaVersion = 1;
export function openDb(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true, mode: 0o750 });
  const file = path.join(dataDir, 'game-hub.sqlite');
  const db = new Database(file);
  chmodSync(file, 0o600);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 3000');
  return db;
}
export function migrate(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const dir = fileURLToPath(new URL('./migrations/', import.meta.url));
  for (const name of readdirSync(dir).filter(x => /^\d+.*\.sql$/.test(x)).sort()) {
    const version = Number(name.split('_')[0]);
    db.transaction(() => {
      if (db.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(version)) return;
      db.exec(readFileSync(path.join(dir, name), 'utf8'));
      db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(version, Date.now());
    }).immediate();
  }
}
export function assertMigrated(db: Db): void {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE name='schema_migrations'").get();
  if (!table || (db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {version:number}).version !== schemaVersion) {
    throw new Error('Database schema is not ready. Run npm run migrate before starting.');
  }
}
export interface UserRow { id: string; username: string; display_name: string; password_hash: string; role: 'player'|'admin'; created_at: number }
export interface GameRow { id: string; slug: string; title: string; description: string; tags_json: string; sort_order: number; published: number; current_release_id: string|null; created_at: number; updated_at: number }
export interface Manifest { manifestVersion: 1; cover?: string; saveSchemaVersion: number; saveSlots: number }
export interface FileRecord { path: string; size: number; sha256: string }
export interface ReleaseRow { id: string; game_id: string; archive_sha256: string; archive_bytes: number; manifest_json: string; files_json: string; storage_key: string; created_at: number; published_at: number|null }
export interface SaveRow { user_id:string; game_id:string; slot:string; data_json:string|null; schema_version:number; size_bytes:number; revision:number; updated_at:number; deleted_at:number|null }
