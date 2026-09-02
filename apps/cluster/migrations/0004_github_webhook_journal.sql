CREATE TABLE github_webhook_delivery (
  delivery_id TEXT PRIMARY KEY,
  sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  event_name TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  journaled_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  payload_sha256 TEXT NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  encryption_algorithm TEXT NOT NULL,
  encryption_key_id TEXT NOT NULL,
  encryption_iv BYTEA NOT NULL,
  payload BYTEA NOT NULL,
  projection_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (projection_status IN ('pending', 'projected', 'failed'))
);

CREATE INDEX github_webhook_delivery_pending_idx
  ON github_webhook_delivery (sequence)
  WHERE projection_status = 'pending';
