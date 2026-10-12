-- Privacy switch: show my event attendance to mutual friends on the map. Additive; existing users default on.
ALTER TABLE users ADD COLUMN IF NOT EXISTS show_attendance_to_friends boolean NOT NULL DEFAULT true;
