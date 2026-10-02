ALTER TABLE events ADD COLUMN IF NOT EXISTS country TEXT;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS country VARCHAR(100);

-- One-time backfill: currency is the only reliable explicit market signal
-- that exists for pre-existing rows. Country is independent of currency
-- going forward (see schema.ts comments) -- this seed never re-runs.
UPDATE events SET country = 'United Kingdom' WHERE currency = 'GBP' AND country IS NULL;
UPDATE events SET country = 'Nigeria' WHERE currency = 'NGN' AND country IS NULL;
UPDATE venues SET country = 'United Kingdom' WHERE currency = 'GBP' AND country IS NULL;
UPDATE venues SET country = 'Nigeria' WHERE currency = 'NGN' AND country IS NULL;

CREATE INDEX IF NOT EXISTS events_country_idx ON events (country);
CREATE INDEX IF NOT EXISTS events_currency_idx ON events (currency);
CREATE INDEX IF NOT EXISTS venues_country_idx ON venues (country);
CREATE INDEX IF NOT EXISTS venues_currency_idx ON venues (currency);
