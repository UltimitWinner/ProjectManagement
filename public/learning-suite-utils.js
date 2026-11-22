// Parses the static assignment data embedded in a saved Learning Suite page.
// This intentionally does not evaluate page scripts or make network requests.
class LiteralReader {
  constructor(source) { this.source = source; this.pos = 0; }

  fail(message) {
    return new Error(`Unsupported Learning Suite data near character ${this.pos}: ${message}`);
  }

  skipSpace() {
    while (this.pos < this.source.length) {
      if (/\s/.test(this.source[this.pos])) this.pos += 1;
      else if (this.source.startsWith('//', this.pos)) {
        const end = this.source.indexOf('\n', this.pos + 2);
        this.pos = end < 0 ? this.source.length : end + 1;
      } else if (this.source.startsWith('/*', this.pos)) {
        const end = this.source.indexOf('*/', this.pos + 2);
        if (end < 0) throw this.fail('unterminated comment');
        this.pos = end + 2;
      } else break;
    }
  }

  readString() {
    const quote = this.source[this.pos++];
    let value = '';
    while (this.pos < this.source.length) {
      const char = this.source[this.pos++];
      if (char === quote) return value;
      if (char === '\n' || char === '\r') throw this.fail('newline inside string');
      if (char !== '\\') { value += char; continue; }
      if (this.pos >= this.source.length) throw this.fail('unterminated escape');
      const escape = this.source[this.pos++];
      const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
      if (Object.hasOwn(simple, escape)) value += simple[escape];
      else if ('\\/\'"'.includes(escape)) value += escape;
      else if (escape === 'u' || escape === 'U' || escape === 'x') {
        const digits = escape.toLowerCase() === 'x' ? 2 : 4;
        const code = this.source.slice(this.pos, this.pos + digits);
        if (!new RegExp(`^[\\da-fA-F]{${digits}}$`).test(code)) throw this.fail('invalid character escape');
        value += String.fromCodePoint(parseInt(code, 16));
        this.pos += digits;
      } else if (escape === '\n') {
        // JavaScript line continuation.
      } else if (escape === '\r') {
        if (this.source[this.pos] === '\n') this.pos += 1;
      } else value += escape;
    }
    throw this.fail('unterminated string');
  }

  readIdentifier() {
    const match = this.source.slice(this.pos).match(/^[A-Za-z_$][\w$]*/);
    if (!match) throw this.fail('expected property name');
    this.pos += match[0].length;
    return match[0];
  }

  readValue() {
    this.skipSpace();
    const char = this.source[this.pos];
    if (char === '{') return this.readObject();
    if (char === '[') return this.readArray();
    if (char === '"' || char === "'") return this.readString();
    const number = this.source.slice(this.pos).match(/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/);
    if (number) {
      this.pos += number[0].length;
      const parsed = Number(number[0]);
      return Number.isFinite(parsed) ? parsed : null;
    }
    const word = this.readIdentifier();
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (['null', 'undefined', 'NaN', 'Infinity'].includes(word)) return null;
    throw this.fail('executable or unsupported value');
  }

  readObject() {
    this.pos += 1;
    const result = {};
    this.skipSpace();
    if (this.source[this.pos] === '}') { this.pos += 1; return result; }
    while (this.pos < this.source.length) {
      this.skipSpace();
      const key = this.source[this.pos] === '"' || this.source[this.pos] === "'" ? this.readString() : this.readIdentifier();
      this.skipSpace();
      if (this.source[this.pos++] !== ':') throw this.fail('expected colon after property name');
      result[key] = this.readValue();
      this.skipSpace();
      if (this.source[this.pos] === '}') { this.pos += 1; return result; }
      if (this.source[this.pos++] !== ',') throw this.fail('expected comma or closing brace');
      this.skipSpace();
      if (this.source[this.pos] === '}') { this.pos += 1; return result; }
    }
    throw this.fail('unterminated object');
  }

  readArray() {
    this.pos += 1;
    const result = [];
    this.skipSpace();
    if (this.source[this.pos] === ']') { this.pos += 1; return result; }
    while (this.pos < this.source.length) {
      result.push(this.readValue());
      this.skipSpace();
      if (this.source[this.pos] === ']') { this.pos += 1; return result; }
      if (this.source[this.pos++] !== ',') throw this.fail('expected comma or closing bracket');
      this.skipSpace();
      if (this.source[this.pos] === ']') { this.pos += 1; return result; }
    }
    throw this.fail('unterminated array');
  }
}

function localDateAndTime(value) {
  const match = String(value || '').trim().match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(?::\d{2})?)?/);
  if (!match || Number.isNaN(Date.parse(`${match[1]}T00:00:00`))) return { date: null, time: null };
  return { date: match[1], time: match[2] || null };
}

function learningSuiteBoolean(value) {
  return value === true || value === 1 || /^(?:1|true|yes|y)$/i.test(String(value ?? '').trim());
}

function descriptionText(value) {
  const doc = new DOMParser().parseFromString(String(value || ''), 'text/html');
  doc.querySelectorAll('script,style').forEach(element => element.remove());
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
}

function decodeHtmlText(value) {
  const escapedTags = String(value ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const doc = new DOMParser().parseFromString(`<textarea>${escapedTags}</textarea>`, 'text/html');
  return doc.querySelector('textarea')?.value ?? String(value ?? '');
}

export function normalizeLearningSuiteCategoryWeights(categoryFolders) {
  const normalized = categoryFolders.map(folder => ({ ...folder }));
  const regularTotal = normalized.reduce((total, folder) => {
    if (folder.bonus_cap_enabled) return total;
    const weight = Number(folder.weight_percent);
    return total + (Number.isFinite(weight) && weight > 0 ? weight : 0);
  }, 0);
  if (regularTotal > 0 && Math.abs(regularTotal - 100) > 1e-9) {
    normalized.forEach(folder => {
      if (folder.bonus_cap_enabled) return;
      const weight = Number(folder.weight_percent);
      folder.weight_percent = Number.isFinite(weight) && weight > 0
        ? weight * 100 / regularTotal
        : 0;
    });
  }
  return normalized;
}

export function normalizeTaskMatchTitle(value) {
  return decodeHtmlText(value)
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201b\u2032]/g, "'")
    .replace(/["\u201c\u201d\u201f\u2033\u00ab\u00bb]/g, '')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase();
}

function detectCourseName(markup) {
  const doc = new DOMParser().parseFromString(markup, 'text/html');
  const meta = doc.querySelector('meta[name="course-name"], meta[name="course_title"], meta[property="og:title"]');
  const metaName = meta?.getAttribute('content')?.trim();
  if (metaName && !/^(byu learning suite|learning suite)$/i.test(metaName)) return metaName;
  const namedElement = doc.querySelector('[data-course-name], [data-course-title], .course-name, .course-title, #courseName, #courseTitle');
  const elementName = namedElement?.getAttribute('data-course-name') || namedElement?.getAttribute('data-course-title') || namedElement?.textContent;
  const clean = String(elementName || '').replace(/\s+/g, ' ').trim();
  return clean && !/^(assignments|grades|byu learning suite|learning suite)$/i.test(clean) ? clean : '';
}

export function parseLearningSuiteHtml(markup, requestedCourseName = '') {
  const courseId = markup.match(/\bglobal_courseID\s*=\s*['"]([^'"]+)['"]/)?.[1] || '';
  const dataMatch = markup.match(/\bconst\s+studentAssignmentsData\s*=\s*/);
  if (!dataMatch) throw new Error('Could not find Learning Suite assignment data. Save the course Grades → Assignments page as HTML.');
  const payload = new LiteralReader(markup.slice(dataMatch.index + dataMatch[0].length)).readValue();
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.assignments) || !Array.isArray(payload.categories)) {
    throw new Error('The saved page does not contain the expected assignments and categories.');
  }
  const categories = payload.categories.filter(category => category?.id && !category.deleted);
  const assignments = payload.assignments.filter(assignment => assignment?.id && assignment.name && !assignment.deleted);
  const includedAssignmentCounts = new Map();
  const includedAssignmentsByCategory = new Map();
  assignments.filter(assignment => assignment.includeScoreInFinalGrade !== false).forEach(assignment => {
    const categoryId = String(assignment.categoryID || '');
    includedAssignmentCounts.set(categoryId, (includedAssignmentCounts.get(categoryId) || 0) + 1);
    const categoryAssignments = includedAssignmentsByCategory.get(categoryId) || [];
    categoryAssignments.push(assignment);
    includedAssignmentsByCategory.set(categoryId, categoryAssignments);
  });
  const scores = (payload.scores || []).filter(score => score && !score.deleted);
  const students = [...new Set(scores.map(score => String(score.studentID || '')).filter(Boolean))];
  if (students.length > 1) throw new Error('This page contains more than one student’s scores. Save the student Assignments page, not an instructor gradebook export.');
  const studentId = students[0] || '';
  const scoreByAssignment = new Map();
  scores.filter(score => !studentId || String(score.studentID || '') === studentId).forEach(score => {
    const id = String(score.assignmentID || '');
    const current = scoreByAssignment.get(id);
    if (!current || String(score.modifyTime || '') >= String(current.modifyTime || '')) scoreByAssignment.set(id, score);
  });

  const courseName = String(requestedCourseName || detectCourseName(markup)).trim();
  if (!courseName) throw new Error('This saved page does not show the course name. Enter a course name in the import form and try again.');
  const rootId = `ls-course-${courseId || 'unknown'}`;
  const folders = [{ id: rootId, name: courseName, parent_id: null, weight_percent: 0, drop_lowest_count: 0, bonus_cap_enabled: false }];
  const categoryMap = new Map();
  const categoryFolders = categories.map(category => {
    const id = String(category.id);
    const folderId = `ls-category-${id}`;
    categoryMap.set(id, category);
    const bonusCap = (includedAssignmentsByCategory.get(id) || []).length > 0
      && includedAssignmentsByCategory.get(id).every(assignment => learningSuiteBoolean(assignment.extraCredit));
    return {
      id: folderId,
      name: String(category.title || 'Uncategorized'),
      parent_id: rootId,
      weight_percent: category.weight ?? 0,
      drop_lowest_count: category.lowScoresToDrop || 0,
      bonus_cap_enabled: bonusCap
    };
  });
  folders.push(...normalizeLearningSuiteCategoryWeights(categoryFolders));
  const uncategorizedId = 'ls-category-uncategorized';
  const tasks = assignments.map(assignment => {
    const assignmentId = String(assignment.id);
    const categoryId = String(assignment.categoryID || '');
    const category = categoryMap.get(categoryId);
    let folderId = `ls-category-${categoryId}`;
    if (!category) {
      folderId = uncategorizedId;
      if (!folders.some(folder => folder.id === uncategorizedId)) {
        folders.push({ id: uncategorizedId, name: 'Uncategorized', parent_id: rootId, weight_percent: 0, drop_lowest_count: 0, bonus_cap_enabled: false });
      }
    }
    const score = scoreByAssignment.get(String(assignment.gbAssignmentID || '')) || scoreByAssignment.get(assignmentId);
    const earned = score && !score.excuse && score.score !== null && score.score !== undefined ? score.score : null;
    const graded = earned !== null;
    const start = localDateAndTime(assignment.beginDate);
    const due = localDateAndTime(assignment.dueDate);
    const rawWeight = assignment.weight;
    const numericWeight = rawWeight !== null && rawWeight !== undefined && rawWeight !== '' ? Number(rawWeight) : NaN;
    const included = assignment.includeScoreInFinalGrade !== false;
    const equalWeightCount = includedAssignmentCounts.get(categoryId) || 0;
    const weight = !included
      ? 0
      : category?.equalAssignWeight ? 1
        : Number.isFinite(numericWeight) ? numericWeight : null;
    const gradeWeightPercent = !included
      ? 0
      : category?.equalAssignWeight
        ? (Number(category.weight) || 0) / Math.max(1, equalWeightCount)
        : Number.isFinite(numericWeight) ? numericWeight : null;
    return {
      id: `ls-assignment-${assignmentId}`,
      title: decodeHtmlText(assignment.name).replace(/\s+/g, ' ').trim().slice(0, 200),
      description: descriptionText(assignment.description),
      folder_id: folderId,
      status: graded ? 'done' : 'todo',
      priority: 'medium',
      start_date: start.date,
      start_time: start.time,
      due_date: due.date,
      due_time: due.time,
      progress: graded ? 100 : 0,
      earned_points: earned,
      max_points: assignment.points ?? null,
      grade: null,
      weight_override: weight,
      extra_credit: learningSuiteBoolean(assignment.extraCredit),
      custom_values: gradeWeightPercent === null ? {} : { 'ls-grade-weight': gradeWeightPercent },
      dependencies: []
    };
  });

  return {
    courseName,
    courseId,
    gradedCount: tasks.filter(task => task.earned_points !== null).length,
    backup: {
      format: 'myplan-task-backup', version: 1,
      source: { system: 'byu_learning_suite', course_id: courseId, course_name: courseName },
      folders,
      custom_fields: [{ id: 'ls-grade-weight', name: 'Grade Weight %', field_type: 'number', options: [] }],
      tasks
    }
  };
}

export function previewLearningSuiteMatches(backup, existingFolders, existingTasks, savedMap = {}) {
  const folderMap = new Map();
  const usedFolderIds = new Map();
  const orderedFolders = [...(backup.folders || [])];
  let remaining = orderedFolders.slice();
  while (remaining.length) {
    let progressed = false;
    remaining = remaining.filter(sourceFolder => {
      const parentKnown = !sourceFolder.parent_id || folderMap.has(sourceFolder.parent_id);
      if (!parentKnown) return true;
      const parentId = sourceFolder.parent_id ? folderMap.get(sourceFolder.parent_id) : null;
      const savedId = savedMap.folders?.[sourceFolder.id];
      const mapped = existingFolders.find(folder => folder.id === savedId && folder.parent_id === parentId);
      const named = existingFolders.find(folder => folder.parent_id === parentId && folder.name.toLowerCase() === String(sourceFolder.name).toLowerCase());
      const match = mapped || named;
      folderMap.set(sourceFolder.id, match?.id || `new:${sourceFolder.id}`);
      if (match) usedFolderIds.set(sourceFolder.id, match.id);
      progressed = true;
      return false;
    });
    if (!progressed) break;
  }

  let updated = 0;
  let added = 0;
  let ambiguous = 0;
  const claimedTaskIds = new Set();
  for (const sourceTask of backup.tasks || []) {
    const savedId = savedMap.tasks?.[sourceTask.id];
    const mappedTask = existingTasks.find(task => task.id === savedId);
    if (mappedTask && !claimedTaskIds.has(mappedTask.id)) {
      updated += 1;
      claimedTaskIds.add(mappedTask.id);
      continue;
    }
    const expectedFolder = folderMap.get(sourceTask.folder_id);
    const candidates = existingTasks.filter(task => !claimedTaskIds.has(task.id) && task.folder_id === expectedFolder
      && normalizeTaskMatchTitle(task.title) === normalizeTaskMatchTitle(sourceTask.title));
    if (candidates.length === 1) { updated += 1; claimedTaskIds.add(candidates[0].id); }
    else if (candidates.length > 1) ambiguous += 1;
    else added += 1;
  }
  return { added, updated, ambiguous, folderMap, matchedFolders: usedFolderIds };
}
