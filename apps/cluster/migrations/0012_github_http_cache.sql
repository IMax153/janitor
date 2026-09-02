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
