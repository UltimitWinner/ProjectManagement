ALTER TABLE projects ADD COLUMN status_options_json TEXT NOT NULL DEFAULT '{"todo":[],"in_progress":[],"done":[]}';
