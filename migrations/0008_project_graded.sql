ALTER TABLE projects ADD COLUMN graded INTEGER NOT NULL DEFAULT 0;

UPDATE projects
SET graded = 1
WHERE EXISTS (
  SELECT 1 FROM folders
  WHERE folders.project_id = projects.id AND folders.grade_enabled = 1
);
