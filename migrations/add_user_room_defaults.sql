-- Hosting defaults: what the create-room form starts with. Additive and idempotent. Null = built-in defaults.
ALTER TABLE users ADD COLUMN IF NOT EXISTS room_defaults jsonb;
