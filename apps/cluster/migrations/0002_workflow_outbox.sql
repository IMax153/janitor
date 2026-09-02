-- Requests to submit workflow executions. Rows are claimed with a bounded
-- lease and fencing token so duplicate dispatchers cannot both complete one.
CREATE TABLE workflow_outbox (
  workflow_tag TEXT NOT NULL,
  execution_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  due_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  PRIMARY KEY (workflow_tag, execution_key)
);

CREATE INDEX workflow_outbox_due_idx
  ON workflow_outbox (due_at)
  WHERE accepted_at IS NULL;
