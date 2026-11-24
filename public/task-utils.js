const STATUS_ORDER = ['todo', 'in_progress', 'done'];
const PRIORITY_ORDER = ['none', 'low', 'medium', 'high', 'urgent'];
const folderPathIndexes = new WeakMap();

function sortValue(task, key, folders, folderPathCache) {
  switch (key) {
    case 'status': return STATUS_ORDER.indexOf(task.status);
    case 'title': return (task.title || '').toLowerCase();
    case 'folder': return getFolderPath(task.folder_id, folders, folderPathCache).toLowerCase();
    case 'priority': return PRIORITY_ORDER.indexOf(task.priority);
    case 'start_date': return task.start_date || 'zzzz';
    case 'due_date': return task.due_date || 'zzzz';
    case 'grade':
      if (task.grade !== null && task.grade !== undefined) return Number(task.grade);
      if (task.earned_points !== null && task.max_points > 0) return (task.earned_points / task.max_points) * 100;
      return -1;
    case 'progress': return task.progress || 0;
    case 'manual_order':
      return task.sort_order !== null && task.sort_order !== undefined && task.sort_order !== '' && Number.isFinite(Number(task.sort_order))
        ? Number(task.sort_order)
        : Number.MAX_SAFE_INTEGER;
    default:
      return key.startsWith('custom:')
        ? String(task.custom_values?.[key.slice(7)] ?? '').toLowerCase()
        : undefined;
  }
}

export function getFolderPath(folderId, folders, pathCache = null) {
  if (!folderId) return '';
  let byId;
  if (folders instanceof Map) {
    byId = folders;
  } else {
    let indexes = pathCache ? null : folderPathIndexes.get(folders);
    if (!indexes) {
      indexes = { byId: new Map(folders.map(folder => [folder.id, folder])), pathCache: pathCache || new Map() };
      if (!pathCache) folderPathIndexes.set(folders, indexes);
    }
    byId = indexes.byId;
    pathCache ||= indexes.pathCache;
  }
  if (pathCache?.has(folderId)) return pathCache.get(folderId);
  const chain = [];
  const visited = new Set();
  let folder = byId.get(folderId);
  let prefix = '';
  while (folder && !visited.has(folder.id)) {
    if (pathCache?.has(folder.id)) {
      prefix = pathCache.get(folder.id);
      break;
    }
    visited.add(folder.id);
    chain.push(folder);
    folder = byId.get(folder.parent_id);
  }
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    prefix = prefix ? `${prefix} / ${chain[index].name}` : chain[index].name;
    pathCache?.set(chain[index].id, prefix);
  }
  return pathCache?.get(folderId) ?? prefix;
}

export function buildGanttRows(tasks, folders) {
  const foldersById = new Map(folders.map(folder => [folder.id, folder]));
  const taskGroupsById = new Map();
  for (const occurrence of tasks) {
    const task = occurrence._recurrenceParent || occurrence;
    let group = taskGroupsById.get(task.id);
    if (!group) {
      group = { id: task.id, task, occurrences: [] };
      taskGroupsById.set(task.id, group);
    }
    group.occurrences.push(occurrence);
  }
  const taskGroups = [...taskGroupsById.values()];
  const pathsByTaskId = new Map();
  for (const group of taskGroups) {
    const path = [];
    const visited = new Set();
    let folder = foldersById.get(group.task.folder_id);
    while (folder && !visited.has(folder.id)) {
      visited.add(folder.id);
      path.push(folder.id);
      folder = foldersById.get(folder.parent_id);
    }
    pathsByTaskId.set(group.id, path.reverse());
  }

  const tasksByFolderId = new Map(folders.map(folder => [folder.id, []]));
  for (const group of taskGroups) {
    for (const folderId of pathsByTaskId.get(group.id) || []) {
      tasksByFolderId.get(folderId)?.push(...group.occurrences);
    }
  }

  const rows = [];
  function appendFolderOccurrence(folderId, segmentTasks, depth) {
    const folder = foldersById.get(folderId);
    if (!folder || segmentTasks.length === 0) return;
    rows.push({ type: 'folder', folder, tasks: tasksByFolderId.get(folderId) || [], depth, showLabel: true });

    for (let index = 0; index < segmentTasks.length;) {
      const group = segmentTasks[index];
      const path = pathsByTaskId.get(group.id) || [];
      const folderIndex = path.indexOf(folderId);
      const childFolderId = folderIndex >= 0 ? path[folderIndex + 1] : null;
      if (!childFolderId) {
        rows.push({ type: 'task', task: group.task, occurrences: group.occurrences, depth: path.length });
        index += 1;
        continue;
      }

      const childTasks = [];
      let nextIndex = index;
      while (nextIndex < segmentTasks.length) {
        const nextPath = pathsByTaskId.get(segmentTasks[nextIndex].id) || [];
        const nextFolderIndex = nextPath.indexOf(folderId);
        if (nextFolderIndex < 0 || nextPath[nextFolderIndex + 1] !== childFolderId) break;
        childTasks.push(segmentTasks[nextIndex]);
        nextIndex += 1;
      }
      appendFolderOccurrence(childFolderId, childTasks, depth + 1);
      index = nextIndex;
    }
  }

  for (let index = 0; index < taskGroups.length;) {
    const taskGroup = taskGroups[index];
    const path = pathsByTaskId.get(taskGroup.id) || [];
    const rootFolderId = path[0];
    if (!rootFolderId) {
      rows.push({ type: 'task', task: taskGroup.task, occurrences: taskGroup.occurrences, depth: 0 });
      index += 1;
      continue;
    }

    const group = [];
    let nextIndex = index;
    while (nextIndex < taskGroups.length && (pathsByTaskId.get(taskGroups[nextIndex].id) || [])[0] === rootFolderId) {
      group.push(taskGroups[nextIndex]);
      nextIndex += 1;
    }
    appendFolderOccurrence(rootFolderId, group, 0);
    index = nextIndex;
  }
  return rows;
}

function localDateValue(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function utcDateFromString(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

function utcDateString(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function repeatDateAt(anchorValue, frequency, interval, occurrenceIndex) {
  const date = utcDateFromString(anchorValue);
  const amount = Math.max(1, Math.trunc(Number(interval) || 1));
  if (!date) return '';
  const index = Math.max(0, Math.trunc(Number(occurrenceIndex) || 0));
  if (frequency === 'daily' || frequency === 'weekly') {
    date.setUTCDate(date.getUTCDate() + index * amount * (frequency === 'weekly' ? 7 : 1));
  } else if (frequency === 'monthly') {
    const day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + index * amount);
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, lastDay));
  } else if (frequency === 'yearly') {
    const month = date.getUTCMonth();
    const day = date.getUTCDate();
    date.setUTCFullYear(date.getUTCFullYear() + index * amount);
    if (date.getUTCMonth() !== month) {
      date.setUTCDate(0);
    } else if (date.getUTCDate() !== day) {
      date.setUTCDate(0);
    }
  }
  return utcDateString(date);
}

export function addRepeatInterval(value, frequency, interval = 1) {
  return repeatDateAt(value, frequency, interval, 1);
}

function shiftDateByDays(value, days) {
  const date = utcDateFromString(value);
  if (!date) return value || null;
  date.setUTCDate(date.getUTCDate() + days);
  return utcDateString(date);
}

function repeatOccurrence(task, occurrenceDate) {
  const anchorDate = task.start_date || task.due_date;
  const anchor = utcDateFromString(anchorDate);
  const occurrence = utcDateFromString(occurrenceDate);
  if (!anchor || !occurrence) return { ...task, id: `${task.id}__occ__${occurrenceDate}`, _recurrenceParent: task };
  const offsetDays = Math.round((occurrence.getTime() - anchor.getTime()) / 86400000);
  return {
    ...task,
    id: `${task.id}__occ__${occurrenceDate}`,
    start_date: task.start_date ? shiftDateByDays(task.start_date, offsetDays) : null,
    due_date: task.due_date ? shiftDateByDays(task.due_date, offsetDays) : null,
    open_at: task.open_at ? `${shiftDateByDays(task.open_at.slice(0, 10), offsetDays)}${task.open_at.slice(10)}` : null,
    dependencies: [],
    _recurrenceParent: task,
    _recurrenceDate: occurrenceDate
  };
}

export function getNextTaskOccurrence(task, fromDate = localDateValue(new Date()), excludedDates = [], excludedWeekdays = []) {
  if (!task?.repeat_frequency) return task;
  const anchor = task.start_date || task.due_date;
  const anchorDate = utcDateFromString(anchor);
  if (!anchorDate) return task;
  const excluded = excludedDates instanceof Set ? excludedDates : new Set(excludedDates);
  const excludedDays = excludedWeekdays instanceof Set ? excludedWeekdays : new Set([...excludedWeekdays].map(Number));
  const targetDate = utcDateFromString(fromDate);
  let index = 0;
  if (targetDate && targetDate > anchorDate) {
    const amount = Math.max(1, Math.trunc(Number(task.repeat_interval) || 1));
    const dayDifference = Math.floor((targetDate.getTime() - anchorDate.getTime()) / 86400000);
    if (task.repeat_frequency === 'daily') index = Math.floor(dayDifference / amount);
    else if (task.repeat_frequency === 'weekly') index = Math.floor(dayDifference / (amount * 7));
    else if (task.repeat_frequency === 'monthly') {
      const monthDifference = (targetDate.getUTCFullYear() - anchorDate.getUTCFullYear()) * 12
        + targetDate.getUTCMonth() - anchorDate.getUTCMonth();
      index = Math.max(0, Math.floor(monthDifference / amount));
    } else if (task.repeat_frequency === 'yearly') {
      index = Math.max(0, Math.floor((targetDate.getUTCFullYear() - anchorDate.getUTCFullYear()) / amount));
    }
  }
  let date = repeatDateAt(anchor, task.repeat_frequency, task.repeat_interval, index);
  let last = null;
  // Every interval is calculated from the original date, preserving a monthly
  // rule such as the 31st even when an intervening month has fewer days.
  for (let count = index; count < 20000 && date && date <= (task.repeat_until || '9999-12-31'); count += 1) {
    last = date;
    const weekday = utcDateFromString(date)?.getUTCDay();
    if (date >= fromDate && !excluded.has(date) && !excludedDays.has(weekday)) {
      return { ...repeatOccurrence(task, date), id: task.id };
    }
    const next = repeatDateAt(anchor, task.repeat_frequency, task.repeat_interval, count + 1);
    if (!next || next <= date) break;
    date = next;
  }
  if (excluded.size || excludedDays.size) return null;
  if (!last) return null;
  return { ...repeatOccurrence(task, last), id: task.id };
}

export function expandRecurringTasks(tasks, holidays = [], excludedWeekdays = [], visibleRange = null) {
  const holidaySet = holidays instanceof Set ? holidays : new Set(holidays);
  const excludedDays = excludedWeekdays instanceof Set ? excludedWeekdays : new Set([...excludedWeekdays].map(Number));
  const rangeStart = utcDateFromString(visibleRange?.start);
  const rangeEnd = utcDateFromString(visibleRange?.end);
  const expanded = [];
  for (const task of tasks) {
    if (!task.repeat_frequency || !task.repeat_until) {
      expanded.push(task);
      continue;
    }
    const anchor = task.start_date || task.due_date;
    if (!utcDateFromString(anchor)) continue;
    if (rangeStart && rangeEnd && rangeEnd >= rangeStart) {
      const anchorTime = utcDateFromString(anchor).getTime();
      const relatedDates = [task.start_date, task.due_date, task.open_at?.slice(0, 10)]
        .map(utcDateFromString).filter(Boolean);
      const lookbackDays = relatedDates.reduce((days, date) => Math.max(days,
        Math.ceil(Math.abs(date.getTime() - anchorTime) / 86400000)), 0);
      const firstSearchDate = shiftDateByDays(visibleRange.start, -lookbackDays);
      let occurrence = getNextTaskOccurrence(task, firstSearchDate, holidaySet, excludedDays);
      if (occurrence?._recurrenceDate < firstSearchDate) occurrence = null;
      while (occurrence?._recurrenceDate && occurrence._recurrenceDate <= visibleRange.end) {
        const occurrenceStart = occurrence.start_date || occurrence.open_at?.slice(0, 10)
          || occurrence.due_date || occurrence._recurrenceDate;
        let occurrenceEnd = occurrence.due_date || occurrenceStart;
        if (occurrence.due_date && occurrence.start_date && occurrence.due_date <= occurrence.start_date) {
          occurrenceEnd = shiftDateByDays(occurrence.start_date, 1);
        }
        if (occurrenceStart <= visibleRange.end && occurrenceEnd >= visibleRange.start) {
          occurrence.id = `${task.id}__occ__${occurrence._recurrenceDate}`;
          expanded.push(occurrence);
        }
        const previousOccurrenceDate = occurrence._recurrenceDate;
        occurrence = getNextTaskOccurrence(task, shiftDateByDays(previousOccurrenceDate, 1), holidaySet, excludedDays);
        if (occurrence?._recurrenceDate <= previousOccurrenceDate) occurrence = null;
      }
      continue;
    }
    let date = anchor;
    for (let count = 0; count < 20000 && date <= task.repeat_until; count += 1) {
      // Project non-working weekdays and holidays are based on the scheduled start date.
      const weekday = utcDateFromString(date)?.getUTCDay();
      if (!holidaySet.has(date) && !excludedDays.has(weekday)) expanded.push(repeatOccurrence(task, date));
      const next = repeatDateAt(anchor, task.repeat_frequency, task.repeat_interval, count + 1);
      if (!next || next <= date) break;
      date = next;
    }
  }
  return expanded;
}

export function buildGanttWeekRanges(startDate, totalDays) {
  const groups = [];
  for (let index = 0; index < totalDays; index += 1) {
    const date = new Date(startDate);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() + index);
    const weekStart = new Date(date);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    const key = localDateValue(weekStart);
    let group = groups.at(-1);
    if (!group || group.key !== key) {
      group = { key, startIndex: index, dayCount: 0, firstDate: new Date(date), lastDate: new Date(date) };
      groups.push(group);
    }
    group.dayCount += 1;
    group.lastDate = new Date(date);
  }

  return groups.map(({ startIndex, dayCount, firstDate, lastDate }) => {
    const sameMonth = firstDate.getMonth() === lastDate.getMonth() && firstDate.getFullYear() === lastDate.getFullYear();
    const sameYear = firstDate.getFullYear() === lastDate.getFullYear();
    const fmt = date => `${date.getMonth() + 1}/${date.getDate()}${sameYear ? '' : `/${String(date.getFullYear()).slice(-2)}`}`;
    const label = localDateValue(firstDate) === localDateValue(lastDate)
      ? fmt(firstDate)
      : sameMonth
      ? `${fmt(firstDate)}–${lastDate.getDate()}${sameYear ? '' : `/${String(lastDate.getFullYear()).slice(-2)}`}`
      : `${fmt(firstDate)}–${fmt(lastDate)}`;
    const compactLabel = localDateValue(firstDate) === localDateValue(lastDate)
      ? String(firstDate.getDate())
      : `${firstDate.getDate()}–${lastDate.getDate()}`;
    return { startIndex, dayCount, label, compactLabel, title: `${localDateValue(firstDate)} – ${localDateValue(lastDate)}` };
  });
}

export function taskGanttDateRange(task, today = new Date()) {
  const fallbackDate = task.start_date || (task.open_at ? task.open_at.slice(0, 10) : task.due_date || localDateValue(today));
  const startDate = task.open_at
    ? new Date(task.open_at)
    : new Date(`${fallbackDate}T${task.start_time || '00:00'}:00`);
  const dueDateString = task.due_date || localDateValue(startDate);
  let dueDate = new Date(`${dueDateString}T${task.due_time || '23:59'}:00`);
  if (!Number.isFinite(startDate.getTime())) startDate.setTime(today.getTime());
  if (!Number.isFinite(dueDate.getTime()) || dueDate <= startDate) {
    dueDate = new Date(startDate);
    dueDate.setHours(23, 59, 0, 0);
    if (dueDate <= startDate) dueDate.setDate(dueDate.getDate() + 1);
  }
  return { startDate, dueDate };
}

export function ganttTimeOffset(date, timelineStart) {
  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const timelineDayStart = new Date(timelineStart.getFullYear(), timelineStart.getMonth(), timelineStart.getDate());
  const calendarDays = (Date.UTC(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate())
    - Date.UTC(timelineDayStart.getFullYear(), timelineDayStart.getMonth(), timelineDayStart.getDate())) / 86400000;
  const nextDay = new Date(dayStart);
  nextDay.setDate(nextDay.getDate() + 1);
  const fraction = (date.getTime() - dayStart.getTime()) / (nextDay.getTime() - dayStart.getTime());
  return calendarDays + fraction;
}

export function ganttCalendarDaysBetween(start, end) {
  return (Date.UTC(end.getFullYear(), end.getMonth(), end.getDate())
    - Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())) / 86400000;
}

export function sortTasks(tasks, folders, sortState, statusOptions = {}) {
  if (!sortState.length) return [...tasks];
  const foldersById = new Map(folders.map(folder => [folder.id, folder]));
  const folderPathCache = new Map();
  return [...tasks].sort((a, b) => {
    for (const { key, dir } of sortState) {
      if (key === 'status') {
        const statusDifference = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
        if (statusDifference) return dir === 'asc' ? statusDifference : -statusDifference;

        const labels = Array.isArray(statusOptions[a.status]) ? statusOptions[a.status] : [];
        const aLabel = String(a.status_label || '').trim();
        const bLabel = String(b.status_label || '').trim();
        const aRank = aLabel ? labels.findIndex(label => String(label).toLowerCase() === aLabel.toLowerCase()) : -1;
        const bRank = bLabel ? labels.findIndex(label => String(label).toLowerCase() === bLabel.toLowerCase()) : -1;
        const rankedA = aRank < 0 && aLabel ? labels.length : aRank;
        const rankedB = bRank < 0 && bLabel ? labels.length : bRank;
        if (rankedA !== rankedB) return dir === 'asc' ? rankedA - rankedB : rankedB - rankedA;
        const labelDifference = aLabel.localeCompare(bLabel, undefined, { sensitivity: 'base' });
        if (labelDifference) return dir === 'asc' ? labelDifference : -labelDifference;
        continue;
      }
      const va = sortValue(a, key, foldersById, folderPathCache);
      const vb = sortValue(b, key, foldersById, folderPathCache);
      if (va === undefined || vb === undefined) continue;
      if (va < vb) return dir === 'asc' ? -1 : 1;
      if (va > vb) return dir === 'asc' ? 1 : -1;
    }
    return 0;
  });
}

export function excludeDoneTasks(tasks, excludeDone = false) {
  return excludeDone ? tasks.filter(task => task.status !== 'done') : [...tasks];
}

export function buildGanttDependencyEdges(tasks) {
  const visibleIds = new Set(tasks.map(task => task.id));
  const edges = [];
  for (const task of tasks) {
    for (const dependencyId of task.dependencies || []) {
      if (dependencyId !== task.id && visibleIds.has(dependencyId)) {
        edges.push({ from: dependencyId, to: task.id });
      }
    }
  }
  return edges;
}

export function ganttDependencyPath(fromX, fromY, toX, toY) {
  const endpointX = toX - 4;
  const gap = endpointX - fromX;
  if (gap <= 28) return `M ${fromX} ${fromY} L ${endpointX} ${toY}`;
  const routeX = fromX + Math.min(24, gap / 2);
  return `M ${fromX} ${fromY} H ${routeX} V ${toY} H ${endpointX}`;
}

export function taskCustomFieldEntries(task, fields) {
  return fields
    .filter(field => task.custom_values?.[field.id] != null && task.custom_values[field.id] !== '')
    .map(field => ({ name: field.name, value: formatCustomFieldValue(field, task.custom_values[field.id]) }));
}

export function formatCustomFieldValue(field, value) {
  if (/\bgrade\s*weight\b/i.test(String(field?.name || ''))) {
    const number = Number(value);
    if (Number.isFinite(number)) return String(Math.trunc(number * 100) / 100);
  }
  return value;
}

export function buildFolderTaskIndex(folders, tasks) {
  const foldersById = new Map(folders.map(folder => [folder.id, folder]));
  const childFoldersByParent = new Map();
  for (const folder of folders) {
    const parentId = folder.parent_id || '';
    if (!childFoldersByParent.has(parentId)) childFoldersByParent.set(parentId, []);
    childFoldersByParent.get(parentId).push(folder);
  }
  const tasksByFolder = new Map();
  for (const task of tasks) {
    const folderId = task.folder_id || '';
    if (!tasksByFolder.has(folderId)) tasksByFolder.set(folderId, []);
    tasksByFolder.get(folderId).push(task);
  }
  return { folders, tasks, foldersById, childFoldersByParent, tasksByFolder };
}

function childFoldersFor(index, folders, parentId) {
  return index?.folders === folders
    ? index.childFoldersByParent.get(parentId || '') || []
    : folders.filter(folder => (folder.parent_id || '') === (parentId || ''));
}

function directTasksFor(index, folders, tasks, folderId) {
  return index?.folders && index.tasks === tasks
    ? index.tasksByFolder.get(folderId || '') || []
    : tasks.filter(task => (task.folder_id || '') === (folderId || ''));
}

export function tasksInFolderTree(folderId, folders, tasks, index = null) {
  const descendantIds = new Set([folderId]);
  const pending = [folderId];
  while (pending.length) {
    const parentId = pending.pop();
    for (const folder of childFoldersFor(index, folders, parentId)) {
      if (Number(folder.weight_percent) > 0 && !descendantIds.has(folder.id)) {
        descendantIds.add(folder.id);
        pending.push(folder.id);
      }
    }
  }
  if (index?.folders === folders && index.tasks === tasks) {
    return [...descendantIds].flatMap(id => index.tasksByFolder.get(id) || []);
  }
  return tasks.filter(task => descendantIds.has(task.folder_id));
}

export function tasksInFolderSubtree(folderId, folders, tasks, index = null) {
  const folderIds = new Set([folderId]);
  const pending = [folderId];
  while (pending.length) {
    const parentId = pending.pop();
    for (const folder of childFoldersFor(index, folders, parentId)) {
      if (!folderIds.has(folder.id)) {
        folderIds.add(folder.id);
        pending.push(folder.id);
      }
    }
  }
  if (index?.folders === folders && index.tasks === tasks) {
    return [...folderIds].flatMap(id => index.tasksByFolder.get(id) || []);
  }
  return tasks.filter(task => folderIds.has(task.folder_id));
}

export function folderGradePotential(tasks, customWeightFieldId = null) {
  if (tasks.length === 0) return { average: null, maxAverage: null, gradedCount: 0 };

  const weights = tasks.map(task => {
    if (task.weight_override !== null && task.weight_override !== undefined && task.weight_override !== '') {
      return { present: true, value: Number(task.weight_override) };
    }
    const rawCustomWeight = customWeightFieldId ? task.custom_values?.[customWeightFieldId] : undefined;
    if (rawCustomWeight !== undefined && rawCustomWeight !== null && rawCustomWeight !== '') {
      return { present: true, value: Number(rawCustomWeight) };
    }
    return { present: false, value: NaN };
  });
  const useWeights = weights.some(weight => weight.present);
  let gradedCount = 0;
  const hasGrade = task => task.grade !== null && task.grade !== undefined
    || task.earned_points !== null && task.earned_points !== undefined && Number(task.max_points) > 0;
  const gradeFraction = task => task.grade !== null && task.grade !== undefined
    ? Number(task.grade) / 100
    : Number(task.earned_points) / Number(task.max_points);

  if (useWeights) {
    let totalWeight = 0;
    let normalWeight = 0;
    let normalGradedWeight = 0;
    let normalCurrentEarned = 0;
    let normalMaxEarned = 0;
    let normalMinEarned = 0;
    let extraCurrentEarned = 0;
    let extraMaxEarned = 0;
    let extraMinEarned = 0;
    tasks.forEach((task, index) => {
      const weight = weights[index].value;
      if (!Number.isFinite(weight) || weight <= 0) return;
      totalWeight += weight;

      if (hasGrade(task)) {
        gradedCount += 1;
        const earned = weight * gradeFraction(task);
        if (task.extra_credit) {
          extraCurrentEarned += earned;
          extraMaxEarned += earned;
          extraMinEarned += earned;
        } else {
          normalGradedWeight += weight;
          normalCurrentEarned += earned;
          normalMaxEarned += earned;
          normalMinEarned += earned;
        }
      } else if (task.extra_credit) {
        extraMaxEarned += weight;
      } else {
        normalWeight += weight;
        normalMaxEarned += weight;
      }
    });
    normalWeight += normalGradedWeight;
    if (totalWeight === 0) return { average: null, maxAverage: 0, minAverage: 0, gradedCount };
    const currentBase = normalWeight === 0 || normalGradedWeight === 0
      ? 100 : (normalCurrentEarned / normalGradedWeight) * 100;
    const maximumBase = normalWeight > 0 ? (normalMaxEarned / normalWeight) * 100 : 100;
    const minimumBase = normalWeight > 0 ? (normalMinEarned / normalWeight) * 100 : 100;
    return {
      average: currentBase + (extraCurrentEarned / totalWeight) * 100,
      maxAverage: maximumBase + (extraMaxEarned / totalWeight) * 100,
      minAverage: minimumBase + (extraMinEarned / totalWeight) * 100,
      gradedCount,
    };
  }

  let totalPossible = 0;
  let normalPossible = 0;
  let normalGradedPossible = 0;
  let normalCurrentEarned = 0;
  let normalMaxEarned = 0;
  let normalMinEarned = 0;
  let extraCurrentEarned = 0;
  let extraMaxEarned = 0;
  let extraMinEarned = 0;
  tasks.forEach(task => {
    const possible = Number(task.max_points) > 0 ? Number(task.max_points)
      : task.grade !== null && task.grade !== undefined ? 100 : 0;
    if (possible <= 0) return;
    totalPossible += possible;
    const isGraded = hasGrade(task);
    if (task.extra_credit) {
      if (isGraded) {
        const earned = possible * gradeFraction(task);
        extraCurrentEarned += earned;
        extraMaxEarned += earned;
        extraMinEarned += earned;
        gradedCount += 1;
      } else {
        extraMaxEarned += possible;
      }
    } else {
      normalPossible += possible;
      if (isGraded) {
        const earned = possible * gradeFraction(task);
        normalCurrentEarned += earned;
        normalMaxEarned += earned;
        normalMinEarned += earned;
        normalGradedPossible += possible;
        gradedCount += 1;
      } else {
        normalMaxEarned += possible;
      }
    }
  });

  if (totalPossible === 0) {
    if (tasks.every(task => task.extra_credit)) {
      return { average: 100, maxAverage: 100, minAverage: 100, gradedCount };
    }
    return { average: null, maxAverage: 100, minAverage: 0, gradedCount };
  }
  const currentBase = normalPossible === 0 || normalGradedPossible === 0
    ? 100 : (normalCurrentEarned / normalGradedPossible) * 100;
  const maximumBase = normalPossible > 0 ? (normalMaxEarned / normalPossible) * 100 : 100;
  const minimumBase = normalPossible > 0 ? (normalMinEarned / normalPossible) * 100 : 100;
  return {
    average: currentBase + (extraCurrentEarned / totalPossible) * 100,
    maxAverage: maximumBase + (extraMaxEarned / totalPossible) * 100,
    minAverage: minimumBase + (extraMinEarned / totalPossible) * 100,
    gradedCount,
  };
}

function folderHasDirectWeights(tasks, customWeightFieldId) {
  return tasks.some(task => {
    const override = task.weight_override;
    const customWeight = customWeightFieldId ? task.custom_values?.[customWeightFieldId] : undefined;
    return (override !== null && override !== undefined && override !== '')
      || (customWeight !== null && customWeight !== undefined && customWeight !== '');
  });
}

function folderContributingTasks(folderId, folders, tasks, ancestors = new Set(), customWeightFieldId = null, index = null) {
  if (ancestors.has(folderId)) return [];
  const directTasks = directTasksFor(index, folders, tasks, folderId);
  const weightedChildren = childFoldersFor(index, folders, folderId).filter(child => Number(child.weight_percent) > 0);
  const included = folderHasDirectWeights(directTasks, customWeightFieldId) || weightedChildren.length === 0
    ? [...directTasks]
    : [];
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(folderId);
  weightedChildren.forEach(child => included.push(...folderContributingTasks(child.id, folders, tasks, nextAncestors, customWeightFieldId, index)));
  return included;
}

function inputTaskScore(task) {
  const multiplier = task.extra_credit ? 2 : 1;
  if (task.grade !== null && task.grade !== undefined) return Number(task.grade) * multiplier;
  if (task.earned_points !== null && task.earned_points !== undefined && Number(task.max_points) > 0) {
    return (Number(task.earned_points) / Number(task.max_points)) * 100 * multiplier;
  }
  return null;
}

function bonusFolderScore(folderId, folders, tasks, customWeightFieldId, scenario, index = null) {
  const bonusTasks = tasksInFolderSubtree(folderId, folders, tasks, index).filter(task => task.extra_credit);
  let totalWeight = 0;
  let earnedWeight = 0;

  for (const task of bonusTasks) {
    const override = task.weight_override;
    const customWeight = customWeightFieldId ? task.custom_values?.[customWeightFieldId] : undefined;
    const rawWeight = override !== null && override !== undefined && override !== ''
      ? override
      : customWeight !== null && customWeight !== undefined && customWeight !== ''
        ? customWeight
        : Number(task.max_points) > 0 ? task.max_points : 1;
    const weight = Number(rawWeight);
    if (!Number.isFinite(weight) || weight <= 0) continue;
    totalWeight += weight;

    let fraction = null;
    if (task.grade !== null && task.grade !== undefined && task.grade !== '') {
      fraction = Number(task.grade) / 100;
    } else if (task.earned_points !== null && task.earned_points !== undefined
      && Number(task.max_points) > 0) {
      fraction = Number(task.earned_points) / Number(task.max_points);
    }
    if (fraction !== null && Number.isFinite(fraction)) {
      earnedWeight += weight * Math.max(0, Math.min(1, fraction));
    } else if (scenario === 'maximum') {
      earnedWeight += weight;
    }
  }

  return totalWeight > 0 ? (earnedWeight / totalWeight) * 100 : 0;
}

function taskScenarioScore(task, scenario) {
  const score = inputTaskScore(task);
  if (score !== null && Number.isFinite(score)) return score;
  if (scenario === 'current') return null;
  return scenario === 'maximum' ? (task.extra_credit ? 200 : 100) : 0;
}

function tasksDroppedForScenario(tasks, lowestCount, highestCount, scenario) {
  const eligible = tasks.filter(task => !task.never_drop && taskScenarioScore(task, scenario) !== null);
  const scoreFor = task => taskScenarioScore(task, scenario);
  const byLowest = (a, b) => scoreFor(a) - scoreFor(b) || String(a.id).localeCompare(String(b.id));
  const byHighest = (a, b) => scoreFor(b) - scoreFor(a) || String(a.id).localeCompare(String(b.id));
  const dropped = new Set();
  eligible.sort(byLowest).slice(0, Math.max(0, Math.floor(Number(lowestCount) || 0)))
    .forEach(task => dropped.add(task.id));
  eligible.filter(task => !dropped.has(task.id)).sort(byHighest)
    .slice(0, Math.max(0, Math.floor(Number(highestCount) || 0)))
    .forEach(task => dropped.add(task.id));
  return dropped;
}

function scenarioValue(potential, scenario) {
  if (scenario === 'current') {
    if (potential.average !== null && potential.average !== undefined) return potential.average;
    if (potential.maxAverage === 0 && potential.minAverage === 0) return 0;
    return null;
  }
  return scenario === 'maximum' ? potential.maxAverage ?? null : potential.minAverage ?? null;
}

function folderTreeScenario(folderId, folders, tasks, customWeightFieldId, scenario, ancestors = new Set(), index = null) {
  if (ancestors.has(folderId)) return { score: null, droppedTaskIds: new Set() };
  const folder = index?.folders === folders ? index.foldersById.get(folderId) : folders.find(item => item.id === folderId);
  if (!folder) {
    const potential = folderGradePotential(directTasksFor(index, folders, tasks, folderId), customWeightFieldId);
    return { score: scenarioValue(potential, scenario), droppedTaskIds: new Set() };
  }

  const contributingTasks = folderContributingTasks(folderId, folders, tasks, new Set(), customWeightFieldId, index);
  const ownDropped = tasksDroppedForScenario(contributingTasks, folder.drop_lowest_count, folder.drop_highest_count, scenario);
  const remainingTasks = ownDropped.size ? tasks.filter(task => !ownDropped.has(task.id)) : tasks;
  if (folder.bonus_cap_enabled) {
    return {
      score: bonusFolderScore(folderId, folders, remainingTasks, customWeightFieldId, scenario, index),
      droppedTaskIds: ownDropped
    };
  }
  if (ownDropped.size && contributingTasks.length > 0 && contributingTasks.every(task => ownDropped.has(task.id))) {
    return { score: 100, droppedTaskIds: ownDropped };
  }

  const directTasks = directTasksFor(index, folders, remainingTasks, folderId);
  const directPotential = folderGradePotential(directTasks, customWeightFieldId);
  const hasDirectWeights = folderHasDirectWeights(directTasks, customWeightFieldId);
  const weightedChildren = childFoldersFor(index, folders, folderId).filter(child => Number(child.weight_percent) > 0);
  if (!hasDirectWeights && weightedChildren.length === 0) {
    return { score: scenarioValue(directPotential, scenario), droppedTaskIds: ownDropped };
  }

  let score = 0;
  let hasScore = false;
  if (hasDirectWeights) {
    const directScore = scenarioValue(directPotential, scenario);
    if (directScore !== null) {
      score += directScore;
      hasScore = true;
    }
  }

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(folderId);
  const droppedTaskIds = new Set(ownDropped);
  for (const child of weightedChildren) {
    const childResult = folderTreeScenario(child.id, folders, remainingTasks, customWeightFieldId, scenario, nextAncestors, index);
    childResult.droppedTaskIds.forEach(id => droppedTaskIds.add(id));
    const childScore = childResult.score === null && scenario === 'current' ? 100 : childResult.score;
    if (childScore !== null) {
      score += weightedGradeContribution(childScore, child.weight_percent);
      hasScore = true;
    }
  }

  return { score: hasScore ? score : null, droppedTaskIds };
}

export function folderTreeGradePotential(folderId, folders, tasks, customWeightFieldId = null, index = null) {
  const current = folderTreeScenario(folderId, folders, tasks, customWeightFieldId, 'current', new Set(), index);
  const maximum = folderTreeScenario(folderId, folders, tasks, customWeightFieldId, 'maximum', new Set(), index);
  const minimum = folderTreeScenario(folderId, folders, tasks, customWeightFieldId, 'minimum', new Set(), index);
  const contributingTasks = folderContributingTasks(folderId, folders, tasks, new Set(), customWeightFieldId, index);
  const gradedCount = contributingTasks.filter(task => inputTaskScore(task) !== null).length;
  return {
    average: current.score,
    maxAverage: maximum.score,
    minAverage: minimum.score,
    gradedCount,
    droppedTaskIdsCurrent: [...current.droppedTaskIds]
  };
}

export function folderMaximumContribution(tasks, weight, customWeightFieldId = null) {
  const { maxAverage } = folderGradePotential(tasks, customWeightFieldId);
  return maxAverage === null ? 0 : (maxAverage / 100) * Number(weight || 0);
}

export function weightedGradeContribution(grade, weight) {
  return (Number(grade || 0) / 100) * Number(weight || 0);
}

export function currentGradeWithUngradedFolderDefault(average) {
  return average === null || average === undefined ? 100 : Number(average);
}

export function pointsGradeProjection(tasks) {
  let totalPossible = 0;
  let normalPossible = 0;
  let normalGradedPossible = 0;
  let normalCurrentEarned = 0;
  let normalMaxEarned = 0;
  let normalMinEarned = 0;
  let extraCurrentEarned = 0;
  let extraMaxEarned = 0;
  let extraMinEarned = 0;
  for (const task of tasks) {
    const possible = Number(task.max_points) > 0 ? Number(task.max_points)
      : task.grade !== null && task.grade !== undefined ? 100 : 0;
    if (possible <= 0) continue;
    totalPossible += possible;
    const isGraded = task.grade !== null && task.grade !== undefined
      || task.earned_points !== null && task.earned_points !== undefined && Number(task.max_points) > 0;
    const earned = task.grade !== null && task.grade !== undefined
      ? possible * Number(task.grade) / 100
      : isGraded ? Number(task.earned_points) : 0;
    if (task.extra_credit) {
      if (isGraded) {
        extraCurrentEarned += earned;
        extraMaxEarned += earned;
        extraMinEarned += earned;
      } else {
        extraMaxEarned += possible;
      }
    } else {
      normalPossible += possible;
      if (isGraded) {
        normalCurrentEarned += earned;
        normalMaxEarned += earned;
        normalMinEarned += earned;
        normalGradedPossible += possible;
      } else {
        normalMaxEarned += possible;
      }
    }
  }
  if (totalPossible === 0) {
    const extraOnly = tasks.length > 0 && tasks.every(task => task.extra_credit);
    return { currentGrade: extraOnly ? 100 : null, maxGrade: 100, minGrade: extraOnly ? 100 : 0 };
  }
  const currentBase = normalPossible === 0
    ? 100
    : normalGradedPossible > 0 ? (normalCurrentEarned / normalGradedPossible) * 100
      : tasks.some(task => task.extra_credit) ? 100 : null;
  const maximumBase = normalPossible > 0 ? (normalMaxEarned / normalPossible) * 100 : 100;
  const minimumBase = normalPossible > 0 ? (normalMinEarned / normalPossible) * 100 : 100;
  return {
    currentGrade: currentBase === null ? null : currentBase + (extraCurrentEarned / totalPossible) * 100,
    maxGrade: maximumBase + (extraMaxEarned / totalPossible) * 100,
    minGrade: minimumBase + (extraMinEarned / totalPossible) * 100,
  };
}

