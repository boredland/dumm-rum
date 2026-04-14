ALTER TABLE known_stops ADD COLUMN slug TEXT;
CREATE INDEX idx_known_stops_slug ON known_stops (slug);
