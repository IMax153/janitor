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
