CREATE TABLE IF NOT EXISTS user_project_email_preferences (
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  include_project INTEGER NOT NULL DEFAULT 1,
  include_overdue INTEGER DEFAULT NULL,
  lookahead_days INTEGER DEFAULT NULL,
  include_undated_open INTEGER DEFAULT NULL,
  weekend_delivery TEXT DEFAULT NULL,
  holiday_delivery TEXT DEFAULT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id, project_id),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_project_email_preferences_project
  ON user_project_email_preferences(project_id, user_id);

CREATE TABLE project_members_new (
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  access_level TEXT NOT NULL DEFAULT 'none',
  PRIMARY KEY(project_id, user_id),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO project_members_new (project_id, user_id, access_level)
SELECT project_id, user_id, access_level FROM project_members;

DROP TABLE project_members;
ALTER TABLE project_members_new RENAME TO project_members;
