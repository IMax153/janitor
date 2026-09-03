-- A saved revision records the track generation it asked synchronization to
-- verify; promotion to active waits until every recorded track has verified
-- at least that generation.
ALTER TABLE labeling_ruleset_revision
  ADD COLUMN required_tracks JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE labeling_repository_rules
  ADD COLUMN activated_at TIMESTAMPTZ;
