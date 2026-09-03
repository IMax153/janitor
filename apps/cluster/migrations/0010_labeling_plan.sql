-- Evaluation output (design: "Concrete evaluator"). The plan is what the
-- active revision would change on the entity; nothing applies it yet.
ALTER TABLE labeling_reconciliation ADD COLUMN plan JSONB;
