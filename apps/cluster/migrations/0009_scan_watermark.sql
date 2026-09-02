ALTER TABLE sync_target ADD COLUMN scan_watermark TIMESTAMPTZ;

ALTER TABLE github_entity
  ADD COLUMN issue_id TEXT,
  ADD COLUMN issue_node_id TEXT;

CREATE UNIQUE INDEX github_entity_issue_id_idx ON github_entity (issue_id) WHERE issue_id IS NOT NULL;
