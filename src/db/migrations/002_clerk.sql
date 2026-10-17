-- Browser login moves to the shared Clerk account (clerk.dkz12345.com).
-- A local player is linked to one Clerk user, either new (password_hash '')
-- or an old account claimed once with its old username and password.
ALTER TABLE users ADD COLUMN clerk_user_id TEXT;
ALTER TABLE users ADD COLUMN linked_at INTEGER;
ALTER TABLE users ADD COLUMN disabled_at INTEGER;
CREATE UNIQUE INDEX users_clerk ON users(clerk_user_id) WHERE clerk_user_id IS NOT NULL;
-- Old cookie sessions can no longer be used to sign in.
DELETE FROM sessions;
