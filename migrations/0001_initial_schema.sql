-- Projects (Workflows / Coursework)
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    color TEXT DEFAULT '#38d8aa',
    default_view TEXT DEFAULT 'board', -- 'board', 'list', 'gantt', 'folder'
    non_working_days_json TEXT NOT NULL DEFAULT '[0,6]',
    holidays_json TEXT NOT NULL DEFAULT '[]',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Users & Authentication
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    system_role TEXT NOT NULL DEFAULT 'user', -- 'admin', 'user'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Project-Dependent User Permissions (none, view, edit, creator per project)
CREATE TABLE IF NOT EXISTS project_members (
    project_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    access_level TEXT NOT NULL DEFAULT 'none', -- 'none', 'view', 'edit', 'creator'
    PRIMARY KEY(project_id, user_id),
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Active User Sessions
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Database-backed login throttling shared across Worker instances.
CREATE TABLE IF NOT EXISTS auth_rate_limits (
    id TEXT PRIMARY KEY,
    window_start_ms INTEGER NOT NULL,
    attempt_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Folders & Nested Subfolders (with grade rates & targets)
CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    parent_id TEXT DEFAULT NULL, -- NULL for root folders (e.g., classes), or parent folder ID for nested subfolders
    name TEXT NOT NULL,          -- e.g. "CS 301 (Algorithms)", "Homework", "Unit 1"
    description TEXT DEFAULT '',
    color TEXT DEFAULT '',
    weight_percent REAL DEFAULT 0, -- Weighted grading contribution %
    target_grade REAL DEFAULT 100,  -- Target grade %
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY(parent_id) REFERENCES folders(id) ON DELETE CASCADE
);

-- Custom field definitions for a project
CREATE TABLE IF NOT EXISTS custom_fields (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    field_type TEXT NOT NULL, -- 'text', 'number', 'select', 'date', 'checkbox'
    options_json TEXT DEFAULT '[]', -- for 'select' type: ["Exam", "Homework", "Project"]
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Tasks (associated with project and folder/subfolder)
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    folder_id TEXT DEFAULT '',  -- References folders(id)
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo', -- 'todo', 'in_progress', 'done'
    priority TEXT NOT NULL DEFAULT 'medium', -- 'low', 'medium', 'high', 'urgent'
    start_date TEXT, -- YYYY-MM-DD
    due_date TEXT,   -- YYYY-MM-DD
    start_time TEXT, -- Local task start/reminder time, HH:MM
    due_time TEXT,   -- Local deadline time, HH:MM
    open_at TEXT,    -- Local task availability datetime, YYYY-MM-DDTHH:MM
    progress INTEGER DEFAULT 0, -- 0 to 100
    color TEXT DEFAULT '',
    earned_points REAL DEFAULT NULL, -- Actual points/grade earned (e.g. 95)
    max_points REAL DEFAULT NULL,    -- Maximum possible points (e.g. 100)
    weight_override REAL DEFAULT NULL, -- Specific weight if not folder-derived
    sort_order INTEGER DEFAULT NULL, -- User-defined task order for Board and Gantt views
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Task Dependencies (Predecessor must finish before Successor)
CREATE TABLE IF NOT EXISTS task_dependencies (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,          -- successor task
    depends_on_task_id TEXT NOT NULL, -- predecessor task
    type TEXT DEFAULT 'finish_to_start',
    FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY(depends_on_task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    UNIQUE(task_id, depends_on_task_id)
);

-- Custom field values stored per task
CREATE TABLE IF NOT EXISTS task_custom_values (
    task_id TEXT NOT NULL,
    custom_field_id TEXT NOT NULL,
    value TEXT,
    PRIMARY KEY(task_id, custom_field_id),
    FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY(custom_field_id) REFERENCES custom_fields(id) ON DELETE CASCADE
);
