CREATE INDEX IF NOT EXISTS idx_tasks_project_order
  ON tasks(project_id, sort_order, start_date, created_at);

CREATE INDEX IF NOT EXISTS idx_folders_project_parent_order
  ON folders(project_id, parent_id, sort_order, created_at);

CREATE INDEX IF NOT EXISTS idx_custom_fields_project_created
  ON custom_fields(project_id, created_at);

CREATE INDEX IF NOT EXISTS idx_project_members_user_project
  ON project_members(user_id, project_id, access_level);

CREATE INDEX IF NOT EXISTS idx_task_dependencies_depends_on
  ON task_dependencies(depends_on_task_id, task_id);

CREATE INDEX IF NOT EXISTS idx_task_custom_values_field_task
  ON task_custom_values(custom_field_id, task_id);

CREATE INDEX IF NOT EXISTS idx_sessions_user
  ON sessions(user_id);
