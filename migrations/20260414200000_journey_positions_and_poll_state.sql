-- Phase 3: add poll_state to journey_runs + create journey_positions table

ALTER TABLE journey_runs ADD COLUMN poll_state TEXT;

-- Backfill all existing rows so they don't get re-enqueued
UPDATE journey_runs SET poll_state = 'done';

CREATE INDEX idx_journey_runs_poll_state ON journey_runs (poll_state, day_of_operation);

CREATE TABLE journey_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  journey_ref TEXT NOT NULL,
  day_of_operation TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  reported_at TEXT NOT NULL,
  route_idx INTEGER,
  rt_route_idx INTEGER,
  captured_at TEXT NOT NULL
);

CREATE INDEX idx_journey_pos_ref_day ON journey_positions (journey_ref, day_of_operation);
CREATE INDEX idx_journey_pos_captured ON journey_positions (captured_at);
