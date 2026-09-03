-- Qualified snapshot handoff (design: "Snapshot handoff"). One row per
-- reconciliation identity; the outbox row for the reconcile workflow is
-- written in the same transaction. Outcomes land on the same row.
CREATE TABLE labeling_reconciliation (
  repository_id TEXT NOT NULL,
  number INTEGER NOT NULL CHECK (number > 0),
  snapshot_generation BIGINT NOT NULL,
  rules_revision BIGINT NOT NULL,
  covered_sequence BIGINT NOT NULL,
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  outcome TEXT CHECK (outcome IN ('evaluated', 'superseded', 'not-qualified', 'failed')),
  detail TEXT,
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (repository_id, number, snapshot_generation, rules_revision)
);

CREATE INDEX labeling_reconciliation_recent_idx
  ON labeling_reconciliation (repository_id, created_at DESC);
