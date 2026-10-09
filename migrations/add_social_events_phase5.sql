-- Social events Phase 5 (privacy). Additive and idempotent.
-- How many EXTRA days guest data may be kept past the normal retention window while a moderation
-- case about the event is still open (pending/hidden event, open appeal, or unreviewed report).
-- Bounded on purpose: storage limitation applies even to evidence.
BEGIN;
INSERT INTO moderation_config (key, value) VALUES ('guest_data_hold_extra_days', '30'::jsonb)
ON CONFLICT (key) DO NOTHING;
COMMIT;
