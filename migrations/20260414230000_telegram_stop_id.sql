ALTER TABLE telegram_subscriptions ADD COLUMN stop_id TEXT NOT NULL DEFAULT '';

-- Replace old unique constraint with one that includes stop_id
DROP INDEX telegram_subscriptions_chat_id_line_direction_unique;
CREATE UNIQUE INDEX telegram_subscriptions_chat_id_line_direction_stop_id_unique
  ON telegram_subscriptions (chat_id, line, direction, stop_id);
