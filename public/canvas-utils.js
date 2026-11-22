import { parseTransferDateValue, parseTransferTimeValue } from './transfer-utils.js';

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function assignmentSubmission(assignment) {
  return assignment.submission && typeof assignment.submission === 'object'
    ? assignment.submission
    : {};
}

function canvasLocalDateTime(value) {
  if (!value) return { date: null, time: null, local: null };
  const date = parseTransferDateValue(value) || null;
  const time = parseTransferTimeValue(value) || null;
  return { date, time, local: date && time ? `${date}T${time}` : null };
}

function groupIsExtraCredit(group) {
  return /\b(extra\s*credit|bonus)\b/i.test(String(group.name || ''));
}

export function canvasCourseToBackup(course, assignmentGroups, instanceUrl = '') {
  const groups = [...(assignmentGroups || [])].sort((a, b) => Number(a.position || 0) - Number(b.position || 0));
  const weightedGroups = Boolean(course?.apply_assignment_group_weights);
  const groupPoints = new Map(groups.map(group => [String(group.id),
    (group.assignments || []).reduce((sum, assignment) => {
      const submission = assignmentSubmission(assignment);
      const points = finiteNumber(assignment.points_possible);
      if (assignment.omit_from_final_grade || submission.excused || points === null || points <= 0) return sum;
      return sum + points;
    }, 0)
  ]));
  const totalPoints = [...groupPoints.values()].reduce((sum, value) => sum + value, 0);
  const folders = [{
    id: `canvas-course-${course.id}`,
    name: String(course.name || course.course_code || `Canvas course ${course.id}`),
    parent_id: null,
    weight_percent: 0,
    drop_lowest_count: 0,
    bonus_cap_enabled: false
  }];
  const tasks = [];

  for (const group of groups) {
    const groupAssignments = Array.isArray(group.assignments) ? group.assignments : [];
    const id = String(group.id);
    const neverDropIds = new Set((Array.isArray(group.rules?.never_drop) ? group.rules.never_drop : []).map(String));
    const extraGroup = groupIsExtraCredit(group);
    const pointsWeight = totalPoints > 0 ? (groupPoints.get(id) || 0) * 100 / totalPoints : 0;
    const rawGroupWeight = finiteNumber(group.group_weight);
    const groupWeight = weightedGroups ? Math.max(0, rawGroupWeight ?? 0) : pointsWeight;
    folders.push({
      id: `canvas-group-${id}`,
      name: String(group.name || `Assignment Group ${id}`),
      parent_id: `canvas-course-${course.id}`,
      weight_percent: groupWeight,
      drop_lowest_count: Math.max(0, Math.floor(Number(group.rules?.drop_lowest) || 0)),
      drop_highest_count: Math.max(0, Math.floor(Number(group.rules?.drop_highest) || 0)),
      bonus_cap_enabled: extraGroup && groupAssignments.length > 0
    });

    for (const assignment of groupAssignments) {
      if (!assignment || assignment.id === undefined || assignment.id === null || !assignment.name) continue;
      const submission = assignmentSubmission(assignment);
      const pointsPossible = finiteNumber(assignment.points_possible);
      const score = finiteNumber(submission.score);
      const isExcused = Boolean(submission.excused);
      const excluded = Boolean(assignment.omit_from_final_grade) || isExcused;
      const zeroPointExtraCredit = pointsPossible === 0 && score !== null && score > 0;
      const extraCredit = extraGroup || zeroPointExtraCredit;
      const graded = score !== null && !isExcused;
      const due = canvasLocalDateTime(assignment.due_at);
      const unlock = canvasLocalDateTime(assignment.unlock_at);
      const weightOverride = excluded ? 0 : extraCredit && pointsPossible === 0 ? Math.max(score ?? 0, 1) : pointsPossible;
      tasks.push({
        id: `canvas-assignment-${course.id}-${assignment.id}`,
        title: String(assignment.name).trim().slice(0, 200),
        description: String(assignment.description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000),
        folder_id: `canvas-group-${id}`,
        status: isExcused || graded ? 'done' : submission.workflow_state === 'submitted' ? 'in_progress' : 'todo',
        status_label: isExcused ? 'Excused' : '',
        priority: 'medium',
        start_date: unlock.date,
        start_time: unlock.time,
        open_at: unlock.local,
        due_date: due.date,
        due_time: due.time,
        progress: isExcused || graded ? 100 : submission.workflow_state === 'submitted' ? 75 : 0,
        earned_points: graded ? score : null,
        max_points: pointsPossible,
        grade: zeroPointExtraCredit ? 100 : null,
        weight_override: weightOverride,
        extra_credit: extraCredit,
        never_drop: neverDropIds.has(String(assignment.id)),
        custom_values: {},
        dependencies: []
      });
    }
  }

  return {
    format: 'myplan-task-backup',
    version: 1,
    source: {
      system: 'canvas',
      course_id: String(course.id),
      course_name: String(course.name || course.course_code || `Canvas course ${course.id}`),
      instance_url: instanceUrl
    },
    folders,
    custom_fields: [],
    tasks
  };
}

export function canvasCourseLabel(course) {
  const name = String(course.name || course.course_code || `Course ${course.id}`);
  const code = String(course.course_code || '').trim();
  return code && !name.includes(code) ? `${code} — ${name}` : name;
}

export function detectCanvasAssignmentsHtml(markup) {
  const text = String(markup || '');
  return /\/courses\/\d+\/assignments\/\d+/i.test(text)
    && /<table\b[\s\S]*?<\/table>/i.test(text)
    && /<(?:th|td)\b[^>]*>[\s\S]*?(?:assignment|name|title)[\s\S]*?<\/(?:th|td)>/i.test(text);
}

function htmlText(markup) {
  return String(markup || '').replace(/<br\s*\/?\s*>/gi, ' ').replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/\s+/g, ' ').trim();
}

function canvasDate(value) {
  const text = htmlText(value);
  if (!text || /no due date|none/i.test(text)) return null;
  const match = text.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})(?:\s+at\s+(\d{1,2}):(\d{2})\s*(am|pm))?/i);
  if (match) {
    const month = new Date(`${match[1]} 1, 2000`).getMonth() + 1;
    let hour = Number(match[4] || 0);
    if (match[6]) hour = hour % 12 + (/pm/i.test(match[6]) ? 12 : 0);
    return `${match[3]}-${String(month).padStart(2, '0')}-${String(Number(match[2])).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${match[5] || '00'}:00`;
  }
  const date = new Date(text.replace(/\s+at\s+/i, ' '));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function canvasScore(value) {
  const match = htmlText(value).match(/(-?\d+(?:\.\d+)?)\s*(?:\/|of)\s*(-?\d+(?:\.\d+)?)/i);
  return match ? { score: Number(match[1]), points: Number(match[2]) } : null;
}

// Reads the static assignments table saved from Canvas. It never evaluates page scripts or makes requests.
export function parseCanvasAssignmentsHtml(markup, options = {}) {
  const source = String(markup || '');
  const tables = [...source.matchAll(/<table\b([^>]*)>([\s\S]*?)<\/table>/gi)];
  let parsed = null;
  for (const [, tableAttrs, tableHtml] of tables) {
    const rows = [...tableHtml.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi)];
    if (!rows.length) continue;
    const cellRows = rows.map(([, attrs, row]) => ({ attrs, cells: [...row.matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi)].map(([, cellAttrs, body]) => ({ attrs: cellAttrs, body, text: htmlText(body) })) }));
    const headers = cellRows[0].cells.map(cell => cell.text.toLowerCase());
    const nameIndex = headers.findIndex(value => /assignment|name|title/.test(value));
    if (nameIndex < 0) continue;
    const column = pattern => headers.findIndex(value => pattern.test(value));
    const dueIndex = column(/due/), pointsIndex = column(/points possible|points/), groupIndex = column(/group|category/), scoreIndex = column(/score|grade/);
    const assignments = [];
    for (const row of cellRows.slice(1)) {
      const cell = row.cells[nameIndex];
      if (!cell) continue;
      const link = cell.body.match(/href=["'][^"']*\/courses\/(\d+)\/assignments\/(\d+)/i);
      const id = row.attrs.match(/data-assignment-id=["'](\d+)/i)?.[1] || link?.[2];
      const courseId = row.attrs.match(/data-course-id=["'](\d+)/i)?.[1] || link?.[1];
      const name = cell.text.replace(/^(?:\s*\d+\s*)/, '').trim();
      if (!id || !name || /^(assignment|name|title)$/i.test(name)) continue;
      const pointsText = row.cells[pointsIndex]?.text || '';
      const points = Number((pointsText.match(/-?\d+(?:\.\d+)?/) || [])[0]);
      const score = scoreIndex >= 0 ? canvasScore(row.cells[scoreIndex]?.text) : null;
      assignments.push({ id, courseId, name, group: row.cells[groupIndex]?.text || 'Assignments', due: canvasDate(row.cells[dueIndex]?.text), points: Number.isFinite(points) ? points : null, score });
    }
    if (assignments.length) { parsed = { assignments, courseId: assignments.find(a => a.courseId)?.courseId || '', title: '' }; break; }
  }
  if (!parsed) throw new Error('Could not find a Canvas assignments table. Save the course Assignments page as HTML and try that file.');
  const titleMatch = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = htmlText(titleMatch?.[1]).replace(/\s*[-|:]\s*(?:Assignments|Canvas).*$/i, '').trim();
  const courseId = options.courseId || parsed.courseId || `saved-${Date.now()}`;
  const courseName = options.courseName || title || 'Canvas course';
  const groups = new Map();
  for (const item of parsed.assignments) {
    const groupName = item.group || 'Assignments';
    if (!groups.has(groupName)) groups.set(groupName, []);
    groups.get(groupName).push({ id: item.id, name: item.name, points_possible: item.points, due_at: item.due, submission: item.score ? { score: item.score.score, workflow_state: 'graded' } : {} });
  }
  const assignmentGroups = [...groups].map(([name, assignments], index) => ({ id: `saved-${index + 1}`, name, position: index + 1, assignments }));
  const backup = canvasCourseToBackup({ id: courseId, name: courseName, apply_assignment_group_weights: false }, assignmentGroups, options.instanceUrl || '');
  return { courseId: String(courseId), courseName, backup, gradedCount: backup.tasks.filter(task => task.earned_points !== null).length };
}
