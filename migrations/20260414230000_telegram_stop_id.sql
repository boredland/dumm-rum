-- Recreate table to change UNIQUE constraint (SQLite can't ALTER constraints)
CREATE TABLE telegram_subscriptions_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  lang TEXT NOT NULL DEFAULT 'de',
  line TEXT NOT NULL,
  direction TEXT NOT NULL,
  stop_id TEXT NOT NULL DEFAULT '',
  time_ranges TEXT,
  weekdays TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(chat_id, line, direction, stop_id)
);

INSERT INTO telegram_subscriptions_new (id, chat_id, lang, line, direction, stop_id, time_ranges, weekdays, created_at)
SELECT id, chat_id, lang, line, direction, '', time_ranges, weekdays, created_at
FROM telegram_subscriptions;

DROP TABLE telegram_subscriptions;
ALTER TABLE telegram_subscriptions_new RENAME TO telegram_subscriptions;

CREATE INDEX idx_telegram_line_dir ON telegram_subscriptions (line, direction);
