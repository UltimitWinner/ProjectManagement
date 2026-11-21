CREATE TABLE IF NOT EXISTS auth_rate_limits (
    id TEXT PRIMARY KEY,
    window_start_ms INTEGER NOT NULL,
    attempt_count INTEGER NOT NULL
);
