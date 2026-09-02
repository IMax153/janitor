-- Scheduled deletion of private content after uninstall or confirmed access
-- loss, with a grace period during which restored access cancels it.
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
