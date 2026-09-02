-- One row per synchronization scope. Generation counters coalesce
-- invalidations; verified columns back the freshness contract; the planner
-- records when it last created repair generations.
CREATE TABLE sync_target (
  scope_key TEXT PRIMARY KEY,
  scope JSONB NOT NULL,
  requested_generation BIGINT NOT NULL DEFAULT 0,
  dispatched_generation BIGINT NOT NULL DEFAULT 0,
  completed_generation BIGINT NOT NULL DEFAULT 0,
  verified_generation BIGINT NOT NULL DEFAULT 0,
  requested_sequence BIGINT,
  verified_sequence BIGINT,
  verified_at TIMESTAMPTZ,
  debounce_started_at TIMESTAMPTZ,
  scan_watermark TIMESTAMPTZ,
  full_requested BOOLEAN NOT NULL DEFAULT FALSE,
  health TEXT NOT NULL DEFAULT 'ok' CHECK (health IN ('ok', 'blocked')),
  blocked_reason TEXT,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP()
);

CREATE INDEX sync_target_pending_idx
  ON sync_target (updated_at)
  WHERE requested_generation > completed_generation;

CREATE TABLE sync_repair_state (
  name TEXT PRIMARY KEY,
  last_planned_at TIMESTAMPTZ NOT NULL,
  generations_created INTEGER NOT NULL DEFAULT 0
);
