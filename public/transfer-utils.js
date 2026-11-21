const CSV_PROFILES = {
  generic: [
    ['Task ID', task => task.id], ['Task Name', task => task.title], ['Description', task => task.description],
    ['Status', task => task.status], ['Status Group', task => task.status_group], ['Priority', task => task.priority], ['Folder Path', task => task.folder_path],
    ['Start Date', task => task.start_date], ['Start Time', task => task.start_time], ['Due Date', task => task.due_date],
    ['Due Time', task => task.due_time], ['Task Opens At', task => task.open_at], ['Progress', task => task.progress],
    ['Earned Points', task => task.earned_points], ['Max Points', task => task.max_points], ['Grade Override', task => task.grade],
    ['Weight Override', task => task.weight_override], ['Extra Credit', task => task.extra_credit ? 'TRUE' : 'FALSE'],
    ['Dependencies', task => task.dependencies]
  ],
  planner: [
    ['Task ID', task => task.id], ['Task title', task => task.title], ['Description', task => task.description],
    ['Bucket Name', task => task.bucket_name], ['Progress', task => task.planner_status], ['Priority', task => task.planner_priority],
    ['Start Date', task => task.start_date], ['Due Date', task => task.due_date], ['Labels', task => task.labels],
    ['Folder Path', task => task.folder_path], ['Start Time', task => task.start_time], ['Due Time', task => task.due_time],
    ['Task Opens At', task => task.open_at], ['MyPlan Task ID', task => task.id], ['MyPlan Dependencies', task => task.dependencies]
  ],
  monday: [
    ['Item', task => task.title], ['Description', task => task.description], ['Status', task => task.monday_status],
    ['Priority', task => task.monday_priority], ['Group', task => task.group_name], ['Folder Path', task => task.folder_path],
    ['Start Date', task => task.start_date], ['Due Date', task => task.due_date], ['Progress', task => task.progress],
    ['Start Time', task => task.start_time], ['Due Time', task => task.due_time], ['Task Opens At', task => task.open_at],
    ['MyPlan Task ID', task => task.id], ['MyPlan Dependencies', task => task.dependencies]
  ],
  clickup: [
    ['Task Name', task => task.title], ['Description', task => task.description], ['Status', task => task.clickup_status],
    ['Priority', task => task.clickup_priority], ['List Name', task => task.list_name], ['Folder Path', task => task.folder_path],
    ['Start Date', task => task.start_date], ['Due Date', task => task.due_date], ['Progress', task => task.progress],
    ['Tags', task => task.tags], ['Start Time', task => task.start_time], ['Due Time', task => task.due_time],
    ['Task Opens At', task => task.open_at], ['MyPlan Task ID', task => task.id], ['MyPlan Dependencies', task => task.dependencies]
  ]
};

const ALIASES = {
  id: ['taskid', 'id', 'customtaskid', 'taskcustomid', 'myplantaskid'],
  title: ['taskname', 'tasktitle', 'title', 'name', 'item', 'task'],
  description: ['description', 'taskcontent', 'notes', 'details'],
  status: ['status', 'taskstatus'],
  status_group: ['statusgroup', 'taskstatusgroup'],
  priority: ['priority'],
  folder_path: ['folderpath', 'foldernamepath', 'folder', 'bucketname', 'group', 'groupname', 'listname', 'lists', 'list'],
  start_date: ['startdate', 'start'],
  start_date_text: ['startdatetext'],
  start_time: ['starttime', 'remindertime'],
  due_date: ['duedate', 'deadline', 'date'],
  due_date_text: ['duedatetext'],
  due_time: ['duetime', 'duedatetime'],
  open_at: ['taskopensat', 'opensat', 'openat'],
  progress: ['progress', 'progresspercent', 'completion', 'percentcomplete'],
  earned_points: ['earnedpoints', 'pointsreceived'],
  max_points: ['maxpoints', 'pointstotal'],
  grade: ['gradeoverride', 'grade', 'gradepercent'],
  weight_override: ['weightoverride', 'gradeweight'],
  extra_credit: ['extracredit', 'myplanextracredit', 'bonuswork'],
  dependencies: ['dependencies', 'dependson', 'predecessors', 'myplandependencies']
};

function localDateParts(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return null;
  return {
    date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
    time: `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  };
}

function parseClickUpNormalDate(value) {
  const match = String(value ?? '').trim().match(/^(?:[A-Za-z]+,\s*)?([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(\d{4})(?:[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?(?:\s*(Z|[+-]\d{2}:?\d{2}))?)?$/i);
  if (!match) return null;
  const month = new Date(`${match[1]} 1, 2000`).getMonth();
  if (!Number.isFinite(month)) return null;
  let hour = Number(match[4] || 0);
  if (match[7]) { hour %= 12; if (match[7].toLowerCase() === 'pm') hour += 12; }
  const minute = Number(match[5] || 0);
  const second = Number(match[6] || 0);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const year = Number(match[3]);
  const day = Number(match[2]);
  const calendarDate = new Date(year, month, day);
  if (calendarDate.getFullYear() !== year || calendarDate.getMonth() !== month || calendarDate.getDate() !== day) return null;
  const offset = match[8];
  if (offset) {
    const normalizedOffset = offset === 'Z' ? 'Z' : offset.includes(':') ? offset : `${offset.slice(0, 3)}:${offset.slice(3)}`;
    const date = new Date(`${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}${normalizedOffset}`);
    return localDateParts(date);
  }
  return localDateParts(new Date(year, month, day, hour, minute, second));
}

export function parseTransferDateValue(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})(?:\s|$)/);
  if (match) {
    const year = match[3].length === 2 ? `20${match[3]}` : match[3];
    return `${year}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`;
  }
  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 20000 && numeric < 80000) {
    return new Date(Date.UTC(1899, 11, 30 + Math.floor(numeric))).toISOString().slice(0, 10);
  }
  if (/^\d{10,13}$/.test(text)) {
    const date = localDateParts(new Date(numeric < 100000000000 ? numeric * 1000 : numeric));
    return date?.date || '';
  }
  if (/^\d{4}-\d\d-\d\d[T ]/.test(text)) {
    const date = localDateParts(new Date(text));
    if (date) return date.date;
  }
  const clickUpDate = parseClickUpNormalDate(text);
  if (clickUpDate) return clickUpDate.date;
  const parsed = localDateParts(new Date(text));
  return parsed?.date || '';
}

export function parseTransferTimeValue(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (/^\d{10,13}$/.test(text)) {
    const numeric = Number(text);
    const date = localDateParts(new Date(numeric < 100000000000 ? numeric * 1000 : numeric));
    return date?.time || '';
  }
  if (/^\d{4}-\d\d-\d\d[T ]/.test(text)) {
    const date = localDateParts(new Date(text));
    if (date) return date.time;
  }
  const clickUpDate = parseClickUpNormalDate(text);
  if (clickUpDate) return clickUpDate.time;
  const match = text.match(/(?:^|[T\s])(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?(?:Z|\s|$)/i);
  if (!match) return '';
  let hour = Number(match[1]);
  if (match[3]) { hour %= 12; if (match[3].toUpperCase() === 'PM') hour += 12; }
  if (hour > 23 || Number(match[2]) > 59) return '';
  return `${String(hour).padStart(2, '0')}:${match[2]}`;
}

export function normalizeHeader(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function stripOuterBrackets(value) {
  const text = String(value ?? '').trim();
  const match = text.match(/^\[([\s\S]*)\]$/);
  return match ? match[1].trim() : text;
}

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { cell += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(cell); cell = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i += 1;
      row.push(cell); cell = '';
      if (row.some(value => value !== '')) rows.push(row);
      row = [];
    } else cell += char;
  }
  row.push(cell);
  if (row.some(value => value !== '')) rows.push(row);
  if (rows.length < 2) return { headers: rows[0] || [], records: [] };
  const headers = rows[0].map(value => value.trim());
  const records = rows.slice(1).map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
  return { headers, records };
}

export function csvCell(value) {
  let text = value == null ? '' : String(value);
  const isNumericCell = typeof value === 'number' || /^-?\d+(?:\.\d+)?$/.test(text.trim());
  if (!isNumericCell && /^[\s]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function serializeCsv(headers, records) {
  return [headers, ...records.map(record => headers.map(header => record[header] ?? ''))]
    .map(row => row.map(csvCell).join(',')).join('\r\n');
}

export function detectCsvProfile(headers) {
  const set = new Set(headers.map(normalizeHeader));
  if (set.has('bucketname') || (set.has('taskname') && set.has('taskid') && set.has('labels'))) return 'planner';
  if (set.has('listname') || set.has('lists') || (set.has('taskname') && set.has('tags')) || set.has('timeestimatehours') || set.has('timeestimaterolleduphours')) return 'clickup';
  if (set.has('item') || set.has('groupname')) return 'monday';
  return 'generic';
}

export function normalizeImportRow(record, headers) {
  const normalized = new Map(headers.map(header => [normalizeHeader(header), String(record[header] ?? '').trim()]));
  const result = {};
  for (const [key, aliases] of Object.entries(ALIASES)) {
    for (const alias of aliases) {
      if (normalized.has(alias) && normalized.get(alias) !== '') { result[key] = normalized.get(alias); break; }
    }
  }
  if (result.folder_path) result.folder_path = result.folder_path.replace(/^\[([\s\S]*)\]$/, '$1').trim();
  if (result.progress && !/^\d+(?:\.\d+)?\s*%?$/.test(result.progress)) {
    result.status ||= result.progress;
    delete result.progress;
  }
  result.title ||= '';
  result.custom = {};
  const known = new Set(Object.values(ALIASES).flat());
  for (const header of headers) {
    const key = normalizeHeader(header);
    if (!known.has(key) && record[header] !== '') result.custom[header.replace(/^custom\s*:\s*/i, '').trim()] = stripOuterBrackets(record[header]);
  }
  return result;
}

export function getCsvProfile(name) {
  return CSV_PROFILES[name] || CSV_PROFILES.generic;
}
