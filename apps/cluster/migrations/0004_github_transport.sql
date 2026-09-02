-- Shared GitHub API budget: observed limits and cooldowns per credential and
-- resource bucket, bounded leases for in-flight requests, and an encrypted
-- cache of representations for conditional requests.
CREATE TABLE github_rate_budget (
  scope_key TEXT NOT NULL,
  resource TEXT NOT NULL,
  rate_limit INTEGER,
  remaining INTEGER,
  used INTEGER,
  reset_at TIMESTAMPTZ,
  retry_after_until TIMESTAMPTZ,
  secondary_cooldown_until TIMESTAMPTZ,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  PRIMARY KEY (scope_key, resource)
);

CREATE TABLE github_rate_lease (
  lease_token TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  resource TEXT NOT NULL,
  priority TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX github_rate_lease_scope_idx ON github_rate_lease (scope_key, resource, expires_at);

CREATE TABLE github_http_cache (
  scope_key TEXT NOT NULL,
  request_key TEXT NOT NULL,
  repository_id TEXT,
  etag TEXT NOT NULL,
  next_url TEXT,
  encryption_key_id TEXT NOT NULL,
  encryption_iv BYTEA NOT NULL,
  body BYTEA NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  PRIMARY KEY (scope_key, request_key)
);

CREATE INDEX github_http_cache_repository_idx ON github_http_cache (repository_id);
