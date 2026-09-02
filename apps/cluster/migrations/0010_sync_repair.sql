ALTER TABLE sync_target ADD COLUMN full_requested BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE sync_repair_state (
  name TEXT PRIMARY KEY,
  last_planned_at TIMESTAMPTZ NOT NULL,
  generations_created INTEGER NOT NULL DEFAULT 0
);
