-- Requests made with a revoked or expired API key are audited too, with outcome 'denied'.
ALTER TABLE audit_log DROP CONSTRAINT audit_log_outcome_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_outcome_check CHECK (outcome IN ('ok', 'error', 'denied'));
