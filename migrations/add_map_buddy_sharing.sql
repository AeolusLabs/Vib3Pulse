-- Safety buddies on the map: an explicit opt-in per user. Additive and idempotent. Off by default.
ALTER TABLE map_sharing_prefs ADD COLUMN IF NOT EXISTS share_with_buddies boolean NOT NULL DEFAULT false;
