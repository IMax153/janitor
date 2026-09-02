ALTER TABLE github_webhook_delivery
  ADD COLUMN installation_id TEXT,
  ADD COLUMN purged_at TIMESTAMPTZ;

CREATE INDEX github_webhook_delivery_installation_idx
  ON github_webhook_delivery (installation_id)
  WHERE purged_at IS NULL;

ALTER TABLE github_repository ADD COLUMN content_purged_at TIMESTAMPTZ;

CREATE TABLE content_purge (
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('installation', 'repository')),
  subject_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  due_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (subject_kind, subject_id)
);

CREATE INDEX content_purge_due_idx ON content_purge (due_at) WHERE completed_at IS NULL;
