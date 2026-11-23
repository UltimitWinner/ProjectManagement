import { Hono } from 'hono';
import { getNextTaskOccurrence } from '../public/task-utils.js';

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
  if (c.req.path.includes('/canvas/')) c.header('Cache-Control', 'no-store, private');
});

// Reject cross-origin browser requests; the app and API are same-origin.
app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/canvas/oauth/callback') return next();
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

function normalizeRepeatRule(body) {
  const frequency = typeof body.repeat_frequency === 'string' ? body.repeat_frequency : '';
  if (!frequency) return { valid: true, frequency: '', interval: 1, until: null };
  if (!['daily', 'weekly', 'monthly', 'yearly'].includes(frequency)) {
    return { valid: false, error: 'Choose a valid repeat frequency.' };
  }
  const interval = Number(body.repeat_interval);
  if (!Number.isInteger(interval) || interval < 1 || interval > 999) {
    return { valid: false, error: 'Repeat interval must be a whole number from 1 to 999.' };
  }
  const dateIsValid = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };
  const anchor = body.start_date || body.due_date;
  const until = body.repeat_until;
  if (!dateIsValid(anchor)) return { valid: false, error: 'A valid start date or due date is required for repeating tasks.' };
  if (!dateIsValid(until) || until < anchor) return { valid: false, error: 'Choose a valid repeat end date on or after the task start date.' };
  return { valid: true, frequency, interval, until };
}

function emailEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function normalizedAppUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : '';
  } catch {
    return '';
  }
}

function zonedDateTime(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`
  };
}

function calendarDayDifference(fromDate, toDate) {
  return Math.round((new Date(`${toDate}T00:00:00Z`).getTime() - new Date(`${fromDate}T00:00:00Z`).getTime()) / 86400000);
}

function emailDate(dateValue, options = { weekday: 'short', month: 'short', day: 'numeric' }) {
  if (!dateValue) return '';
  return new Date(`${dateValue}T00:00:00Z`).toLocaleDateString('en-US', { ...options, timeZone: 'UTC' });
}

async function collectDailyDigest(db, user, preferences, localDate) {
  const userId = user.id || user.user_id;
  const defaultLookaheadDays = Number.isInteger(Number(preferences.lookahead_days))
    ? Math.min(30, Math.max(0, Number(preferences.lookahead_days))) : 7;
  const { results } = await db.prepare(`
    SELECT t.*, p.id AS calendar_project_id, p.name AS project_name,
      p.holidays_json, p.non_working_days_json, f.name AS folder_name,
      COALESCE(dpe.include_project, 1) AS digest_include_project,
      dpe.include_overdue AS project_include_overdue,
      dpe.lookahead_days AS project_lookahead_days,
      dpe.include_undated_open AS project_include_undated_open,
      dpe.weekend_delivery AS project_weekend_delivery,
      dpe.holiday_delivery AS project_holiday_delivery
    FROM projects p
    LEFT JOIN user_project_email_preferences dpe
      ON dpe.project_id = p.id AND dpe.user_id = ?
    LEFT JOIN tasks t ON t.project_id = p.id AND COALESCE(dpe.include_project, 1) = 1 AND (
      (
        t.repeat_frequency IS NOT NULL AND t.repeat_frequency != ''
        AND COALESCE(NULLIF(t.start_date, ''), NULLIF(t.due_date, '')) <= date(?, '+' || COALESCE(dpe.lookahead_days, ?) || ' days')
        AND (t.repeat_until IS NULL OR t.repeat_until >= ?)
      )
      OR (
        t.status != 'done'
        AND (
          (COALESCE(NULLIF(t.due_date, ''), NULLIF(t.start_date, '')) IS NOT NULL
            AND COALESCE(NULLIF(t.due_date, ''), NULLIF(t.start_date, '')) <= date(?, '+' || COALESCE(dpe.lookahead_days, ?) || ' days')
            AND (COALESCE(dpe.include_overdue, ?) = 1 OR COALESCE(NULLIF(t.due_date, ''), NULLIF(t.start_date, '')) >= ?))
          OR (COALESCE(dpe.include_undated_open, ?) = 1 AND NULLIF(t.due_date, '') IS NULL AND NULLIF(t.start_date, '') IS NULL)
        )
      )
    )
    LEFT JOIN folders f ON f.id = t.folder_id
    WHERE (
      EXISTS (
        SELECT 1 FROM project_members pm
        WHERE pm.project_id = p.id AND pm.user_id = ? AND pm.access_level != 'none'
      )
      OR (
        ? = 'admin' AND NOT EXISTS (
          SELECT 1 FROM project_members admin_pm
          WHERE admin_pm.project_id = p.id AND admin_pm.user_id = ? AND admin_pm.access_level = 'none'
        )
      )
    )
  `).bind(userId, localDate, defaultLookaheadDays, localDate,
    localDate, defaultLookaheadDays, preferences.include_overdue ? 1 : 0, localDate,
    preferences.include_undated_open ? 1 : 0,
    userId, user.system_role || 'user', userId).all();

  const groups = { overdue: [], dueToday: [], upcoming: [], undated: [], lookaheadDays: defaultLookaheadDays, suppressEmpty: false };
  const projectInfo = new Map();
  for (const task of results || []) {
    const projectId = task.calendar_project_id;
    if (Number(task.digest_include_project) === 0) {
      groups.suppressEmpty = true;
      continue;
    }
    const projectLookaheadDays = task.project_lookahead_days === null || task.project_lookahead_days === undefined
      ? defaultLookaheadDays
      : Math.min(30, Math.max(0, Number(task.project_lookahead_days) || 0));
    const includeOverdue = task.project_include_overdue === null || task.project_include_overdue === undefined
      ? Boolean(preferences.include_overdue) : Number(task.project_include_overdue) === 1;
    const includeUndatedOpen = task.project_include_undated_open === null || task.project_include_undated_open === undefined
      ? Boolean(preferences.include_undated_open) : Number(task.project_include_undated_open) === 1;
    let holidays = [];
    try { holidays = JSON.parse(task.holidays_json || '[]'); } catch { }
    holidays = normalizeHolidayDates(holidays, []);
    let nonWorkingDays;
    try { nonWorkingDays = JSON.parse(task.non_working_days_json || '[0,6]'); } catch { nonWorkingDays = [0, 6]; }
    nonWorkingDays = normalizeCalendarDays(nonWorkingDays, [0, 6]);
    const weekday = new Date(`${localDate}T00:00:00.000Z`).getUTCDay();
    const projectIsWeekend = nonWorkingDays.includes(weekday);
    const projectIsHoliday = holidays.includes(localDate);
    if (!projectInfo.has(projectId)) {
      projectInfo.set(projectId, {
        isWeekend: projectIsWeekend,
        isHoliday: projectIsHoliday,
        lookaheadDays: projectLookaheadDays,
        includeOverdue,
        weekendDelivery: task.project_weekend_delivery || preferences.weekend_delivery || 'always',
        holidayDelivery: task.project_holiday_delivery || preferences.holiday_delivery || 'always',
        dueTodayCount: 0,
        items: []
      });
      groups.lookaheadDays = Math.max(groups.lookaheadDays, projectLookaheadDays);
    }
    if (!task.id) continue;

    const isRepeating = Boolean(task.repeat_frequency);
    if (task.status === 'done' && !isRepeating) continue;
    if (isRepeating && task.repeat_until && task.repeat_until < localDate) continue;

    let occurrenceFromDate = localDate;
    if (isRepeating && task.start_date && task.due_date) {
      const dueOffset = calendarDayDifference(task.start_date, task.due_date);
      if (dueOffset < 0) {
        const nextDueCandidate = new Date(`${localDate}T00:00:00.000Z`);
        nextDueCandidate.setUTCDate(nextDueCandidate.getUTCDate() - dueOffset);
        occurrenceFromDate = nextDueCandidate.toISOString().slice(0, 10);
      }
    }
    const occurrence = isRepeating ? getNextTaskOccurrence(task, occurrenceFromDate, holidays) : task;
    if (!occurrence) continue;
    const dueDate = occurrence.due_date || occurrence.start_date;
    const taskInfo = projectInfo.get(projectId);
    if (!dueDate) {
      if (!isRepeating && includeUndatedOpen && task.status !== 'done') {
        const item = {
          title: task.title,
          project: task.project_name,
          projectId,
          folder: task.folder_name || '',
          dueDate: '',
          dueTime: '',
          priority: task.priority || 'medium',
          status: task.status_label || task.status || 'todo',
          repeating: false
        };
        groups.undated.push(item);
        taskInfo.items.push(item);
      }
      continue;
    }
    const daysAhead = calendarDayDifference(localDate, dueDate);
    if (isRepeating && dueDate < localDate) continue;
    const item = {
      title: task.title,
      project: task.project_name,
      projectId,
      folder: task.folder_name || '',
      dueDate,
      dueTime: occurrence.due_date ? (occurrence.due_time || '') : (occurrence.start_time || ''),
      priority: task.priority || 'medium',
      status: isRepeating ? 'Repeating' : (task.status_label || task.status || 'todo'),
      repeating: isRepeating
    };

    if (daysAhead === 0) taskInfo.dueTodayCount += 1;
    if (daysAhead < 0 && includeOverdue) groups.overdue.push(item);
    else if (daysAhead === 0) groups.dueToday.push(item);
    else if (daysAhead > 0 && daysAhead <= taskInfo.lookaheadDays) groups.upcoming.push(item);
    if (daysAhead < 0 ? includeOverdue : daysAhead <= taskInfo.lookaheadDays) taskInfo.items.push(item);
  }

  const projectModes = project => {
    const modes = [];
    if (project.isWeekend) modes.push(project.weekendDelivery);
    if (project.isHoliday) modes.push(project.holidayDelivery);
    return modes;
  };
  const excludedProjects = new Set();
  for (const [projectId, info] of projectInfo) {
    const modes = projectModes(info);
    if (modes.some(mode => mode !== 'always')) groups.suppressEmpty = true;
    if (modes.includes('never')
      || (modes.includes('due_today') && info.dueTodayCount === 0)
      || (modes.includes('if_content') && info.items.length === 0)) {
      excludedProjects.add(projectId);
    }
  }
  if (excludedProjects.size) {
    for (const key of ['overdue', 'dueToday', 'upcoming', 'undated']) {
      groups[key] = groups[key].filter(item => !excludedProjects.has(item.projectId));
    }
  }
  for (const key of ['overdue', 'dueToday', 'upcoming', 'undated']) {
    for (const item of groups[key]) delete item.projectId;
    groups[key].sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.title.localeCompare(b.title));
  }
  return groups;
}

function buildDailyDigestEmail(user, localDate, groups, appUrl = '') {
  const counts = {
    overdue: groups.overdue.length,
    dueToday: groups.dueToday.length,
    upcoming: groups.upcoming.length,
    undated: groups.undated.length
  };
  const total = counts.overdue + counts.dueToday + counts.upcoming;
  const dateLabel = emailDate(localDate, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const sections = [
    ['overdue', 'Overdue', '#b42318'],
    ['dueToday', 'Due today', '#b54708'],
    ['upcoming', `Coming up · next ${groups.lookaheadDays} day${groups.lookaheadDays === 1 ? '' : 's'}`, '#176b87'],
    ['undated', 'Open · no date set', '#6941c6']
  ].filter(([key]) => groups[key].length);

  const sectionHtml = sections.map(([key, heading, accent]) => `
    <tr><td style="padding:24px 28px 8px;"><h2 style="margin:0;color:${accent};font-size:16px;line-height:22px;">${heading} <span style="font-size:12px;font-weight:500;color:#667085;">${groups[key].length}</span></h2></td></tr>
    ${groups[key].map(task => `
      <tr><td style="padding:8px 28px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e4e7ec;border-radius:10px;background:#fff;">
          <tr><td style="padding:14px 16px;border-left:4px solid ${accent};">
            <div style="font-size:15px;font-weight:650;line-height:21px;color:#182230;">${emailEscape(task.title)}</div>
            <div style="padding-top:5px;font-size:12px;line-height:18px;color:#667085;">${emailEscape(task.project)}${task.folder ? ` · ${emailEscape(task.folder)}` : ''}</div>
            <div style="padding-top:10px;font-size:12px;line-height:18px;color:#344054;">${emailEscape(emailDate(task.dueDate, { month: 'short', day: 'numeric' }))}${task.dueTime ? ` · ${emailEscape(task.dueTime)}` : ''} <span style="padding-left:8px;text-transform:capitalize;color:#667085;">${emailEscape(task.priority)}</span>${task.repeating ? ' <span style="padding-left:8px;color:#176b87;">Repeating</span>' : ''}</div>
          </td></tr>
        </table>
      </td></tr>
    `).join('')}
  `).join('');
  const openLink = appUrl
    ? `<tr><td align="center" style="padding:26px 28px 10px;"><a href="${emailEscape(appUrl)}" style="display:inline-block;padding:11px 20px;border-radius:8px;background:#178c78;color:#fff;text-decoration:none;font-size:14px;font-weight:650;">Open MyPlan</a></td></tr>`
    : '';
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f2f4f7;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#182230;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f2f4f7;padding:28px 12px;"><tr><td align="center">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;border-collapse:separate;border-spacing:0;background:#fff;border:1px solid #e4e7ec;border-radius:16px;overflow:hidden;">
        <tr><td style="padding:24px 28px;background:#132a3a;color:#fff;"><div style="font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:#a5f3e3;font-weight:700;">MYPLAN · DAILY DIGEST</div><h1 style="margin:11px 0 0;font-size:24px;line-height:31px;color:#fff;">Your day, at a glance</h1><div style="padding-top:5px;font-size:14px;color:#d0d5dd;">${emailEscape(dateLabel)}</div></td></tr>
        <tr><td style="padding:20px 28px 4px;"><p style="margin:0;font-size:15px;line-height:22px;color:#344054;">Hi ${emailEscape(user.name || user.username)}, here’s what needs your attention.</p></td></tr>
        <tr><td style="padding:16px 28px 0;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
          <td style="padding:12px;background:#fff5f4;border-radius:9px;text-align:center;"><div style="font-size:20px;font-weight:700;color:#b42318;">${counts.overdue}</div><div style="font-size:11px;color:#667085;">OVERDUE</div></td><td width="8"></td>
          <td style="padding:12px;background:#fffaeb;border-radius:9px;text-align:center;"><div style="font-size:20px;font-weight:700;color:#b54708;">${counts.dueToday}</div><div style="font-size:11px;color:#667085;">DUE TODAY</div></td><td width="8"></td>
          <td style="padding:12px;background:#eff8ff;border-radius:9px;text-align:center;"><div style="font-size:20px;font-weight:700;color:#176b87;">${counts.upcoming}</div><div style="font-size:11px;color:#667085;">${groups.lookaheadDays === 0 ? 'TODAY ONLY' : `NEXT ${groups.lookaheadDays} DAYS`}</div></td><td width="8"></td>
          <td style="padding:12px;background:#f4f3ff;border-radius:9px;text-align:center;"><div style="font-size:20px;font-weight:700;color:#6941c6;">${counts.undated}</div><div style="font-size:11px;color:#667085;">NO DATE</div></td>
        </tr></table></td></tr>
        ${sectionHtml || '<tr><td style="padding:30px 28px;text-align:center;color:#667085;font-size:14px;">You’re all caught up. No tasks match this digest.</td></tr>'}
        ${openLink}
        <tr><td style="padding:24px 28px 26px;text-align:center;color:#98a2b3;font-size:11px;line-height:17px;">You’re receiving this because daily digest emails are enabled for your MyPlan account.</td></tr>
      </table>
    </td></tr></table>
  </body></html>`;
  const textLines = [`MYPLAN DAILY DIGEST — ${dateLabel}`, `Hi ${user.name || user.username}, here’s what needs your attention.`, `${total} task${total === 1 ? '' : 's'} in this digest.`, ''];
  for (const [key, heading] of [['overdue', 'OVERDUE'], ['dueToday', 'DUE TODAY'], ['upcoming', `COMING UP · NEXT ${groups.lookaheadDays} DAYS`], ['undated', 'OPEN · NO DATE SET']]) {
    if (!groups[key].length) continue;
    textLines.push(heading);
    for (const task of groups[key]) textLines.push(`• ${task.title} — ${task.project}${task.folder ? ` / ${task.folder}` : ''}${task.dueDate ? ` — ${task.dueDate}${task.dueTime ? ` ${task.dueTime}` : ''}` : ' — No date set'}${task.repeating ? ' — Repeating' : ''}`);
    textLines.push('');
  }
  if (appUrl) textLines.push(`Open MyPlan: ${appUrl}`);
  return { subject: `MyPlan daily digest · ${dateLabel}`, html, text: textLines.join('\n') };
}

function isEmailSenderConfigured(env) {
  return Boolean(env.GMAIL_ADDRESS && env.GMAIL_APP_PASSWORD);
}

async function sendDigestEmail(env, email, message, idempotencyKey) {
  const { sendGmailSmtp } = await import('./gmail-smtp.js');
  return sendGmailSmtp({
    address: env.GMAIL_ADDRESS,
    appPassword: env.GMAIL_APP_PASSWORD,
    recipient: email,
    message,
    idempotencyKey
  });
}

async function runDailyDigestSchedule(env, now = new Date()) {
  if (!isEmailSenderConfigured(env)) {
    console.warn('Daily digests are enabled but GMAIL_ADDRESS or GMAIL_APP_PASSWORD is not configured.');
    return { processed: 0, sent: 0, empty: 0, failed: 0, configured: false };
  }

  const { results: preferences } = await env.DB.prepare(`
    SELECT p.*, u.name, u.username, u.system_role
    FROM user_email_preferences p
    JOIN users u ON u.id = p.user_id
    WHERE p.email_enabled = 1 AND p.email IS NOT NULL AND p.email != ''
    ORDER BY p.updated_at ASC
  `).all();

  const stats = { processed: 0, sent: 0, skipped: 0, failed: 0, configured: true };
  for (const preference of preferences || []) {
    if (stats.processed >= 10) break; // Allow headroom under the Workers Free subrequest limit.
    let localNow;
    try { localNow = zonedDateTime(now, preference.timezone || 'UTC'); }
    catch { continue; }
    if (localNow.time < preference.daily_digest_time) continue;

    const claim = await env.DB.prepare(`
      INSERT INTO email_digest_deliveries (user_id, local_date, status, attempts, updated_at)
      VALUES (?, ?, 'sending', 1, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, local_date) DO UPDATE SET
        status = 'sending', attempts = email_digest_deliveries.attempts + 1,
        provider_error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE (email_digest_deliveries.status = 'failed' AND email_digest_deliveries.updated_at < datetime('now', '-5 minutes'))
        OR (email_digest_deliveries.status = 'sending' AND email_digest_deliveries.updated_at < datetime('now', '-10 minutes'))
      RETURNING user_id
    `).bind(preference.user_id, localNow.date).first();
    if (!claim) continue;
    stats.processed += 1;

    try {
      const groups = await collectDailyDigest(env.DB, preference, preference, localNow.date);
      const digestItemCount = groups.overdue.length + groups.dueToday.length
        + groups.upcoming.length + groups.undated.length;
      if (groups.suppressEmpty && digestItemCount === 0) {
        await env.DB.prepare(`UPDATE email_digest_deliveries SET status = 'skipped', provider_error = 'No digest content for this project day', updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND local_date = ?`)
          .bind(preference.user_id, localNow.date).run();
        stats.skipped += 1;
        continue;
      }
      const message = buildDailyDigestEmail(preference, localNow.date, groups, normalizedAppUrl(env.APP_URL));
      const messageId = await sendDigestEmail(env, preference.email, message, `myplan-daily-digest/${preference.user_id}/${localNow.date}`);
      await env.DB.prepare(`UPDATE email_digest_deliveries SET status = 'sent', provider_message_id = ?, provider_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND local_date = ?`)
        .bind(messageId, preference.user_id, localNow.date).run();
      stats.sent += 1;
    } catch (error) {
      const providerError = sanitizeString(error?.message || 'Email delivery failed.', 500);
      await env.DB.prepare(`UPDATE email_digest_deliveries SET status = 'failed', provider_error = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND local_date = ?`)
        .bind(providerError, preference.user_id, localNow.date).run();
      stats.failed += 1;
      console.error(`Daily digest delivery failed for account ${preference.user_id}: ${providerError}`);
    }
  }
  return stats;
}

async function rateLimitKey(value, pepper) {
  const bytes = new TextEncoder().encode(`${pepper}:${value}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function recordLoginAttempt(db, key, limit, windowMs = 60000) {
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const row = await db.prepare(`
    INSERT INTO auth_rate_limits (id, window_start_ms, attempt_count)
    VALUES (?, ?, 1)
    ON CONFLICT(id) DO UPDATE SET
      attempt_count = CASE
        WHEN auth_rate_limits.window_start_ms = excluded.window_start_ms THEN auth_rate_limits.attempt_count + 1
        ELSE 1
      END,
      window_start_ms = excluded.window_start_ms
    RETURNING attempt_count
  `).bind(key, windowStart).first();

  // Opportunistic cleanup keeps the persistent limiter table bounded.
  if (Math.random() < 0.01) {
    await db.prepare('DELETE FROM auth_rate_limits WHERE window_start_ms < ?').bind(now - windowMs * 2).run();
  }
  return Number(row?.attempt_count || 0) > limit;
}

// Table schema initialization & migration
const initializedDatabases = new WeakMap();
async function initTables(db) {
  if (initializedDatabases.has(db)) return initializedDatabases.get(db);
  const initialization = initializeTables(db);
  initializedDatabases.set(db, initialization);
  try {
    await initialization;
  } catch (error) {
    initializedDatabases.delete(db);
    throw error;
  }
}

async function initializeTables(db) {
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
      graded INTEGER NOT NULL DEFAULT 0,
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
    db.prepare(`CREATE TABLE IF NOT EXISTS user_email_preferences (
      user_id TEXT PRIMARY KEY,
      email TEXT DEFAULT NULL,
      email_enabled INTEGER NOT NULL DEFAULT 0,
      daily_digest_time TEXT NOT NULL DEFAULT '08:00',
      timezone TEXT NOT NULL DEFAULT 'UTC',
      include_overdue INTEGER NOT NULL DEFAULT 1,
      include_due_today INTEGER NOT NULL DEFAULT 1,
      include_upcoming INTEGER NOT NULL DEFAULT 1,
      lookahead_days INTEGER NOT NULL DEFAULT 7,
      include_undated_open INTEGER NOT NULL DEFAULT 0,
      weekend_delivery TEXT NOT NULL DEFAULT 'always',
      holiday_delivery TEXT NOT NULL DEFAULT 'always',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS email_digest_deliveries (
      user_id TEXT NOT NULL,
      local_date TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      provider_message_id TEXT DEFAULT NULL,
      provider_error TEXT DEFAULT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(user_id, local_date),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_user_email_preferences_enabled ON user_email_preferences(email_enabled, daily_digest_time)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS user_project_email_preferences (
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
    )`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_user_project_email_preferences_project ON user_project_email_preferences(project_id, user_id)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS project_members (
      project_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      access_level TEXT NOT NULL DEFAULT 'none',
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
    db.prepare(`CREATE TABLE IF NOT EXISTS canvas_oauth_states (
      state_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      canvas_url TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS canvas_connections (
      user_id TEXT PRIMARY KEY,
      canvas_url TEXT NOT NULL,
      access_token_encrypted TEXT NOT NULL,
      refresh_token_encrypted TEXT,
      expires_at TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT DEFAULT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      color TEXT DEFAULT '',
      weight_percent REAL DEFAULT 0,
      sort_order INTEGER DEFAULT NULL,
      bonus_cap_enabled INTEGER NOT NULL DEFAULT 0,
      drop_lowest_count INTEGER NOT NULL DEFAULT 0,
      drop_highest_count INTEGER NOT NULL DEFAULT 0,
      grade_enabled INTEGER NOT NULL DEFAULT 0,
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
      never_drop INTEGER NOT NULL DEFAULT 0,
      repeat_frequency TEXT NOT NULL DEFAULT '',
      repeat_interval INTEGER NOT NULL DEFAULT 1,
      repeat_until TEXT DEFAULT NULL,
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
    ['projects', 'graded', 'INTEGER NOT NULL DEFAULT 0'],
    ['folders', 'drop_lowest_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['folders', 'drop_highest_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['folders', 'grade_enabled', 'INTEGER NOT NULL DEFAULT 0'],
    ['folders', 'sort_order', 'INTEGER DEFAULT NULL'],
    ['folders', 'bonus_cap_enabled', 'INTEGER NOT NULL DEFAULT 0'],
    ['tasks', 'extra_credit', 'INTEGER NOT NULL DEFAULT 0'],
    ['tasks', 'never_drop', 'INTEGER NOT NULL DEFAULT 0'],
    ['tasks', 'repeat_frequency', "TEXT NOT NULL DEFAULT ''"],
    ['tasks', 'repeat_interval', 'INTEGER NOT NULL DEFAULT 1'],
    ['tasks', 'repeat_until', 'TEXT DEFAULT NULL'],
    ['tasks', 'start_time', 'TEXT'],
    ['tasks', 'due_time', 'TEXT'],
    ['tasks', 'open_at', 'TEXT'],
    ['tasks', 'status_label', "TEXT NOT NULL DEFAULT ''"],
    ['user_email_preferences', 'lookahead_days', 'INTEGER NOT NULL DEFAULT 7'],
    ['user_email_preferences', 'include_undated_open', 'INTEGER NOT NULL DEFAULT 0'],
    ['user_email_preferences', 'weekend_delivery', "TEXT NOT NULL DEFAULT 'always'"],
    ['user_email_preferences', 'holiday_delivery', "TEXT NOT NULL DEFAULT 'always'"],
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
  if (minRequired === 'edit' && !['edit', 'creator'].includes(accessLevel)) return false;
  return true;
}

function normalizeCanvasBaseUrl(value, env = {}) {
  if (typeof value !== 'string' || value.length > 300) throw new Error('Enter your Canvas site URL.');
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('Enter a valid Canvas site URL, such as https://canvas.school.edu.'); }
  const hostname = url.hostname.toLowerCase();
  const configuredHosts = String(env.CANVAS_ALLOWED_HOSTS || '').split(',').map(host => host.trim().toLowerCase()).filter(Boolean);
  const allowlisted = configuredHosts.some(host => host.startsWith('*.')
    ? hostname.endsWith(host.slice(1)) && hostname !== host.slice(2)
    : hostname === host);
  const standardCanvasHost = hostname === 'canvas.instructure.com' || hostname.endsWith('.instructure.com')
    || /\.(?:edu|edu\.[a-z]{2}|ac\.[a-z]{2})$/.test(hostname);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || (url.pathname !== '/' && url.pathname !== '') || (url.port && url.port !== '443')
    || !hostname.includes('.') || /^\d+(?:\.\d+){3}$/.test(hostname)
    || hostname === 'localhost' || hostname.endsWith('.localhost')
    || /\.(?:local|internal|test|invalid|example|lan|home\.arpa)$/.test(hostname)
    || (!standardCanvasHost && !allowlisted)) {
    throw new Error('Use a public HTTPS Canvas site (such as a *.instructure.com or *.edu host). Custom domains must be added to CANVAS_ALLOWED_HOSTS.');
  }
  return url.origin;
}

function canvasBase64(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function canvasBytesFromBase64(value) {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

async function canvasEncryptionKey(env) {
  if (typeof env.APP_PEPPER !== 'string' || env.APP_PEPPER.length < 32) {
    throw new Error('APP_PEPPER must be configured before Canvas tokens can be stored.');
  }
  const material = new TextEncoder().encode(`myplan-canvas-token:${env.APP_PEPPER}`);
  const digest = await crypto.subtle.digest('SHA-256', material);
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encryptCanvasToken(value, env) {
  const key = await canvasEncryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value));
  return `${canvasBase64(iv)}.${canvasBase64(encrypted)}`;
}

async function decryptCanvasToken(value, env) {
  if (typeof value !== 'string' || !value.includes('.')) throw new Error('Stored Canvas credentials are invalid. Reconnect Canvas.');
  try {
    const [ivPart, encryptedPart] = value.split('.', 2);
    const key = await canvasEncryptionKey(env);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: canvasBytesFromBase64(ivPart) }, key, canvasBytesFromBase64(encryptedPart)
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    throw new Error('Could not unlock the stored Canvas credentials. Reconnect Canvas.');
  }
}

async function canvasStateHash(state, env) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${env.APP_PEPPER}:${state}`));
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function canvasTokenRequest(canvasUrl, parameters) {
  const response = await fetch(`${canvasUrl}/login/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(parameters)
  });
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok || !data.access_token) {
    throw new Error(response.status === 401 || response.status === 403
      ? 'Canvas rejected the OAuth request. Check the developer key and its redirect URL.'
      : 'Canvas could not complete OAuth. Check the Canvas site URL and developer key settings.');
  }
  return data;
}

async function canvasGetAccessToken(db, env, userId) {
  const connection = await db.prepare('SELECT * FROM canvas_connections WHERE user_id = ?').bind(userId).first();
  if (!connection) throw new Error('Connect a Canvas account first.');
  let accessToken = await decryptCanvasToken(connection.access_token_encrypted, env);
  const expiresAt = connection.expires_at ? Date.parse(connection.expires_at) : 0;
  if (expiresAt && expiresAt <= Date.now() + 90000) {
    if (!connection.refresh_token_encrypted) throw new Error('Canvas access token is no longer valid. Reconnect with a new token.');
    const refreshToken = await decryptCanvasToken(connection.refresh_token_encrypted, env);
    let refreshed;
    try {
      refreshed = await canvasTokenRequest(connection.canvas_url, {
        grant_type: 'refresh_token',
        client_id: env.CANVAS_CLIENT_ID,
        client_secret: env.CANVAS_CLIENT_SECRET,
        refresh_token: refreshToken
      });
    } catch {
      throw new Error('Canvas authorization expired. Connect your account again.');
    }
    accessToken = refreshed.access_token;
    const nextRefreshToken = refreshed.refresh_token || refreshToken;
    const nextExpiry = Number(refreshed.expires_in) > 0
      ? new Date(Date.now() + Number(refreshed.expires_in) * 1000).toISOString()
      : null;
    await db.prepare(`UPDATE canvas_connections SET access_token_encrypted = ?, refresh_token_encrypted = ?,
      expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`)
      .bind(await encryptCanvasToken(accessToken, env), await encryptCanvasToken(nextRefreshToken, env), nextExpiry, userId).run();
  }
  return { connection, accessToken };
}

function canvasNextPage(linkHeader) {
  for (const segment of String(linkHeader || '').split(/,(?=\s*<)/)) {
    if (!/rel="?next"?/i.test(segment)) continue;
    const match = segment.match(/<([^>]+)>/);
    return match?.[1] || null;
  }
  return null;
}

async function canvasGetAllPages(canvasUrl, accessToken, initialUrl) {
  const items = [];
  let nextUrl = new URL(initialUrl, `${canvasUrl}/`);
  for (let page = 0; nextUrl && page < 200; page += 1) {
    if (nextUrl.origin !== canvasUrl || !nextUrl.pathname.startsWith('/api/v1/')) {
      throw new Error('Canvas returned an invalid pagination URL.');
    }
    const response = await fetch(nextUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json+canvas-string-ids'
      }
    });
    if (response.status === 401) throw new Error('Canvas authorization is no longer valid. Connect your account again.');
    if (response.status === 403) throw new Error('Canvas denied access to this course or its grades.');
    if (response.status === 429) throw new Error('Canvas is rate limiting requests. Wait a moment and retry.');
    if (!response.ok) throw new Error(`Canvas API returned HTTP ${response.status}.`);
    const result = await response.json();
    if (!Array.isArray(result)) throw new Error('Canvas returned an unexpected response.');
    items.push(...result);
    const next = canvasNextPage(response.headers.get('Link'));
    nextUrl = next ? new URL(next, canvasUrl) : null;
  }
  if (nextUrl) throw new Error('Canvas returned too many pages of results.');
  return items;
}

async function canvasGetCourses(canvasUrl, accessToken) {
  const base = new URL('/api/v1/courses', `${canvasUrl}/`);
  base.searchParams.set('enrollment_state', 'active');
  base.searchParams.append('include[]', 'term');
  base.searchParams.set('per_page', '100');
  try {
    return await canvasGetAllPages(canvasUrl, accessToken, base);
  } catch (error) {
    if (!/HTTP 403/.test(error.message)) throw error;
    const userCourses = new URL('/api/v1/users/self/courses', `${canvasUrl}/`);
    userCourses.searchParams.set('enrollment_state', 'active');
    userCourses.searchParams.append('include[]', 'term');
    userCourses.searchParams.set('per_page', '100');
    return canvasGetAllPages(canvasUrl, accessToken, userCourses);
  }
}

function canvasApiError(c, error) {
  return c.json({ error: error instanceof Error ? error.message : 'Canvas request failed.' }, 502);
}

app.get('/api/canvas/config', async (c) => {
  const user = await getAuthenticatedUser(c);
  if (!user) return c.json({ error: 'Authentication required' }, 401);
  return c.json({ tokenEnabled: true });
});

app.post('/api/projects/:id/canvas/connect-token', async (c) => {
  return c.json({ error: 'Canvas token imports are temporarily disabled. Import a saved Canvas Assignments page instead.' }, 410);
  /* Token connection is paused while this Canvas instance denies current-user API access. */
  const user = await getAuthenticatedUser(c);
  if (!user) return c.json({ error: 'Authentication required' }, 401);
  const projectId = c.req.param('id');
  const db = c.env.DB;
  if (!verifyProjectPermission(await getProjectAccessLevel(db, projectId, user), 'edit')) return c.json({ error: 'Requires edit permission on project' }, 403);
  if (typeof c.env.APP_PEPPER !== 'string' || c.env.APP_PEPPER.length < 32) return c.json({ error: 'APP_PEPPER must be configured as a secret of at least 32 characters.' }, 503);
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON payload' }, 400); }
  let canvasUrl;
  try { canvasUrl = normalizeCanvasBaseUrl(body.canvas_url, c.env); } catch (error) { return c.json({ error: error.message }, 400); }
  const tokenInput = typeof body.access_token === 'string' ? body.access_token.trim() : '';
  const token = tokenInput.replace(/^Bearer\s+/i, '');
  if (!token || token.length > 4096) return c.json({ error: 'Enter a valid Canvas access token.' }, 400);
  try {
    const checkUrl = new URL('/api/v1/users/self', `${canvasUrl}/`);
    const response = await fetch(checkUrl, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    if (!response.ok) return c.json({ error: response.status === 401
      ? 'Canvas returned 401 Unauthorized. Check that this is a current API access token for this exact Canvas site; a login/session token will not work.'
      : response.status === 403
        ? 'Canvas returned 403 Forbidden for the current-user API. Your Canvas administrator may restrict API access for personal tokens.'
        : `Canvas returned HTTP ${response.status} while checking the token.` }, 400);
    let courseCheck = await fetch(new URL('/api/v1/courses?per_page=1', `${canvasUrl}/`), { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    if (courseCheck.status === 403) {
      courseCheck = await fetch(new URL('/api/v1/users/self/courses?per_page=1', `${canvasUrl}/`), { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    }
    if (!courseCheck.ok) return c.json({ error: courseCheck.status === 403
      ? 'Canvas authenticated the token but denied both course-list endpoints. Your administrator may need to allow Canvas API access, or use the saved Assignments page import.'
      : `Canvas returned HTTP ${courseCheck.status} while checking course access.` }, 400);
    await db.prepare(`INSERT OR REPLACE INTO canvas_connections (user_id, canvas_url, access_token_encrypted, refresh_token_encrypted, expires_at, updated_at) VALUES (?, ?, ?, NULL, NULL, CURRENT_TIMESTAMP)`)
      .bind(user.id, canvasUrl, await encryptCanvasToken(token, c.env)).run();
    return c.json({ connected: true, canvas_url: canvasUrl });
  } catch (error) { return c.json({ error: error instanceof Error ? error.message : 'Could not connect to Canvas.' }, 502); }
});

app.post('/api/projects/:id/canvas/connect', async (c) => {
  return c.json({ error: 'Canvas OAuth has been retired. Use the access-token connection flow.' }, 410);
  /* Legacy OAuth implementation retained temporarily for existing deployments. */
  const user = await getAuthenticatedUser(c);
  if (!user) return c.json({ error: 'Authentication required' }, 401);
  const projectId = c.req.param('id');
  const db = c.env.DB;
  if (!verifyProjectPermission(await getProjectAccessLevel(db, projectId, user), 'edit')) {
    return c.json({ error: 'Requires edit permission on project' }, 403);
  }
  if (!c.env.CANVAS_CLIENT_ID || !c.env.CANVAS_CLIENT_SECRET) {
    return c.json({ error: 'Canvas OAuth is not configured. Set CANVAS_CLIENT_ID and CANVAS_CLIENT_SECRET after registering a Canvas developer key.' }, 503);
  }
  if (typeof c.env.APP_PEPPER !== 'string' || c.env.APP_PEPPER.length < 32) {
    return c.json({ error: 'APP_PEPPER must be configured as a secret of at least 32 characters.' }, 503);
  }
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON payload' }, 400); }
  let canvasUrl;
  try { canvasUrl = normalizeCanvasBaseUrl(body.canvas_url, c.env); } catch (error) { return c.json({ error: error.message }, 400); }

  const state = `mp_${generateSalt()}${generateSalt()}`;
  const stateHash = await canvasStateHash(state, c.env);
  const redirectUri = new URL('/api/canvas/oauth/callback', c.req.url).toString();
  await db.prepare("DELETE FROM canvas_oauth_states WHERE datetime(created_at) < datetime('now', '-15 minutes')").run();
  await db.prepare(`INSERT INTO canvas_oauth_states (state_hash, user_id, project_id, canvas_url, redirect_uri)
    VALUES (?, ?, ?, ?, ?)`)
    .bind(stateHash, user.id, projectId, canvasUrl, redirectUri).run();

  const authUrl = new URL('/login/oauth2/auth', `${canvasUrl}/`);
  authUrl.searchParams.set('client_id', c.env.CANVAS_CLIENT_ID);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('scope', 'url:GET|/api/v1/courses url:GET|/api/v1/courses/:course_id/assignment_groups');
  return c.json({ authorization_url: authUrl.toString() });
});

app.get('/api/canvas/oauth/callback', async (c) => {
  return c.text('Canvas OAuth has been retired. Return to MyPlan and connect with an access token.', 410);
  /* Legacy OAuth callback retained temporarily for existing deployments. */
  const state = c.req.query('state') || '';
  if (!state || typeof c.env.APP_PEPPER !== 'string' || c.env.APP_PEPPER.length < 32) {
    return c.text('Canvas authorization could not be verified. Return to MyPlan and try again.', 400);
  }
  const db = c.env.DB;
  await initTables(db);
  const stateHash = await canvasStateHash(state, c.env);
  const pending = await db.prepare('SELECT * FROM canvas_oauth_states WHERE state_hash = ?').bind(stateHash).first();
  await db.prepare('DELETE FROM canvas_oauth_states WHERE state_hash = ?').bind(stateHash).run();
  if (!pending || Date.now() - Date.parse(pending.created_at) > 15 * 60 * 1000) {
    return c.text('Canvas authorization expired. Return to MyPlan and try again.', 400);
  }
  if (c.req.query('error') || !c.req.query('code')) {
    const target = new URL('/', c.req.url);
    target.searchParams.set('canvas_oauth', 'denied');
    target.searchParams.set('canvas_project', pending.project_id);
    return c.redirect(target.toString(), 303);
  }

  try {
    const tokens = await canvasTokenRequest(pending.canvas_url, {
      grant_type: 'authorization_code',
      client_id: c.env.CANVAS_CLIENT_ID,
      client_secret: c.env.CANVAS_CLIENT_SECRET,
      redirect_uri: pending.redirect_uri,
      code: c.req.query('code')
    });
    const oldConnection = await db.prepare('SELECT * FROM canvas_connections WHERE user_id = ?').bind(pending.user_id).first();
    if (oldConnection) {
      try {
        const oldAccess = await decryptCanvasToken(oldConnection.access_token_encrypted, c.env);
        await fetch(`${oldConnection.canvas_url}/login/oauth2/token`, {
          method: 'DELETE', headers: { Authorization: `Bearer ${oldAccess}` }
        });
      } catch { /* Reauthorization below replaces any credentials that could not be revoked. */ }
    }
    const expiresAt = Number(tokens.expires_in) > 0
      ? new Date(Date.now() + Number(tokens.expires_in) * 1000).toISOString()
      : null;
    await db.prepare(`INSERT OR REPLACE INTO canvas_connections
      (user_id, canvas_url, access_token_encrypted, refresh_token_encrypted, expires_at, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`)
      .bind(pending.user_id, pending.canvas_url,
        await encryptCanvasToken(tokens.access_token, c.env),
        tokens.refresh_token ? await encryptCanvasToken(tokens.refresh_token, c.env) : null,
        expiresAt).run();
    const target = new URL('/', c.req.url);
    target.searchParams.set('canvas_oauth', 'connected');
    target.searchParams.set('canvas_project', pending.project_id);
    return c.redirect(target.toString(), 303);
  } catch {
    const target = new URL('/', c.req.url);
    target.searchParams.set('canvas_oauth', 'error');
    target.searchParams.set('canvas_project', pending.project_id);
    return c.redirect(target.toString(), 303);
  }
});

app.get('/api/projects/:id/canvas/status', async (c) => {
  return c.json({ error: 'Canvas token imports are temporarily disabled.' }, 410);
  /* Legacy account status endpoint is paused with token imports. */
  const user = await getAuthenticatedUser(c);
  if (!user) return c.json({ error: 'Authentication required' }, 401);
  const projectId = c.req.param('id');
  if (!verifyProjectPermission(await getProjectAccessLevel(c.env.DB, projectId, user), 'view')) return c.json({ error: 'Access denied' }, 403);
  const connection = await c.env.DB.prepare('SELECT canvas_url, expires_at FROM canvas_connections WHERE user_id = ?').bind(user.id).first();
  return c.json({ connected: Boolean(connection), canvas_url: connection?.canvas_url || '', expires_at: connection?.expires_at || null });
});

app.get('/api/projects/:id/canvas/courses', async (c) => {
  return c.json({ error: 'Canvas token imports are temporarily disabled.' }, 410);
  /* Legacy API import endpoint is paused. */
  const user = await getAuthenticatedUser(c);
  if (!user) return c.json({ error: 'Authentication required' }, 401);
  const projectId = c.req.param('id');
  if (!verifyProjectPermission(await getProjectAccessLevel(c.env.DB, projectId, user), 'view')) return c.json({ error: 'Access denied' }, 403);
  try {
    const { connection, accessToken } = await canvasGetAccessToken(c.env.DB, c.env, user.id);
    const courses = await canvasGetCourses(connection.canvas_url, accessToken);
    return c.json(courses.map(course => ({
      id: String(course.id), name: course.name || course.course_code || `Course ${course.id}`,
      course_code: course.course_code || '', term: course.term?.name || '',
      apply_assignment_group_weights: Boolean(course.apply_assignment_group_weights)
    })));
  } catch (error) { return canvasApiError(c, error); }
});

app.get('/api/projects/:id/canvas/courses/:courseId/assignment-groups', async (c) => {
  return c.json({ error: 'Canvas token imports are temporarily disabled.' }, 410);
  /* Legacy API import endpoint is paused. */
  const user = await getAuthenticatedUser(c);
  if (!user) return c.json({ error: 'Authentication required' }, 401);
  const projectId = c.req.param('id');
  if (!verifyProjectPermission(await getProjectAccessLevel(c.env.DB, projectId, user), 'edit')) {
    return c.json({ error: 'Requires edit permission on project' }, 403);
  }
  const courseId = c.req.param('courseId');
  if (!/^\d{1,20}$/.test(courseId)) return c.json({ error: 'Invalid Canvas course ID.' }, 400);
  try {
    const { connection, accessToken } = await canvasGetAccessToken(c.env.DB, c.env, user.id);
    const url = new URL(`/api/v1/courses/${courseId}/assignment_groups`, `${connection.canvas_url}/`);
    url.searchParams.append('include[]', 'assignments');
    url.searchParams.append('include[]', 'submission');
    url.searchParams.append('include[]', 'all_dates');
    url.searchParams.set('per_page', '100');
    const groups = await canvasGetAllPages(connection.canvas_url, accessToken, url);
    return c.json(groups);
  } catch (error) { return canvasApiError(c, error); }
});

app.delete('/api/projects/:id/canvas/connection', async (c) => {
  const user = await getAuthenticatedUser(c);
  if (!user) return c.json({ error: 'Authentication required' }, 401);
  const projectId = c.req.param('id');
  if (!verifyProjectPermission(await getProjectAccessLevel(c.env.DB, projectId, user), 'edit')) {
    return c.json({ error: 'Requires edit permission on project' }, 403);
  }
  // Remove the stored credential locally. Token revocation is managed in Canvas.
  await c.env.DB.prepare('DELETE FROM canvas_connections WHERE user_id = ?').bind(user.id).run();
  return c.json({ success: true });
});

// ----------------- Auth API Routes -----------------
app.get('/api/auth/me', async (c) => {
  const user = await getAuthenticatedUser(c);
  if (!user) {
    return c.json({ error: 'Unauthenticated. Login required.' }, 401);
  }
  return c.json({ user });
});

app.get('/api/notifications/preferences', async (c) => {
  const user = await getAuthenticatedUser(c);
  if (!user) return c.json({ error: 'Authentication required' }, 401);

  const row = await c.env.DB.prepare('SELECT * FROM user_email_preferences WHERE user_id = ?').bind(user.id).first();
  const { results: projectPreferences } = await c.env.DB.prepare(`
    SELECT p.id AS project_id, p.name AS project_name,
      COALESCE(dpe.include_project, 1) AS include_project,
      dpe.include_overdue, dpe.lookahead_days, dpe.include_undated_open,
      dpe.weekend_delivery, dpe.holiday_delivery
    FROM projects p
    LEFT JOIN user_project_email_preferences dpe
      ON dpe.project_id = p.id AND dpe.user_id = ?
    WHERE EXISTS (
      SELECT 1 FROM project_members pm
      WHERE pm.project_id = p.id AND pm.user_id = ? AND pm.access_level != 'none'
    ) OR (
      ? = 'admin' AND NOT EXISTS (
        SELECT 1 FROM project_members admin_pm
        WHERE admin_pm.project_id = p.id AND admin_pm.user_id = ? AND admin_pm.access_level = 'none'
      )
    )
    ORDER BY p.name COLLATE NOCASE ASC
  `).bind(user.id, user.id, user.systemRole || 'user', user.id).all();
  return c.json({
    hasSaved: Boolean(row),
    senderConfigured: isEmailSenderConfigured(c.env),
    preferences: row ? {
      email: row.email || '',
      email_enabled: Boolean(row.email_enabled),
      daily_digest_time: row.daily_digest_time || '08:00',
      timezone: row.timezone || 'UTC',
      include_overdue: Boolean(row.include_overdue),
      lookahead_days: Number.isInteger(Number(row.lookahead_days)) ? Number(row.lookahead_days) : 7,
      include_undated_open: Boolean(row.include_undated_open),
      weekend_delivery: row.weekend_delivery || 'always',
      holiday_delivery: row.holiday_delivery || 'always'
    } : {
      email: '', email_enabled: false, daily_digest_time: '08:00', timezone: 'UTC',
      include_overdue: true, lookahead_days: 7, include_undated_open: false,
      weekend_delivery: 'always', holiday_delivery: 'always'
    },
    project_preferences: (projectPreferences || []).map(project => ({
      project_id: project.project_id,
      project_name: project.project_name,
      include_project: Number(project.include_project) !== 0,
      include_overdue: project.include_overdue == null ? null : Number(project.include_overdue) === 1,
      lookahead_days: project.lookahead_days == null ? null : Number(project.lookahead_days),
      include_undated_open: project.include_undated_open == null ? null : Number(project.include_undated_open) === 1,
      weekend_delivery: project.weekend_delivery || 'inherit',
      holiday_delivery: project.holiday_delivery || 'inherit'
    }))
  });
});

app.put('/api/notifications/preferences', async (c) => {
  const user = await getAuthenticatedUser(c);
  if (!user) return c.json({ error: 'Authentication required' }, 401);

  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON payload' }, 400); }
  const email_enabled = body.email_enabled === true || body.email_enabled === 1 || body.email_enabled === 'true';
  const email = sanitizeString(body.email || '', 254).toLowerCase();
  if (email_enabled && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: 'Enter a valid email address to receive digests.' }, 400);
  }
  const daily_digest_time = typeof body.daily_digest_time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(body.daily_digest_time)
    ? body.daily_digest_time : null;
  if (!daily_digest_time) return c.json({ error: 'Choose a valid daily send time.' }, 400);
  const timezone = sanitizeString(body.timezone || '', 100);
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date()); }
  catch { return c.json({ error: 'Choose a valid time zone.' }, 400); }

  const include_overdue = body.include_overdue === true || body.include_overdue === 1 || body.include_overdue === 'true' ? 1 : 0;
  const lookahead_days = Number(body.lookahead_days);
  if (!Number.isInteger(lookahead_days) || lookahead_days < 0 || lookahead_days > 30) {
    return c.json({ error: 'Choose a look-ahead window from 0 to 30 days.' }, 400);
  }
  const include_undated_open = body.include_undated_open === true || body.include_undated_open === 1 || body.include_undated_open === 'true' ? 1 : 0;
  const validDeliveryModes = ['always', 'never', 'due_today', 'if_content'];
  const weekend_delivery = validDeliveryModes.includes(body.weekend_delivery) ? body.weekend_delivery : null;
  const holiday_delivery = validDeliveryModes.includes(body.holiday_delivery) ? body.holiday_delivery : null;
  if (!weekend_delivery || !holiday_delivery) {
    return c.json({ error: 'Choose valid weekend and holiday delivery options.' }, 400);
  }

  let projectPreferences;
  if (body.project_preferences !== undefined) {
    if (!Array.isArray(body.project_preferences) || body.project_preferences.length > 500) {
      return c.json({ error: 'Project email settings must be a list of at most 500 projects.' }, 400);
    }
    const { results: accessibleProjects } = await c.env.DB.prepare(`
      SELECT p.id FROM projects p
      WHERE EXISTS (
        SELECT 1 FROM project_members pm
        WHERE pm.project_id = p.id AND pm.user_id = ? AND pm.access_level != 'none'
      ) OR (
        ? = 'admin' AND NOT EXISTS (
          SELECT 1 FROM project_members admin_pm
          WHERE admin_pm.project_id = p.id AND admin_pm.user_id = ? AND admin_pm.access_level = 'none'
        )
      )
    `).bind(user.id, user.systemRole || 'user', user.id).all();
    const accessibleIds = new Set((accessibleProjects || []).map(project => project.id));
    const seenProjectIds = new Set();
    projectPreferences = [];
    const nullableBoolean = value => {
      if (value === null || value === undefined || value === 'inherit') return null;
      if (value === true || value === 1 || value === 'true') return 1;
      if (value === false || value === 0 || value === 'false') return 0;
      return undefined;
    };
    for (const item of body.project_preferences) {
      const projectId = typeof item?.project_id === 'string' ? item.project_id : '';
      if (!projectId || !accessibleIds.has(projectId) || seenProjectIds.has(projectId)) {
        return c.json({ error: 'Project settings contain an inaccessible or duplicate project.' }, 400);
      }
      seenProjectIds.add(projectId);
      const includeProject = item.include_project === false || item.include_project === 0 || item.include_project === 'false' ? 0 : 1;
      const includeOverdue = nullableBoolean(item.include_overdue);
      const includeUndatedOpen = nullableBoolean(item.include_undated_open);
      if (includeOverdue === undefined || includeUndatedOpen === undefined) {
        return c.json({ error: 'Choose valid per-project task inclusion options.' }, 400);
      }
      let projectLookaheadDays = null;
      if (item.lookahead_days !== null && item.lookahead_days !== undefined && item.lookahead_days !== '' && item.lookahead_days !== 'inherit') {
        projectLookaheadDays = Number(item.lookahead_days);
        if (!Number.isInteger(projectLookaheadDays) || projectLookaheadDays < 0 || projectLookaheadDays > 30) {
          return c.json({ error: 'Per-project look-ahead must be from 0 to 30 days.' }, 400);
        }
      }
      const projectWeekend = item.weekend_delivery || 'inherit';
      const projectHoliday = item.holiday_delivery || 'inherit';
      if (!['inherit', ...validDeliveryModes].includes(projectWeekend) || !['inherit', ...validDeliveryModes].includes(projectHoliday)) {
        return c.json({ error: 'Choose valid per-project weekend and holiday delivery options.' }, 400);
      }
      projectPreferences.push({
        projectId,
        includeProject,
        includeOverdue,
        lookaheadDays: projectLookaheadDays,
        includeUndatedOpen,
        weekendDelivery: projectWeekend === 'inherit' ? null : projectWeekend,
        holidayDelivery: projectHoliday === 'inherit' ? null : projectHoliday
      });
    }
  }

  const statements = [c.env.DB.prepare(`
    INSERT INTO user_email_preferences (
      user_id, email, email_enabled, daily_digest_time, timezone,
      include_overdue, lookahead_days, include_undated_open, weekend_delivery, holiday_delivery, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      email = excluded.email,
      email_enabled = excluded.email_enabled,
      daily_digest_time = excluded.daily_digest_time,
      timezone = excluded.timezone,
      include_overdue = excluded.include_overdue,
      lookahead_days = excluded.lookahead_days,
      include_undated_open = excluded.include_undated_open,
      weekend_delivery = excluded.weekend_delivery,
      holiday_delivery = excluded.holiday_delivery,
      updated_at = CURRENT_TIMESTAMP
  `).bind(user.id, email || null, email_enabled ? 1 : 0, daily_digest_time, timezone,
    include_overdue, lookahead_days, include_undated_open, weekend_delivery, holiday_delivery)];
  if (projectPreferences) {
    statements.push(c.env.DB.prepare('DELETE FROM user_project_email_preferences WHERE user_id = ?').bind(user.id));
    for (const project of projectPreferences) {
      statements.push(c.env.DB.prepare(`
        INSERT INTO user_project_email_preferences (
          user_id, project_id, include_project, include_overdue, lookahead_days,
          include_undated_open, weekend_delivery, holiday_delivery, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).bind(user.id, project.projectId, project.includeProject, project.includeOverdue,
        project.lookaheadDays, project.includeUndatedOpen, project.weekendDelivery, project.holidayDelivery));
    }
  }
  await c.env.DB.batch(statements);

  return c.json({ success: true, senderConfigured: isEmailSenderConfigured(c.env) });
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

app.post('/api/auth/change-password', async (c) => {
  const user = await getAuthenticatedUser(c);
  if (!user) return c.json({ error: 'Authentication required' }, 401);
  if (typeof c.env.APP_PEPPER !== 'string' || c.env.APP_PEPPER.length < 32) {
    return c.json({ error: 'Password service is not configured.' }, 503);
  }
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON payload' }, 400); }
  const currentPassword = typeof body?.current_password === 'string' ? body.current_password : '';
  const newPassword = typeof body?.new_password === 'string' ? body.new_password : '';
  if (newPassword.length < 12 || newPassword.length > 1024) {
    return c.json({ error: 'New password must be between 12 and 1024 characters.' }, 400);
  }
  const db = c.env.DB;
  const account = await db.prepare('SELECT password_hash, salt FROM users WHERE id = ?').bind(user.id).first();
  if (!account || !timingSafeEqual(await hashPassword(currentPassword, account.salt, c.env.APP_PEPPER), account.password_hash)) {
    return c.json({ error: 'Current password is incorrect.' }, 403);
  }
  const salt = generateSalt();
  const passwordHash = await hashPassword(newPassword, salt, c.env.APP_PEPPER);
  const sessionToken = readSessionCookie(c);
  await db.batch([
    db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?').bind(passwordHash, salt, user.id),
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').bind(user.id, sessionToken)
  ]);
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
      LEFT JOIN project_members admin_pm
        ON admin_pm.project_id = p.id AND admin_pm.user_id = ?
      WHERE admin_pm.access_level IS NULL OR admin_pm.access_level != 'none'
      ORDER BY p.created_at ASC
    `).bind(user.id);
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

app.get('/api/admin/projects', async (c) => {
  const user = await getAuthenticatedUser(c);
  if (!user) return c.json({ error: 'Authentication required' }, 401);
  if (user.systemRole !== 'admin') return c.json({ error: 'System administrator access required' }, 403);

  const { results } = await c.env.DB.prepare('SELECT id, name FROM projects ORDER BY name COLLATE NOCASE ASC').all();
  return c.json(results || []);
});

app.get('/api/permission-projects', async (c) => {
  const user = await getAuthenticatedUser(c);
  if (!user) return c.json({ error: 'Authentication required' }, 401);

  const query = user.systemRole === 'admin'
    ? c.env.DB.prepare("SELECT id, name, 'edit' AS user_access_level FROM projects ORDER BY name COLLATE NOCASE ASC")
    : c.env.DB.prepare(`
      SELECT p.id, p.name, pm.access_level AS user_access_level
      FROM projects p
      JOIN project_members pm ON pm.project_id = p.id
      WHERE pm.user_id = ? AND pm.access_level IN ('edit', 'creator')
      ORDER BY p.name COLLATE NOCASE ASC
    `).bind(user.id);
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
  const graded = body.graded === true || body.graded === 1 || body.graded === '1' || body.graded === 'true' ? 1 : 0;

  await db.batch([
    db.prepare('INSERT INTO projects (id, name, description, color, default_view, non_working_days_json, holidays_json, status_options_json, graded) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, name, description, color, default_view, JSON.stringify(nonWorkingDays), JSON.stringify(holidays), JSON.stringify(statusOptions), graded),
    db.prepare('INSERT INTO project_members (project_id, user_id, access_level) VALUES (?, ?, ?)').bind(id, user.id, 'creator')
  ]);

  return c.json({ id, name, description, color, default_view, graded, non_working_days_json: JSON.stringify(nonWorkingDays), holidays_json: JSON.stringify(holidays), status_options_json: JSON.stringify(statusOptions), user_access_level: 'creator' }, 201);
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
  const existingProject = await db.prepare('SELECT non_working_days_json, holidays_json, status_options_json, graded FROM projects WHERE id = ?').bind(id).first();
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
  const graded = body.graded === undefined
    ? Number(existingProject.graded) || 0
    : body.graded === true || body.graded === 1 || body.graded === '1' || body.graded === 'true' ? 1 : 0;

  await db.prepare(`UPDATE projects
    SET name = ?, description = ?, color = ?, default_view = ?, non_working_days_json = ?, holidays_json = ?, status_options_json = ?, graded = ?
    WHERE id = ?`).bind(
    name, description, color, default_view, JSON.stringify(nonWorkingDays), JSON.stringify(holidays), JSON.stringify(cleanedStatusOptions), graded, id
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
  const isAdmin = user.systemRole === 'admin';
  const access = await getProjectAccessLevel(db, projectId, user);
  if (!isAdmin && !verifyProjectPermission(access, 'edit')) return c.json({ error: 'Project edit access required' }, 403);
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
  })).filter(member => isAdmin || access === 'creator' || member.accessLevel !== 'none');

  return c.json(response);
});

app.post('/api/projects/:id/viewers', async (c) => {
  const user = await getAuthenticatedUser(c);
  if (!user) return c.json({ error: 'Authentication required' }, 401);

  const db = c.env.DB;
  const projectId = c.req.param('id');
  const isAdmin = user.systemRole === 'admin';
  const access = await getProjectAccessLevel(db, projectId, user);
  if (!isAdmin && !verifyProjectPermission(access, 'edit')) return c.json({ error: 'Project edit access required' }, 403);
  const project = await db.prepare('SELECT id FROM projects WHERE id = ?').bind(projectId).first();
  if (!project) return c.json({ error: 'Project not found' }, 404);

  const { username: rawUsername } = await c.req.json();
  const username = sanitizeString(rawUsername, 80);
  if (!username) return c.json({ error: 'Enter a username.' }, 400);
  const target = await db.prepare('SELECT id, username, name, system_role FROM users WHERE username = ? COLLATE NOCASE').bind(username).first();
  if (!target) return c.json({ error: 'No account exists with that username.' }, 404);
  if (!isAdmin && target.system_role === 'admin') return c.json({ error: 'System administrators retain global edit access and cannot be managed as viewers.' }, 403);

  const current = await db.prepare('SELECT access_level FROM project_members WHERE project_id = ? AND user_id = ?').bind(projectId, target.id).first();
  if (!isAdmin && current?.access_level === 'creator') {
    return c.json({ error: 'Only a system administrator can change creator access.' }, 403);
  }
  if (current?.access_level === 'edit') return c.json({ error: 'That user is already an editor. Editors cannot change editor access.' }, 403);
  if (current?.access_level === 'view') return c.json({ error: 'That user already has view access.' }, 409);

  await db.prepare(`
    INSERT OR REPLACE INTO project_members (project_id, user_id, access_level)
    VALUES (?, ?, 'view')
  `).bind(projectId, target.id).run();

  return c.json({ success: true, user: { userId: target.id, username: target.username, name: target.name, systemRole: target.system_role || 'user', accessLevel: 'view' } });
});

app.post('/api/projects/:id/members', async (c) => {
  const user = await getAuthenticatedUser(c);
  if (!user) return c.json({ error: 'Authentication required' }, 401);

  const db = c.env.DB;
  const projectId = c.req.param('id');
  const isAdmin = user.systemRole === 'admin';
  const projectAccess = await getProjectAccessLevel(db, projectId, user);
  if (!isAdmin && projectAccess !== 'creator') return c.json({ error: 'Project creator access required' }, 403);
  const project = await db.prepare('SELECT id FROM projects WHERE id = ?').bind(projectId).first();
  if (!project) return c.json({ error: 'Project not found' }, 404);

  const body = await c.req.json();
  const username = sanitizeString(body.username || '', 80);
  const accessLevel = body.access_level;
  const allowedLevels = isAdmin ? ['none', 'view', 'edit', 'creator'] : ['none', 'view', 'edit'];
  if (!username) return c.json({ error: 'Enter a username.' }, 400);
  if (!allowedLevels.includes(accessLevel)) return c.json({ error: 'Choose a valid project access level.' }, 400);

  const target = await db.prepare('SELECT id, username, name, system_role FROM users WHERE username = ? COLLATE NOCASE').bind(username).first();
  if (!target) return c.json({ error: 'No account exists with that username.' }, 404);
  if (!isAdmin && target.system_role === 'admin') {
    return c.json({ error: 'System administrators retain global access and cannot be managed by a project creator.' }, 403);
  }
  const current = await db.prepare('SELECT access_level FROM project_members WHERE project_id = ? AND user_id = ?').bind(projectId, target.id).first();
  if (!isAdmin && current?.access_level === 'creator') {
    return c.json({ error: 'Only a system administrator can change creator access.' }, 403);
  }

  await db.prepare(`
    INSERT INTO project_members (project_id, user_id, access_level) VALUES (?, ?, ?)
    ON CONFLICT(project_id, user_id) DO UPDATE SET access_level = excluded.access_level
  `).bind(projectId, target.id, accessLevel).run();
  return c.json({ success: true, projectId, user: { userId: target.id, username: target.username, name: target.name }, access_level: accessLevel });
});

app.put('/api/projects/:id/members/:userId', async (c) => {
  const user = await getAuthenticatedUser(c);
  if (!user) return c.json({ error: 'Authentication required' }, 401);

  const db = c.env.DB;
  const projectId = c.req.param('id');
  const targetUserId = c.req.param('userId');
  const isAdmin = user.systemRole === 'admin';

  const project = await db.prepare('SELECT id FROM projects WHERE id = ?').bind(projectId).first();
  if (!project) return c.json({ error: 'Project not found' }, 404);
  const target = await db.prepare('SELECT id, system_role FROM users WHERE id = ?').bind(targetUserId).first();
  if (!target) return c.json({ error: 'User not found' }, 404);

  const { access_level } = await c.req.json();
  if (!['none', 'view', 'edit', 'creator'].includes(access_level)) {
    return c.json({ error: 'Invalid access level. Must be none, view, edit, or creator.' }, 400);
  }

  if (!isAdmin) {
    const projectAccess = await getProjectAccessLevel(db, projectId, user);
    if (!verifyProjectPermission(projectAccess, 'edit')) return c.json({ error: 'Project edit access required' }, 403);
    const current = await db.prepare('SELECT access_level FROM project_members WHERE project_id = ? AND user_id = ?').bind(projectId, targetUserId).first();
    if (target.system_role === 'admin' || current?.access_level === 'creator') {
      return c.json({ error: 'Only a system administrator can change system administrator or creator access.' }, 403);
    }
    if (projectAccess === 'creator') {
      if (access_level === 'creator') return c.json({ error: 'Only a system administrator can assign creator access.' }, 403);
    } else if (current?.access_level !== 'view' || access_level !== 'none') {
      return c.json({ error: 'Editors may only remove view access from existing viewers.' }, 403);
    }
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

  const { results } = await db.prepare(`
    SELECT * FROM folders WHERE project_id = ?
    ORDER BY CASE WHEN sort_order IS NULL THEN 1 ELSE 0 END, sort_order ASC, created_at ASC
  `).bind(projectId).all();
  return c.json(results || []);
});

app.patch('/api/projects/:id/folders/order', async (c) => {
  const user = await getAuthenticatedUser(c);
  if (!user) return c.json({ error: 'Authentication required' }, 401);

  const db = c.env.DB;
  const projectId = c.req.param('id');
  const access = await getProjectAccessLevel(db, projectId, user);
  if (!verifyProjectPermission(access, 'edit')) return c.json({ error: 'Requires edit permission on project' }, 403);

  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON payload' }, 400); }
  const parentId = body?.parent_id || null;
  const folderIds = body?.folder_ids;
  if (!Array.isArray(folderIds) || folderIds.length === 0 || folderIds.some(id => typeof id !== 'string' || !id)
    || new Set(folderIds).size !== folderIds.length) {
    return c.json({ error: 'folder_ids must be a non-empty array of unique folder IDs.' }, 400);
  }

  const { results: projectFolders } = await db.prepare('SELECT id, parent_id FROM folders WHERE project_id = ?').bind(projectId).all();
  const existingIds = new Set((projectFolders || []).filter(folder => (folder.parent_id || null) === parentId).map(folder => folder.id));
  if (parentId && !(projectFolders || []).some(folder => folder.id === parentId)) {
    return c.json({ error: 'Parent folder must belong to this project.' }, 400);
  }
  if (folderIds.length !== existingIds.size || folderIds.some(id => !existingIds.has(id))) {
    return c.json({ error: 'folder_ids must include every sibling folder exactly once.' }, 400);
  }

  await db.batch(folderIds.map((id, index) => db.prepare(
    'UPDATE folders SET sort_order = ? WHERE id = ? AND project_id = ?'
  ).bind(index, id, projectId)));
  return c.json({ success: true });
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
  const projectSettings = await db.prepare('SELECT color, graded FROM projects WHERE id = ?').bind(projectId).first();
  const color = sanitizeColor(body.color, projectSettings?.color || '#38d8aa');
  const requestedWeight = Number(body.weight_percent);
  const weight_percent = Number.isFinite(requestedWeight) ? Math.max(0, requestedWeight) : 0;
  const requestedDropLowest = Number(body.drop_lowest_count);
  const drop_lowest_count = Number.isFinite(requestedDropLowest) ? Math.max(0, Math.floor(requestedDropLowest)) : 0;
  const requestedDropHighest = Number(body.drop_highest_count);
  const drop_highest_count = Number.isFinite(requestedDropHighest) ? Math.max(0, Math.floor(requestedDropHighest)) : 0;
  const target_grade = Number(body.target_grade) || 100;
  const bonus_cap_enabled = body.bonus_cap_enabled === true || body.bonus_cap_enabled === 1
    || body.bonus_cap_enabled === '1' || body.bonus_cap_enabled === 'true' ? 1 : 0;
  const grade_enabled = body.grade_enabled === undefined
    ? Number(projectSettings?.graded) || 0
    : body.grade_enabled === true || body.grade_enabled === 1 || body.grade_enabled === '1' || body.grade_enabled === 'true' ? 1 : 0;

  await db.prepare(`
    INSERT INTO folders (id, project_id, parent_id, name, description, color, weight_percent, drop_lowest_count, drop_highest_count, target_grade, bonus_cap_enabled, grade_enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(id, projectId, parent_id, name, description, color, weight_percent, drop_lowest_count, drop_highest_count, target_grade, bonus_cap_enabled, grade_enabled).run();

  return c.json({ id, project_id: projectId, parent_id, name, description, color, weight_percent, drop_lowest_count, drop_highest_count, target_grade, bonus_cap_enabled, grade_enabled }, 201);
});

app.put('/api/folders/:id', async (c) => {
  const user = await getAuthenticatedUser(c);
  if (!user) return c.json({ error: 'Authentication required' }, 401);

  const db = c.env.DB;
  const id = c.req.param('id');
  const folder = await db.prepare('SELECT project_id, parent_id, color, bonus_cap_enabled, grade_enabled FROM folders WHERE id = ?').bind(id).first();
  if (!folder) return c.json({ error: 'Folder not found' }, 404);

  const access = await getProjectAccessLevel(db, folder.project_id, user);
  if (!verifyProjectPermission(access, 'edit')) return c.json({ error: 'Requires edit permission on project' }, 403);

  const body = await c.req.json();
  const name = sanitizeString(body.name || 'Folder', 100);
  const parent_id = body.parent_id ? String(body.parent_id) : null;
  const description = sanitizeString(body.description || '', 500);
  const projectColor = await db.prepare('SELECT color FROM projects WHERE id = ?').bind(folder.project_id).first();
  const color = sanitizeColor(body.color, folder.color || projectColor?.color || '#38d8aa');
  const requestedWeight = Number(body.weight_percent);
  const weight_percent = Number.isFinite(requestedWeight) ? Math.max(0, requestedWeight) : 0;
  const requestedDropLowest = Number(body.drop_lowest_count);
  const drop_lowest_count = Number.isFinite(requestedDropLowest) ? Math.max(0, Math.floor(requestedDropLowest)) : 0;
  const requestedDropHighest = Number(body.drop_highest_count);
  const drop_highest_count = Number.isFinite(requestedDropHighest) ? Math.max(0, Math.floor(requestedDropHighest)) : 0;
  const target_grade = Number(body.target_grade) || 100;
  const bonus_cap_enabled = body.bonus_cap_enabled === undefined
    ? Number(folder.bonus_cap_enabled) || 0
    : body.bonus_cap_enabled === true || body.bonus_cap_enabled === 1
      || body.bonus_cap_enabled === '1' || body.bonus_cap_enabled === 'true' ? 1 : 0;
  const grade_enabled = body.grade_enabled === undefined
    ? Number(folder.grade_enabled) || 0
    : body.grade_enabled === true || body.grade_enabled === 1 || body.grade_enabled === '1' || body.grade_enabled === 'true' ? 1 : 0;

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
    SET name = ?, parent_id = ?, description = ?, color = ?, weight_percent = ?, drop_lowest_count = ?, drop_highest_count = ?, target_grade = ?, bonus_cap_enabled = ?, grade_enabled = ?,
        sort_order = CASE WHEN parent_id IS NOT ? THEN NULL ELSE sort_order END
    WHERE id = ?
  `).bind(name, parent_id, description, color, weight_percent, drop_lowest_count, drop_highest_count, target_grade, bonus_cap_enabled, grade_enabled, parent_id, id).run();

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

  const { results: allFolders } = await db.prepare('SELECT id, parent_id FROM folders WHERE project_id = ?').bind(folder.project_id).all();
  const childrenByParent = new Map();
  for (const row of allFolders || []) {
    const parent = row.parent_id || '';
    if (!childrenByParent.has(parent)) childrenByParent.set(parent, []);
    childrenByParent.get(parent).push(row.id);
  }
  const subtree = [];
  const pending = [id];
  while (pending.length) {
    const folderId = pending.pop();
    subtree.push(folderId);
    pending.push(...(childrenByParent.get(folderId) || []));
  }
  await db.batch(subtree.map(folderId => db.prepare('DELETE FROM folders WHERE id = ?').bind(folderId)));
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

  const dependenciesByTask = new Map();
  for (const dep of deps || []) {
    if (!dependenciesByTask.has(dep.task_id)) dependenciesByTask.set(dep.task_id, []);
    dependenciesByTask.get(dep.task_id).push(dep.depends_on_task_id);
  }
  const customValuesByTask = new Map();
  for (const value of customVals || []) {
    if (!customValuesByTask.has(value.task_id)) customValuesByTask.set(value.task_id, {});
    customValuesByTask.get(value.task_id)[value.custom_field_id] = value.value;
  }
  const taskMap = (tasks || []).map(task => {
    return {
      ...task,
      dependencies: dependenciesByTask.get(task.id) || [],
      custom_values: customValuesByTask.get(task.id) || {}
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
  const repeat = normalizeRepeatRule(body);
  if (!repeat.valid) return c.json({ error: repeat.error }, 400);
  const id = 'task-' + generateSalt().substring(0, 8);

  const title = sanitizeString(body.title || 'Untitled Task', 200);
  const description = sanitizeString(body.description || '', 2000);
  const folder_id = sanitizeString(body.folder_id || '', 50);
  const status = ['todo', 'in_progress', 'done'].includes(body.status) ? body.status : 'todo';
  const priority = ['none', 'low', 'medium', 'high', 'urgent'].includes(body.priority) ? body.priority : 'medium';
  const progress = Math.max(0, Math.min(100, Number(body.progress) || 0));
  const extra_credit = body.extra_credit === true || body.extra_credit === 1 || body.extra_credit === '1' || body.extra_credit === 'true' ? 1 : 0;
  const never_drop = body.never_drop === true || body.never_drop === 1 || body.never_drop === '1' || body.never_drop === 'true' ? 1 : 0;

  await db.prepare(`
    INSERT INTO tasks (id, project_id, folder_id, title, description, status, status_label, priority, start_date, due_date, start_time, due_time, open_at, progress, color, earned_points, max_points, grade, weight_override, extra_credit, never_drop, repeat_frequency, repeat_interval, repeat_until)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    extra_credit,
    never_drop,
    repeat.frequency,
    repeat.interval,
    repeat.until
  ).run();

  const relatedWrites = [];
  if (Array.isArray(body.dependencies)) {
    for (const depId of body.dependencies) {
      if (depId && depId !== id) {
        const depKey = 'dep-' + generateSalt().substring(0, 8);
        relatedWrites.push(db.prepare('INSERT OR IGNORE INTO task_dependencies (id, task_id, depends_on_task_id) VALUES (?, ?, ?)').bind(depKey, id, depId));
      }
    }
  }

  if (body.custom_values && typeof body.custom_values === 'object') {
    for (const [cfId, val] of Object.entries(body.custom_values)) {
      if (val !== undefined && val !== null) {
        relatedWrites.push(db.prepare('INSERT OR REPLACE INTO task_custom_values (task_id, custom_field_id, value) VALUES (?, ?, ?)').bind(id, cfId, sanitizeString(String(val), 500)));
      }
    }
  }
  if (relatedWrites.length) await db.batch(relatedWrites);

  return c.json({ id, ...body, title, description }, 201);
});

app.put('/api/tasks/:id', async (c) => {
  const user = await getAuthenticatedUser(c);
  if (!user) return c.json({ error: 'Authentication required' }, 401);

  const db = c.env.DB;
  const id = c.req.param('id');
  const task = await db.prepare('SELECT project_id, start_date, due_date, repeat_frequency, repeat_interval, repeat_until FROM tasks WHERE id = ?').bind(id).first();
  if (!task) return c.json({ error: 'Task not found' }, 404);

  const access = await getProjectAccessLevel(db, task.project_id, user);
  if (!verifyProjectPermission(access, 'edit')) return c.json({ error: 'Requires edit permission on project' }, 403);

  const body = await c.req.json();
  const repeat = normalizeRepeatRule({
    ...task,
    ...body,
    repeat_frequency: body.repeat_frequency === undefined ? task.repeat_frequency : body.repeat_frequency,
    repeat_interval: body.repeat_interval === undefined ? task.repeat_interval : body.repeat_interval,
    repeat_until: body.repeat_until === undefined ? task.repeat_until : body.repeat_until
  });
  if (!repeat.valid) return c.json({ error: repeat.error }, 400);
  const title = sanitizeString(body.title || 'Untitled Task', 200);
  const description = sanitizeString(body.description || '', 2000);
  const folder_id = sanitizeString(body.folder_id || '', 50);
  const status = ['todo', 'in_progress', 'done'].includes(body.status) ? body.status : 'todo';
  const priority = ['none', 'low', 'medium', 'high', 'urgent'].includes(body.priority) ? body.priority : 'medium';
  const progress = Math.max(0, Math.min(100, Number(body.progress) || 0));
  const extra_credit = body.extra_credit === true || body.extra_credit === 1 || body.extra_credit === '1' || body.extra_credit === 'true' ? 1 : 0;
  const never_drop = body.never_drop === true || body.never_drop === 1 || body.never_drop === '1' || body.never_drop === 'true' ? 1 : 0;

  await db.prepare(`
    UPDATE tasks
    SET title = ?, description = ?, folder_id = ?, status = ?, status_label = ?, priority = ?, start_date = ?, due_date = ?, start_time = ?, due_time = ?, open_at = ?, progress = ?, color = ?,
        earned_points = ?, max_points = ?, grade = ?, weight_override = ?, extra_credit = ?, never_drop = ?,
        repeat_frequency = ?, repeat_interval = ?, repeat_until = ?, updated_at = CURRENT_TIMESTAMP
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
    never_drop,
    repeat.frequency,
    repeat.interval,
    repeat.until,
    id
  ).run();

  const relatedWrites = [];
  if (Array.isArray(body.dependencies)) {
    relatedWrites.push(db.prepare('DELETE FROM task_dependencies WHERE task_id = ?').bind(id));
    for (const depId of body.dependencies) {
      if (depId && depId !== id) {
        const depKey = 'dep-' + generateSalt().substring(0, 8);
        relatedWrites.push(db.prepare('INSERT OR IGNORE INTO task_dependencies (id, task_id, depends_on_task_id) VALUES (?, ?, ?)').bind(depKey, id, depId));
      }
    }
  }

  if (body.custom_values && typeof body.custom_values === 'object') {
    for (const [cfId, val] of Object.entries(body.custom_values)) {
      if (val === null || val === '') {
        relatedWrites.push(db.prepare('DELETE FROM task_custom_values WHERE task_id = ? AND custom_field_id = ?').bind(id, cfId));
      } else {
        relatedWrites.push(db.prepare('INSERT OR REPLACE INTO task_custom_values (task_id, custom_field_id, value) VALUES (?, ?, ?)').bind(id, cfId, sanitizeString(String(val), 500)));
      }
    }
  }
  if (relatedWrites.length) await db.batch(relatedWrites);

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

export default {
  fetch: (request, env, executionContext) => app.fetch(request, env, executionContext),
  async scheduled(controller, env) {
    const scheduledAt = Number(controller?.scheduledTime) || Date.now();
    const stats = await runDailyDigestSchedule(env, new Date(scheduledAt));
    console.log('Daily digest schedule completed:', JSON.stringify(stats));
  }
};
