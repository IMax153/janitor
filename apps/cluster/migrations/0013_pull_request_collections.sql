-- Collection facts for pull requests (plan: "Collection tracks"). Rows are
-- replaced wholesale by the entity refresh that fetched them, in the same
-- transaction as the entity, so they are never newer or older than it.
CREATE TABLE github_pull_request_collections (
  repository_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  /** False when the file listing was cut off at the fetch limit. */
  files_complete BOOLEAN NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  PRIMARY KEY (repository_id, number),
  FOREIGN KEY (repository_id, number) REFERENCES github_entity (repository_id, number) ON DELETE CASCADE
);

CREATE TABLE github_pull_request_file (
  repository_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  path TEXT NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY (repository_id, number, path),
  FOREIGN KEY (repository_id, number) REFERENCES github_pull_request_collections (repository_id, number) ON DELETE CASCADE
);

CREATE TABLE github_check_run (
  repository_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  PRIMARY KEY (repository_id, number, name),
  FOREIGN KEY (repository_id, number) REFERENCES github_pull_request_collections (repository_id, number) ON DELETE CASCADE
);

CREATE TABLE github_pull_request_review (
  repository_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  reviewer TEXT NOT NULL,
  state TEXT NOT NULL,
  PRIMARY KEY (repository_id, number, reviewer),
  FOREIGN KEY (repository_id, number) REFERENCES github_pull_request_collections (repository_id, number) ON DELETE CASCADE
);
