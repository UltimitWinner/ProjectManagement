import { Hono } from 'hono';

const app = new Hono();

// Global Security Headers Middleware (XSS, Clickjacking, MIME sniffing, Referrer)
app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none';"
  );
});

// Reject cross-origin browser requests; the app and API are same-origin.
app.use('/api/*', async (c, next) => {
  const origin = c.req.header('Origin');
  if (origin) {
    try {
      if (new URL(origin).origin !== new URL(c.req.url).origin) {
        return c.json({ error: 'Cross-origin requests are not allowed' }, 403);
      }
    } catch {
      return c.json({ error: 'Invalid request origin' }, 403);
    }
  }
  await next();
});

function generateSalt() {
  const saltBytes = new Uint8Array(16);
  crypto.getRandomValues(saltBytes);
  return Array.from(saltBytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hashPassword(password, salt, pepper) {
  const enc = new TextEncoder();
  const combined = enc.encode(`${password}:${salt}:${pepper}`);

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    combined,
    { name: 'PBKDF2' },
    false,
    ['deriveBits', 'deriveKey']
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: enc.encode(salt),
      iterations: 100000,
      hash: 'SHA-256'
    },
    keyMaterial,
    256
  );

  return Array.from(new Uint8Array(derivedBits))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function sanitizeString(input, maxLength = 500) {
  if (typeof input !== 'string') return '';
  // Keep stored text as text. HTML escaping belongs at the rendering sink.
  return input.trim().slice(0, maxLength);
}

function sanitizeColor(input, fallback = '#38d8aa') {
  return typeof input === 'string' && /^#[\da-f]{3,8}$/i.test(input) ? input : fallback;
}

function normalizeCalendarDays(value, fallback = [0, 6]) {
  if (!Array.isArray(value)) return fallback;
  return [...new Set(value.map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6))];
}

function normalizeHolidayDates(value, fallback = []) {
  if (!Array.isArray(value)) return fallback;
  return [...new Set(value.filter(date => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)))].sort();
}

function normalizeStatusOptions(value) {
  const groups = ['todo', 'in_progress', 'done'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || groups.some(group => !Array.isArray(value[group]) || value[group].length > 20
      || value[group].some(label => typeof label !== 'string' || !label.trim() || label.trim().length > 60))
    || Object.keys(value).some(group => !groups.includes(group))) return null;
  return Object.fromEntries(groups.map(group => [group,
    [...new Map(value[group].map(label => [label.trim().toLocaleLowerCase(), sanitizeString(label, 60)])).values()]
  ]));
}

function normalizeTime(value) {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : null;
}

function normalizeLocalDateTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  return value;
}

async function rateLimitKey(value, pepper) {
  const bytes = new TextEncoder().encode(`${pepper}:${value}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function recordLoginAttempt(db, key, limit, windowMs = 60000) {
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  await db.prepare(`
    INSERT INTO auth_rate_limits (id, window_start_ms, attempt_count)
    VALUES (?, ?, 1)
    ON CONFLICT(id) DO UPDATE SET
      attempt_count = CASE
        WHEN auth_rate_limits.window_start_ms = excluded.window_start_ms THEN auth_rate_limits.attempt_count + 1
        ELSE 1
      END,
      window_start_ms = excluded.window_start_ms
  `).bind(key, windowStart).run();
  const row = await db.prepare('SELECT attempt_count FROM auth_rate_limits WHERE id = ?').bind(key).first();

  // Opportunistic cleanup keeps the persistent limiter table bounded.
  if (Math.random() < 0.01) {
    await db.prepare('DELETE FROM auth_rate_limits WHERE window_start_ms < ?').bind(now - windowMs * 2).run();
  }
  return Number(row?.attempt_count || 0) > limit;
}

// Table schema initialization & migration
async function initTables(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      color TEXT DEFAULT '#38d8aa',
      default_view TEXT DEFAULT 'board',
      non_working_days_json TEXT NOT NULL DEFAULT '[0,6]',
      holidays_json TEXT NOT NULL DEFAULT '[]',
      status_options_json TEXT NOT NULL DEFAULT '{"todo":[],"in_progress":[],"done":[]}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      system_role TEXT NOT NULL DEFAULT 'user',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS project_members (
      project_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      access_level TEXT NOT NULL DEFAULT 'edit',
      PRIMARY KEY(project_id, user_id),
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS auth_rate_limits (
      id TEXT PRIMARY KEY,
      window_start_ms INTEGER NOT NULL,
      attempt_count INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT DEFAULT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      color TEXT DEFAULT '',
      weight_percent REAL DEFAULT 0,
      drop_lowest_count INTEGER NOT NULL DEFAULT 0,
      target_grade REAL DEFAULT 100,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS custom_fields (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      field_type TEXT NOT NULL,
      options_json TEXT DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      folder_id TEXT DEFAULT '',
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'todo',
      status_label TEXT NOT NULL DEFAULT '',
      priority TEXT NOT NULL DEFAULT 'medium',
      start_date TEXT,
      due_date TEXT,
      start_time TEXT,
      due_time TEXT,
      open_at TEXT,
      progress INTEGER DEFAULT 0,
      color TEXT DEFAULT '',
      earned_points REAL DEFAULT NULL,
      max_points REAL DEFAULT NULL,
      grade REAL DEFAULT NULL,
      weight_override REAL DEFAULT NULL,
      extra_credit INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS task_dependencies (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      depends_on_task_id TEXT NOT NULL,
      type TEXT DEFAULT 'finish_to_start',
      FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY(depends_on_task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      UNIQUE(task_id, depends_on_task_id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS task_custom_values (
      task_id TEXT NOT NULL,
      custom_field_id TEXT NOT NULL,
      value TEXT,
      PRIMARY KEY(task_id, custom_field_id),
      FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY(custom_field_id) REFERENCES custom_fields(id) ON DELETE CASCADE
    )`)
  ]);

  try {
    await db.prepare("ALTER TABLE tasks ADD COLUMN folder_id TEXT DEFAULT ''").run();
  } catch (e) { }
  try {
    await db.prepare("ALTER TABLE users ADD COLUMN system_role TEXT NOT NULL DEFAULT 'user'").run();
  } catch (e) { }
  try {
    await db.prepare("ALTER TABLE tasks ADD COLUMN grade REAL DEFAULT NULL").run();
  } catch (e) { }
  try {
    await db.prepare("ALTER TABLE tasks ADD COLUMN sort_order INTEGER DEFAULT NULL").run();
  } catch (e) { }
  for (const [table, column, definition] of [
    ['projects', 'non_working_days_json', "TEXT NOT NULL DEFAULT '[0,6]'"],
    ['projects', 'holidays_json', "TEXT NOT NULL DEFAULT '[]'"],
    ['projects', 'status_options_json', `TEXT NOT NULL DEFAULT '{"todo":[],"in_progress":[],"done":[]}'`],
    ['folders', 'drop_lowest_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['tasks', 'extra_credit', 'INTEGER NOT NULL DEFAULT 0'],
    ['tasks', 'start_time', 'TEXT'],
    ['tasks', 'due_time', 'TEXT'],
    ['tasks', 'open_at', 'TEXT'],
    ['tasks', 'status_label', "TEXT NOT NULL DEFAULT ''"],
  ]) {
    try { await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run(); } catch (e) { }
  }
}

// STRICT AUTHENTICATION: Returns user object or null
async function ensureBootstrapUser(db, env) {
  const bootstrapCompleted = await db.prepare("SELECT value FROM app_settings WHERE key = 'bootstrap_completed'").first();
  if (bootstrapCompleted) return false;

  const username = typeof env.BOOTSTRAP_USERNAME === 'string' ? env.BOOTSTRAP_USERNAME.trim().slice(0, 80) : '';
  const password = typeof env.BOOTSTRAP_PASSWORD === 'string' ? env.BOOTSTRAP_PASSWORD : '';
  const name = typeof env.BOOTSTRAP_NAME === 'string' && env.BOOTSTRAP_NAME.trim()
    ? env.BOOTSTRAP_NAME.trim().slice(0, 100)
    : username;
  if (!username || password.length < 12 || password.length > 1024 || typeof env.APP_PEPPER !== 'string' || env.APP_PEPPER.length < 32) return false;
  const existing = await db.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();

  const salt = generateSalt();
  const passwordHash = await hashPassword(password, salt, env.APP_PEPPER);
  const id = existing?.id || `usr-${generateSalt().slice(0, 12)}`;
  await db.batch([
    db.prepare(`INSERT INTO users (id, username, password_hash, salt, name, system_role)
      VALUES (?, ?, ?, ?, ?, 'admin')
      ON CONFLICT(username) DO UPDATE SET
        password_hash = excluded.password_hash,
        salt = excluded.salt,
        name = excluded.name,
        system_role = 'admin'`).bind(id, username, passwordHash, salt, name),
    db.prepare("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('bootstrap_completed', '1')")
  ]);
  return true;
}

function readSessionCookie(c) {
  const cookieHeader = c.req.header('Cookie') || '';
  const cookie = cookieHeader.split(';').map(part => part.trim()).find(part => part.startsWith('myplan_session='));
  return cookie ? cookie.slice('myplan_session='.length) : '';
}

function writeSessionCookie(c, token, maxAge) {
  const secure = new URL(c.req.url).protocol === 'https:' ? '; Secure' : '';
  c.header('Set-Cookie', `myplan_session=${token}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=${maxAge}${secure}`);
}

async function getAuthenticatedUser(c) {
  const db = c.env.DB;
  await initTables(db);
  await ensureBootstrapUser(db, c.env);
  const token = readSessionCookie(c);

  if (!token) {
    return null;
  }

  const session = await db.prepare(`
    SELECT s.id as session_id, s.expires_at, u.id as user_id, u.username, u.name, u.system_role
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.id = ?
  `).bind(token).first();

  if (!session) {
    return null;
  }

  if (new Date(session.expires_at) < new Date()) {
    await db.prepare('DELETE FROM sessions WHERE id = ?').bind(token).run();
    return null;
  }

  return {
    id: session.user_id,
    userId: session.user_id,
    username: session.username,
    name: session.name,
    systemRole: session.system_role || 'user'
  };
}

// PROJECT-DEPENDENT PERMISSION CHECKER:
async function getProjectAccessLevel(db, projectId, user) {
  if (!user) return 'none';
  if (user.systemRole === 'admin') return 'edit';

  const member = await db.prepare(`
    SELECT access_level FROM project_members
    WHERE project_id = ? AND user_id = ?
  `).bind(projectId, user.id).first();

  if (!member) {
    return 'none';
  }

  return member.access_level || 'none';
}

function verifyProjectPermission(accessLevel, minRequired = 'view') {
  if (accessLevel === 'none') return false;
  if (minRequired === 'edit' && accessLevel !== 'edit') return false;
  return true;
}

// ----------------- Auth API Routes -----------------
app.get('/api/auth/me', async (c) => {
  const user = await getAuthenticatedUser(c);
  if (!user) {
    return c.json({ error: 'Unauthenticated. Login required.' }, 401);
  }
  return c.json({ user });
});

app.post('/api/auth/login', async (c) => {
  const db = c.env.DB;
  await initTables(db);
  if (typeof c.env.APP_PEPPER !== 'string' || c.env.APP_PEPPER.length < 32) {
    return c.json({ error: 'APP_PEPPER must be configured as a secret of at least 32 characters.' }, 503);
  }
  await ensureBootstrapUser(db, c.env);

  let body;
  try {
    body = await c.req.json();
  } catch (e) {
    return c.json({ error: 'Invalid JSON payload' }, 400);
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({ error: 'Invalid login payload' }, 400);
  }

  const username = typeof body.username === 'string' ? body.username.trim().slice(0, 80) : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!username || !password || password.length > 1024) {
    return c.json({ error: 'Username and password required' }, 400);
  }

  const clientIp = c.req.header('cf-connecting-ip') || 'local-client';
  const ipKey = await rateLimitKey(`ip:${clientIp}`, c.env.APP_PEPPER);
  const usernameKey = await rateLimitKey(`username:${username.toLowerCase()}`, c.env.APP_PEPPER);
  const ipLimited = await recordLoginAttempt(db, `ip:${ipKey}`, 20);
  const userLimited = await recordLoginAttempt(db, `user:${usernameKey}`, 10);
  if (ipLimited || userLimited) {
    return c.json({ error: 'Too many login attempts. Please wait a minute and try again.' }, 429);
  }

  const user = await db.prepare('SELECT id, username, name, system_role, password_hash, salt FROM users WHERE username = ?').bind(username).first();

  if (!user) {
    await hashPassword(password, 'dummysalt12345678', c.env.APP_PEPPER);
    return c.json({ error: 'Invalid username or password' }, 401);
  }

  const computedHash = await hashPassword(password, user.salt, c.env.APP_PEPPER);
  if (!timingSafeEqual(computedHash, user.password_hash)) {
    return c.json({ error: 'Invalid username or password' }, 401);
  }

  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const token = 'sess_' + Array.from(tokenBytes).map(b => b.toString(16).padStart(2, '0')).join('');

  const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
  await db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').bind(token, user.id, expiresAt).run();

  writeSessionCookie(c, token, 7 * 86400);
  return c.json({
    user: {
      id: user.id,
      username: user.username,
      name: user.name,
      systemRole: user.system_role || 'user'
    }
  });
});

app.post('/api/auth/logout', async (c) => {
  const db = c.env.DB;
  const token = readSessionCookie(c);
  if (token) {
    await db.prepare('DELETE FROM sessions WHERE id = ?').bind(token).run();
  }
  writeSessionCookie(c, '', 0);
  return c.json({ success: true });
});

app.post('/api/admin/users', async (c) => {
  const user = await getAuthenticatedUser(c);
  if (!user) return c.json({ error: 'Authentication required' }, 401);
  if (user.systemRole !== 'admin') return c.json({ error: 'System administrator access required' }, 403);

  if (typeof c.env.APP_PEPPER !== 'string' || c.env.APP_PEPPER.length < 32) {
    return c.json({ error: 'APP_PEPPER must be configured as a secret of at least 32 characters.' }, 503);
  }
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON payload' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'Invalid user payload' }, 400);

  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const systemRole = body.system_role === 'admin' ? 'admin' : 'user';
  if (!username || username.length > 80 || !name || name.length > 100) {
    return c.json({ error: 'Username (1–80 characters) and full name (1–100 characters) are required.' }, 400);
  }
  if (password.length < 12 || password.length > 1024) {
    return c.json({ error: 'Password must be between 12 and 1024 characters.' }, 400);
  }

  const salt = generateSalt();
  const passwordHash = await hashPassword(password, salt, c.env.APP_PEPPER);
  const id = `usr-${generateSalt().slice(0, 12)}`;
  try {
    await c.env.DB.prepare(`
      INSERT INTO users (id, username, password_hash, salt, name, system_role)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(id, username, passwordHash, salt, name, systemRole).run();
  } catch {
    return c.json({ error: 'That username is already in use.' }, 409);
  }
  return c.json({ id, username, name, system_role: systemRole }, 201);
});

app.get('/api/admin/users', async (c) => {
  const user = await getAuthenticatedUser(c);
  if (!user) return c.json({ error: 'Authentication required' }, 401);
  if (user.systemRole !== 'admin') return c.json({ error: 'System administrator access required' }, 403);
  const { results } = await c.env.DB.prepare('SELECT id, username, name, system_role FROM users ORDER BY username ASC').all();
  return c.json((results || []).map(account => ({
    userId: account.id,
    username: account.username,
    name: account.name,
    systemRole: account.system_role || 'user',
  })));
});

app.put('/api/admin/users/:id/role', async (c) => {
  const user = await getAuthenticatedUser(c);
  if (!user) return c.json({ error: 'Authentication required' }, 401);
  if (user.systemRole !== 'admin') return c.json({ error: 'System administrator access required' }, 403);

  const targetId = c.req.param('id');
  const target = await c.env.DB.prepare('SELECT id, system_role FROM users WHERE id = ?').bind(targetId).first();
  if (!target) return c.json({ error: 'User not found' }, 404);
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON payload' }, 400);
  }
  const systemRole = body?.system_role;
  if (!['admin', 'user'].includes(systemRole)) return c.json({ error: 'Role must be admin or user.' }, 400);

  if (target.system_role === 'admin' && systemRole !== 'admin') {
    const { count } = await c.env.DB.prepare("SELECT count(*) AS count FROM users WHERE system_role = 'admin'").first();
    if (Number(count) <= 1) return c.json({ error: 'The last system administrator cannot be demoted.' }, 409);
  }
  await c.env.DB.prepare('UPDATE users SET system_role = ? WHERE id = ?').bind(systemRole, targetId).run();
  return c.json({ success: true, userId: targetId, system_role: systemRole });
});

app.delete('/api/admin/users/:id', async (c) => {
  const user = await getAuthenticatedUser(c);
  if (!user) return c.json({ error: 'Authentication required' }, 401);
  if (user.systemRole !== 'admin') return c.json({ error: 'System administrator access required' }, 403);

  const targetId = c.req.param('id');
  if (targetId === user.id) return c.json({ error: 'You cannot remove your own account.' }, 400);
  const target = await c.env.DB.prepare('SELECT id, system_role FROM users WHERE id = ?').bind(targetId).first();
  if (!target) return c.json({ error: 'User not found' }, 404);
  if (target.system_role === 'admin') {
    const { count } = await c.env.DB.prepare("SELECT count(*) AS count FROM users WHERE system_role = 'admin'").first();
    if (Number(count) <= 1) return c.json({ error: 'The last system administrator cannot be removed.' }, 409);
  }
  await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(targetId).run();
  return c.json({ success: true });
});

// ----------------- Projects API (Filtered by user project membership) -----------------
app.get('/api/projects', async (c) => {
  const user = await getAuthenticatedUser(c);
  if (!user) return c.json({ error: 'Authentication required' }, 401);

  const db = c.env.DB;
  let query;
  if (user.systemRole === 'admin') {
    query = db.prepare(`
      SELECT p.*, 'edit' as user_access_level
      FROM projects p
      ORDER BY p.created_at ASC
    `);
  } else {
    query = db.prepare(`
      SELECT p.*, pm.access_level as user_access_level
      FROM projects p
      JOIN project_members pm ON p.id = pm.project_id
      WHERE pm.user_id = ? AND pm.access_level != 'none'
      ORDER BY p.created_at ASC
    `).bind(user.id);
  }

  const { results } = await query.all();
  return c.json(results || []);
});

app.post('/api/projects', async (c) => {
  const user = await getAuthenticatedUser(c);
  if (!user) return c.json({ error: 'Authentication required' }, 401);

  const db = c.env.DB;
  const body = await c.req.json();
  const id = 'proj-' + generateSalt().substring(0, 8);
  const name = sanitizeString(body.name || 'New Project', 100);
  const description = sanitizeString(body.description || '', 500);
  const color = sanitizeColor(body.color);
  const default_view = ['board', 'list', 'gantt', 'folder'].includes(body.default_view) ? body.default_view : 'folder';
  const nonWorkingDays = normalizeCalendarDays(body.non_working_days, [0, 6]);
  const holidays = normalizeHolidayDates(body.holidays, []);
  const statusOptions = body.status_options === undefined
    ? { todo: [], in_progress: [], done: [] }
    : normalizeStatusOptions(body.status_options);
  if (!statusOptions) return c.json({ error: 'Each status group must contain up to 20 non-empty labels of 60 characters or fewer.' }, 400);

  await db.batch([
    db.prepare('INSERT INTO projects (id, name, description, color, default_view, non_working_days_json, holidays_json, status_options_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, name, description, color, default_view, JSON.stringify(nonWorkingDays), JSON.stringify(holidays), JSON.stringify(statusOptions)),
    db.prepare('INSERT INTO project_members (project_id, user_id, access_level) VALUES (?, ?, ?)').bind(id, user.id, 'edit')
  ]);

  return c.json({ id, name, description, color, default_view, non_working_days_json: JSON.stringify(nonWorkingDays), holidays_json: JSON.stringify(holidays), status_options_json: JSON.stringify(statusOptions), user_access_level: 'edit' }, 201);
});

app.get('/api/projects/:id', async (c) => {
  const user = await getAuthenticatedUser(c);
  if (!user) return c.json({ error: 'Authentication required' }, 401);

  const db = c.env.DB;
  const projectId = c.req.param('id');
  const access = await getProjectAccessLevel(db, projectId, user);

  if (!verifyProjectPermission(access, 'view')) {
    return c.json({ error: 'Access denied: You do not have permissions for this project' }, 403);
  }

  const project = await db.prepare('SELECT * FROM projects WHERE id = ?').bind(projectId).first();
  return c.json({ ...project, user_access_level: access });
});

app.put('/api/projects/:id', async (c) => {
  const user = await getAuthenticatedUser(c);
  if (!user) return c.json({ error: 'Authentication required' }, 401);

  const db = c.env.DB;
  const id = c.req.param('id');
  const access = await getProjectAccessLevel(db, id, user);
  if (!verifyProjectPermission(access, 'edit')) return c.json({ error: 'Unauthorized: Requires edit access on project' }, 403);

  const body = await c.req.json();
  const name = sanitizeString(body.name || 'Project', 100);
  const description = sanitizeString(body.description || '', 500);
  const color = sanitizeColor(body.color);
  const default_view = ['board', 'list', 'gantt', 'folder'].includes(body.default_view) ? body.default_view : 'folder';
  const existingProject = await db.prepare('SELECT non_working_days_json, holidays_json, status_options_json FROM projects WHERE id = ?').bind(id).first();
  if (!existingProject) return c.json({ error: 'Project not found' }, 404);
  let existingDays = [0, 6];
  let existingHolidays = [];
  try { existingDays = JSON.parse(existingProject.non_working_days_json || '[0,6]'); } catch { }
  try { existingHolidays = JSON.parse(existingProject.holidays_json || '[]'); } catch { }
  const nonWorkingDays = normalizeCalendarDays(body.non_working_days, existingDays);
  const holidays = normalizeHolidayDates(body.holidays, existingHolidays);
  let existingStatusOptions;
  try { existingStatusOptions = JSON.parse(existingProject.status_options_json || '{"todo":[],"in_progress":[],"done":[]}'); } catch { existingStatusOptions = { todo: [], in_progress: [], done: [] }; }
  const cleanedStatusOptions = normalizeStatusOptions(body.status_options === undefined ? existingStatusOptions : body.status_options);
  if (!cleanedStatusOptions) {
    return c.json({ error: 'Each status group must contain up to 20 non-empty labels of 60 characters or fewer.' }, 400);
  }

  await db.prepare(`UPDATE projects
    SET name = ?, description = ?, color = ?, default_view = ?, non_working_days_json = ?, holidays_json = ?, status_options_json = ?
    WHERE id = ?`).bind(
    name, description, color, default_view, JSON.stringify(nonWorkingDays), JSON.stringify(holidays), JSON.stringify(cleanedStatusOptions), id
  ).run();
  return c.json({ success: true });
});

app.delete('/api/projects/:id', async (c) => {
  const user = await getAuthenticatedUser(c);
  if (!user) return c.json({ error: 'Authentication required' }, 401);

  const db = c.env.DB;
  const id = c.req.param('id');
  const access = await getProjectAccessLevel(db, id, user);
  if (!verifyProjectPermission(access, 'edit')) return c.json({ error: 'Unauthorized: Requires edit access on project' }, 403);

  await db.prepare('DELETE FROM projects WHERE id = ?').bind(id).run();
  return c.json({ success: true });
});

// ----------------- Project Members & Permissions API -----------------
app.get('/api/projects/:id/members', async (c) => {
  const user = await getAuthenticatedUser(c);
  if (!user) return c.json({ error: 'Authentication required' }, 401);

  const db = c.env.DB;
  const projectId = c.req.param('id');
  if (user.systemRole !== 'admin') return c.json({ error: 'System administrator access required' }, 403);
  const project = await db.prepare('SELECT id FROM projects WHERE id = ?').bind(projectId).first();
  if (!project) return c.json({ error: 'Project not found' }, 404);

  const { results: users } = await db.prepare('SELECT id, username, name, system_role FROM users ORDER BY username ASC').all();
  const { results: members } = await db.prepare('SELECT user_id, access_level FROM project_members WHERE project_id = ?').bind(projectId).all();

  const memberMap = new Map((members || []).map(m => [m.user_id, m.access_level]));

  const response = (users || []).map(u => ({
    userId: u.id,
    username: u.username,
    name: u.name,
    systemRole: u.system_role || 'user',
    accessLevel: memberMap.get(u.id) || 'none'
  }));

  return c.json(response);
});

app.put('/api/projects/:id/members/:userId', async (c) => {
  const user = await getAuthenticatedUser(c);
  if (!user) return c.json({ error: 'Authentication required' }, 401);

  const db = c.env.DB;
  const projectId = c.req.param('id');
  const targetUserId = c.req.param('userId');
  if (user.systemRole !== 'admin') return c.json({ error: 'System administrator access required' }, 403);

  const project = await db.prepare('SELECT id FROM projects WHERE id = ?').bind(projectId).first();
  if (!project) return c.json({ error: 'Project not found' }, 404);
  const target = await db.prepare('SELECT id FROM users WHERE id = ?').bind(targetUserId).first();
  if (!target) return c.json({ error: 'User not found' }, 404);

  const { access_level } = await c.req.json();
  if (!['none', 'view', 'edit'].includes(access_level)) {
    return c.json({ error: 'Invalid access level. Must be none, view, or edit.' }, 400);
  }

  await db.prepare(`
    INSERT OR REPLACE INTO project_members (project_id, user_id, access_level)
    VALUES (?, ?, ?)
  `).bind(projectId, targetUserId, access_level).run();

  return c.json({ success: true, projectId, targetUserId, access_level });
});

// ----------------- Folders & Nested Subfolders API -----------------
app.get('/api/projects/:id/folders', async (c) => {
  const user = await getAuthenticatedUser(c);
  if (!user) return c.json({ error: 'Authentication required' }, 401);

  const db = c.env.DB;
  const projectId = c.req.param('id');
  const access = await getProjectAccessLevel(db, projectId, user);
  if (!verifyProjectPermission(access, 'view')) return c.json({ error: 'Access denied' }, 403);

  const { results } = await db.prepare('SELECT * FROM folders WHERE project_id = ? ORDER BY created_at ASC').bind(projectId).all();
  return c.json(results || []);
});

app.post('/api/projects/:id/folders', async (c) => {
  const user = await getAuthenticatedUser(c);
  if (!user) return c.json({ error: 'Authentication required' }, 401);

  const db = c.env.DB;
  const projectId = c.req.param('id');
  const access = await getProjectAccessLevel(db, projectId, user);
  if (!verifyProjectPermission(access, 'edit')) return c.json({ error: 'Requires edit permission on project' }, 403);

  const body = await c.req.json();
  const id = 'fld-' + generateSalt().substring(0, 8);
  const name = sanitizeString(body.name || 'New Folder', 100);
  const parent_id = body.parent_id ? String(body.parent_id) : null;
  const description = sanitizeString(body.description || '', 500);
  const color = sanitizeString(body.color || '', 20);
  const requestedWeight = Number(body.weight_percent);
  const weight_percent = Number.isFinite(requestedWeight) ? Math.max(0, requestedWeight) : 0;
  const requestedDropLowest = Number(body.drop_lowest_count);
  const drop_lowest_count = Number.isFinite(requestedDropLowest) ? Math.max(0, Math.floor(requestedDropLowest)) : 0;
  const target_grade = Number(body.target_grade) || 100;

  await db.prepare(`
    INSERT INTO folders (id, project_id, parent_id, name, description, color, weight_percent, drop_lowest_count, target_grade)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(id, projectId, parent_id, name, description, color, weight_percent, drop_lowest_count, target_grade).run();

  return c.json({ id, project_id: projectId, parent_id, name, description, color, weight_percent, drop_lowest_count, target_grade }, 201);
});

app.put('/api/folders/:id', async (c) => {
  const user = await getAuthenticatedUser(c);
  if (!user) return c.json({ error: 'Authentication required' }, 401);

  const db = c.env.DB;
  const id = c.req.param('id');
  const folder = await db.prepare('SELECT project_id FROM folders WHERE id = ?').bind(id).first();
  if (!folder) return c.json({ error: 'Folder not found' }, 404);

  const access = await getProjectAccessLevel(db, folder.project_id, user);
  if (!verifyProjectPermission(access, 'edit')) return c.json({ error: 'Requires edit permission on project' }, 403);

  const body = await c.req.json();
  const name = sanitizeString(body.name || 'Folder', 100);
  const parent_id = body.parent_id ? String(body.parent_id) : null;
  const description = sanitizeString(body.description || '', 500);
  const color = sanitizeString(body.color || '', 20);
  const requestedWeight = Number(body.weight_percent);
  const weight_percent = Number.isFinite(requestedWeight) ? Math.max(0, requestedWeight) : 0;
  const requestedDropLowest = Number(body.drop_lowest_count);
  const drop_lowest_count = Number.isFinite(requestedDropLowest) ? Math.max(0, Math.floor(requestedDropLowest)) : 0;
  const target_grade = Number(body.target_grade) || 100;

  if (parent_id === id) {
    return c.json({ error: 'A folder cannot be its own parent' }, 400);
  }

  // Guard against circular ancestry (e.g. making a grandparent a child of its own grandchild)
  if (parent_id) {
    let check = parent_id;
    const visited = new Set([id]);
    while (check) {
      if (visited.has(check)) {
        return c.json({ error: 'Circular folder nesting detected' }, 400);
      }
      visited.add(check);
      const row = await db.prepare('SELECT parent_id FROM folders WHERE id = ?').bind(check).first();
      check = row?.parent_id || null;
    }
  }

  await db.prepare(`
    UPDATE folders
    SET name = ?, parent_id = ?, description = ?, color = ?, weight_percent = ?, drop_lowest_count = ?, target_grade = ?
    WHERE id = ?
  `).bind(name, parent_id, description, color, weight_percent, drop_lowest_count, target_grade, id).run();

  return c.json({ success: true });
});

app.delete('/api/folders/:id', async (c) => {
  const user = await getAuthenticatedUser(c);
  if (!user) return c.json({ error: 'Authentication required' }, 401);

  const db = c.env.DB;
  const id = c.req.param('id');
  const folder = await db.prepare('SELECT project_id FROM folders WHERE id = ?').bind(id).first();
  if (!folder) return c.json({ error: 'Folder not found' }, 404);

  const access = await getProjectAccessLevel(db, folder.project_id, user);
  if (!verifyProjectPermission(access, 'edit')) return c.json({ error: 'Requires edit permission on project' }, 403);

  // Recursively delete all descendant folders before deleting the target
  async function deleteRecursive(folderId) {
    const { results: children } = await db.prepare('SELECT id FROM folders WHERE parent_id = ?').bind(folderId).all();
    for (const child of (children || [])) {
      await deleteRecursive(child.id);
    }
    await db.prepare('DELETE FROM folders WHERE id = ?').bind(folderId).run();
  }
  await deleteRecursive(id);
  return c.json({ success: true });
});

// ----------------- Custom Fields API Routes -----------------
app.get('/api/projects/:id/fields', async (c) => {
  const user = await getAuthenticatedUser(c);
  if (!user) return c.json({ error: 'Authentication required' }, 401);

  const db = c.env.DB;
  const projectId = c.req.param('id');
  const access = await getProjectAccessLevel(db, projectId, user);
  if (!verifyProjectPermission(access, 'view')) return c.json({ error: 'Access denied' }, 403);

  const { results } = await db.prepare('SELECT * FROM custom_fields WHERE project_id = ? ORDER BY created_at ASC').bind(projectId).all();
  return c.json((results || []).map(f => ({ ...f, options: JSON.parse(f.options_json || '[]') })));
});

app.post('/api/projects/:id/fields', async (c) => {
  const user = await getAuthenticatedUser(c);
  if (!user) return c.json({ error: 'Authentication required' }, 401);

  const db = c.env.DB;
  const projectId = c.req.param('id');
  const access = await getProjectAccessLevel(db, projectId, user);
  if (!verifyProjectPermission(access, 'edit')) return c.json({ error: 'Requires edit permission on project' }, 403);

  const body = await c.req.json();
  const id = 'cf-' + generateSalt().substring(0, 8);
  const name = sanitizeString(body.name || '', 100);
  const field_type = ['text', 'number', 'select', 'date', 'checkbox'].includes(body.field_type) ? body.field_type : 'text';
  const cleanOptions = Array.isArray(body.options) ? body.options.map(opt => sanitizeString(String(opt), 100)).filter(Boolean) : [];
  const optionsJson = JSON.stringify(cleanOptions);

  await db.prepare('INSERT INTO custom_fields (id, project_id, name, field_type, options_json) VALUES (?, ?, ?, ?, ?)').bind(
    id, projectId, name, field_type, optionsJson
  ).run();

  return c.json({ id, project_id: projectId, name, field_type, options: cleanOptions }, 201);
});

app.put('/api/fields/:id', async (c) => {
  const user = await getAuthenticatedUser(c);
  if (!user) return c.json({ error: 'Authentication required' }, 401);

  const db = c.env.DB;
  const id = c.req.param('id');
  const field = await db.prepare('SELECT project_id FROM custom_fields WHERE id = ?').bind(id).first();
  if (!field) return c.json({ error: 'Field not found' }, 404);

  const access = await getProjectAccessLevel(db, field.project_id, user);
  if (!verifyProjectPermission(access, 'edit')) return c.json({ error: 'Requires edit permission on project' }, 403);

  const body = await c.req.json();
  const name = sanitizeString(body.name || '', 100);
  const field_type = ['text', 'number', 'select', 'date', 'checkbox'].includes(body.field_type) ? body.field_type : 'text';
  const cleanOptions = Array.isArray(body.options) ? body.options.map(opt => sanitizeString(String(opt), 100)).filter(Boolean) : [];
  const optionsJson = JSON.stringify(cleanOptions);

  await db.prepare('UPDATE custom_fields SET name = ?, field_type = ?, options_json = ? WHERE id = ?').bind(
    name, field_type, optionsJson, id
  ).run();

  return c.json({ success: true });
});

app.delete('/api/fields/:id', async (c) => {
  const user = await getAuthenticatedUser(c);
  if (!user) return c.json({ error: 'Authentication required' }, 401);

  const db = c.env.DB;
  const id = c.req.param('id');
  const field = await db.prepare('SELECT project_id FROM custom_fields WHERE id = ?').bind(id).first();
  if (!field) return c.json({ error: 'Field not found' }, 404);

  const access = await getProjectAccessLevel(db, field.project_id, user);
  if (!verifyProjectPermission(access, 'edit')) return c.json({ error: 'Requires edit permission on project' }, 403);

  await db.prepare('DELETE FROM custom_fields WHERE id = ?').bind(id).run();
  return c.json({ success: true });
});

// ----------------- Tasks API Routes -----------------
app.get('/api/projects/:id/tasks', async (c) => {
  const user = await getAuthenticatedUser(c);
  if (!user) return c.json({ error: 'Authentication required' }, 401);

  const db = c.env.DB;
  const projectId = c.req.param('id');
  const access = await getProjectAccessLevel(db, projectId, user);
  if (!verifyProjectPermission(access, 'view')) return c.json({ error: 'Access denied' }, 403);

  const { results: tasks } = await db.prepare(`
    SELECT * FROM tasks WHERE project_id = ?
    ORDER BY CASE WHEN sort_order IS NULL THEN 1 ELSE 0 END, sort_order ASC, start_date ASC, created_at ASC
  `).bind(projectId).all();
  const { results: deps } = await db.prepare(`
    SELECT td.* FROM task_dependencies td
    JOIN tasks t ON td.task_id = t.id
    WHERE t.project_id = ?
  `).bind(projectId).all();

  const { results: customVals } = await db.prepare(`
    SELECT tcv.* FROM task_custom_values tcv
    JOIN tasks t ON tcv.task_id = t.id
    WHERE t.project_id = ?
  `).bind(projectId).all();

  const taskMap = (tasks || []).map(task => {
    const dependencies = (deps || []).filter(d => d.task_id === task.id).map(d => d.depends_on_task_id);
    const customFields = {};
    (customVals || []).filter(cv => cv.task_id === task.id).forEach(cv => {
      customFields[cv.custom_field_id] = cv.value;
    });
    return {
      ...task,
      dependencies,
      custom_values: customFields
    };
  });

  return c.json(taskMap);
});

app.patch('/api/projects/:id/tasks/order', async (c) => {
  const user = await getAuthenticatedUser(c);
  if (!user) return c.json({ error: 'Authentication required' }, 401);

  const db = c.env.DB;
  const projectId = c.req.param('id');
  const access = await getProjectAccessLevel(db, projectId, user);
  if (!verifyProjectPermission(access, 'edit')) return c.json({ error: 'Requires edit permission on project' }, 403);

  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON payload' }, 400);
  }
  const taskIds = body?.task_ids;
  const statuses = body?.statuses || {};
  const statusLabels = body?.status_labels || {};
  if (!Array.isArray(taskIds) || taskIds.some(id => typeof id !== 'string') || new Set(taskIds).size !== taskIds.length) {
    return c.json({ error: 'task_ids must be an array of unique task IDs.' }, 400);
  }

  const { results: projectTasks } = await db.prepare('SELECT id FROM tasks WHERE project_id = ?').bind(projectId).all();
  const existingIds = new Set((projectTasks || []).map(task => task.id));
  if (taskIds.length !== existingIds.size || taskIds.some(id => !existingIds.has(id))) {
    return c.json({ error: 'task_ids must include every task in this project exactly once.' }, 400);
  }
  if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses)
    || Object.entries(statuses).some(([id, status]) => !existingIds.has(id) || !['todo', 'in_progress', 'done'].includes(status))) {
    return c.json({ error: 'statuses must map project task IDs to valid task statuses.' }, 400);
  }
  if (!statusLabels || typeof statusLabels !== 'object' || Array.isArray(statusLabels)
    || Object.entries(statusLabels).some(([id, label]) => !existingIds.has(id) || typeof label !== 'string' || label.trim().length > 60)) {
    return c.json({ error: 'status_labels must map project task IDs to labels of 60 characters or fewer.' }, 400);
  }

  await db.batch(taskIds.map((id, index) => db.prepare(`
    UPDATE tasks
    SET sort_order = ?, status = COALESCE(?, status),
        status_label = CASE WHEN ? = 1 THEN ? WHEN ? IS NOT NULL THEN '' ELSE status_label END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND project_id = ?
  `).bind(
    index,
    Object.hasOwn(statuses, id) ? statuses[id] : null,
    Object.hasOwn(statusLabels, id) ? 1 : 0,
    Object.hasOwn(statusLabels, id) ? sanitizeString(statusLabels[id], 60) : null,
    Object.hasOwn(statuses, id) ? statuses[id] : null,
    id,
    projectId
  )));

  return c.json({ success: true });
});

app.post('/api/projects/:id/tasks/bulk-delete', async (c) => {
  const user = await getAuthenticatedUser(c);
  if (!user) return c.json({ error: 'Authentication required' }, 401);

  const db = c.env.DB;
  const projectId = c.req.param('id');
  const access = await getProjectAccessLevel(db, projectId, user);
  if (!verifyProjectPermission(access, 'edit')) return c.json({ error: 'Requires edit permission on project' }, 403);

  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON payload' }, 400);
  }
  const taskIds = body?.task_ids;
  if (!Array.isArray(taskIds) || taskIds.length === 0 || taskIds.length > 50
    || taskIds.some(id => typeof id !== 'string' || !id) || new Set(taskIds).size !== taskIds.length) {
    return c.json({ error: 'task_ids must contain 1 to 50 unique task IDs per batch.' }, 400);
  }

  const placeholders = taskIds.map(() => '?').join(', ');
  const { results } = await db.prepare(`SELECT id FROM tasks WHERE project_id = ? AND id IN (${placeholders})`)
    .bind(projectId, ...taskIds).all();
  if ((results || []).length !== taskIds.length) {
    return c.json({ error: 'Every selected task must belong to this project.' }, 400);
  }

  await db.batch([
    db.prepare(`DELETE FROM task_dependencies WHERE task_id IN (${placeholders}) OR depends_on_task_id IN (${placeholders})`)
      .bind(...taskIds, ...taskIds),
    db.prepare(`DELETE FROM task_custom_values WHERE task_id IN (${placeholders})`).bind(...taskIds),
    db.prepare(`DELETE FROM tasks WHERE project_id = ? AND id IN (${placeholders})`).bind(projectId, ...taskIds)
  ]);
  return c.json({ success: true, deleted: taskIds.length });
});

app.post('/api/projects/:id/tasks', async (c) => {
  const user = await getAuthenticatedUser(c);
  if (!user) return c.json({ error: 'Authentication required' }, 401);

  const db = c.env.DB;
  const projectId = c.req.param('id');
  const access = await getProjectAccessLevel(db, projectId, user);
  if (!verifyProjectPermission(access, 'edit')) return c.json({ error: 'Requires edit permission on project' }, 403);

  const body = await c.req.json();
  const id = 'task-' + generateSalt().substring(0, 8);

  const title = sanitizeString(body.title || 'Untitled Task', 200);
  const description = sanitizeString(body.description || '', 2000);
  const folder_id = sanitizeString(body.folder_id || '', 50);
  const status = ['todo', 'in_progress', 'done'].includes(body.status) ? body.status : 'todo';
  const priority = ['none', 'low', 'medium', 'high', 'urgent'].includes(body.priority) ? body.priority : 'medium';
  const progress = Math.max(0, Math.min(100, Number(body.progress) || 0));
  const extra_credit = body.extra_credit === true || body.extra_credit === 1 || body.extra_credit === '1' || body.extra_credit === 'true' ? 1 : 0;

  await db.prepare(`
    INSERT INTO tasks (id, project_id, folder_id, title, description, status, status_label, priority, start_date, due_date, start_time, due_time, open_at, progress, color, earned_points, max_points, grade, weight_override, extra_credit)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    projectId,
    folder_id,
    title,
    description,
    status,
    sanitizeString(body.status_label || '', 60),
    priority,
    body.start_date || null,
    body.due_date || null,
    normalizeTime(body.start_time),
    normalizeTime(body.due_time),
    normalizeLocalDateTime(body.open_at),
    progress,
    sanitizeString(body.color || '', 20),
    body.earned_points !== undefined && body.earned_points !== '' && body.earned_points !== null ? Number(body.earned_points) : null,
    body.max_points !== undefined && body.max_points !== '' && body.max_points !== null ? Number(body.max_points) : null,
    body.grade !== undefined && body.grade !== '' && body.grade !== null ? Number(body.grade) : null,
    body.weight_override !== undefined && body.weight_override !== '' && body.weight_override !== null ? Number(body.weight_override) : null,
    extra_credit
  ).run();

  if (Array.isArray(body.dependencies)) {
    for (const depId of body.dependencies) {
      if (depId && depId !== id) {
        const depKey = 'dep-' + generateSalt().substring(0, 8);
        await db.prepare('INSERT OR IGNORE INTO task_dependencies (id, task_id, depends_on_task_id) VALUES (?, ?, ?)').bind(depKey, id, depId).run();
      }
    }
  }

  if (body.custom_values && typeof body.custom_values === 'object') {
    for (const [cfId, val] of Object.entries(body.custom_values)) {
      if (val !== undefined && val !== null) {
        await db.prepare('INSERT OR REPLACE INTO task_custom_values (task_id, custom_field_id, value) VALUES (?, ?, ?)').bind(id, cfId, sanitizeString(String(val), 500)).run();
      }
    }
  }

  return c.json({ id, ...body, title, description }, 201);
});

app.put('/api/tasks/:id', async (c) => {
  const user = await getAuthenticatedUser(c);
  if (!user) return c.json({ error: 'Authentication required' }, 401);

  const db = c.env.DB;
  const id = c.req.param('id');
  const task = await db.prepare('SELECT project_id FROM tasks WHERE id = ?').bind(id).first();
  if (!task) return c.json({ error: 'Task not found' }, 404);

  const access = await getProjectAccessLevel(db, task.project_id, user);
  if (!verifyProjectPermission(access, 'edit')) return c.json({ error: 'Requires edit permission on project' }, 403);

  const body = await c.req.json();
  const title = sanitizeString(body.title || 'Untitled Task', 200);
  const description = sanitizeString(body.description || '', 2000);
  const folder_id = sanitizeString(body.folder_id || '', 50);
  const status = ['todo', 'in_progress', 'done'].includes(body.status) ? body.status : 'todo';
  const priority = ['none', 'low', 'medium', 'high', 'urgent'].includes(body.priority) ? body.priority : 'medium';
  const progress = Math.max(0, Math.min(100, Number(body.progress) || 0));
  const extra_credit = body.extra_credit === true || body.extra_credit === 1 || body.extra_credit === '1' || body.extra_credit === 'true' ? 1 : 0;

  await db.prepare(`
    UPDATE tasks
    SET title = ?, description = ?, folder_id = ?, status = ?, status_label = ?, priority = ?, start_date = ?, due_date = ?, start_time = ?, due_time = ?, open_at = ?, progress = ?, color = ?,
        earned_points = ?, max_points = ?, grade = ?, weight_override = ?, extra_credit = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(
    title,
    description,
    folder_id,
    status,
    sanitizeString(body.status_label || '', 60),
    priority,
    body.start_date || null,
    body.due_date || null,
    normalizeTime(body.start_time),
    normalizeTime(body.due_time),
    normalizeLocalDateTime(body.open_at),
    progress,
    sanitizeString(body.color || '', 20),
    body.earned_points !== undefined && body.earned_points !== '' && body.earned_points !== null ? Number(body.earned_points) : null,
    body.max_points !== undefined && body.max_points !== '' && body.max_points !== null ? Number(body.max_points) : null,
    body.grade !== undefined && body.grade !== '' && body.grade !== null ? Number(body.grade) : null,
    body.weight_override !== undefined && body.weight_override !== '' && body.weight_override !== null ? Number(body.weight_override) : null,
    extra_credit,
    id
  ).run();

  if (Array.isArray(body.dependencies)) {
    await db.prepare('DELETE FROM task_dependencies WHERE task_id = ?').bind(id).run();
    for (const depId of body.dependencies) {
      if (depId && depId !== id) {
        const depKey = 'dep-' + generateSalt().substring(0, 8);
        await db.prepare('INSERT OR IGNORE INTO task_dependencies (id, task_id, depends_on_task_id) VALUES (?, ?, ?)').bind(depKey, id, depId).run();
      }
    }
  }

  if (body.custom_values && typeof body.custom_values === 'object') {
    for (const [cfId, val] of Object.entries(body.custom_values)) {
      if (val === null || val === '') {
        await db.prepare('DELETE FROM task_custom_values WHERE task_id = ? AND custom_field_id = ?').bind(id, cfId).run();
      } else {
        await db.prepare('INSERT OR REPLACE INTO task_custom_values (task_id, custom_field_id, value) VALUES (?, ?, ?)').bind(id, cfId, sanitizeString(String(val), 500)).run();
      }
    }
  }

  return c.json({ success: true });
});

app.patch('/api/tasks/:id/status', async (c) => {
  const user = await getAuthenticatedUser(c);
  if (!user) return c.json({ error: 'Authentication required' }, 401);

  const db = c.env.DB;
  const id = c.req.param('id');
  const task = await db.prepare('SELECT project_id FROM tasks WHERE id = ?').bind(id).first();
  if (!task) return c.json({ error: 'Task not found' }, 404);

  const access = await getProjectAccessLevel(db, task.project_id, user);
  if (!verifyProjectPermission(access, 'edit')) return c.json({ error: 'Requires edit permission on project' }, 403);

  const { status } = await c.req.json();
  if (!['todo', 'in_progress', 'done'].includes(status)) {
    return c.json({ error: 'Invalid task status' }, 400);
  }

  await db.prepare('UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(status, id).run();
  return c.json({ success: true, status });
});

app.delete('/api/tasks/:id', async (c) => {
  const user = await getAuthenticatedUser(c);
  if (!user) return c.json({ error: 'Authentication required' }, 401);

  const db = c.env.DB;
  const id = c.req.param('id');
  const task = await db.prepare('SELECT project_id FROM tasks WHERE id = ?').bind(id).first();
  if (!task) return c.json({ error: 'Task not found' }, 404);

  const access = await getProjectAccessLevel(db, task.project_id, user);
  if (!verifyProjectPermission(access, 'edit')) return c.json({ error: 'Requires edit permission on project' }, 403);

  await db.prepare('DELETE FROM tasks WHERE id = ?').bind(id).run();
  return c.json({ success: true });
});

export default app;
