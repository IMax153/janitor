CREATE TABLE workflow_probe_commit (
  probe_id TEXT NOT NULL,
  step TEXT NOT NULL CHECK (step IN ('first', 'second')),
  committed_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  PRIMARY KEY (probe_id, step)
);
