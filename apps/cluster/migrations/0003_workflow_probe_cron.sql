ALTER TABLE workflow_probe_commit
DROP CONSTRAINT workflow_probe_commit_step_check;

ALTER TABLE workflow_probe_commit
ADD CONSTRAINT workflow_probe_commit_step_check
CHECK (step IN ('first', 'second', 'queue', 'cron'));
