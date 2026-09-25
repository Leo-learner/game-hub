CREATE TABLE users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'player' CHECK(role IN ('player','admin')), created_at INTEGER NOT NULL
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL, renewed_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE games (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]', sort_order INTEGER NOT NULL DEFAULT 0,
  published INTEGER NOT NULL DEFAULT 0 CHECK(published IN (0,1)),
  current_release_id TEXT REFERENCES game_releases(id), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE game_releases (
  id TEXT PRIMARY KEY, game_id TEXT NOT NULL REFERENCES games(id),
  archive_sha256 TEXT NOT NULL, archive_bytes INTEGER NOT NULL, manifest_json TEXT NOT NULL,
  files_json TEXT NOT NULL, storage_key TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, published_at INTEGER
);
CREATE INDEX releases_game ON game_releases(game_id, created_at);
CREATE TABLE saves (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, game_id TEXT NOT NULL REFERENCES games(id),
  slot TEXT NOT NULL, data_json TEXT, schema_version INTEGER NOT NULL, size_bytes INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL CHECK(revision > 0), updated_at INTEGER NOT NULL, deleted_at INTEGER,
  PRIMARY KEY(user_id, game_id, slot)
);
CREATE INDEX saves_user_active ON saves(user_id, updated_at) WHERE deleted_at IS NULL;
CREATE TABLE idempotency_keys (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, scope TEXT NOT NULL, key TEXT NOT NULL,
  fingerprint TEXT NOT NULL, response_json TEXT NOT NULL, expires_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, scope, key)
);
CREATE INDEX idempotency_expiry ON idempotency_keys(expires_at);
