-- Users of the dashboard and the gateway. Passwords are bcrypt hashes.
CREATE TABLE users (
  id            serial PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN ('admin', 'member')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Dashboard login sessions. The cookie holds a random token; we store only its SHA-256.
CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

-- Gateway API keys. The full key is shown once; we store its SHA-256 and a display prefix.
-- kind = 'chat' keys are short-lived keys the chat agent mints to call /mcp as the logged-in user.
CREATE TABLE api_keys (
  id           serial PRIMARY KEY,
  user_id      integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  prefix       text NOT NULL,
  key_hash     text NOT NULL UNIQUE,
  kind         text NOT NULL DEFAULT 'user' CHECK (kind IN ('user', 'chat')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz
);

-- Upstream MCP servers. credential_enc is AES-256-GCM ciphertext and never leaves the backend.
CREATE TABLE servers (
  id             serial PRIMARY KEY,
  slug           text NOT NULL UNIQUE CHECK (slug ~ '^[a-z][a-z0-9_]{1,15}$'),
  name           text NOT NULL,
  url            text NOT NULL,
  auth_type      text NOT NULL DEFAULT 'none' CHECK (auth_type IN ('none', 'bearer', 'header')),
  auth_header    text,
  credential_enc text,
  enabled        boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Which first-boot seeds have run, so a seeded server an admin deletes is not re-created.
CREATE TABLE seed_state (key text PRIMARY KEY);

-- One row per tool call, from /mcp or from chat. Emails and slugs are copied in so the log
-- still reads correctly after a user or server is deleted.
CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  ts           timestamptz NOT NULL DEFAULT now(),
  user_id      integer REFERENCES users(id) ON DELETE SET NULL,
  user_email   text NOT NULL,
  api_key_id   integer,
  source       text NOT NULL CHECK (source IN ('mcp', 'chat')),
  server_slug  text,
  tool         text NOT NULL,
  duration_ms  integer NOT NULL,
  outcome      text NOT NULL CHECK (outcome IN ('ok', 'error')),
  error        text,
  args_preview text
);
CREATE INDEX audit_log_ts ON audit_log (ts DESC);
CREATE INDEX audit_log_user ON audit_log (user_id, ts DESC);
