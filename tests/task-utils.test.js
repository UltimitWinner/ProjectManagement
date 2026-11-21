import test from 'node:test';
import assert from 'node:assert/strict';
import { sortTasks, excludeDoneTasks, buildGanttDependencyEdges, ganttDependencyPath, taskCustomFieldEntries, getFolderPath, buildGanttRows, buildGanttWeekRanges, taskGanttDateRange, ganttTimeOffset, ganttCalendarDaysBetween, folderGradePotential, folderTreeGradePotential, folderMaximumContribution, pointsGradeProjection, weightedGradeContribution, currentGradeWithUngradedFolderDefault, tasksInFolderTree, tasksInFolderSubtree } from '../public/task-utils.js';

const folders = [
  { id: 'f1', name: 'Biology' },
  { id: 'f2', name: 'Chemistry' },
];

test('sorts tasks by multiple fields in priority order', () => {
  const tasks = [
    { id: 'late', status: 'todo', priority: 'low', title: 'Zeta' },
    { id: 'first', status: 'todo', priority: 'high', title: 'Alpha' },
    { id: 'second', status: 'todo', priority: 'high', title: 'Beta' },
    { id: 'done', status: 'done', priority: 'urgent', title: 'Aardvark' },
  ];

  const sorted = sortTasks(tasks, folders, [
    { key: 'status', dir: 'asc' },
    { key: 'priority', dir: 'desc' },
    { key: 'title', dir: 'asc' },
  ]);

  assert.deepEqual(sorted.map(task => task.id), ['first', 'second', 'late', 'done']);
  assert.deepEqual(tasks.map(task => task.id), ['late', 'first', 'second', 'done'], 'sorting must not mutate source tasks');
});

test('sorts status options in their configured order within each status group', () => {
  const tasks = [
    { id: 'review', status: 'in_progress', status_label: 'Review' },
    { id: 'todo', status: 'todo', status_label: 'Queued' },
    { id: 'working', status: 'in_progress', status_label: 'Working' },
    { id: 'default', status: 'in_progress', status_label: '' },
    { id: 'done', status: 'done', status_label: 'Published' },
  ];
  const statusOptions = {
    todo: ['Queued'],
    in_progress: ['Working', 'Review'],
    done: ['Published'],
  };

  assert.deepEqual(
    sortTasks(tasks, [], [{ key: 'status', dir: 'asc' }], statusOptions).map(task => task.id),
    ['todo', 'default', 'working', 'review', 'done']
  );
});

test('includes every descendant task in selected top-level folder scope', () => {
  const folderTree = [
    { id: 'course-a', parent_id: null },
    { id: 'sub-a', parent_id: 'course-a', weight_percent: 0 },
    { id: 'deep-a', parent_id: 'sub-a', weight_percent: 0 },
    { id: 'course-b', parent_id: null },
  ];
  const scopedTasks = [
    { id: 'root-task', folder_id: 'course-a' },
    { id: 'sub-task', folder_id: 'sub-a' },
    { id: 'deep-task', folder_id: 'deep-a' },
    { id: 'other-course', folder_id: 'course-b' },
    { id: 'unfiled', folder_id: '' },
  ];
  assert.deepEqual(tasksInFolderSubtree('course-a', folderTree, scopedTasks).map(task => task.id), ['root-task', 'sub-task', 'deep-task']);
});

test('sorts tasks by saved manual order', () => {
  const tasks = [
    { id: 'third', sort_order: 2 },
    { id: 'first', sort_order: 0 },
    { id: 'second', sort_order: 1 },
    { id: 'unranked', sort_order: null },
  ];
  assert.deepEqual(sortTasks(tasks, [], [{ key: 'manual_order', dir: 'asc' }]).map(task => task.id), ['first', 'second', 'third', 'unranked']);
});

test('builds nested folder rows and labels every repeated interrupted folder group', () => {
  const folders = [
    { id: 'course', name: 'Course', parent_id: null },
    { id: 'homework', name: 'Homework', parent_id: 'course' },
    { id: 'quiz', name: 'Quiz', parent_id: 'course' },
    { id: 'other', name: 'Other', parent_id: null },
  ];
  const tasks = [
    { id: 'hw1', folder_id: 'homework' },
    { id: 'hw2', folder_id: 'homework' },
    { id: 'quiz1', folder_id: 'quiz' },
    { id: 'hw3', folder_id: 'homework' },
    { id: 'other1', folder_id: 'other' },
    { id: 'hw4', folder_id: 'homework' },
  ];
  const rows = buildGanttRows(tasks, folders);
  assert.deepEqual(rows.map(row => row.type === 'folder' ? `${row.folder.id}${row.showLabel ? '' : '(repeat)'}` : row.task.id), [
    'course', 'homework', 'hw1', 'hw2', 'quiz', 'quiz1', 'homework', 'hw3', 'other', 'other1', 'course', 'homework', 'hw4',
  ]);
  const courseLines = rows.filter(row => row.type === 'folder' && row.folder.id === 'course');
  const homeworkLines = rows.filter(row => row.type === 'folder' && row.folder.id === 'homework');
  assert.deepEqual(courseLines.map(row => row.tasks.map(task => task.id)), [
    ['hw1', 'hw2', 'quiz1', 'hw3', 'hw4'],
    ['hw1', 'hw2', 'quiz1', 'hw3', 'hw4'],
  ]);
  assert.deepEqual(homeworkLines.map(row => row.tasks.map(task => task.id)), [
    ['hw1', 'hw2', 'hw3', 'hw4'],
    ['hw1', 'hw2', 'hw3', 'hw4'],
    ['hw1', 'hw2', 'hw3', 'hw4'],
  ]);
});

test('maps task open and due times proportionally within the day', () => {
  const today = new Date(2026, 10, 20);
  const { startDate, dueDate } = taskGanttDateRange({
    start_date: '2026-11-20',
    start_time: '09:00',
    due_date: '2026-11-20',
    due_time: '15:00',
  }, today);
  const offsetStart = ganttTimeOffset(startDate, new Date(2026, 10, 20));
  const offsetDue = ganttTimeOffset(dueDate, new Date(2026, 10, 20));
  assert.ok(Math.abs(offsetStart - 0.375) < 0.0001);
  assert.ok(Math.abs(offsetDue - 0.625) < 0.0001);
  assert.ok(Math.abs((offsetDue - offsetStart) - 0.25) < 0.0001);
  assert.equal(ganttCalendarDaysBetween(new Date(2026, 10, 20), new Date(2026, 10, 23)), 3);
});

test('defaults Gantt bars to start and end of day and respects the explicit open timestamp', () => {
  const today = new Date(2026, 10, 20);
  const dayRange = taskGanttDateRange({ start_date: '2026-11-20', due_date: '2026-11-20' }, today);
  assert.equal(dayRange.startDate.getHours(), 0);
  assert.equal(dayRange.dueDate.getHours(), 23);
  assert.equal(dayRange.dueDate.getMinutes(), 59);

  const openedRange = taskGanttDateRange({
    start_date: '2026-11-20', start_time: '08:00', open_at: '2026-11-20T10:30',
    due_date: '2026-11-20', due_time: '12:00',
  }, today);
  assert.equal(openedRange.startDate.getHours(), 10);
  assert.equal(openedRange.startDate.getMinutes(), 30);
});

test('groups Gantt header dates into readable calendar week ranges', () => {
  const ranges = buildGanttWeekRanges(new Date(2026, 10, 1), 14);
  assert.deepEqual(ranges.map(({ startIndex, dayCount, label }) => ({ startIndex, dayCount, label })), [
    { startIndex: 0, dayCount: 7, label: '11/1–7' },
    { startIndex: 7, dayCount: 7, label: '11/8–14' }
  ]);
});

test('formats partial Gantt weeks and month boundaries', () => {
  const ranges = buildGanttWeekRanges(new Date(2026, 9, 30), 10);
  assert.deepEqual(ranges.map(({ dayCount, label }) => ({ dayCount, label })), [
    { dayCount: 2, label: '10/30–31' },
    { dayCount: 7, label: '11/1–7' },
    { dayCount: 1, label: '11/8' }
  ]);
});

test('supports descending secondary sort and custom-field sort keys', () => {
  const tasks = [
    { id: 'one', status: 'todo', custom_values: { cf1: 'Alpha' } },
    { id: 'three', status: 'todo', custom_values: { cf1: 'Gamma' } },
    { id: 'two', status: 'todo', custom_values: { cf1: 'Beta' } },
  ];

  const sorted = sortTasks(tasks, folders, [
    { key: 'status', dir: 'asc' },
    { key: 'custom:cf1', dir: 'desc' },
  ]);

  assert.deepEqual(sorted.map(task => task.id), ['three', 'two', 'one']);
});

test('done-task filter excludes completed tasks only when enabled', () => {
  const tasks = [
    { id: 'open', status: 'todo' },
    { id: 'done', status: 'done' },
  ];
  assert.deepEqual(excludeDoneTasks(tasks).map(task => task.id), ['open', 'done']);
  assert.deepEqual(excludeDoneTasks(tasks, true).map(task => task.id), ['open']);
  assert.deepEqual(tasks.map(task => task.id), ['open', 'done'], 'filter must not mutate source tasks');
});

test('Gantt dependency edges include only visible predecessor and successor tasks', () => {
  const allTasks = [
    { id: 'active-a', status: 'in_progress', dependencies: [] },
    { id: 'active-b', status: 'todo', dependencies: ['active-a', 'completed'] },
    { id: 'completed', status: 'done', dependencies: ['active-a'] }
  ];
  const visibleTasks = excludeDoneTasks(allTasks, true);
  assert.deepEqual(buildGanttDependencyEdges(visibleTasks), [{ from: 'active-a', to: 'active-b' }]);
});

test('Gantt dependency arrows use direct diagonals when there is no room for an elbow', () => {
  assert.equal(ganttDependencyPath(100, 20, 106, 62), 'M 100 20 L 102 62');
  assert.equal(ganttDependencyPath(100, 20, 160, 62), 'M 100 20 H 124 V 62 H 156');
});

test('folder sorting uses the complete nested folder path', () => {
  const nestedFolders = [
    { id: 'root', name: 'Science' },
    { id: 'middle', name: 'Biology', parent_id: 'root' },
    { id: 'leaf', name: 'Labs', parent_id: 'middle' },
  ];
  assert.equal(getFolderPath('leaf', nestedFolders), 'Science / Biology / Labs');
  const sorted = sortTasks([
    { id: 'z', folder_id: 'leaf' },
    { id: 'a', folder_id: 'middle' },
  ], nestedFolders, [{ key: 'folder', dir: 'asc' }]);
  assert.deepEqual(sorted.map(task => task.id), ['a', 'z']);
});

test('returns only populated custom fields for task-tree chips', () => {
  const task = { custom_values: { cf1: 'Textbook', cf2: '', cf3: null } };
  const fields = [
    { id: 'cf1', name: 'Material' },
    { id: 'cf2', name: 'Room' },
    { id: 'cf3', name: 'Instructor' },
    { id: 'cf4', name: 'Due date' },
  ];

  assert.deepEqual(taskCustomFieldEntries(task, fields), [{ name: 'Material', value: 'Textbook' }]);
});

test('folder without assignment weights uses earned points over total possible points', () => {
  const potential = folderGradePotential([
    { earned_points: 40, max_points: 50, grade: null },
    { earned_points: null, max_points: 25, grade: null, status: 'todo' },
  ]);

  assert.equal(potential.average, 80);
  assert.equal(Number(potential.maxAverage.toFixed(4)), 86.6667);
  assert.equal(potential.gradedCount, 1);
});

test('grade overrides use a 100-point slot and ungraded tasks use their own max points', () => {
  const potential = folderGradePotential([
    { grade: 70, earned_points: null, max_points: null },
    { grade: null, earned_points: null, max_points: 50 },
  ]);

  assert.equal(potential.average, 70);
  assert.equal(potential.maxAverage, 80);
});

test('ungraded tasks do not lower current score but count fully for max and zero for min', () => {
  const weighted = folderGradePotential([
    { grade: 50, weight_override: 20 },
    { grade: null, weight_override: 80, status: 'todo' },
  ]);
  assert.equal(weighted.average, 50);
  assert.equal(weighted.maxAverage, 90);
  assert.equal(weighted.minAverage, 10);

  const points = folderGradePotential([
    { earned_points: 20, max_points: 20, grade: null },
    { earned_points: null, max_points: 80, grade: null, status: 'done' },
  ]);
  assert.equal(points.average, 100);
  assert.equal(points.maxAverage, 100);
  assert.equal(points.minAverage, 20);
});

test('100% on a 50-point assignment with no weight is 100%', () => {
  const potential = folderGradePotential([
    { earned_points: 50, max_points: 50, grade: null },
  ]);
  assert.equal(potential.average, 100);
  assert.equal(potential.maxAverage, 100);
});

test('zero or invalid assignment weights contribute nothing', () => {
  const potential = folderGradePotential([
    { grade: 100, weight_override: 0 },
    { grade: 100, custom_values: { weight: 'not a number' } },
  ], 'weight');
  assert.equal(potential.average, null);
  assert.equal(potential.maxAverage, 0);
});

test('tasks with no points or weights produce a 100% folder score', () => {
  const potential = folderGradePotential([
    { grade: null, earned_points: null, max_points: null },
  ]);
  assert.equal(potential.average, null);
  assert.equal(potential.maxAverage, 100);
  assert.equal(potential.minAverage, 0);
});

test('an ungraded folder defaults to 100% for current grade but preserves zero scores', () => {
  assert.equal(currentGradeWithUngradedFolderDefault(null), 100);
  assert.equal(currentGradeWithUngradedFolderDefault(undefined), 100);
  assert.equal(currentGradeWithUngradedFolderDefault(0), 0);
  assert.equal(currentGradeWithUngradedFolderDefault(76.5), 76.5);
});

test('task weights form a relative grade within a folder and the folder weight sets course contribution', () => {
  const task = { id: 'only-task', folder_id: 'only-folder', grade: 100, custom_values: { assignment_weight: '1.5' } };
  const folderAtTaskWeight = [{ id: 'only-folder', parent_id: null, weight_percent: 1.5 }];
  const folderAtDifferentWeight = [{ id: 'only-folder', parent_id: null, weight_percent: 2.5 }];

  const firstFolderScore = folderTreeGradePotential('only-folder', folderAtTaskWeight, [task], 'assignment_weight');
  const secondFolderScore = folderTreeGradePotential('only-folder', folderAtDifferentWeight, [task], 'assignment_weight');
  assert.equal(firstFolderScore.average, 100);
  assert.equal(weightedGradeContribution(firstFolderScore.average, folderAtTaskWeight[0].weight_percent), 1.5);
  assert.equal(secondFolderScore.average, 100);
  assert.equal(weightedGradeContribution(secondFolderScore.average, folderAtDifferentWeight[0].weight_percent), 2.5);

  const extraCreditTask = { ...task, grade: 250 };
  const extraCreditFolder = folderTreeGradePotential('only-folder', folderAtDifferentWeight, [extraCreditTask], 'assignment_weight');
  assert.equal(extraCreditFolder.average, 250);
  assert.equal(weightedGradeContribution(extraCreditFolder.average, folderAtDifferentWeight[0].weight_percent), 6.25);
});

test('folder drop-lowest rule affects current, maximum, and minimum scores across nested tasks', () => {
  const folders = [
    { id: 'course', parent_id: null, weight_percent: 0, drop_lowest_count: 1 },
    { id: 'category', parent_id: 'course', weight_percent: 100, drop_lowest_count: 0 },
  ];
  const tasks = [
    { id: 'lowest', folder_id: 'category', grade: null, earned_points: 50, max_points: 100 },
    { id: 'higher', folder_id: 'category', grade: null, earned_points: 80, max_points: 100 },
    { id: 'ungraded', folder_id: 'category', grade: null, earned_points: null, max_points: 100 },
  ];

  const potential = folderTreeGradePotential('course', folders, tasks);
  assert.equal(potential.average, 80, 'current score drops the lowest graded task');
  assert.equal(potential.maxAverage, 90, 'maximum drops the lowest entered score and gives remaining ungraded work full credit');
  assert.equal(potential.minAverage, 65, 'minimum drops the ungraded task first');
  assert.deepEqual(potential.droppedTaskIdsCurrent, ['lowest']);
});

test('point-based maximum is 70% for a zero score worth 30 points with 70 points remaining', () => {
  const projection = pointsGradeProjection([
    { grade: 0, earned_points: null, max_points: 30 },
    { grade: null, earned_points: null, max_points: 70 },
  ]);
  assert.equal(projection.maxGrade, 70);
});

test('maximum weighted contribution uses actual grade for completed categories', () => {
  const contribution = folderMaximumContribution([
    { grade: 10, earned_points: null, max_points: 30, weight_override: 100 },
  ], 30);
  assert.equal(contribution, 3);
});

test('empty weighted categories do not add maximum possible points', () => {
  assert.equal(folderMaximumContribution([], 40), 0);
});

test('extra credit can raise a weighted category contribution above its weight', () => {
  assert.equal(folderMaximumContribution([
    { grade: 250, earned_points: null, max_points: 100 },
  ], 50), 125);
  assert.equal(pointsGradeProjection([
    { grade: 250, earned_points: null, max_points: 100 },
  ]).currentGrade, 250);
});

test('extra credit adds bonus points without lowering a folder when unearned', () => {
  const onlyExtraAtOnePercent = folderGradePotential([
    { grade: 100, weight_override: 1, extra_credit: true },
  ]);
  assert.equal(onlyExtraAtOnePercent.average, 200);
  assert.equal(weightedGradeContribution(onlyExtraAtOnePercent.average, 1), 2);

  const unearnedExtraOnly = folderGradePotential([
    { grade: 0, weight_override: 1, extra_credit: true },
  ]);
  assert.equal(unearnedExtraOnly.average, 100);
  assert.equal(unearnedExtraOnly.maxAverage, 100);
  assert.equal(unearnedExtraOnly.minAverage, 100);

  const mixed = folderGradePotential([
    { grade: 100, weight_override: 2 },
    { grade: 100, weight_override: 2, extra_credit: true },
  ]);
  assert.equal(mixed.average, 150);
  assert.equal(mixed.maxAverage, 150);
  assert.equal(mixed.minAverage, 150);

  const ungradedExtraOnly = folderGradePotential([
    { grade: null, earned_points: null, max_points: 100, extra_credit: true },
  ]);
  assert.equal(ungradedExtraOnly.average, 100);
  assert.equal(ungradedExtraOnly.maxAverage, 200);
  assert.equal(ungradedExtraOnly.minAverage, 100);

  const unearnedProjection = pointsGradeProjection([
    { grade: null, earned_points: null, max_points: 100, extra_credit: true },
  ]);
  assert.equal(unearnedProjection.currentGrade, 100);
  assert.equal(unearnedProjection.maxGrade, 200);
  assert.equal(unearnedProjection.minGrade, 100);
});

test('current grade sums weighted course points and allows extra credit above 100 percent', () => {
  const weightedPoints = weightedGradeContribution(5, 100)
    + weightedGradeContribution(100, 25)
    + weightedGradeContribution(100, 35)
    + weightedGradeContribution(100, 10);
  assert.equal(weightedPoints, 75);
  assert.equal(weightedGradeContribution(250, 50), 125);
});

test('folder averages use assignment weights and include descendant tasks', () => {
  const folders = [
    { id: 'parent', parent_id: null, weight_percent: 0 },
    { id: 'child', parent_id: 'parent', weight_percent: 30 },
  ];
  const tasks = [
    { id: 'direct', folder_id: 'parent', grade: 100, max_points: 10, custom_values: { weight: '10' } },
    { id: 'nested', folder_id: 'child', grade: 50, max_points: 10, custom_values: { weight: '90' } },
    { id: 'outside', folder_id: 'other', grade: 0, max_points: 10, custom_values: { weight: '500' } },
  ];

  const parentTasks = tasksInFolderTree('parent', folders, tasks);
  assert.deepEqual(parentTasks.map(task => task.id), ['direct', 'nested']);
  assert.equal(Number(folderGradePotential(parentTasks, 'weight').average.toFixed(8)), 55);
});

test('parent folder score combines category weights instead of flattening assignment weights', () => {
  const folders = [
    { id: 'course', parent_id: null, weight_percent: 0 },
    { id: 'homework', parent_id: 'course', weight_percent: 30 },
    { id: 'final', parent_id: 'course', weight_percent: 35 },
    { id: 'quizzes', parent_id: 'course', weight_percent: 35 },
  ];
  const tasks = [
    { id: 'hw', folder_id: 'homework', grade: 100, custom_values: { weight: '100' } },
    { id: 'final-a', folder_id: 'final', grade: 100, custom_values: { weight: '20' } },
    { id: 'final-b', folder_id: 'final', grade: 100, custom_values: { weight: '80' } },
    { id: 'quiz', folder_id: 'quizzes', grade: 100 },
  ];

  const potential = folderTreeGradePotential('course', folders, tasks, 'weight');
  assert.equal(potential.average, 100);
  assert.equal(potential.maxAverage, 100);
  assert.equal(potential.minAverage, 100);
});

test('parent folder maximum and minimum include ungraded weighted categories', () => {
  const folders = [
    { id: 'course', parent_id: null, weight_percent: 0 },
    { id: 'graded', parent_id: 'course', weight_percent: 30 },
    { id: 'remaining', parent_id: 'course', weight_percent: 70 },
  ];
  const tasks = [
    { id: 'done', folder_id: 'graded', grade: 100, custom_values: { weight: '100' } },
    { id: 'todo', folder_id: 'remaining', grade: null, custom_values: { weight: '100' } },
  ];

  const potential = folderTreeGradePotential('course', folders, tasks, 'weight');
  assert.equal(potential.average, 100, 'ungraded weighted category contributes its full weight to current score');
  assert.equal(potential.maxAverage, 100);
  assert.equal(potential.minAverage, 30);
});

test('an ungraded weighted subfolder contributes its full category weight to its parent current score', () => {
  const folders = [
    { id: 'course', parent_id: null, weight_percent: 0 },
    { id: 'ungraded-category', parent_id: 'course', weight_percent: 27.5 },
  ];
  const tasks = [{ id: 'waiting', folder_id: 'ungraded-category', grade: null, earned_points: null, max_points: 100 }];
  const potential = folderTreeGradePotential('course', folders, tasks, 'weight');

  assert.equal(potential.average, 27.5);
  assert.equal(potential.maxAverage, 27.5);
  assert.equal(potential.minAverage, 0);
});

test('zero-weight subfolder and its descendants do not contribute to parent average', () => {
  const folders = [
    { id: 'parent', parent_id: null, weight_percent: 0 },
    { id: 'weighted-child', parent_id: 'parent', weight_percent: 30 },
    { id: 'unweighted-child', parent_id: 'parent', weight_percent: 0 },
    { id: 'weighted-grandchild', parent_id: 'unweighted-child', weight_percent: 20 },
  ];
  const tasks = [
    { id: 'parent-task', folder_id: 'parent', grade: 80, max_points: 100 },
    { id: 'included-task', folder_id: 'weighted-child', grade: 60, max_points: 100 },
    { id: 'excluded-task', folder_id: 'unweighted-child', grade: 0, max_points: 100 },
    { id: 'excluded-grandchild-task', folder_id: 'weighted-grandchild', grade: 0, max_points: 100 },
  ];

  const included = tasksInFolderTree('parent', folders, tasks);
  assert.deepEqual(included.map(task => task.id), ['parent-task', 'included-task']);
  assert.equal(folderGradePotential(included).average, 70);
});
