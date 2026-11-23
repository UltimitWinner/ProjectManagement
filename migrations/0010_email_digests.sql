CREATE TABLE IF NOT EXISTS user_email_preferences (
  user_id TEXT PRIMARY KEY,
  email TEXT DEFAULT NULL,
  email_enabled INTEGER NOT NULL DEFAULT 0,
  daily_digest_time TEXT NOT NULL DEFAULT '08:00',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  include_overdue INTEGER NOT NULL DEFAULT 1,
  include_due_today INTEGER NOT NULL DEFAULT 1,
  include_upcoming INTEGER NOT NULL DEFAULT 1,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS email_digest_deliveries (
  user_id TEXT NOT NULL,
  local_date TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  provider_message_id TEXT DEFAULT NULL,
  provider_error TEXT DEFAULT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id, local_date),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_email_preferences_enabled
  ON user_email_preferences(email_enabled, daily_digest_time);
