-- Immutable auto-labeling rules revisions. Saving inserts a new revision and
-- advances the repository's configured pointer under an optimistic check;
-- synchronization later promotes a revision to active once every track a
-- rule needs is ready.
CREATE TABLE labeling_ruleset_revision (
  repository_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  ruleset JSONB NOT NULL,
  saved_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  saved_by_issuer TEXT NOT NULL,
  saved_by_subject TEXT NOT NULL,
  PRIMARY KEY (repository_id, revision)
);

CREATE TABLE labeling_repository_rules (
  repository_id TEXT PRIMARY KEY,
  configured_revision BIGINT NOT NULL,
  active_revision BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  FOREIGN KEY (repository_id, configured_revision)
    REFERENCES labeling_ruleset_revision (repository_id, revision),
  FOREIGN KEY (repository_id, active_revision)
    REFERENCES labeling_ruleset_revision (repository_id, revision)
);
