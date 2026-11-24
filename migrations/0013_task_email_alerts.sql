ALTER TABLE user_email_preferences
  ADD COLUMN daily_digest_enabled INTEGER NOT NULL DEFAULT 0;

ALTER TABLE user_email_preferences
  ADD COLUMN alert_due_soon INTEGER NOT NULL DEFAULT 0;

ALTER TABLE user_email_preferences
  ADD COLUMN alert_overdue INTEGER NOT NULL DEFAULT 0;

UPDATE user_email_preferences
SET daily_digest_enabled = email_enabled;

CREATE TABLE IF NOT EXISTS email_task_alert_deliveries (
  user_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  occurrence_key TEXT NOT NULL,
  alert_type TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  provider_message_id TEXT DEFAULT NULL,
  provider_error TEXT DEFAULT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id, task_id, occurrence_key, alert_type),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_email_task_alert_deliveries_updated
  ON email_task_alert_deliveries(status, updated_at);

CREATE INDEX IF NOT EXISTS idx_tasks_due_alert_lookup
  ON tasks(due_date, status, project_id, due_time);
