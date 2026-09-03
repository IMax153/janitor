-- Classifier evaluation (plan: "Classifier evaluator"). Consent is per
-- repository and names the provider and model it covers. Leases bound
-- in-flight provider calls so revocation can drain them. Decisions are
-- cached by policy version and evidence so a repeated snapshot does not
-- repeat the call.
CREATE TABLE labeling_ai_consent (
  repository_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('enabled', 'draining', 'disabled')),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  actor_issuer TEXT NOT NULL,
  actor_subject TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP()
);

CREATE TABLE labeling_ai_lease (
  lease_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ
);
CREATE INDEX labeling_ai_lease_active_idx ON labeling_ai_lease (repository_id, released_at, expires_at);

CREATE TABLE labeling_ai_decision (
  repository_id TEXT NOT NULL,
  policy_version_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  evidence_hash TEXT NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('match', 'no-match', 'unknown')),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  reason TEXT NOT NULL,
  latency_ms INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  PRIMARY KEY (repository_id, policy_version_id, number, evidence_hash)
);
