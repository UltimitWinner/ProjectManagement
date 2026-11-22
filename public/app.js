import { sortTasks, excludeDoneTasks, buildGanttDependencyEdges, ganttDependencyPath, taskCustomFieldEntries, formatCustomFieldValue, getFolderPath, buildGanttRows, buildGanttWeekRanges, taskGanttDateRange, ganttTimeOffset, ganttCalendarDaysBetween, folderTreeGradePotential, pointsGradeProjection, weightedGradeContribution, currentGradeWithUngradedFolderDefault, tasksInFolderTree, tasksInFolderSubtree } from './task-utils.js';
import { parseCsv, serializeCsv, detectCsvProfile, normalizeImportRow, normalizeHeader, getCsvProfile, parseTransferDateValue, parseTransferTimeValue } from './transfer-utils.js';
import { parseLearningSuiteHtml, previewLearningSuiteMatches, normalizeTaskMatchTitle } from './learning-suite-utils.js';

// State
let currentUser = null; // { id, username, name, systemRole }
let currentProjectAccess = 'none'; // 'none', 'view', 'edit' for the currently selected project
let projects = [];
let currentProjectId = null;
let currentProject = null;
let selectedStatsFolderId;
let folders = []; // All folders & subfolders
let collapsedFolderIds = new Set();
let customFields = [];
let tasks = [];
let currentView = 'folder';

// Multi-column sort state for list view: array of { key, dir } — primary sort first
// Sortable keys: 'status','title','folder','priority','start_date','due_date','grade','progress'
let listSortState = [{ key: 'status', dir: 'asc' }];
let excludeDoneFromList = false;
let selectedTaskIds = new Set();
let currentDroppedGradeTaskIds = new Set();
let lastBoardDropAt = 0;
let lastGanttDropAt = 0;
let lastListDropAt = 0;
let projectHolidayDraft = [];
let pendingImport = null;
let exportSelectedOnly = false;

// Remove the legacy bearer token. Sessions now use an HttpOnly cookie.
localStorage.removeItem('myplan_auth_token');

// UI Elements
const authGateOverlay = document.getElementById('authGateOverlay');
const gateLoginForm = document.getElementById('gateLoginForm');
const gateLoginError = document.getElementById('gateLoginError');

const projectList = document.getElementById('projectList');
const currentProjectTitle = document.getElementById('currentProjectTitle');
const currentProjectDesc = document.getElementById('currentProjectDesc');
const btnNewProject = document.getElementById('btnNewProject');
const btnEditProject = document.getElementById('btnEditProject');
const btnManageMembers = document.getElementById('btnManageMembers');
const btnManageFields = document.getElementById('btnManageFields');
const btnAddTask = document.getElementById('btnAddTask');
const btnNewFolderTop = document.getElementById('btnNewFolderTop');
const btnLogout = document.getElementById('btnLogout');
const userDisplayName = document.getElementById('userDisplayName');
const projectAccessBadge = document.getElementById('projectAccessBadge');
const userRoleSubtext = document.getElementById('userRoleSubtext');

// Modals
const taskModal = document.getElementById('taskModal');
const folderModal = document.getElementById('folderModal');
const projectModal = document.getElementById('projectModal');
const membersModal = document.getElementById('membersModal');
const fieldsModal = document.getElementById('fieldsModal');
const dataTransferModal = document.getElementById('dataTransferModal');

// Forms
const taskForm = document.getElementById('taskForm');
const folderForm = document.getElementById('folderForm');
const projectForm = document.getElementById('projectForm');
const newFieldForm = document.getElementById('newFieldForm');

// Views
const restrictedView = document.getElementById('restrictedView');
const folderView = document.getElementById('folderView');
const boardView = document.getElementById('boardView');
const listView = document.getElementById('listView');
const ganttView = document.getElementById('ganttView');

// Init
document.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  applyProjectsSidebarPreference();
  applyThemePreference();
  await checkAuthAndBootstrap();
});

function setupEventListeners() {
  document.getElementById('btnToggleProjectsSidebar').addEventListener('click', toggleProjectsSidebar);
  document.getElementById('btnToggleTheme').addEventListener('click', toggleTheme);
  // View Switcher
  document.querySelectorAll('.view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentView = btn.dataset.view;
      renderCurrentView();
    });
  });

  // Auth Gate Form
  gateLoginForm.addEventListener('submit', handleGateLogin);
  gateLoginForm.querySelectorAll('input').forEach(input => input.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      gateLoginForm.requestSubmit();
    }
  }));
  btnLogout.addEventListener('click', handleLogout);

  // Project Modals
  btnNewProject.addEventListener('click', () => openProjectModal());
  btnEditProject.addEventListener('click', () => openProjectModal(currentProject));
  document.getElementById('btnCloseProjModal').addEventListener('click', () => projectModal.classList.add('hidden'));
  document.getElementById('btnCancelProjModal').addEventListener('click', () => projectModal.classList.add('hidden'));
  projectForm.addEventListener('submit', handleSaveProject);
  document.getElementById('btnDeleteProject').addEventListener('click', handleDeleteProject);

  // Project Members & Permissions Modal
  btnManageMembers.addEventListener('click', () => openMembersModal());
  document.getElementById('btnCloseMembersModal').addEventListener('click', () => membersModal.classList.add('hidden'));
  document.getElementById('newUserForm').addEventListener('submit', handleCreateUser);

  // Folder Modal
  btnNewFolderTop.addEventListener('click', () => openFolderModal());
  document.getElementById('btnCloseFolderModal').addEventListener('click', () => folderModal.classList.add('hidden'));
  document.getElementById('btnCancelFolderModal').addEventListener('click', () => folderModal.classList.add('hidden'));
  folderForm.addEventListener('submit', handleSaveFolder);
  document.getElementById('btnDeleteFolder').addEventListener('click', handleDeleteFolder);

  // Task Modal
  btnAddTask.addEventListener('click', () => openTaskModal());
  document.getElementById('btnCloseTaskModal').addEventListener('click', () => taskModal.classList.add('hidden'));
  document.getElementById('btnCancelTaskModal').addEventListener('click', () => taskModal.classList.add('hidden'));
  taskForm.addEventListener('submit', handleSaveTask);
  document.getElementById('btnDeleteTask').addEventListener('click', handleDeleteTask);
  document.getElementById('taskStatus').addEventListener('change', event => populateTaskStatusOptions(event.target.value));

  // Progress range label
  document.getElementById('taskProgress').addEventListener('input', (e) => {
    document.getElementById('progressLabel').textContent = e.target.value;
  });

  // Custom Fields Modal
  btnManageFields.addEventListener('click', () => openFieldsModal());
  document.getElementById('btnCloseFieldsModal').addEventListener('click', () => fieldsModal.classList.add('hidden'));
  document.getElementById('newFieldType').addEventListener('change', (e) => {
    document.getElementById('selectOptionsGroup').style.display = e.target.value === 'select' ? 'block' : 'none';
  });
  newFieldForm.addEventListener('submit', handleSaveField);
  document.getElementById('btnCancelEditField').addEventListener('click', resetFieldForm);

  document.getElementById('ganttDayWidth').addEventListener('input', event => {
    document.getElementById('ganttDayWidthValue').textContent = `${event.target.value} px`;
    const preferences = getGanttPreferences();
    preferences.dayWidth = Number(event.target.value);
    saveGanttPreferences(preferences);
    renderGanttView();
  });
  document.getElementById('applyGanttRange').addEventListener('click', applyGanttDateRange);
  document.getElementById('resetGanttRange').addEventListener('click', () => {
    const preferences = getGanttPreferences();
    preferences.rangeStart = '';
    preferences.rangeEnd = '';
    saveGanttPreferences(preferences);
    renderGanttView();
  });
  document.getElementById('toggleGanttSidebar').addEventListener('click', toggleGanttSidebar);
  document.getElementById('ganttResizeHandle').addEventListener('pointerdown', startGanttSidebarResize);
  document.getElementById('ganttResizeHandle').addEventListener('keydown', handleGanttSidebarResizeKey);
  document.getElementById('btnAddProjectHoliday').addEventListener('click', addProjectHoliday);
  document.getElementById('btnDataTransfer').addEventListener('click', () => openDataTransferModal(false));
  document.getElementById('btnExportSelectedFolderTasks').addEventListener('click', () => openDataTransferModal(true));
  document.getElementById('btnExportSelectedListTasks').addEventListener('click', () => openDataTransferModal(true));
  document.getElementById('btnCloseDataTransfer').addEventListener('click', closeDataTransferModal);
  document.getElementById('btnCancelDataTransfer').addEventListener('click', closeDataTransferModal);
  document.getElementById('btnExportTasks').addEventListener('click', exportTasks);
  document.getElementById('taskExportFormat').addEventListener('change', updateExportHint);
  document.getElementById('btnImportTasks').addEventListener('click', importTasks);
  document.getElementById('taskImportFile').addEventListener('change', previewTaskImport);
  document.getElementById('taskImportFormat').addEventListener('change', previewTaskImport);
  document.getElementById('taskImportCourseName').addEventListener('input', previewTaskImport);
  document.getElementById('taskImportUpdateMatches').addEventListener('change', previewTaskImport);
  document.getElementById('exportGanttSvg').addEventListener('click', exportGanttSvg);
  const ganttSidebar = document.getElementById('ganttSidebarCol');
  const ganttChart = document.getElementById('ganttChartArea');
  ganttSidebar.addEventListener('scroll', () => {
    if (ganttChart.scrollTop !== ganttSidebar.scrollTop) ganttChart.scrollTop = ganttSidebar.scrollTop;
  });
  ganttChart.addEventListener('scroll', () => {
    if (ganttSidebar.scrollTop !== ganttChart.scrollTop) ganttSidebar.scrollTop = ganttChart.scrollTop;
  });

  document.getElementById('folderTreeContainer').addEventListener('click', handleFolderTreeAction);
  document.getElementById('gradeScopeSelect').addEventListener('change', event => {
    selectedStatsFolderId = event.target.value || null;
    renderFolderView();
  });
  document.getElementById('listTableBody').addEventListener('click', handleListAction);
  const listTableBody = document.getElementById('listTableBody');
  listTableBody.addEventListener('dragstart', handleListDragStart);
  listTableBody.addEventListener('dragend', handleListDragEnd);
  listTableBody.addEventListener('dragover', handleListDragOver);
  listTableBody.addEventListener('dragleave', handleListDragLeave);
  listTableBody.addEventListener('drop', handleListDrop);
  document.getElementById('excludeDoneTasks').addEventListener('change', event => setExcludeDoneFilter(event.target.checked));
  document.getElementById('excludeDoneTasksGantt').addEventListener('change', event => setExcludeDoneFilter(event.target.checked));
  document.getElementById('clearListSort').addEventListener('click', () => {
    listSortState = [];
    saveListPreferences();
    renderListView();
  });
  document.getElementById('btnDeleteSelectedTasks').addEventListener('click', handleBulkDeleteTasks);
  boardView.addEventListener('dragstart', handleBoardDragStart);
  boardView.addEventListener('dragend', handleBoardDragEnd);
  boardView.addEventListener('dragover', handleBoardDragOver);
  boardView.addEventListener('dragleave', handleBoardDragLeave);
  boardView.addEventListener('drop', handleBoardDrop);

  const ganttViewport = document.getElementById('ganttViewport');
  ganttViewport.addEventListener('dragstart', handleGanttDragStart);
  ganttViewport.addEventListener('dragend', handleGanttDragEnd);
  ganttViewport.addEventListener('dragover', handleGanttDragOver);
  ganttViewport.addEventListener('dragleave', handleGanttDragLeave);
  ganttViewport.addEventListener('drop', handleGanttDrop);
}

function applyProjectsSidebarPreference() {
  let hidden = false;
  try { hidden = localStorage.getItem('pulseplan_projects_sidebar_hidden') === 'true'; } catch {}
  setProjectsSidebarHidden(hidden, false);
}

function toggleProjectsSidebar() {
  const hidden = !document.querySelector('.app-container').classList.contains('projects-sidebar-hidden');
  setProjectsSidebarHidden(hidden, true);
}

function setProjectsSidebarHidden(hidden, persist) {
  document.querySelector('.app-container').classList.toggle('projects-sidebar-hidden', hidden);
  const button = document.getElementById('btnToggleProjectsSidebar');
  button.setAttribute('aria-expanded', String(!hidden));
  button.setAttribute('aria-label', hidden ? 'Show projects sidebar' : 'Hide projects sidebar');
  button.title = hidden ? 'Show projects sidebar' : 'Hide projects sidebar';
  if (persist) {
    try { localStorage.setItem('pulseplan_projects_sidebar_hidden', String(hidden)); } catch {}
  }
}

function applyThemePreference() {
  let theme = 'dark';
  try {
    const saved = localStorage.getItem('myplan_theme');
    if (saved === 'light' || saved === 'dark') theme = saved;
  } catch {}
  setTheme(theme, false);
}

function toggleTheme() {
  const nextTheme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  setTheme(nextTheme, true);
}

function setTheme(theme, persist) {
  const isLight = theme === 'light';
  document.documentElement.dataset.theme = isLight ? 'light' : 'dark';
  const button = document.getElementById('btnToggleTheme');
  button.textContent = isLight ? 'Dark mode' : 'Light mode';
  button.setAttribute('aria-pressed', String(isLight));
  button.setAttribute('aria-label', isLight ? 'Switch to dark mode' : 'Switch to light mode');
  if (persist) {
    try { localStorage.setItem('myplan_theme', isLight ? 'light' : 'dark'); } catch {}
  }
}

function handleBoardDragStart(event) {
  const card = event.target.closest('.task-card');
  if (!card || currentProjectAccess !== 'edit') {
    event.preventDefault();
    return;
  }
  card.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', card.dataset.taskId);
}

function handleBoardDragEnd(event) {
  event.target.closest('.task-card')?.classList.remove('dragging');
  boardView.querySelectorAll('.kanban-column.drag-over').forEach(column => column.classList.remove('drag-over'));
  boardView.querySelectorAll('.kanban-status-bucket.drag-over').forEach(bucket => bucket.classList.remove('drag-over'));
  boardView.querySelectorAll('.task-card.drop-before, .task-card.drop-after').forEach(card => card.classList.remove('drop-before', 'drop-after'));
}

function handleBoardDragOver(event) {
  const column = event.target.closest('.kanban-column');
  if (!column || currentProjectAccess !== 'edit') return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  column.classList.add('drag-over');
  boardView.querySelectorAll('.kanban-status-bucket.drag-over').forEach(bucket => bucket.classList.remove('drag-over'));
  event.target.closest('.kanban-status-bucket')?.classList.add('drag-over');
  boardView.querySelectorAll('.task-card.drop-before, .task-card.drop-after').forEach(card => card.classList.remove('drop-before', 'drop-after'));
  const targetCard = event.target.closest('.task-card');
  if (targetCard && !targetCard.classList.contains('dragging')) {
    const after = event.clientY >= targetCard.getBoundingClientRect().top + targetCard.offsetHeight / 2;
    targetCard.classList.add(after ? 'drop-after' : 'drop-before');
  }
}

function handleBoardDragLeave(event) {
  const column = event.target.closest('.kanban-column');
  if (column && !column.contains(event.relatedTarget)) column.classList.remove('drag-over');
}

async function handleBoardDrop(event) {
  const column = event.target.closest('.kanban-column');
  if (!column || currentProjectAccess !== 'edit') return;
  event.preventDefault();
  const taskId = event.dataTransfer.getData('text/plain');
  const task = tasks.find(item => item.id === taskId);
  const targetStatus = column.dataset.status;
  if (!task) return;

  const orderedByStatus = new Map(['todo', 'in_progress', 'done'].map(status => [
    status,
    [...column.parentElement.querySelectorAll(`#tasks-${status} .task-card`)]
      .map(card => card.dataset.taskId)
      .filter(id => id !== taskId)
  ]));
  const targetIds = orderedByStatus.get(targetStatus);
  const targetBucket = event.target.closest('.kanban-status-bucket');
  const targetCard = event.target.closest('.task-card');
  let targetIndex = targetIds.length;
  if (targetCard && targetCard.dataset.taskId !== taskId) {
    targetIndex = targetIds.indexOf(targetCard.dataset.taskId)
      + (event.clientY >= targetCard.getBoundingClientRect().top + targetCard.offsetHeight / 2 ? 1 : 0);
  } else if (targetBucket) {
    const buckets = [...column.querySelectorAll('.kanban-status-bucket')];
    const bucketIndex = buckets.indexOf(targetBucket);
    const cardsBefore = buckets.slice(0, bucketIndex)
      .flatMap(bucket => [...bucket.querySelectorAll('.task-card')])
      .filter(card => card.dataset.taskId !== taskId).length;
    const cardsInBucket = [...targetBucket.querySelectorAll('.task-card')]
      .filter(card => card.dataset.taskId !== taskId).length;
    targetIndex = cardsBefore + cardsInBucket;
  }
  targetIds.splice(Math.max(0, targetIndex), 0, taskId);
  const taskIds = [...orderedByStatus.values()].flat();
  const statuses = task.status === targetStatus ? {} : { [taskId]: targetStatus };
  const targetLabel = targetBucket
    ? targetBucket.dataset.statusLabel || ''
    : task.status === targetStatus ? (task.status_label || '') : '';
  const statusLabels = (task.status_label || '') === targetLabel ? {} : { [taskId]: targetLabel };

  lastBoardDropAt = Date.now();
  try {
    await persistTaskOrder(taskIds, statuses, statusLabels);
  } catch (error) {
    alert(`Could not move task: ${error.message}`);
    renderBoardView();
  } finally {
    boardView.querySelectorAll('.kanban-column.drag-over').forEach(el => el.classList.remove('drag-over'));
    boardView.querySelectorAll('.kanban-status-bucket.drag-over').forEach(el => el.classList.remove('drag-over'));
    boardView.querySelectorAll('.task-card.drop-before, .task-card.drop-after').forEach(card => card.classList.remove('drop-before', 'drop-after'));
  }
}

async function persistTaskOrder(taskIds, statuses = {}, statusLabels = {}) {
  await api(`/api/projects/${currentProjectId}/tasks/order`, {
    method: 'PATCH',
    body: JSON.stringify({ task_ids: taskIds, statuses, status_labels: statusLabels })
  });
  const positions = new Map(taskIds.map((id, index) => [id, index]));
  tasks.forEach(task => {
    task.sort_order = positions.get(task.id);
    if (Object.hasOwn(statuses, task.id)) task.status = statuses[task.id];
    if (Object.hasOwn(statusLabels, task.id)) task.status_label = statusLabels[task.id];
  });
  tasks.sort((a, b) => Number(a.sort_order) - Number(b.sort_order));
  listSortState = [{ key: 'manual_order', dir: 'asc' }];
  saveListPreferences();
  renderCurrentView();
}

function listPreferencesKey() {
  return `myplan_list_preferences_${currentProjectId || 'none'}`;
}

function loadListPreferences() {
  listSortState = [{ key: 'status', dir: 'asc' }];
  excludeDoneFromList = false;
  try {
    const saved = JSON.parse(localStorage.getItem(listPreferencesKey()) || 'null');
    if (saved && Array.isArray(saved.sort)) {
      listSortState = saved.sort
        .filter(item => item && typeof item.key === 'string'
          && (['status', 'title', 'folder', 'priority', 'start_date', 'due_date', 'grade', 'progress', 'manual_order'].includes(item.key)
            || /^custom:[A-Za-z0-9_-]+$/.test(item.key))
          && ['asc', 'desc'].includes(item.dir))
        .slice(0, 20);
    }
    excludeDoneFromList = saved?.excludeDone === true;
  } catch {
    // Keep defaults when browser storage is unavailable or malformed.
  }
  const listFilter = document.getElementById('excludeDoneTasks');
  const ganttFilter = document.getElementById('excludeDoneTasksGantt');
  if (listFilter) listFilter.checked = excludeDoneFromList;
  if (ganttFilter) ganttFilter.checked = excludeDoneFromList;
}

function saveListPreferences() {
  if (!currentProjectId) return;
  try {
    localStorage.setItem(listPreferencesKey(), JSON.stringify({
      sort: listSortState,
      excludeDone: excludeDoneFromList
    }));
  } catch {
    // The current session still uses the selected options if storage is unavailable.
  }
}

function collapsedFoldersKey() {
  return `myplan_collapsed_folders_${currentProjectId || 'none'}`;
}

function loadCollapsedFolders() {
  collapsedFolderIds = new Set();
  try {
    const saved = JSON.parse(localStorage.getItem(collapsedFoldersKey()) || '[]');
    if (Array.isArray(saved)) collapsedFolderIds = new Set(saved.filter(id => typeof id === 'string'));
  } catch {
    // Keep all folders expanded if browser storage is unavailable or malformed.
  }
}

function saveCollapsedFolders() {
  if (!currentProjectId) return;
  try {
    localStorage.setItem(collapsedFoldersKey(), JSON.stringify([...collapsedFolderIds]));
  } catch {
    // The current session still uses the selected collapsed state if storage is unavailable.
  }
}

function learningSuiteSyncMapKey(courseId) {
  return `myplan_learning_suite_sync_${currentProjectId || 'none'}_${String(courseId || 'unknown')}`;
}

function loadLearningSuiteSyncMap(courseId) {
  try {
    const saved = JSON.parse(localStorage.getItem(learningSuiteSyncMapKey(courseId)) || '{}');
    return {
      folders: saved.folders && typeof saved.folders === 'object' ? saved.folders : {},
      tasks: saved.tasks && typeof saved.tasks === 'object' ? saved.tasks : {}
    };
  } catch {
    return { folders: {}, tasks: {} };
  }
}

function saveLearningSuiteSyncMap(courseId, map) {
  try { localStorage.setItem(learningSuiteSyncMapKey(courseId), JSON.stringify(map)); } catch {}
}

function clearGanttDropMarkers(clearDragging = true) {
  if (clearDragging) document.querySelectorAll('.gantt-sidebar-cell.dragging, .gantt-bar-item.dragging').forEach(el => el.classList.remove('dragging'));
  document.querySelectorAll('.gantt-sidebar-cell.drop-before, .gantt-sidebar-cell.drop-after, .gantt-row.drop-before, .gantt-row.drop-after')
    .forEach(el => el.classList.remove('drop-before', 'drop-after'));
}

function handleGanttDragStart(event) {
  const draggable = event.target.closest('.gantt-sidebar-cell[draggable="true"], .gantt-bar-item[draggable="true"]');
  if (!draggable || currentProjectAccess !== 'edit') {
    event.preventDefault();
    return;
  }
  draggable.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', draggable.dataset.taskId);
}

function handleGanttDragEnd() {
  clearGanttDropMarkers();
  ganttViewportDragPosition = null;
}

function handleGanttDragOver(event) {
  const target = event.target.closest('.gantt-sidebar-cell, .gantt-row, .gantt-bar-item');
  if (!target || currentProjectAccess !== 'edit') return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  clearGanttDropMarkers(false);
  const taskId = target.dataset.taskId || target.closest('[data-task-id]')?.dataset.taskId;
  const sidebarCell = target.classList.contains('gantt-sidebar-cell') ? target : document.querySelector(`.gantt-sidebar-cell[data-task-id="${CSS.escape(taskId || '')}"]`);
  const row = target.classList.contains('gantt-row') ? target : document.querySelector(`.gantt-row[data-task-id="${CSS.escape(taskId || '')}"]`);
  if (!taskId) return;
  const after = event.clientY >= target.getBoundingClientRect().top + target.offsetHeight / 2;
  [sidebarCell, row].filter(Boolean).forEach(el => el.classList.add(after ? 'drop-after' : 'drop-before'));
  ganttViewportDragPosition = { taskId, after };
}

let ganttViewportDragPosition = null;

function handleGanttDragLeave(event) {
  if (!event.currentTarget.contains(event.relatedTarget)) clearGanttDropMarkers();
}

async function handleGanttDrop(event) {
  const draggedId = event.dataTransfer.getData('text/plain');
  const target = event.target.closest('.gantt-sidebar-cell, .gantt-row, .gantt-bar-item');
  const targetId = ganttViewportDragPosition?.taskId || target?.dataset.taskId;
  const after = ganttViewportDragPosition?.after ?? false;
  event.preventDefault();
  clearGanttDropMarkers();
  ganttViewportDragPosition = null;
  if (!draggedId || !targetId || draggedId === targetId || currentProjectAccess !== 'edit') return;

  const ordered = sortTasks(tasks, folders, listSortState, projectStatusOptions()).map(task => task.id);
  const fromIndex = ordered.indexOf(draggedId);
  const targetIndex = ordered.indexOf(targetId);
  if (fromIndex < 0 || targetIndex < 0) return;
  ordered.splice(fromIndex, 1);
  const insertAt = ordered.indexOf(targetId) + (after ? 1 : 0);
  ordered.splice(insertAt, 0, draggedId);
  try {
    lastGanttDropAt = Date.now();
    await persistTaskOrder(ordered);
  } catch (error) {
    alert(`Could not reorder Gantt tasks: ${error.message}`);
  }
}

function getGanttPreferenceKey() {
  return `myplan_gantt_preferences_${currentProjectId || 'none'}`;
}

function getGanttPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(getGanttPreferenceKey()) || '{}');
    return {
      dayWidth: Math.max(16, Math.min(160, Number(saved.dayWidth) || 40)),
      sidebarWidth: Math.max(180, Math.min(600, Number(saved.sidebarWidth) || 250)),
      sidebarHidden: Boolean(saved.sidebarHidden),
      rangeStart: typeof saved.rangeStart === 'string' ? saved.rangeStart : '',
      rangeEnd: typeof saved.rangeEnd === 'string' ? saved.rangeEnd : '',
    };
  } catch {
    return { dayWidth: 40, sidebarWidth: 250, sidebarHidden: false, rangeStart: '', rangeEnd: '' };
  }
}

function saveGanttPreferences(preferences) {
  localStorage.setItem(getGanttPreferenceKey(), JSON.stringify(preferences));
}

function toggleGanttSidebar() {
  const preferences = getGanttPreferences();
  preferences.sidebarHidden = !preferences.sidebarHidden;
  saveGanttPreferences(preferences);
  renderGanttView();
}

function applyGanttDateRange() {
  const rangeStart = document.getElementById('ganttRangeStart').value;
  const rangeEnd = document.getElementById('ganttRangeEnd').value;
  if (!rangeStart || !rangeEnd || rangeEnd < rangeStart) {
    alert('Choose a start date and an end date on or after the start date.');
    return;
  }
  const preferences = getGanttPreferences();
  preferences.rangeStart = rangeStart;
  preferences.rangeEnd = rangeEnd;
  saveGanttPreferences(preferences);
  renderGanttView();
}

function startGanttSidebarResize(event) {
  if (getGanttPreferences().sidebarHidden) return;
  event.preventDefault();
  const viewport = document.getElementById('ganttViewport');
  const sidebar = document.getElementById('ganttSidebarCol');
  const preferences = getGanttPreferences();
  const resize = moveEvent => {
    const width = Math.max(180, Math.min(600, moveEvent.clientX - viewport.getBoundingClientRect().left));
    sidebar.style.width = `${width}px`;
    preferences.sidebarWidth = width;
  };
  const finish = () => {
    window.removeEventListener('pointermove', resize);
    window.removeEventListener('pointerup', finish);
    saveGanttPreferences(preferences);
  };
  window.addEventListener('pointermove', resize);
  window.addEventListener('pointerup', finish, { once: true });
}

function handleGanttSidebarResizeKey(event) {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  const preferences = getGanttPreferences();
  preferences.sidebarWidth = Math.max(180, Math.min(600, preferences.sidebarWidth + (event.key === 'ArrowRight' ? 16 : -16)));
  saveGanttPreferences(preferences);
  renderGanttView();
  document.getElementById('ganttResizeHandle').focus();
}

function handleListDragStart(event) {
  const row = event.target.closest('tr[data-task-id]');
  if (!row || currentProjectAccess !== 'edit' || event.target.closest('button, input, select, a')) {
    event.preventDefault();
    return;
  }
  row.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', row.dataset.taskId);
}

function handleListDragEnd() {
  const tbody = document.getElementById('listTableBody');
  tbody.querySelectorAll('tr.dragging, tr.drop-before, tr.drop-after').forEach(row => row.classList.remove('dragging', 'drop-before', 'drop-after'));
}

function handleListDragOver(event) {
  const targetRow = event.target.closest('tr[data-task-id]');
  if (!targetRow || currentProjectAccess !== 'edit') return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('#listTableBody tr.drop-before, #listTableBody tr.drop-after').forEach(row => row.classList.remove('drop-before', 'drop-after'));
  if (targetRow.classList.contains('dragging')) return;
  const after = event.clientY >= targetRow.getBoundingClientRect().top + targetRow.offsetHeight / 2;
  targetRow.classList.add(after ? 'drop-after' : 'drop-before');
}

function handleListDragLeave(event) {
  const tbody = event.currentTarget;
  if (!tbody.contains(event.relatedTarget)) {
    tbody.querySelectorAll('tr.drop-before, tr.drop-after').forEach(row => row.classList.remove('drop-before', 'drop-after'));
  }
}

async function handleListDrop(event) {
  const targetRow = event.target.closest('tr[data-task-id]');
  if (!targetRow || currentProjectAccess !== 'edit') return;
  event.preventDefault();
  const draggedId = event.dataTransfer.getData('text/plain');
  const targetId = targetRow.dataset.taskId;
  if (!draggedId || draggedId === targetId) return;

  const visibleIds = sortedTasks().map(task => task.id);
  const fromIndex = visibleIds.indexOf(draggedId);
  const targetIndex = visibleIds.indexOf(targetId);
  if (fromIndex < 0 || targetIndex < 0) return;
  visibleIds.splice(fromIndex, 1);
  const after = event.clientY >= targetRow.getBoundingClientRect().top + targetRow.offsetHeight / 2;
  visibleIds.splice(visibleIds.indexOf(targetId) + (after ? 1 : 0), 0, draggedId);

  // Keep hidden done tasks in their existing slots while reordering visible rows.
  const allSortedIds = sortTasks(tasks, folders, listSortState, projectStatusOptions()).map(task => task.id);
  const visibleSet = new Set(sortedTasks().map(task => task.id));
  let visibleIndex = 0;
  const completeOrder = allSortedIds.map(id => visibleSet.has(id) ? visibleIds[visibleIndex++] : id);
  lastListDropAt = Date.now();
  try {
    await persistTaskOrder(completeOrder);
  } catch (error) {
    alert(`Could not reorder list tasks: ${error.message}`);
  }
}

function handleFolderTreeAction(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const taskRow = button.closest('.tree-task-row');
  if (taskRow && button.dataset.action === 'edit-task') {
    event.stopPropagation();
    const task = tasks.find(item => item.id === taskRow.dataset.taskId);
    if (task) openTaskModal(task);
    return;
  }
  const node = button.closest('.folder-node');
  const folder = folders.find(item => item.id === node?.dataset.folderId);
  if (!folder) return;
  event.stopPropagation();
  if (button.dataset.action === 'add-subfolder') openFolderModal(null, folder.id);
  else if (button.dataset.action === 'add-task') openTaskModal(null, folder.id);
  else if (button.dataset.action === 'edit-folder') openFolderModal(folder);
}

function handleListAction(event) {
  const button = event.target.closest('[data-action="edit-task"]');
  if (!button) return;
  event.stopPropagation();
  const task = tasks.find(item => item.id === button.closest('tr')?.dataset.taskId);
  if (task) openTaskModal(task);
}

function getTaskFolderColor(task) {
  const visited = new Set();
  let folder = folders.find(item => item.id === task.folder_id);
  while (folder && !visited.has(folder.id)) {
    visited.add(folder.id);
    if (typeof folder.color === 'string' && /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(folder.color)) {
      return folder.color;
    }
    folder = folders.find(item => item.id === folder.parent_id);
  }
  return '';
}

function applyTaskFolderColor(element, task) {
  const color = getTaskFolderColor(task);
  if (color) element.style.setProperty('--folder-color', color);
}

function readableTextColor(hexColor) {
  const value = String(hexColor || '').replace('#', '');
  const expanded = value.length === 3 ? value.split('').map(char => char + char).join('') : value;
  if (!/^[\da-f]{6}$/i.test(expanded)) return '#f1f7f5';
  const channels = [0, 2, 4].map(index => parseInt(expanded.slice(index, index + 2), 16) / 255)
    .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  return luminance > 0.42 ? '#06231c' : '#f1f7f5';
}

// ----------------- Strict API Helper -----------------
async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json' };

  const res = await fetch(path, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) }
  });

  if (res.status === 401) {
    // Session expired or unauthenticated -> Force Login Gate!
    showAuthGate();
    throw new Error('Unauthenticated');
  }

  if (!res.ok) {
    let errMessage = 'API Error';
    try {
      const errJson = await res.json();
      errMessage = errJson.error || JSON.stringify(errJson);
    } catch {
      errMessage = await res.text();
    }
    throw new Error(errMessage || `HTTP ${res.status}`);
  }
  return res.json();
}

// ----------------- Mandatory Initial Authentication -----------------
async function checkAuthAndBootstrap() {
  try {
    const res = await api('/api/auth/me');
    currentUser = res.user;
    hideAuthGate();
    userDisplayName.textContent = currentUser.name;
    userRoleSubtext.textContent = currentUser.systemRole === 'admin' ? '(System Admin)' : '';
    await loadProjects();
  } catch (err) {
    showAuthGate();
  }
}

function showAuthGate() {
  authGateOverlay.classList.remove('hidden');
  gateLoginError.classList.add('hidden');
  gateLoginError.textContent = '';
}

function hideAuthGate() {
  authGateOverlay.classList.add('hidden');
}

async function handleGateLogin(e) {
  e.preventDefault();
  const username = document.getElementById('gateUsername').value.trim();
  const password = document.getElementById('gatePassword').value;
  await performLogin(username, password);
}

async function performLogin(username, password) {
  gateLoginError.classList.add('hidden');
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Login failed');
    }

    const data = await res.json();
    currentUser = data.user;
    userDisplayName.textContent = currentUser.name;
    userRoleSubtext.textContent = currentUser.systemRole === 'admin' ? '(System Admin)' : '';

    hideAuthGate();
    gateLoginForm.reset();
    await loadProjects();
  } catch (err) {
    gateLoginError.textContent = err.message;
    gateLoginError.classList.remove('hidden');
  }
}

async function handleLogout() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch (e) { }
  currentUser = null;
  currentProjectId = null;
  currentProject = null;
  projects = [];
  tasks = [];
  folders = [];
  showAuthGate();
}

// ----------------- Projects & Project-Dependent Permissions -----------------
async function loadProjects() {
  if (!currentUser) return;
  try {
    projects = await api('/api/projects');
    renderSidebarProjects();

    if (projects.length > 0) {
      if (!currentProjectId || !projects.find(p => p.id === currentProjectId)) {
        await selectProject(projects[0].id);
      } else {
        await selectProject(currentProjectId);
      }
    } else {
      currentProjectId = null;
      currentProject = null;
      btnManageMembers.classList.toggle('hidden', currentUser?.systemRole !== 'admin');
      currentProjectTitle.textContent = 'No Projects Available';
      currentProjectDesc.textContent = 'You are not assigned to any projects. Click + to create one.';
      tasks = [];
      folders = [];
      renderCurrentView();
    }
  } catch (err) {
    console.error('Failed to load projects', err);
  }
}

async function selectProject(id) {
  if (currentProjectId !== id) {
    selectedStatsFolderId = undefined;
    selectedTaskIds.clear();
  }
  currentProjectId = id;
  currentProject = projects.find(p => p.id === id);
  if (!currentProject) return;
  loadListPreferences();
  loadCollapsedFolders();

  // Retrieve project details and verified user access level for this specific project
  try {
    const projDetail = await api(`/api/projects/${id}`);
    currentProjectAccess = projDetail.user_access_level || 'none';
  } catch {
    currentProjectAccess = 'none';
  }

  currentProjectTitle.textContent = currentProject.name;
  currentProjectDesc.textContent = currentProject.description || 'No description provided';

  // Update Access Badge
  projectAccessBadge.textContent = currentProjectAccess.toUpperCase();
  projectAccessBadge.className = 'badge';
  if (currentProjectAccess === 'edit') {
    projectAccessBadge.classList.add('badge-success');
  } else if (currentProjectAccess === 'view') {
    projectAccessBadge.classList.add('badge-medium');
  } else {
    projectAccessBadge.classList.add('badge-urgent');
  }

  // Enforce Project-Dependent Permissions in UI
  const canEdit = currentProjectAccess === 'edit';
  const hasAccess = currentProjectAccess !== 'none';

  document.querySelectorAll('.edit-required').forEach(el => {
    if (canEdit) {
      el.removeAttribute('disabled');
      el.style.opacity = '1';
      el.style.pointerEvents = 'auto';
    } else {
      el.setAttribute('disabled', 'true');
      el.style.opacity = '0.5';
      el.style.pointerEvents = 'none';
    }
  });
  btnManageMembers.classList.toggle('hidden', currentUser?.systemRole !== 'admin');

  if (!hasAccess) {
    restrictedView.classList.remove('hidden');
    folderView.classList.remove('active');
    boardView.classList.remove('active');
    listView.classList.remove('active');
    ganttView.classList.remove('active');
    document.querySelector('.view-switcher').style.display = 'none';
    return;
  } else {
    restrictedView.classList.add('hidden');
    document.querySelector('.view-switcher').style.display = 'flex';
  }

  // Set default view preference if set
  if (currentProject.default_view) {
    currentView = currentProject.default_view;
    document.querySelectorAll('.view-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.view === currentView);
    });
  }

  renderSidebarProjects();
  await loadFolders();
  await loadCustomFields();
  await loadTasks();
}

async function loadFolders() {
  if (!currentProjectId || currentProjectAccess === 'none') return;
  folders = await api(`/api/projects/${currentProjectId}/folders`);
}

async function loadCustomFields() {
  if (!currentProjectId || currentProjectAccess === 'none') return;
  customFields = await api(`/api/projects/${currentProjectId}/fields`);
}

async function loadTasks() {
  if (!currentProjectId || currentProjectAccess === 'none') return;
  tasks = await api(`/api/projects/${currentProjectId}/tasks`);
  renderCurrentView();
}

function renderSidebarProjects() {
  projectList.innerHTML = '';
  projects.forEach(p => {
    const li = document.createElement('li');
    li.className = `project-item ${p.id === currentProjectId ? 'active' : ''}`;
    li.innerHTML = `
      <div class="project-name-wrapper">
        <span class="project-indicator" style="background-color: ${p.color || '#38d8aa'}"></span>
        <span>${escapeHtml(p.name)}</span>
      </div>
      <span class="default-view-tag">${escapeHtml(p.default_view || 'folder')}</span>
    `;
    li.addEventListener('click', () => selectProject(p.id));
    projectList.appendChild(li);
  });
}

function renderCurrentView() {
  if (currentProjectAccess === 'none') return;
  if (currentView !== 'folder') calculateFolderTreeGrades();

  folderView.classList.remove('active');
  boardView.classList.remove('active');
  listView.classList.remove('active');
  ganttView.classList.remove('active');

  if (currentView === 'folder') {
    folderView.classList.add('active');
    renderFolderView();
  } else if (currentView === 'board') {
    boardView.classList.add('active');
    renderBoardView();
  } else if (currentView === 'list') {
    listView.classList.add('active');
    renderListView();
  } else if (currentView === 'gantt') {
    ganttView.classList.add('active');
    renderGanttView();
  }
}

// ----------------- Task Transfer & Gantt Export -----------------
function openDataTransferModal(selectedOnly = false) {
  exportSelectedOnly = Boolean(selectedOnly);
  pendingImport = null;
  document.getElementById('taskImportFile').value = '';
  document.getElementById('taskImportFormat').value = 'auto';
  document.getElementById('taskImportCourseName').value = '';
  document.getElementById('taskImportCourseNameGroup').hidden = true;
  document.getElementById('learningSuiteImportInstructions').hidden = true;
  document.getElementById('taskImportUpdateMatchesGroup').hidden = true;
  document.getElementById('taskImportUpdateMatches').checked = true;
  document.getElementById('taskImportPreview').textContent = 'Choose a file to preview its rows.';
  document.getElementById('btnImportTasks').disabled = true;
  document.getElementById('btnExportTasks').textContent = exportSelectedOnly ? 'Download selected tasks' : 'Download tasks';
  updateExportHint();
  dataTransferModal.classList.remove('hidden');
}

function updateExportHint() {
  const format = document.getElementById('taskExportFormat').value;
  const hints = {
    json: "JSON preserves this app's folders, custom fields, project settings, and task dependencies.",
    csv: 'Generic CSV includes task fields, full folder paths, dependencies, and custom-field columns.',
    planner: 'Planner profile CSV follows common Planner spreadsheet columns and includes the full folder path. Planner’s documented export is Excel; this file is a spreadsheet interchange format, not a direct upload to Planner.',
    monday: 'monday.com profile CSV uses Item, Group, Status, Priority, and date columns, plus folder paths and custom fields.',
    clickup: 'ClickUp profile CSV uses Task Name, List Name, Status, Priority, dates, tags, and custom-field columns.'
  };
  const selectionHint = exportSelectedOnly
    ? ` Exporting ${tasks.filter(task => selectedTaskIds.has(task.id)).length} selected task(s).`
    : '';
  document.getElementById('taskExportHint').textContent = `${hints[format] || hints.json}${selectionHint}`;
}

function closeDataTransferModal() {
  dataTransferModal.classList.add('hidden');
  pendingImport = null;
}

function downloadFile(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function transferFilename(ext) {
  const name = (currentProject?.name || 'project').normalize('NFKD').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  return `${name || 'project'}-tasks.${ext}`;
}

function ganttFilename() {
  const name = (currentProject?.name || 'project').normalize('NFKD').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  return `${name || 'project'}-gantt.svg`;
}

function taskTransferRecords(sourceTasks = tasks) {
  return sourceTasks.map(task => {
    const folder = folders.find(item => item.id === task.folder_id);
    const folderPath = getFolderPath(task.folder_id, folders);
    return {
      ...task,
      title: task.title,
      status: getTaskStatusLabel(task),
      status_group: task.status,
      folder_path: folderPath,
      bucket_name: folderPath.split(' / ').at(-1) || '',
      group_name: folderPath.split(' / ').at(-1) || '',
      list_name: folderPath.split(' / ').at(-1) || '',
      planner_status: task.status === 'done' ? 'Completed' : task.status === 'in_progress' ? 'In progress' : 'Not started',
      planner_priority: ({ urgent: 1, high: 2, medium: 3, low: 4 })[task.priority] || 3,
      monday_status: task.status === 'done' ? 'Done' : task.status === 'in_progress' ? 'Working on it' : 'Not started',
      monday_priority: ({ none: 'None', urgent: 'Critical', high: 'High', medium: 'Medium', low: 'Low' })[task.priority] || 'Medium',
      clickup_status: task.status === 'done' ? 'complete' : task.status === 'in_progress' ? 'in progress' : 'to do',
      clickup_priority: ({ none: 'none', urgent: 1, high: 2, medium: 3, low: 4 })[task.priority] ?? 3,
      labels: '',
      tags: '',
      dependencies: (task.dependencies || []).join(';'),
      ...(customFields.reduce((values, field) => {
        values[`Custom: ${field.name}`] = task.custom_values?.[field.id] ?? '';
        return values;
      }, {})),
      _folder: folder,
    };
  });
}

function exportTasks() {
  const format = document.getElementById('taskExportFormat').value;
  const sourceTasks = exportSelectedOnly ? tasks.filter(task => selectedTaskIds.has(task.id)) : tasks;
  if (!sourceTasks.length) {
    alert('Select at least one task to export.');
    return;
  }
  if (format === 'json') {
    const selectedIds = new Set(sourceTasks.map(task => task.id));
    const includedFolderIds = new Set();
    if (exportSelectedOnly) {
      sourceTasks.forEach(task => {
        let folder = folders.find(item => item.id === task.folder_id);
        const visited = new Set();
        while (folder && !visited.has(folder.id)) {
          visited.add(folder.id);
          includedFolderIds.add(folder.id);
          folder = folders.find(item => item.id === folder.parent_id);
        }
      });
    }
    const backup = {
      format: 'myplan-task-backup',
      version: 1,
      exported_at: new Date().toISOString(),
      project: currentProject,
      folders: exportSelectedOnly ? folders.filter(folder => includedFolderIds.has(folder.id)) : folders,
      custom_fields: customFields,
      tasks: sourceTasks.map(task => exportSelectedOnly
        ? { ...task, dependencies: (task.dependencies || []).filter(id => selectedIds.has(id)) }
        : task)
    };
    downloadFile(transferFilename('json'), JSON.stringify(backup, null, 2), 'application/json;charset=utf-8');
    return;
  }

  const profile = getCsvProfile(format);
  const records = taskTransferRecords(sourceTasks);
  const headers = profile.map(([header]) => header);
  for (const field of customFields) headers.push(`Custom: ${field.name}`);
  const rows = records.map(task => Object.fromEntries([
    ...profile.map(([header, getValue]) => [header, getValue(task)]),
    ...customFields.map(field => [`Custom: ${field.name}`, task.custom_values?.[field.id] ?? ''])
  ]));
  downloadFile(transferFilename('csv'), '\uFEFF' + serializeCsv(headers, rows), 'text/csv;charset=utf-8');
}

function previewTaskImport() {
  const file = document.getElementById('taskImportFile').files[0];
  const preview = document.getElementById('taskImportPreview');
  const importButton = document.getElementById('btnImportTasks');
  const chosenFormat = document.getElementById('taskImportFormat').value;
  const isLearningSuiteFile = chosenFormat === 'learning_suite_html' || file?.name.toLowerCase().endsWith('.html');
  document.getElementById('taskImportCourseNameGroup').hidden = !isLearningSuiteFile;
  document.getElementById('learningSuiteImportInstructions').hidden = !isLearningSuiteFile;
  document.getElementById('taskImportUpdateMatchesGroup').hidden = !isLearningSuiteFile;
  pendingImport = null;
  importButton.disabled = true;
  if (!file) { preview.textContent = 'Choose a file to preview its rows.'; return; }
  if (file.name.toLowerCase().endsWith('.html')) document.getElementById('taskImportFormat').value = 'learning_suite_html';

  const reader = new FileReader();
  reader.onload = () => {
    const content = String(reader.result || '');
    try {
      if (chosenFormat === 'learning_suite_html' || file.name.toLowerCase().endsWith('.html')) {
        const courseNameField = document.getElementById('taskImportCourseName');
        const parsed = parseLearningSuiteHtml(content, courseNameField.value);
        if (!courseNameField.value) courseNameField.value = parsed.courseName;
        const mergePreview = previewLearningSuiteMatches(
          parsed.backup,
          folders,
          tasks,
          loadLearningSuiteSyncMap(parsed.courseId)
        );
        pendingImport = {
          type: 'learning_suite_html', data: parsed.backup,
          count: parsed.backup.tasks.length, skipped: 0, mergePreview
        };
        const mergeEnabled = document.getElementById('taskImportUpdateMatches').checked;
        const updates = mergeEnabled ? mergePreview.updated : 0;
        const adds = mergeEnabled ? mergePreview.added : parsed.backup.tasks.length;
        const ambiguous = mergeEnabled ? mergePreview.ambiguous : 0;
        const existingCategories = parsed.backup.folders.filter(folder => folder.parent_id && mergePreview.matchedFolders.has(folder.id)).length;
        const categoryCount = parsed.backup.folders.filter(folder => folder.parent_id).length;
        const newCategories = Math.max(0, categoryCount - existingCategories);
        preview.textContent = `BYU Learning Suite: ${parsed.backup.tasks.length} assignments, ${parsed.backup.folders.length - 1} categories, ${parsed.gradedCount} graded. Ready to add ${adds} and update ${updates} matching task(s); ${newCategories} category folder(s) will be added and ${existingCategories} refreshed. ${ambiguous} ambiguous title match(es) will be skipped.`;
      } else if (file.name.toLowerCase().endsWith('.json') || content.trimStart().startsWith('{')) {
        const backup = JSON.parse(content);
        const rows = Array.isArray(backup) ? backup : backup.tasks;
        if (!Array.isArray(rows)) throw new Error('The JSON file does not contain a tasks array.');
        const validCount = rows.filter(row => String(row.title || row.name || row.task_name || '').trim()).length;
        pendingImport = { type: 'json', data: backup, count: validCount, skipped: rows.length - validCount };
        preview.textContent = `MyPlan/JSON data: ${validCount} task(s) ready; ${rows.length - validCount} row(s) without a task name will be skipped. Folders and custom fields: ${backup.folders?.length || 0} / ${backup.custom_fields?.length || 0}.`;
      } else {
        const { headers, records } = parseCsv(content);
        if (!headers.length) throw new Error('No CSV header row was found.');
        const chosen = document.getElementById('taskImportFormat').value;
        const profile = chosen === 'auto' ? detectCsvProfile(headers) : chosen;
        const mapped = records.map(record => normalizeImportRow(record, headers));
        const validRows = mapped.filter(row => row.title);
        const skipped = mapped.length - validRows.length;
        const known = new Set(['taskid', 'id', 'customtaskid', 'taskcustomid', 'myplantaskid', 'myplandependencies', 'taskname', 'tasktitle', 'title', 'name', 'item', 'task', 'description', 'taskcontent', 'notes', 'details', 'status', 'statusgroup', 'taskstatusgroup', 'progress', 'taskstatus', 'priority', 'folderpath', 'foldernamepath', 'folder', 'bucketname', 'group', 'groupname', 'listname', 'lists', 'list', 'startdate', 'startdatetext', 'start', 'starttime', 'remindertime', 'duedate', 'duedatetext', 'deadline', 'date', 'duetime', 'duedatetime', 'taskopensat', 'opensat', 'openat', 'progresspercent', 'completion', 'percentcomplete', 'earnedpoints', 'pointsreceived', 'maxpoints', 'pointstotal', 'gradeoverride', 'grade', 'gradepercent', 'weightoverride', 'gradeweight', 'dependencies', 'dependson', 'predecessors']);
        known.add('extracredit');
        known.add('myplanextracredit');
        known.add('bonuswork');
        const unknown = headers.filter(header => !known.has(normalizeHeader(header)));
        pendingImport = { type: 'csv', profile, headers, records, mapped, count: validRows.length, skipped };
        const sample = validRows.slice(0, 5).map(row => row.title).join(' · ');
        preview.textContent = `${profileLabel(profile)} CSV: ${validRows.length} task(s) ready; ${skipped} row(s) without a task name will be skipped. ${unknown.length} custom column(s): ${unknown.map(header => header.replace(/^custom\s*:\s*/i, '')).join(', ') || 'none'}.${sample ? ` Sample: ${sample}` : ''}`;
      }
      const missingCourseName = isLearningSuiteFile && !document.getElementById('taskImportCourseName').value.trim();
      importButton.disabled = !pendingImport.count || currentProjectAccess !== 'edit' || missingCourseName;
    } catch (error) {
      const needsCourseName = isLearningSuiteFile && /does not show the course name/i.test(error.message);
      preview.textContent = needsCourseName
        ? 'This saved page does not show a readable course name. Enter the course name above, then preview again.'
        : `Could not read this file: ${error.message}`;
      pendingImport = null;
    }
  };
  reader.onerror = () => { preview.textContent = 'Could not read the selected file.'; };
  reader.readAsText(file);
}

function profileLabel(profile) {
  return ({ planner: 'Microsoft Planner', monday: 'monday.com', clickup: 'ClickUp', generic: 'Generic' })[profile] || 'Generic';
}

function parseTransferDate(value) {
  return parseTransferDateValue(value);
}

function parseTransferNumber(value) {
  if (value === '' || value == null) return null;
  const number = Number(String(value).replace(/[%,$\s]/g, ''));
  return Number.isFinite(number) ? number : null;
}

function normalizeTransferStatus(value, progressValue = '') {
  const status = String(value || '').toLowerCase().replace(/[_-]/g, ' ');
  if (/complete|finished|closed|done/.test(status)) return 'done';
  if (/^(todo|to do|not active|not started|open|new|pending)$/.test(status)) return 'todo';
  if (/progress|working|active|started|in work/.test(status)) return 'in_progress';
  const progress = parseTransferNumber(progressValue || value);
  return progress >= 100 ? 'done' : progress > 0 ? 'in_progress' : 'todo';
}

function isBuiltInStatusLabel(value) {
  return /^(todo|to do|not active|not started|open|new|pending|in progress|active|working|done|completed|complete|finished|closed)$/i
    .test(String(value || '').trim().replace(/[_-]/g, ' '));
}

function getTaskStatusLabel(task) {
  if (task?.status_label?.trim()) return task.status_label.trim();
  return ({ todo: 'Not Active', in_progress: 'Active', done: 'Completed' })[task?.status] || 'Not Active';
}

function projectStatusOptions() {
  try {
    const options = JSON.parse(currentProject?.status_options_json || '{}');
    return {
      todo: Array.isArray(options.todo) ? options.todo : [],
      in_progress: Array.isArray(options.in_progress) ? options.in_progress : [],
      done: Array.isArray(options.done) ? options.done : []
    };
  } catch {
    return { todo: [], in_progress: [], done: [] };
  }
}

function populateTaskStatusOptions(group, selectedLabel = '') {
  const select = document.getElementById('taskStatusLabel');
  const groupName = ({ todo: 'Not Active', in_progress: 'Active', done: 'Completed' })[group] || 'Not Active';
  const labels = projectStatusOptions()[group] || [];
  const options = [['', `Use ${groupName}`], ...labels.map(label => [label, label])];
  if (selectedLabel && !labels.includes(selectedLabel)) options.push([selectedLabel, `${selectedLabel} (existing)`]);
  select.replaceChildren(...options.map(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    return option;
  }));
  select.value = selectedLabel;
}

function normalizeTransferPriority(value, profile) {
  const priority = String(value ?? '').trim().toLowerCase();
  if (['none', 'no priority', 'no priority set'].includes(priority)) return 'none';
  if (['1', 'p0', 'urgent', 'critical'].includes(priority)) return 'urgent';
  if (['2', 'p1', 'high', 'important'].includes(priority)) return 'high';
  if (['4', 'p3', 'low'].includes(priority)) return 'low';
  if (['3', 'p2', 'normal', 'medium'].includes(priority)) return 'medium';
  if (profile === 'planner' && priority === '0') return 'urgent';
  return 'medium';
}

function normalizeImportTime(value) {
  return parseTransferTimeValue(value);
}

async function getOrCreateImportFolder(path, folderCache, weight = null) {
  const names = String(path || '').split(/\s*(?:\/|>|\\|\|)\s*/).map(name => name.trim()).filter(Boolean);
  let parentId = null;
  let accumulated = '';
  for (const name of names) {
    accumulated = accumulated ? `${accumulated} / ${name}` : name;
    let folder = folderCache.find(item => item.parent_id === parentId && item.name.toLowerCase() === name.toLowerCase());
    if (!folder) {
      folder = await api(`/api/projects/${currentProjectId}/folders`, {
        method: 'POST',
        body: JSON.stringify({ name, parent_id: parentId, weight_percent: names.length === 1 ? weight : 0 })
      });
      folders.push(folder);
      folderCache.push(folder);
    }
    parentId = folder.id;
  }
  return parentId || '';
}

async function ensureImportCustomFields(names, definitions = []) {
  const byName = new Map(customFields.map(field => [normalizeHeader(field.name), field.id]));
  const ids = {};
  for (const name of names) {
    const cleanName = String(name || '').trim().slice(0, 100);
    if (!cleanName) continue;
    const key = normalizeHeader(cleanName);
    let id = byName.get(key);
    if (!id) {
      const definition = definitions.find(field => normalizeHeader(field.name) === key);
      const allowedTypes = ['text', 'number', 'select', 'date', 'checkbox'];
      const fieldType = allowedTypes.includes(definition?.field_type) ? definition.field_type : 'text';
      let options = Array.isArray(definition?.options) ? definition.options : [];
      if (!options.length && definition?.options_json) {
        try { options = JSON.parse(definition.options_json); } catch { options = []; }
      }
      const created = await api(`/api/projects/${currentProjectId}/fields`, {
        method: 'POST', body: JSON.stringify({ name: cleanName, field_type: fieldType, options })
      });
      id = created.id;
      customFields.push({ ...created, name: cleanName, field_type: fieldType, options });
      byName.set(key, id);
    }
    ids[key] = id;
  }
  return ids;
}

function inferCsvCustomFieldDefinitions(names, rows) {
  return names.map(name => {
    const values = rows.map(row => Object.entries(row.custom || {})
      .find(([column]) => normalizeHeader(column) === normalizeHeader(name))?.[1])
      .map(value => String(value ?? '').trim()).filter(Boolean);
    const looksNumeric = values.length > 0 && values.every(value => parseTransferNumber(value) !== null);
    const hoursColumn = /time\s*estimate.*hours/i.test(name);
    const dateColumn = /date/i.test(name) && values.length > 0 && values.every(value => parseTransferDate(value));
    return { name, field_type: dateColumn ? 'date' : (looksNumeric || hoursColumn) ? 'number' : 'text' };
  });
}

function makeTaskImportPayload(row, profile, folderId, customValueIds) {
  const progressRaw = parseTransferNumber(row.progress) ?? (normalizeTransferStatus(row.status) === 'done' ? 100 : 0);
  const custom_values = {};
  for (const [name, value] of Object.entries(row.custom || {})) {
    const id = customValueIds[normalizeHeader(name)];
    if (id) custom_values[id] = value;
  }
  return {
    title: String(row.title || '').trim().slice(0, 200),
    description: String(row.description || '').slice(0, 2000),
    folder_id: folderId,
    status: ['todo', 'in_progress', 'done'].includes(row.status_group) ? row.status_group : normalizeTransferStatus(row.status, progressRaw),
    status_label: isBuiltInStatusLabel(row.status) ? '' : String(row.status || '').trim().slice(0, 60),
    priority: normalizeTransferPriority(row.priority, profile),
    start_date: parseTransferDate(row.start_date_text || row.start_date) || null,
    due_date: parseTransferDate(row.due_date_text || row.due_date) || null,
    start_time: normalizeImportTime(row.start_time) || normalizeImportTime(row.start_date_text) || normalizeImportTime(row.start_date) || null,
    due_time: normalizeImportTime(row.due_time) || normalizeImportTime(row.due_date_text) || normalizeImportTime(row.due_date) || null,
    open_at: String(row.open_at || '').match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/) ? row.open_at : null,
    progress: Math.max(0, Math.min(100, progressRaw || 0)),
    earned_points: parseTransferNumber(row.earned_points),
    max_points: parseTransferNumber(row.max_points),
    grade: parseTransferNumber(row.grade),
    weight_override: parseTransferNumber(row.weight_override),
    extra_credit: /^(?:1|true|yes|y)$/i.test(String(row.extra_credit || '').trim()),
    dependencies: [],
    custom_values,
    _sourceId: row.id || '',
    _sourceDependencies: String(row.dependencies || '').split(/[;|]/).map(value => value.trim()).filter(Boolean)
  };
}

async function importTasks() {
  if (!pendingImport || currentProjectAccess !== 'edit') return;
  const button = document.getElementById('btnImportTasks');
  const preview = document.getElementById('taskImportPreview');
  button.disabled = true;
  let createdCount = 0;
  let updatedCount = 0;
  let updatedFolderCount = 0;
  let ambiguousCount = 0;
  try {
    const data = pendingImport;
    const isLearningSuite = data.type === 'learning_suite_html';
    const updateMatches = isLearningSuite && document.getElementById('taskImportUpdateMatches').checked;
    const learningSuiteCourseId = data.data?.source?.course_id || 'unknown';
    const syncMap = isLearningSuite ? loadLearningSuiteSyncMap(learningSuiteCourseId) : null;
    let normalizedRows = [];
    let folderSourceMap = new Map();
    let customValueIds = {};
    let sourceFieldIdMap = new Map();
    let fieldNames = [];

    if (data.type === 'csv') {
      normalizedRows = data.mapped.map(row => ({ ...row, folder_path: row.folder_path || '' })).filter(row => row.title);
      fieldNames = [...new Set(normalizedRows.flatMap(row => Object.keys(row.custom || {})))];
      customValueIds = await ensureImportCustomFields(fieldNames, inferCsvCustomFieldDefinitions(fieldNames, normalizedRows));
    } else {
      const backup = data.data;
      const sourceFields = backup.custom_fields || backup.customFields || [];
      fieldNames = sourceFields.map(field => field.name).filter(Boolean);
      customValueIds = await ensureImportCustomFields(fieldNames, sourceFields);
      sourceFields.forEach(field => {
        const targetId = customValueIds[normalizeHeader(field.name)];
        if (field.id && targetId) sourceFieldIdMap.set(field.id, targetId);
      });
      const sourceFolders = backup.folders || [];
      for (const folder of [...sourceFolders].sort((a, b) => folderDepth(a, sourceFolders) - folderDepth(b, sourceFolders))) {
        const parentId = folder.parent_id ? folderSourceMap.get(folder.parent_id) || null : null;
        const mappedId = isLearningSuite ? syncMap.folders[folder.id] : null;
        let match = mappedId ? folders.find(item => item.id === mappedId && item.parent_id === parentId) : null;
        if (!match) match = folders.find(item => item.parent_id === parentId && item.name.toLowerCase() === String(folder.name).toLowerCase());
        let id = match?.id;
        if (!id) {
          const made = await api(`/api/projects/${currentProjectId}/folders`, {
            method: 'POST', body: JSON.stringify({
              name: folder.name, parent_id: parentId, description: folder.description || '', color: folder.color || '',
              weight_percent: Number(folder.weight_percent) || 0, drop_lowest_count: Number(folder.drop_lowest_count) || 0,
              target_grade: Number(folder.target_grade) || 100,
              bonus_cap_enabled: Boolean(folder.bonus_cap_enabled)
            })
          });
          folders.push(made); id = made.id;
        } else if (isLearningSuite) {
          const isCourseRoot = !folder.parent_id;
          const nextWeight = isCourseRoot ? (Number(match.weight_percent) || 0) : (Number(folder.weight_percent) || 0);
          const nextDropLowest = isCourseRoot ? (Number(match.drop_lowest_count) || 0) : (Number(folder.drop_lowest_count) || 0);
          const nextName = String(folder.name || match.name);
          const nextBonusCap = isCourseRoot ? Boolean(match.bonus_cap_enabled) : Boolean(folder.bonus_cap_enabled);
          if (match.name !== nextName || Number(match.weight_percent) !== nextWeight
            || Number(match.drop_lowest_count) !== nextDropLowest || Boolean(match.bonus_cap_enabled) !== nextBonusCap) {
            await api(`/api/folders/${match.id}`, {
              method: 'PUT',
              body: JSON.stringify({
                name: nextName, parent_id: parentId, description: match.description || '', color: match.color || '',
                weight_percent: nextWeight, drop_lowest_count: nextDropLowest, target_grade: Number(match.target_grade) || 100,
                bonus_cap_enabled: nextBonusCap
              })
            });
            Object.assign(match, { name: nextName, weight_percent: nextWeight, drop_lowest_count: nextDropLowest, bonus_cap_enabled: nextBonusCap });
            updatedFolderCount += 1;
          }
        }
        folderSourceMap.set(folder.id, id);
        if (isLearningSuite) syncMap.folders[folder.id] = id;
      }
      if (isLearningSuite) saveLearningSuiteSyncMap(learningSuiteCourseId, syncMap);
      const sourceTasks = Array.isArray(backup) ? backup : (backup.tasks || []);
      normalizedRows = sourceTasks.map(task => ({
        ...task,
        title: task.title || task.name || task.task_name,
        custom_values: task.custom_values || task.customValues || {},
        _sourceId: task.id || '',
        _sourceDependencies: task.dependencies || [],
        _json: true
      })).filter(row => String(row.title || '').trim());
    }

    const folderCache = [...folders];
    const sourceTaskIdMap = new Map();
    const tasksToLink = [];
    const claimedExistingTaskIds = new Set();
    for (const row of normalizedRows) {
      const path = row.folder_path || row.folder || row.bucket_name || row.bucket || row.group || row.list_name || row.list || '';
      const folderId = data.type !== 'csv' && row.folder_id
        ? folderSourceMap.get(row.folder_id) || ''
        : await getOrCreateImportFolder(path, folderCache);
      let payload;
      if (row._json) {
        const custom_values = {};
        for (const [sourceId, value] of Object.entries(row.custom_values || {})) {
          const mappedId = sourceFieldIdMap.get(sourceId);
          if (mappedId && value != null) custom_values[mappedId] = value;
        }
        payload = {
          title: String(row.title).trim().slice(0, 200), description: String(row.description || '').slice(0, 2000),
          folder_id: folderId, status: ['todo', 'in_progress', 'done'].includes(row.status) ? row.status : 'todo',
          status_label: String(row.status_label || '').trim().slice(0, 60),
          priority: ['none', 'low', 'medium', 'high', 'urgent'].includes(row.priority) ? row.priority : 'medium',
          start_date: row.start_date || null, due_date: row.due_date || null, start_time: row.start_time || null,
          due_time: row.due_time || null, open_at: row.open_at || null, progress: Number(row.progress) || 0,
          color: row.color || '', earned_points: row.earned_points ?? null, max_points: row.max_points ?? null,
          grade: row.grade ?? null, weight_override: row.weight_override ?? null,
          extra_credit: /^(?:1|true|yes|y)$/i.test(String(row.extra_credit || '').trim()),
          custom_values, dependencies: []
        };
        row._sourceDependencies = row._sourceDependencies || [];
      } else {
        payload = makeTaskImportPayload(row, data.profile, folderId, customValueIds);
      }
      const sourceId = row._sourceId || payload._sourceId || row.id;
      let existing = null;
      if (isLearningSuite && updateMatches) {
        const mappedTaskId = syncMap.tasks[String(sourceId || '')];
        existing = tasks.find(task => task.id === mappedTaskId && !claimedExistingTaskIds.has(task.id)) || null;
        if (!existing) {
          const candidates = tasks.filter(task => !claimedExistingTaskIds.has(task.id)
            && task.folder_id === folderId
            && normalizeTaskMatchTitle(task.title) === normalizeTaskMatchTitle(payload.title));
          if (candidates.length === 1) existing = candidates[0];
          else if (candidates.length > 1) {
            ambiguousCount += 1;
            continue;
          }
        }
      }

      if (existing) {
        claimedExistingTaskIds.add(existing.id);
        const hasGrade = row.earned_points !== null && row.earned_points !== undefined;
        const updatePayload = {
          ...payload,
          description: payload.description || existing.description || '',
          status: hasGrade ? 'done' : existing.status,
          status_label: existing.status_label || '',
          priority: existing.priority || payload.priority,
          start_date: payload.start_date || null,
          start_time: payload.start_time || null,
          due_date: payload.due_date || null,
          due_time: payload.due_time || null,
          open_at: existing.open_at || null,
          progress: hasGrade ? 100 : (Number(existing.progress) || 0),
          color: existing.color || '',
          custom_values: { ...(existing.custom_values || {}), ...(payload.custom_values || {}) },
          dependencies: existing.dependencies || []
        };
        await api(`/api/tasks/${existing.id}`, { method: 'PUT', body: JSON.stringify(updatePayload) });
        updatedCount += 1;
        if (sourceId) syncMap.tasks[String(sourceId)] = existing.id;
      } else {
        const created = await api(`/api/projects/${currentProjectId}/tasks`, { method: 'POST', body: JSON.stringify(payload) });
        createdCount += 1;
        if (sourceId) {
          sourceTaskIdMap.set(String(sourceId), created.id);
          if (isLearningSuite) syncMap.tasks[String(sourceId)] = created.id;
        }
        tasksToLink.push({ id: created.id, payload, sourceDependencies: row._sourceDependencies || payload._sourceDependencies || [] });
      }
      if (isLearningSuite) saveLearningSuiteSyncMap(learningSuiteCourseId, syncMap);
      preview.textContent = `Processed ${createdCount + updatedCount} of ${normalizedRows.length} assignments (${createdCount} added, ${updatedCount} updated).`;
    }

    for (const item of tasksToLink) {
      const dependencies = item.sourceDependencies.map(value => sourceTaskIdMap.get(String(value))).filter(Boolean);
      if (dependencies.length) {
        await api(`/api/tasks/${item.id}`, { method: 'PUT', body: JSON.stringify({ ...item.payload, dependencies }) });
      }
    }
    await loadFolders();
    await loadCustomFields();
    await loadTasks();
    preview.textContent = isLearningSuite
      ? `Learning Suite import complete: ${createdCount} task(s) added, ${updatedCount} updated, ${updatedFolderCount} category folder(s) refreshed${ambiguousCount ? `, ${ambiguousCount} ambiguous match(es) skipped` : ''}.`
      : `Import complete: ${createdCount} task(s) added. ${data.skipped || 0} nameless row(s) were skipped.`;
    pendingImport = null;
    setTimeout(closeDataTransferModal, 900);
  } catch (error) {
    preview.textContent = `Import stopped after ${createdCount + updatedCount} task(s): ${error.message}. Completed adds and updates remain in the project; preview and retry the remaining items.`;
  } finally {
    button.disabled = currentProjectAccess !== 'edit' || !pendingImport;
  }
}

function folderDepth(folder, allFolders) {
  const byId = new Map(allFolders.map(item => [item.id, item]));
  let depth = 0, cursor = folder, seen = new Set();
  while (cursor?.parent_id && !seen.has(cursor.id)) { seen.add(cursor.id); cursor = byId.get(cursor.parent_id); depth += 1; }
  return depth;
}

function exportGanttSvg() {
  const namespace = 'http://www.w3.org/2000/svg';
  const themeStyle = getComputedStyle(document.documentElement);
  const themeColors = {
    background: themeStyle.getPropertyValue('--bg').trim() || '#070c14',
    surface: themeStyle.getPropertyValue('--card-bg').trim() || '#0d1420',
    border: themeStyle.getPropertyValue('--card-border').trim() || '#23404a',
    text: themeStyle.getPropertyValue('--text-main').trim() || '#f1f7f5',
    softText: themeStyle.getPropertyValue('--text-soft').trim() || '#c8ded9',
    mutedText: themeStyle.getPropertyValue('--text-muted').trim() || '#8fa6a6',
    accent: themeStyle.getPropertyValue('--accent-1').trim() || '#38d8aa',
    info: themeStyle.getPropertyValue('--accent-2').trim() || '#25c2fd',
    warning: themeStyle.getPropertyValue('--warning').trim() || '#f2c66d'
  };
  const sidebar = document.getElementById('ganttSidebarCol');
  const header = document.getElementById('ganttTimelineHeader');
  const bars = document.getElementById('ganttBarsContainer');
  const overlay = document.getElementById('ganttSvgLines');
  const hiddenSidebar = document.getElementById('ganttViewport').classList.contains('gantt-sidebar-hidden');
  const sideWidth = hiddenSidebar ? 0 : sidebar.getBoundingClientRect().width;
  const headerHeight = header.getBoundingClientRect().height;
  const contentWidth = Math.max(header.scrollWidth, bars.scrollWidth);
  const contentHeight = Math.max(bars.scrollHeight, 18);
  const width = sideWidth + contentWidth;
  const height = headerHeight + contentHeight;
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('xmlns', namespace);
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('role', 'img');
  const title = document.createElementNS(namespace, 'title');
  title.textContent = `${currentProject?.name || 'Project'} Gantt chart`;
  svg.appendChild(title);
  const add = (tag, attrs = {}, parent = svg) => {
    const node = document.createElementNS(namespace, tag);
    for (const [key, value] of Object.entries(attrs)) if (value !== null && value !== undefined) node.setAttribute(key, String(value));
    parent.appendChild(node); return node;
  };
  add('rect', { x: 0, y: 0, width, height, fill: themeColors.background });
  if (!hiddenSidebar) add('rect', { x: 0, y: 0, width: sideWidth, height, fill: themeColors.surface });
  add('rect', { x: 0, y: 0, width, height: headerHeight, fill: themeColors.surface });

  [...header.children].forEach(cell => {
    const x = sideWidth + cell.offsetLeft;
    const dayColor = getComputedStyle(cell).backgroundColor;
    add('rect', { x, y: 0, width: cell.offsetWidth, height: headerHeight, fill: dayColor === 'rgba(0, 0, 0, 0)' ? themeColors.surface : dayColor, stroke: themeColors.border, 'stroke-width': 1 });
    const text = add('text', { x: x + cell.offsetWidth / 2, y: headerHeight / 2 + 4, fill: themeColors.softText, 'font-size': 11, 'text-anchor': 'middle', 'font-family': 'Arial, sans-serif' });
    text.textContent = cell.textContent.trim();
  });

  bars.querySelectorAll('.gantt-calendar-band').forEach(band => {
    const fill = band.classList.contains('holiday') ? themeColors.warning : band.classList.contains('today') ? themeColors.accent : themeColors.mutedText;
    const opacity = band.classList.contains('holiday') ? 0.10 : 0.045;
    add('rect', {
      x: sideWidth + parseFloat(band.style.left || '0'), y: headerHeight,
      width: parseFloat(band.style.width || '0'), height: contentHeight, fill, opacity
    });
  });

  const rowNodes = [...bars.children].filter(node => node.classList.contains('gantt-folder-row') || node.classList.contains('gantt-row'));
  const sidebarNodes = [...sidebar.children];
  rowNodes.forEach((row, index) => {
    const rowY = headerHeight + row.offsetTop;
    const isFolder = row.classList.contains('gantt-folder-row');
    const rowHeight = row.offsetHeight || (isFolder ? 18 : 42);
    if (isFolder) {
      const labelCell = sidebarNodes[index];
      if (labelCell && !hiddenSidebar) {
        const color = getComputedStyle(labelCell).borderLeftColor || themeColors.mutedText;
        add('rect', { x: 0, y: rowY, width: sideWidth, height: rowHeight, fill: themeColors.surface });
        add('rect', { x: 0, y: rowY, width: 3, height: rowHeight, fill: color });
        const label = add('text', { x: parseFloat(labelCell.style.paddingLeft || '12'), y: rowY + rowHeight - 5, fill: themeColors.mutedText, 'font-size': 10, 'font-family': 'Arial, sans-serif' });
        label.textContent = labelCell.textContent;
      }
      const span = row.querySelector('.gantt-folder-span');
      if (span && !span.hidden) {
        const color = getComputedStyle(span).borderTopColor || themeColors.mutedText;
        const x = sideWidth + parseFloat(span.style.left || '0');
        const spanWidth = parseFloat(span.style.width || '0');
        add('line', { x1: x, x2: x + spanWidth, y1: rowY + 13, y2: rowY + 13, stroke: color, 'stroke-width': 2, opacity: 0.7 });
        const labelNode = span.querySelector('.gantt-folder-span-label');
        if (labelNode) {
          const label = add('text', { x: x + 3, y: rowY + 9, fill: color, 'font-size': 9, 'font-family': 'Arial, sans-serif' });
          label.textContent = labelNode.textContent;
        }
      }
    } else {
      if (!hiddenSidebar && sidebarNodes[index]) {
        add('rect', { x: 0, y: rowY, width: sideWidth, height: rowHeight, fill: themeColors.surface, stroke: themeColors.border, 'stroke-width': 1 });
        const label = add('text', { x: parseFloat(sidebarNodes[index].style.paddingLeft || '12'), y: rowY + rowHeight / 2 + 4, fill: themeColors.text, 'font-size': 12, 'font-family': 'Arial, sans-serif' });
        label.textContent = sidebarNodes[index].textContent;
      }
      add('line', { x1: sideWidth, x2: width, y1: rowY + rowHeight, y2: rowY + rowHeight, stroke: themeColors.border, 'stroke-width': 1 });
      const bar = bars.querySelector(`.gantt-bar-item[data-task-id="${CSS.escape(row.dataset.taskId || '')}"]`);
      if (bar && !bar.hidden) {
        const x = sideWidth + parseFloat(bar.style.left || '0');
        const y = headerHeight + parseFloat(bar.style.top || '0');
        const w = parseFloat(bar.style.width || '0');
        const h = bar.offsetHeight || 24;
        const fill = getComputedStyle(bar).backgroundColor;
        add('rect', { x, y, width: w, height: h, rx: 4, fill });
        const progress = bar.querySelector('.gantt-bar-progress');
        if (progress) add('rect', { x, y, width: Math.min(w, w * parseFloat(progress.style.width || '0') / 100), height: h, rx: 4, fill: getComputedStyle(progress).backgroundColor });
        const label = add('text', { x: x + 7, y: y + h / 2 + 4, fill: getComputedStyle(bar).color, 'font-size': 11, 'font-family': 'Arial, sans-serif' });
        label.textContent = bar.querySelector('span')?.textContent || '';
      }
    }
  });

  const depGroup = add('g', { transform: `translate(${sideWidth},${headerHeight})`, fill: 'none', stroke: themeColors.info, 'stroke-width': 1.5, 'stroke-dasharray': '4 3', opacity: 0.75 });
  [...overlay.children].forEach(child => depGroup.appendChild(child.cloneNode(true)));
  const xml = new XMLSerializer().serializeToString(svg);
  downloadFile(ganttFilename(), `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`, 'image/svg+xml;charset=utf-8');
}

// ----------------- 1. Folders, Nested Subfolders & Hierarchical Grades -----------------
function renderFolderView() {
  const container = document.getElementById('folderTreeContainer');
  container.innerHTML = '';

  const rootFolders = folders.filter(folder => !folder.parent_id);
  const scopeSelect = document.getElementById('gradeScopeSelect');
  if (selectedStatsFolderId === undefined || (selectedStatsFolderId && !rootFolders.some(folder => folder.id === selectedStatsFolderId))) {
    selectedStatsFolderId = rootFolders[0]?.id || null;
  }
  scopeSelect.innerHTML = '<option value="">All coursework</option>' + rootFolders
    .map(folder => `<option value="${escapeHtml(folder.id)}">${escapeHtml(folder.name)}</option>`).join('');
  scopeSelect.value = selectedStatsFolderId || '';

  const gradeData = calculateFolderTreeGrades(selectedStatsFolderId);

  // Summary Metrics
  document.getElementById('valCurrentGrade').textContent = gradeData.currentGrade !== '--' ? `${gradeData.currentGrade}%` : '--';
  document.getElementById('valMaxGrade').textContent = `${gradeData.maxGrade}%`;
  document.getElementById('valMinGrade').textContent = `${gradeData.minGrade}%`;

  const scopedTasks = selectedStatsFolderId ? tasksInFolderSubtree(selectedStatsFolderId, folders, tasks) : tasks;
  const totalTasks = scopedTasks.length;
  const doneTasks = scopedTasks.filter(task => task.status === 'done').length;
  const progressPct = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;
  document.getElementById('valClassProgress').textContent = `${progressPct}%`;
  document.getElementById('subClassProgress').textContent = `${doneTasks} of ${totalTasks} tasks completed`;
  document.querySelector('.grade-card.pace .grade-card-label').textContent = 'Overall Completion';
  document.getElementById('subCurrentGrade').textContent = selectedStatsFolderId
    ? `Current score for ${folders.find(folder => folder.id === selectedStatsFolderId)?.name || 'selected folder'}`
    : 'Weighted course points earned so far';

  if (rootFolders.length === 0 && tasks.length === 0) {
    const emptyDiv = document.createElement('div');
    emptyDiv.style.cssText = 'text-align:center;padding:3rem;color:var(--text-muted);';
    emptyDiv.innerHTML = '<p>No folders or tasks in this project yet.</p>';
    const createBtn = document.createElement('button');
    createBtn.className = 'btn-primary edit-required';
    createBtn.style.marginTop = '1rem';
    createBtn.textContent = '+ Create Root Folder / Class';
    createBtn.addEventListener('click', () => openFolderModal());
    emptyDiv.appendChild(createBtn);
    container.appendChild(emptyDiv);
    updateBulkDeleteControls();
    return;
  }

  // Render each root folder with its nested subfolders
  rootFolders.forEach(root => {
    const rootBlock = renderFolderNode(root, 0, gradeData);
    container.appendChild(rootBlock);
  });

  // Render Unassigned / General tasks if any
  const unassignedTasks = tasks.filter(t => !t.folder_id);
  if (unassignedTasks.length > 0) {
    const generalBlock = document.createElement('div');
    generalBlock.className = 'folder-node root-folder';
    generalBlock.innerHTML = `
      <div class="folder-header-row">
        <div class="folder-title-left">
          <span class="folder-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg></span>
          <strong>General Tasks (Unfiled)</strong>
          <span class="badge badge-dep">${unassignedTasks.length} tasks</span>
        </div>
      </div>
      <div class="folder-content-area" id="tasks-unfiled"></div>
    `;
    const tasksContainer = generalBlock.querySelector('#tasks-unfiled');
    unassignedTasks.forEach(task => {
      tasksContainer.appendChild(createTaskTreeRow(task));
    });
    container.appendChild(generalBlock);
  }
  updateBulkDeleteControls();
}

function renderFolderNode(folder, depth, gradeData) {
  const node = document.createElement('div');
  node.dataset.folderId = folder.id;
  const isRoot = depth === 0;
  node.className = `folder-node ${isRoot ? 'root-folder' : 'sub-folder'}`;
  node.style.marginLeft = `${depth * 20}px`;
  // Add a left border tint that gets lighter as depth increases
  if (!isRoot) {
    node.style.borderLeftWidth = '2px';
    node.style.borderLeftStyle = 'solid';
    node.style.borderLeftColor = depth % 2 ? '#25c2fd' : '#38d8aa';
  }

  const folderIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>';

  // Subfolders belonging to this folder
  const subfolders = folders.filter(f => f.parent_id === folder.id);
  // Tasks directly inside this folder
  const folderTasks = tasks.filter(t => t.folder_id === folder.id);

  const folderStats = gradeData.folderStats.get(folder.id) || { avg: '--', earnedRate: 0, weight: folder.weight_percent, totalCount: folderTasks.length };

  const showFolderWeight = Number(folder.weight_percent) > 0 || depth > 0;
  const weightBadge = showFolderWeight
    ? `<span class="badge badge-custom">${escapeHtml(formatCustomFieldValue({ name: 'Grade Weight %' }, Number(folder.weight_percent) || 0))}% ${folder.bonus_cap_enabled ? 'bonus cap' : 'weight'}</span>`
    : '';
  const dropLowestBadge = Number(folder.drop_lowest_count) > 0
    ? `<span class="badge badge-custom">Drops ${Number(folder.drop_lowest_count)} lowest</span>` : '';
  const gradeBadge = folderStats.avg !== '--' ? `<span class="badge badge-grade">Score: ${folderStats.avg}%</span>` : '';

  node.innerHTML = `
    <div class="folder-header-row">
      <div class="folder-title-left">
        <button class="btn-icon-subtle folder-collapse-toggle" type="button" aria-expanded="true" aria-controls="content-${escapeHtml(folder.id)}" aria-label="Collapse ${escapeHtml(folder.name)}" title="Collapse folder">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
        </button>
        <span class="folder-icon">${folderIcon}</span>
        <strong>${escapeHtml(folder.name)}</strong>
        ${weightBadge}
        ${dropLowestBadge}
        ${gradeBadge}
        <span class="task-count">${folderStats.totalCount} tasks</span>
      </div>
      <div class="folder-actions-right">
        <button class="btn-icon-subtle edit-required" title="Add Task in this Folder" data-action="add-task">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-4 h-4"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>
        </button>
        <button class="btn-icon-subtle edit-required" title="Add Subfolder" data-action="add-subfolder">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-4 h-4" aria-hidden="true">
            <path d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            <path d="M15.5 11.5v5M13 14h5" />
          </svg>
        </button>
        <button class="btn-icon-subtle edit-required" title="Edit Folder" data-action="edit-folder">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-4 h-4"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
      </div>
    </div>
    <div class="folder-content-area" id="content-${folder.id}"></div>
  `;

  // Wire buttons via addEventListener (required — CSP blocks inline onclick)
  installFolderReorderHandlers(node.querySelector('.folder-header-row'), folder);
  const contentArea = node.querySelector('.folder-content-area');
  const collapseButton = node.querySelector('.folder-collapse-toggle');
  const initiallyCollapsed = collapsedFolderIds.has(folder.id);
  node.classList.toggle('collapsed', initiallyCollapsed);
  collapseButton.setAttribute('aria-expanded', String(!initiallyCollapsed));
  collapseButton.setAttribute('aria-label', `${initiallyCollapsed ? 'Expand' : 'Collapse'} ${folder.name}`);
  collapseButton.title = `${initiallyCollapsed ? 'Expand' : 'Collapse'} folder`;
  collapseButton.addEventListener('click', event => {
    event.stopPropagation();
    const collapsed = node.classList.toggle('collapsed');
    if (collapsed) collapsedFolderIds.add(folder.id);
    else collapsedFolderIds.delete(folder.id);
    saveCollapsedFolders();
    collapseButton.setAttribute('aria-expanded', String(!collapsed));
    collapseButton.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} ${folder.name}`);
    collapseButton.title = `${collapsed ? 'Expand' : 'Collapse'} folder`;
  });

  // Render direct tasks inside this folder
  folderTasks.forEach(task => {
    const taskRow = createTaskTreeRow(task);
    installFolderTaskReorderHandlers(taskRow, task);
    contentArea.appendChild(taskRow);
  });

  // Render nested subfolders recursively
  subfolders.forEach(sub => {
    contentArea.appendChild(renderFolderNode(sub, depth + 1, gradeData));
  });

  return node;
}

function getFolderDepth(folderId) {
  let depth = 0;
  let current = folders.find(folder => folder.id === folderId);
  const seen = new Set();
  while (current?.parent_id && !seen.has(current.id)) {
    seen.add(current.id);
    current = folders.find(folder => folder.id === current.parent_id);
    if (current) depth += 1;
  }
  return depth;
}

let activeFolderDragId = null;

function installFolderReorderHandlers(header, folder) {
  if (currentProjectAccess !== 'edit') return;
  header.draggable = true;
  header.addEventListener('dragstart', event => {
    if (event.target.closest('button')) { event.preventDefault(); return; }
    activeFolderDragId = folder.id;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', folder.id);
    header.closest('.folder-node')?.classList.add('dragging');
  });
  header.addEventListener('dragover', event => {
    const draggedId = activeFolderDragId || event.dataTransfer?.getData('text/plain');
    const draggedFolder = folders.find(item => item.id === draggedId);
    if (!draggedFolder || draggedFolder.id === folder.id
      || (draggedFolder.parent_id || null) !== (folder.parent_id || null)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const node = header.closest('.folder-node');
    node?.classList.remove('folder-drop-before', 'folder-drop-after');
    const after = event.clientY >= header.getBoundingClientRect().top + header.offsetHeight / 2;
    node?.classList.add(after ? 'folder-drop-after' : 'folder-drop-before');
  });
  header.addEventListener('dragleave', event => {
    if (!header.contains(event.relatedTarget)) header.closest('.folder-node')?.classList.remove('folder-drop-before', 'folder-drop-after');
  });
  header.addEventListener('drop', async event => {
    const draggedId = activeFolderDragId || event.dataTransfer?.getData('text/plain');
    const draggedFolder = folders.find(item => item.id === draggedId);
    if (!draggedFolder || draggedFolder.id === folder.id
      || (draggedFolder.parent_id || null) !== (folder.parent_id || null)) return;
    event.preventDefault();
    event.stopPropagation();
    const after = event.clientY >= header.getBoundingClientRect().top + header.offsetHeight / 2;
    const ordered = folders.filter(item => (item.parent_id || null) === (folder.parent_id || null)).map(item => item.id);
    ordered.splice(ordered.indexOf(draggedId), 1);
    const targetIndex = ordered.indexOf(folder.id);
    ordered.splice(targetIndex + (after ? 1 : 0), 0, draggedId);
    activeFolderDragId = null;
    document.querySelectorAll('.folder-node.dragging, .folder-node.folder-drop-before, .folder-node.folder-drop-after')
      .forEach(item => item.classList.remove('dragging', 'folder-drop-before', 'folder-drop-after'));
    try {
      await persistFolderOrder(folder.parent_id || null, ordered);
    } catch (error) {
      alert(`Could not reorder folders: ${error.message}`);
      renderCurrentView();
    }
  });
  header.addEventListener('dragend', () => {
    activeFolderDragId = null;
    document.querySelectorAll('.folder-node.dragging, .folder-node.folder-drop-before, .folder-node.folder-drop-after')
      .forEach(item => item.classList.remove('dragging', 'folder-drop-before', 'folder-drop-after'));
  });
}

async function persistFolderOrder(parentId, folderIds) {
  await api(`/api/projects/${currentProjectId}/folders/order`, {
    method: 'PATCH',
    body: JSON.stringify({ parent_id: parentId, folder_ids: folderIds })
  });
  const positionById = new Map(folderIds.map((id, index) => [id, index]));
  folders.forEach(folder => {
    if (positionById.has(folder.id)) folder.sort_order = positionById.get(folder.id);
  });
  await loadFolders();
  renderCurrentView();
}

let activeFolderTaskDragId = null;

function installFolderTaskReorderHandlers(row, task) {
  if (currentProjectAccess !== 'edit' || !task.folder_id) return;
  row.draggable = true;
  row.addEventListener('dragstart', event => {
    if (event.target.closest('button, input')) { event.preventDefault(); return; }
    activeFolderTaskDragId = task.id;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', task.id);
    row.classList.add('dragging');
  });
  row.addEventListener('dragover', event => {
    const draggedId = activeFolderTaskDragId || event.dataTransfer?.getData('text/plain');
    const draggedTask = tasks.find(item => item.id === draggedId);
    if (!draggedTask || draggedTask.id === task.id || draggedTask.folder_id !== task.folder_id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    row.classList.remove('drop-before', 'drop-after');
    const after = event.clientY >= row.getBoundingClientRect().top + row.offsetHeight / 2;
    row.classList.add(after ? 'drop-after' : 'drop-before');
  });
  row.addEventListener('dragleave', event => {
    if (!row.contains(event.relatedTarget)) row.classList.remove('drop-before', 'drop-after');
  });
  row.addEventListener('drop', async event => {
    const draggedId = activeFolderTaskDragId || event.dataTransfer?.getData('text/plain');
    const draggedTask = tasks.find(item => item.id === draggedId);
    if (!draggedTask || draggedTask.id === task.id || draggedTask.folder_id !== task.folder_id) return;
    event.preventDefault();
    event.stopPropagation();
    const after = event.clientY >= row.getBoundingClientRect().top + row.offsetHeight / 2;
    const siblingIds = tasks.filter(item => item.folder_id === task.folder_id).map(item => item.id);
    siblingIds.splice(siblingIds.indexOf(draggedId), 1);
    siblingIds.splice(siblingIds.indexOf(task.id) + (after ? 1 : 0), 0, draggedId);
    const reorderedSiblings = new Set(siblingIds);
    let nextSiblingIndex = 0;
    const orderedTaskIds = tasks.map(item => reorderedSiblings.has(item.id) ? siblingIds[nextSiblingIndex++] : item.id);
    activeFolderTaskDragId = null;
    document.querySelectorAll('.tree-task-row.dragging, .tree-task-row.drop-before, .tree-task-row.drop-after')
      .forEach(item => item.classList.remove('dragging', 'drop-before', 'drop-after'));
    try {
      await persistTaskOrder(orderedTaskIds);
    } catch (error) {
      alert(`Could not reorder tasks in this folder: ${error.message}`);
      renderCurrentView();
    }
  });
  row.addEventListener('dragend', () => {
    activeFolderTaskDragId = null;
    row.classList.remove('dragging', 'drop-before', 'drop-after');
  });
}

function taskGradeScoreMarkup(task) {
  const droppedClass = currentDroppedGradeTaskIds.has(task.id) ? ' dropped-grade-score' : '';
  const score = value => `<span class="${droppedClass.trim()}">${escapeHtml(value)}</span>`;
  if (task.grade !== null && task.grade !== undefined) {
    return `${score(`${task.grade}%`)} <span style="font-size:0.68rem;opacity:0.7;">(override)</span>`;
  }
  if (task.earned_points !== null && task.earned_points !== undefined && Number(task.max_points) > 0) {
    const percent = Math.round((Number(task.earned_points) / Number(task.max_points)) * 100);
    return `${score(`${task.earned_points}/${task.extra_credit ? '+' : ''}${task.max_points}`)} (${score(`${percent}%`)})`;
  }
  return task.max_points ? `-/${task.extra_credit ? '+' : ''}${escapeHtml(task.max_points)}` : '-';
}

function createTaskTreeRow(task) {
  const row = document.createElement('div');
  row.className = 'tree-task-row';
  row.dataset.taskId = task.id;

  const gradeText = taskGradeScoreMarkup(task);

  // Build custom field chips for fields that have a value on this task
  const cfChips = taskCustomFieldEntries(task, customFields)
    .map(({ name, value }) => `<span class="badge badge-custom" style="font-size:0.68rem;">${escapeHtml(name)}: ${escapeHtml(value)}</span>`)
    .join('');

  row.innerHTML = `
    <div class="tree-task-main">
      <input type="checkbox" class="tree-task-select" aria-label="Select ${escapeHtml(task.title)}" ${selectedTaskIds.has(task.id) ? 'checked' : ''} ${currentProjectAccess === 'none' ? 'disabled' : ''}>
      <span class="badge badge-${task.status}">${escapeHtml(getTaskStatusLabel(task))}</span>
      <span class="tree-task-title">${escapeHtml(task.title)}</span>
      <span class="badge badge-${task.priority}">${task.priority}</span>
      ${cfChips}
    </div>
    <div class="tree-task-meta">
      <span class="tree-task-grade">Score: <strong>${gradeText}</strong></span>
      <span class="tree-task-date">Due: ${escapeHtml(task.due_date ? formatTaskDateAndTime(task.due_date, task.due_time) : 'No due date')}</span>
      <span class="tree-task-progress">${task.progress}%</span>
      <button class="btn-secondary edit-required" style="padding: 2px 8px; font-size: 0.75rem;" data-action="edit-task">Edit</button>
    </div>
  `;

  // Wire via addEventListener (CSP blocks inline onclick)
  row.querySelector('.tree-task-select').addEventListener('change', event => {
    if (event.target.checked) selectedTaskIds.add(task.id);
    else selectedTaskIds.delete(task.id);
    updateBulkDeleteControls();
  });
  row.addEventListener('dblclick', event => {
    if (!event.target.closest('.tree-task-select')) openTaskModal(task);
  });
  return row;
}

// Grade calculation engine across folders and nested subfolders
function calculateFolderTreeGrades(scopeFolderId = null) {
  const folderStats = new Map();
  const assignmentWeightFieldId = customFields.find(field => /\bweight\b/i.test(field.name))?.id || null;
  currentDroppedGradeTaskIds = new Set();
  let totalAssignedWeight = 0;
  let earnedWeighted = 0;
  let remainingWeight = 0;
  let minimumWeighted = 0;

  // Calculate individual folder averages
  folders.forEach(f => {
    const fTasks = tasksInFolderTree(f.id, folders, tasks);
    const potential = folderTreeGradePotential(f.id, folders, tasks, assignmentWeightFieldId);
    (potential.droppedTaskIdsCurrent || []).forEach(taskId => currentDroppedGradeTaskIds.add(taskId));
    const { average: avg, minAverage, maxAverage, gradedCount } = potential;
    const weight = Number(f.weight_percent) || 0;

    folderStats.set(f.id, {
      avg: avg !== null ? avg.toFixed(1) : '--',
      average: avg,
      maxAverage,
      minAverage,
      weight,
      gradedCount,
      totalCount: fTasks.length
    });
  });

  if (scopeFolderId) {
    const potential = folderTreeGradePotential(scopeFolderId, folders, tasks, assignmentWeightFieldId);
    return {
      currentGrade: currentGradeWithUngradedFolderDefault(potential.average).toFixed(1),
      maxGrade: (potential.maxAverage ?? 0).toFixed(1),
      minGrade: (potential.minAverage ?? 0).toFixed(1),
      folderStats
    };
  }

  // Only the highest weighted folder in each branch contributes to the course
  // total. Its score already includes any weighted subfolders beneath it.
  const topWeightedFolders = folders.filter(folder => {
    if (!(Number(folder.weight_percent) > 0)) return false;
    const visited = new Set([folder.id]);
    let parentId = folder.parent_id;
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = folders.find(item => item.id === parentId);
      if (!parent) break;
      if (Number(parent.weight_percent) > 0) return false;
      parentId = parent.parent_id;
    }
    return true;
  });

  topWeightedFolders.forEach(folder => {
    const stats = folderStats.get(folder.id);
    const weight = Number(folder.weight_percent) || 0;
    totalAssignedWeight += weight;
    earnedWeighted += weightedGradeContribution(currentGradeWithUngradedFolderDefault(stats.average), weight);
    if (stats.maxAverage !== null) remainingWeight += weightedGradeContribution(stats.maxAverage, weight);
    if (stats.minAverage !== null) minimumWeighted += weightedGradeContribution(stats.minAverage, weight);
  });

  if (totalAssignedWeight > 0) {
    const currentGrade = earnedWeighted.toFixed(1);
    const maxGrade = remainingWeight.toFixed(1);
    const minGrade = minimumWeighted.toFixed(1);
    return { currentGrade, maxGrade, minGrade, folderStats };
  } else {
    const projection = pointsGradeProjection(tasks);
    return {
      currentGrade: projection.currentGrade !== null ? projection.currentGrade.toFixed(1) : '--',
      maxGrade: projection.maxGrade.toFixed(1),
      minGrade: projection.minGrade.toFixed(1),
      folderStats
    };
  }
}

// ----------------- 2. Kanban Board View -----------------
function renderBoardView() {
  const statuses = ['todo', 'in_progress', 'done'];
  statuses.forEach(status => {
    const col = document.getElementById(`tasks-${status}`);
    const countEl = document.getElementById(`count-${status}`);
    col.innerHTML = '';

    const filtered = sortTasks(tasks, folders, [{ key: 'manual_order', dir: 'asc' }]).filter(t => t.status === status);
    countEl.textContent = filtered.length;
    const groupName = ({ todo: 'Not Active', in_progress: 'Active', done: 'Completed' })[status];
    const labels = [...new Set([
      ...projectStatusOptions()[status],
      ...filtered.map(task => task.status_label).filter(Boolean)
    ])];
    const bucketCards = new Map();
    [['', groupName], ...labels.map(label => [label, label])].forEach(([statusLabel, labelText]) => {
      const bucket = document.createElement('div');
      bucket.className = 'kanban-status-bucket';
      bucket.dataset.status = status;
      bucket.dataset.statusLabel = statusLabel;
      const bucketTasks = filtered.filter(task => (task.status_label || '') === statusLabel);
      const bucketHeader = document.createElement('div');
      bucketHeader.className = 'kanban-status-bucket-header';
      const title = document.createElement('span');
      title.textContent = labelText;
      const bucketCount = document.createElement('span');
      bucketCount.className = 'task-count';
      bucketCount.textContent = bucketTasks.length;
      bucketHeader.append(title, bucketCount);
      const bucketContent = document.createElement('div');
      bucketContent.className = 'kanban-status-cards';
      bucket.append(bucketHeader, bucketContent);
      col.appendChild(bucket);
      bucketCards.set(statusLabel, bucketContent);
    });

    filtered.forEach(task => {
      const card = document.createElement('div');
      card.className = 'task-card';
      card.dataset.taskId = task.id;
      card.draggable = currentProjectAccess === 'edit';

      const folderPath = getFolderPath(task.folder_id, folders);
      const folderBadge = folderPath ? `<span class="badge badge-course">Folder: ${escapeHtml(folderPath)}</span>` : '';
      const extraCreditBadge = task.extra_credit ? '<span class="badge badge-custom">Extra Credit · 2×</span>' : '';
      applyTaskFolderColor(card, task);

      let gradeBadge = '';
      if (task.grade !== null && task.grade !== undefined) {
        gradeBadge = `<span class="badge badge-grade">Grade: ${taskGradeScoreMarkup(task)}</span>`;
      } else if (task.earned_points !== null && task.earned_points !== undefined && task.max_points) {
        gradeBadge = `<span class="badge badge-grade">Score: ${taskGradeScoreMarkup(task)}</span>`;
      }

      let depBadge = '';
      if (task.dependencies && task.dependencies.length > 0) {
        depBadge = `<span class="badge badge-dep">${task.dependencies.length} dependencies</span>`;
      }

      card.innerHTML = `
        <div class="task-card-header">
          <span class="task-card-title">${escapeHtml(task.title)}</span>
          <span class="badge badge-${task.priority}">${task.priority}</span>
        </div>
        ${task.description ? `<p class="task-card-desc">${escapeHtml(task.description)}</p>` : ''}
        <div class="task-card-badges">
          <span class="badge badge-${task.status}">${escapeHtml(getTaskStatusLabel(task))}</span>
          ${folderBadge}
          ${extraCreditBadge}
          ${gradeBadge}
          ${depBadge}
        </div>
        <div class="task-dates">
          ${task.due_date ? `Due: ${escapeHtml(formatTaskDateAndTime(task.due_date, task.due_time))}` : 'No due date'}
        </div>
        <div class="progress-bar-bg">
          <div class="progress-bar-fill" style="width: ${task.progress}%"></div>
        </div>
      `;

      card.addEventListener('click', () => {
        if (Date.now() - lastBoardDropAt < 350) return;
        openTaskModal(task);
      });
      card.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        openTaskModal(task);
      });
      bucketCards.get(task.status_label || '')?.appendChild(card);
    });
  });
}

// ----------------- 3. List View -----------------
function sortedTasks() {
  return sortTasks(excludeDoneTasks(tasks, excludeDoneFromList), folders, listSortState, projectStatusOptions());
}

function setExcludeDoneFilter(enabled) {
  excludeDoneFromList = Boolean(enabled);
  saveListPreferences();
  document.getElementById('excludeDoneTasks').checked = excludeDoneFromList;
  document.getElementById('excludeDoneTasksGantt').checked = excludeDoneFromList;
  if (currentView === 'list') renderListView();
  else if (currentView === 'gantt') renderGanttView();
}

function renderListView() {
  const theadRow = document.getElementById('listTableHeaders');
  const tbody = document.getElementById('listTableBody');
  const sortSummary = document.getElementById('listSortSummary');
  const clearSortButton = document.getElementById('clearListSort');

  // Column definitions: [ label, sortKey (or null for unsortable) ]
  const cols = [
    ['Select', null],
    ['Status', 'status'], ['Task Title', 'title'], ['Folder Path', 'folder'],
    ['Priority', 'priority'], ['Start Date', 'start_date'], ['Due Date', 'due_date'],
    ['Grade / Score', 'grade'], ['Dependencies', null], ['Progress', 'progress'],
    ...customFields.map(f => [f.name, `custom:${f.id}`]),
    ['Actions', null]
  ];

  const columnLabels = new Map(cols.filter(([, key]) => key).map(([label, key]) => [key, label]));
  columnLabels.set('manual_order', 'Saved order');
  sortSummary.textContent = listSortState.length
    ? `Sort order: ${listSortState.map(({ key, dir }) => `${columnLabels.get(key) || key} ${dir === 'asc' ? '↑' : '↓'}`).join(' → ')}`
    : 'No sort applied';
  clearSortButton.disabled = listSortState.length === 0;
  const existingTaskIds = new Set(tasks.map(task => task.id));
  selectedTaskIds = new Set([...selectedTaskIds].filter(id => existingTaskIds.has(id)));
  const visibleTasks = sortedTasks();

  theadRow.innerHTML = '';
  cols.forEach(([label, key]) => {
    const th = document.createElement('th');
    if (label === 'Select') {
      const selectAll = document.createElement('input');
      selectAll.type = 'checkbox';
      selectAll.className = 'task-select-all';
      selectAll.setAttribute('aria-label', 'Select all visible tasks');
      const selectedVisibleCount = visibleTasks.filter(task => selectedTaskIds.has(task.id)).length;
      selectAll.checked = visibleTasks.length > 0 && selectedVisibleCount === visibleTasks.length;
      selectAll.indeterminate = selectedVisibleCount > 0 && selectedVisibleCount < visibleTasks.length;
      selectAll.disabled = currentProjectAccess === 'none' || visibleTasks.length === 0;
      selectAll.addEventListener('change', () => {
        visibleTasks.forEach(task => selectAll.checked ? selectedTaskIds.add(task.id) : selectedTaskIds.delete(task.id));
        renderListView();
      });
      th.appendChild(selectAll);
    } else if (key) {
      const sortEntry = listSortState.find(s => s.key === key);
      const arrow = sortEntry ? (sortEntry.dir === 'asc' ? ' ▲' : ' ▼') : '';
      const rank = sortEntry
        ? ` <sup style="opacity:0.6;">${listSortState.indexOf(sortEntry) + 1}</sup>` : '';
      th.innerHTML = `<span class="sort-th">${escapeHtml(label)}${arrow}${rank}</span>`;
      th.style.cursor = 'pointer';
      th.title = 'Click to set the primary sort. Shift+click to add or change a ranked sort level.';
      th.addEventListener('click', e => {
        if (e.shiftKey) {
          // Add/toggle as secondary sort key
          const idx = listSortState.findIndex(s => s.key === key);
          if (idx === -1) {
            listSortState.push({ key, dir: 'asc' });
          } else if (listSortState[idx].dir === 'asc') {
            listSortState[idx].dir = 'desc';
          } else {
            listSortState.splice(idx, 1); // remove on third click
          }
        } else {
          // Replace sort with this key alone
          const cur = listSortState.find(s => s.key === key);
          const nextDir = (cur && listSortState.length === 1) ? (cur.dir === 'asc' ? 'desc' : 'asc') : 'asc';
          listSortState = [{ key, dir: nextDir }];
        }
        saveListPreferences();
        renderListView();
      });
    } else {
      th.textContent = label;
    }
    theadRow.appendChild(th);
  });

  tbody.innerHTML = '';
  visibleTasks.forEach(task => {
    const tr = document.createElement('tr');
    tr.dataset.taskId = task.id;
    tr.draggable = currentProjectAccess === 'edit';
    applyTaskFolderColor(tr, task);
    const folderPath = getFolderPath(task.folder_id, folders);

    const gradeText = taskGradeScoreMarkup(task);

    tr.innerHTML = `
      <td><input type="checkbox" class="task-select-checkbox" aria-label="Select task" ${selectedTaskIds.has(task.id) ? 'checked' : ''} ${currentProjectAccess === 'none' ? 'disabled' : ''}></td>
      <td><span class="badge badge-${task.status}">${escapeHtml(getTaskStatusLabel(task))}</span></td>
      <td style="font-weight: 600;">${escapeHtml(task.title)}${task.extra_credit ? ' <span class="badge badge-custom">Extra Credit</span>' : ''}</td>
      <td><span class="badge badge-course folder-path-badge">${escapeHtml(folderPath || '-')}</span></td>
      <td><span class="badge badge-${task.priority}">${task.priority}</span></td>
      <td>${escapeHtml(formatTaskDateAndTime(task.start_date, task.start_time))}</td>
      <td>${escapeHtml(formatTaskDateAndTime(task.due_date, task.due_time))}</td>
      <td><strong class="list-grade-value">${gradeText}</strong></td>
      <td>${task.dependencies?.length ? `${task.dependencies.length} dependencies` : '-'}</td>
      <td>${task.progress}%</td>
      ${customFields.map(f => {
        const value = task.custom_values?.[f.id];
        return `<td>${escapeHtml(value !== null && value !== undefined && value !== '' ? formatCustomFieldValue(f, value) : '-')}</td>`;
      }).join('')}
      <td><button class="btn-secondary edit-required" style="padding:2px 8px;font-size:0.75rem;" data-action="edit-task">Edit</button></td>
    `;

    tr.addEventListener('dblclick', event => {
      if (!event.target.closest('.task-select-checkbox') && Date.now() - lastListDropAt >= 350) openTaskModal(task);
    });
    tr.querySelector('.task-select-checkbox').addEventListener('change', event => {
      if (event.target.checked) selectedTaskIds.add(task.id);
      else selectedTaskIds.delete(task.id);
      updateBulkDeleteControls();
    });
    tbody.appendChild(tr);
  });
  updateBulkDeleteControls();
}

function updateBulkDeleteControls() {
  const count = selectedTaskIds.size;
  document.getElementById('selectedTaskCount').textContent = `${count} selected`;
  document.getElementById('folderSelectedTaskCount').textContent = `${count} selected`;
  document.getElementById('btnDeleteSelectedTasks').disabled = count === 0 || currentProjectAccess !== 'edit';
  document.getElementById('btnExportSelectedFolderTasks').disabled = count === 0 || currentProjectAccess === 'none';
  document.getElementById('btnExportSelectedListTasks').disabled = count === 0 || currentProjectAccess === 'none';
  const selectAll = document.querySelector('#listTableHeaders .task-select-all');
  if (selectAll) {
    const visibleTasks = sortedTasks();
    const selectedVisibleCount = visibleTasks.filter(task => selectedTaskIds.has(task.id)).length;
    selectAll.checked = visibleTasks.length > 0 && selectedVisibleCount === visibleTasks.length;
    selectAll.indeterminate = selectedVisibleCount > 0 && selectedVisibleCount < visibleTasks.length;
  }
}

async function handleBulkDeleteTasks() {
  const selectedTasks = tasks.filter(task => selectedTaskIds.has(task.id));
  if (!selectedTasks.length || currentProjectAccess !== 'edit') return;
  const preview = selectedTasks.slice(0, 5).map(task => `â€¢ ${task.title}`).join('\n');
  const extra = selectedTasks.length > 5 ? `\nâ€¦and ${selectedTasks.length - 5} more` : '';
  if (!confirm(`Permanently delete ${selectedTasks.length} selected task(s)? This cannot be undone.\n\n${preview}${extra}`)) return;

  const button = document.getElementById('btnDeleteSelectedTasks');
  const originalText = button.textContent;
  const chunkSize = 50;
  let deletedCount = 0;
  let failure = null;
  button.disabled = true;
  try {
    for (let index = 0; index < selectedTasks.length; index += chunkSize) {
      const chunk = selectedTasks.slice(index, index + chunkSize);
      button.textContent = `Deleting ${deletedCount} of ${selectedTasks.length}...`;
      await api(`/api/projects/${currentProjectId}/tasks/bulk-delete`, {
        method: 'POST',
        body: JSON.stringify({ task_ids: chunk.map(task => task.id) })
      });
      chunk.forEach(task => selectedTaskIds.delete(task.id));
      deletedCount += chunk.length;
    }
  } catch (error) {
    failure = error;
  } finally {
    try { await loadTasks(); } catch { }
    button.textContent = originalText;
    updateBulkDeleteControls();
  }
  if (failure) alert(`Deleted ${deletedCount} of ${selectedTasks.length} task(s). The remaining selections were kept. ${failure.message}`);
}

// ----------------- 4. Gantt Chart View -----------------
function localDateString(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatTaskDateAndTime(date, time) {
  return date ? `${date}${time ? ` ${time}` : ''}` : '-';
}

function renderGanttView() {
  const sidebar = document.getElementById('ganttSidebarCol');
  const header = document.getElementById('ganttTimelineHeader');
  const barsContainer = document.getElementById('ganttBarsContainer');
  const svgLines = document.getElementById('ganttSvgLines');
  const viewport = document.getElementById('ganttViewport');
  const preferences = getGanttPreferences();
  const ganttTasks = sortTasks(excludeDoneTasks(tasks, excludeDoneFromList), folders, listSortState, projectStatusOptions());
  const ganttRows = buildGanttRows(ganttTasks, folders);
  document.getElementById('excludeDoneTasksGantt').checked = excludeDoneFromList;

  sidebar.style.width = `${preferences.sidebarWidth}px`;
  viewport.classList.toggle('gantt-sidebar-hidden', preferences.sidebarHidden);
  document.getElementById('toggleGanttSidebar').textContent = preferences.sidebarHidden ? 'Show task names' : 'Hide task names';
  document.getElementById('ganttDayWidth').value = String(preferences.dayWidth);
  document.getElementById('ganttDayWidthValue').textContent = `${preferences.dayWidth} px`;
  document.getElementById('ganttRangeStart').value = preferences.rangeStart;
  document.getElementById('ganttRangeEnd').value = preferences.rangeEnd;

  sidebar.innerHTML = '';
  header.innerHTML = '';
  barsContainer.innerHTML = '';
  svgLines.innerHTML = '';

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let minDate = new Date(today);
  let maxDate = new Date(today.getTime() + 30 * 86400000);
  const taskDates = new Map();
  ganttTasks.forEach(task => {
    const { startDate, dueDate } = taskGanttDateRange(task, today);
    taskDates.set(task.id, { startDate, dueDate });
    if (startDate < minDate) minDate = new Date(startDate);
    if (dueDate > maxDate) maxDate = new Date(dueDate);
  });

  if (preferences.rangeStart && preferences.rangeEnd && preferences.rangeEnd >= preferences.rangeStart) {
    minDate = new Date(`${preferences.rangeStart}T00:00:00`);
    maxDate = new Date(`${preferences.rangeEnd}T00:00:00`);
    maxDate.setDate(maxDate.getDate() + 1);
  } else {
    minDate.setHours(0, 0, 0, 0);
    maxDate.setHours(0, 0, 0, 0);
    minDate.setDate(minDate.getDate() - 3);
    maxDate.setDate(maxDate.getDate() + 8);
  }

  const totalDays = Math.max(1, ganttCalendarDaysBetween(minDate, maxDate));
  const dayWidth = preferences.dayWidth;
  const weeklyHeader = dayWidth < 36;
  const chartWidth = totalDays * dayWidth;

  header.style.width = `${chartWidth}px`;
  barsContainer.style.width = `${chartWidth}px`;
  svgLines.style.width = `${chartWidth}px`;
  const rowHeight = entry => entry.type === 'folder' ? 18 : 42;
  const chartHeight = ganttRows.reduce((height, entry) => height + rowHeight(entry), 0);
  barsContainer.style.height = `${chartHeight}px`;
  svgLines.style.height = `${chartHeight}px`;

  const nonWorkingDays = parseJsonArray(currentProject?.non_working_days_json, [0, 6]).map(Number);
  const holidays = new Set(parseJsonArray(currentProject?.holidays_json, []));
  for (let i = 0; i < totalDays; i++) {
    const curDate = new Date(minDate);
    curDate.setDate(curDate.getDate() + i);
    const cell = document.createElement('div');
    cell.className = 'gantt-time-cell';
    cell.style.width = `${dayWidth}px`;
    const isToday = curDate.toDateString() === today.toDateString();
    const holiday = holidays.has(localDateString(curDate));
    const nonWorking = holiday || nonWorkingDays.includes(curDate.getDay());
    if (nonWorking) cell.classList.add(holiday ? 'gantt-holiday' : 'gantt-non-working-day');
    if (isToday) cell.classList.add('gantt-today');
    cell.title = holiday ? 'Project holiday' : nonWorking ? 'Non-working day' : localDateString(curDate);
    cell.innerHTML = weeklyHeader ? '' : `<span>${curDate.getMonth() + 1}/${curDate.getDate()}</span>`;
    header.appendChild(cell);

    if (nonWorking || isToday) {
      const band = document.createElement('div');
      band.className = `gantt-calendar-band ${holiday ? 'holiday' : nonWorking ? 'non-working' : 'today'}`;
      band.style.left = `${i * dayWidth}px`;
      band.style.width = `${dayWidth}px`;
      band.style.height = `${chartHeight}px`;
      barsContainer.appendChild(band);
    }
  }

  if (weeklyHeader) {
    buildGanttWeekRanges(minDate, totalDays).forEach(week => {
      const label = document.createElement('div');
      label.className = 'gantt-week-range-cell';
      label.style.left = `${week.startIndex * dayWidth}px`;
      label.style.width = `${week.dayCount * dayWidth}px`;
      label.textContent = week.dayCount * dayWidth < 64 ? week.compactLabel : week.label;
      label.title = week.title;
      header.appendChild(label);
    });
  }

  let yTop = 0;
  for (const entry of ganttRows) {
    if (entry.type === 'folder') {
      const folder = entry.folder;
      const color = getFolderDisplayColor(folder);
      const sideCell = document.createElement('div');
      sideCell.className = 'gantt-folder-sidebar-cell';
      sideCell.style.paddingLeft = `${12 + entry.depth * 12}px`;
      sideCell.style.setProperty('--folder-color', color);
      sideCell.textContent = entry.showLabel ? folder.name : '';
      sideCell.title = getFolderPath(folder.id, folders) || folder.name;
      sidebar.appendChild(sideCell);

      const row = document.createElement('div');
      row.className = 'gantt-folder-row';
      const dates = entry.tasks.map(task => taskDates.get(task.id)).filter(Boolean);
      if (dates.length) {
        const firstDate = new Date(Math.min(...dates.map(date => date.startDate.getTime())));
        const lastDate = new Date(Math.max(...dates.map(date => date.dueDate.getTime())));
        const clippedStart = new Date(Math.max(firstDate.getTime(), minDate.getTime()));
        const clippedEnd = new Date(Math.min(lastDate.getTime(), maxDate.getTime()));
        const left = ganttTimeOffset(clippedStart, minDate) * dayWidth;
        const width = Math.max(2, (ganttTimeOffset(clippedEnd, minDate) - ganttTimeOffset(clippedStart, minDate)) * dayWidth);
        const span = document.createElement('div');
        span.className = 'gantt-folder-span';
        span.style.left = `${left}px`;
        span.style.width = `${width}px`;
        span.style.setProperty('--folder-color', color);
        if (clippedEnd <= minDate || clippedStart >= maxDate || clippedEnd <= clippedStart) span.hidden = true;
        span.title = `${getFolderPath(folder.id, folders) || folder.name}: ${firstDate.toLocaleDateString()} – ${lastDate.toLocaleDateString()}`;
        if (entry.showLabel) {
          const label = document.createElement('span');
          label.className = 'gantt-folder-span-label';
          label.textContent = folder.name;
          span.appendChild(label);
        }
        row.appendChild(span);
      }
      barsContainer.appendChild(row);
      yTop += rowHeight(entry);
      continue;
    }

    const task = entry.task;
    const { startDate, dueDate } = taskDates.get(task.id);
    const sideCell = document.createElement('div');
    sideCell.className = 'gantt-sidebar-cell';
    sideCell.dataset.taskId = task.id;
    sideCell.draggable = currentProjectAccess === 'edit';
    sideCell.style.paddingLeft = `${12 + entry.depth * 12}px`;
    sideCell.textContent = task.title;
    sideCell.title = `${task.title} (Double click to edit)`;
    sideCell.addEventListener('click', () => {
      if (Date.now() - lastGanttDropAt >= 350) openTaskModal(task);
    });
    sideCell.addEventListener('dblclick', () => openTaskModal(task));
    sidebar.appendChild(sideCell);

    const row = document.createElement('div');
    row.className = 'gantt-row';
    row.dataset.taskId = task.id;
    barsContainer.appendChild(row);

    const clippedStart = new Date(Math.max(startDate.getTime(), minDate.getTime()));
    const clippedEnd = new Date(Math.min(dueDate.getTime(), maxDate.getTime()));
    const left = ganttTimeOffset(clippedStart, minDate) * dayWidth;
    const width = Math.max(2, (ganttTimeOffset(clippedEnd, minDate) - ganttTimeOffset(clippedStart, minDate)) * dayWidth);

    const bar = document.createElement('div');
    bar.className = 'gantt-bar-item';
    bar.dataset.taskId = task.id;
    bar.draggable = currentProjectAccess === 'edit';
    applyTaskFolderColor(bar, task);
    bar.style.color = readableTextColor(getTaskFolderColor(task) || getComputedStyle(document.documentElement).getPropertyValue('--accent-1').trim());
    bar.style.left = `${left}px`;
    bar.style.width = `${width}px`;
    bar.style.top = `${yTop + 9}px`;
    if (clippedEnd <= minDate || clippedStart >= maxDate || clippedEnd <= clippedStart) bar.hidden = true;
    bar.title = `${task.title}: ${startDate.toLocaleString()} - ${dueDate.toLocaleString()}`;
    bar.innerHTML = `
      <div class="gantt-bar-progress" style="width: ${task.progress}%"></div>
      <span style="position:relative; z-index:2; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(task.title)}</span>
    `;

    bar.addEventListener('click', () => {
      if (Date.now() - lastGanttDropAt >= 350) openTaskModal(task);
    });
    bar.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      openTaskModal(task);
    });
    barsContainer.appendChild(bar);
    yTop += rowHeight(entry);
  }

  const dependencyEdges = buildGanttDependencyEdges(ganttTasks);
  if (dependencyEdges.length) {
    const namespace = 'http://www.w3.org/2000/svg';
    const defs = document.createElementNS(namespace, 'defs');
    const marker = document.createElementNS(namespace, 'marker');
    marker.setAttribute('id', 'gantt-dependency-arrowhead');
    marker.setAttribute('viewBox', '0 0 8 8');
    marker.setAttribute('refX', '7');
    marker.setAttribute('refY', '4');
    marker.setAttribute('markerWidth', '7');
    marker.setAttribute('markerHeight', '7');
    marker.setAttribute('orient', 'auto');
    const dependencyColor = getComputedStyle(document.documentElement).getPropertyValue('--accent-2').trim() || '#25c2fd';
    const arrowHead = document.createElementNS(namespace, 'path');
    arrowHead.setAttribute('d', 'M 0 0 L 8 4 L 0 8 z');
    arrowHead.setAttribute('fill', dependencyColor);
    marker.appendChild(arrowHead);
    defs.appendChild(marker);
    svgLines.appendChild(defs);

    const rowsByTaskId = new Map([...barsContainer.querySelectorAll('.gantt-row')].map(row => [row.dataset.taskId, row]));
    const barsByTaskId = new Map([...barsContainer.querySelectorAll('.gantt-bar-item')].map(bar => [bar.dataset.taskId, bar]));
    for (const { from, to } of dependencyEdges) {
      const fromRow = rowsByTaskId.get(from);
      const toRow = rowsByTaskId.get(to);
      const fromBar = barsByTaskId.get(from);
      const toBar = barsByTaskId.get(to);
      if (!fromRow || !toRow || !fromBar || !toBar || fromBar.hidden || toBar.hidden) continue;

      const fromX = parseFloat(fromBar.style.left || '0') + parseFloat(fromBar.style.width || '0');
      const toX = parseFloat(toBar.style.left || '0');
      const fromY = fromRow.offsetTop + fromRow.offsetHeight / 2;
      const toY = toRow.offsetTop + toRow.offsetHeight / 2;
      const path = document.createElementNS(namespace, 'path');
      path.setAttribute('class', 'dep-line');
      path.setAttribute('d', ganttDependencyPath(fromX, fromY, toX, toY));
      path.setAttribute('marker-end', 'url(#gantt-dependency-arrowhead)');
      path.setAttribute('stroke', dependencyColor);
      path.setAttribute('stroke-width', '1.5');
      path.setAttribute('stroke-dasharray', '4 3');
      path.setAttribute('fill', 'none');
      path.setAttribute('opacity', '0.8');
      const title = document.createElementNS(namespace, 'title');
      title.textContent = `${tasks.find(task => task.id === to)?.title || 'Task'} depends on ${tasks.find(task => task.id === from)?.title || 'task'}`;
      path.appendChild(title);
      svgLines.appendChild(path);
    }
  }
}

function getFolderDisplayColor(folder) {
  const visited = new Set();
  let current = folder;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (typeof current.color === 'string' && /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(current.color)) return current.color;
    current = folders.find(item => item.id === current.parent_id);
  }
  return '#8fa6a6';
}

// ----------------- Task Modal Handlers -----------------
function populateTaskFolderDropdown(selectedFolderId = '') {
  const select = document.getElementById('taskFolder');
  select.innerHTML = '<option value="">-- General / No Folder --</option>';

  // Recursive helper: adds folder then all its descendants indented
  function addFolderOption(folder, depth) {
    const opt = document.createElement('option');
    opt.value = folder.id;
    const indent = '\u00a0\u00a0'.repeat(depth);
    const weightText = formatCustomFieldValue({ name: 'Grade Weight %' }, Number(folder.weight_percent) || 0);
    opt.textContent = `${indent}${folder.name}${folder.weight_percent > 0 ? ` (${weightText}%)` : ''}`;
    if (folder.id === selectedFolderId) opt.selected = true;
    select.appendChild(opt);

    folders.filter(f => f.parent_id === folder.id).forEach(child => addFolderOption(child, depth + 1));
  }

  folders.filter(f => !f.parent_id).forEach(root => addFolderOption(root, 0));
}

function openTaskModal(task = null, presetFolderId = '') {
  document.getElementById('taskModalTitle').textContent = task ? 'Edit Task' : 'Create Task';
  document.getElementById('taskId').value = task ? task.id : '';
  document.getElementById('taskTitle').value = task ? task.title : '';
  document.getElementById('taskDesc').value = task ? task.description : '';
  document.getElementById('taskStatus').value = task ? task.status : 'todo';
  populateTaskStatusOptions(task ? task.status : 'todo', task?.status_label || '');
  document.getElementById('taskPriority').value = task ? task.priority : 'medium';
  document.getElementById('taskStartDate').value = task?.start_date || '';
  document.getElementById('taskDueDate').value = task?.due_date || '';
  document.getElementById('taskStartTime').value = task?.start_time || '';
  document.getElementById('taskDueTime').value = task?.due_time || '';
  document.getElementById('taskOpenAt').value = task?.open_at || '';
  document.getElementById('taskProgress').value = task?.progress || 0;
  document.getElementById('progressLabel').textContent = task?.progress || 0;

  document.getElementById('taskEarnedPoints').value = (task?.earned_points !== null && task?.earned_points !== undefined) ? task.earned_points : '';
  document.getElementById('taskMaxPoints').value = task?.max_points || '';
  document.getElementById('taskGrade').value = (task?.grade !== null && task?.grade !== undefined) ? task.grade : '';
  document.getElementById('taskExtraCredit').checked = Boolean(task?.extra_credit);

  renderTaskCustomFields(task);

  populateTaskFolderDropdown(task?.folder_id || presetFolderId);

  const btnDelete = document.getElementById('btnDeleteTask');
  if (task && currentProjectAccess === 'edit') {
    btnDelete.classList.remove('hidden');
  } else {
    btnDelete.classList.add('hidden');
  }

  // Populate dependencies
  const depSelect = document.getElementById('taskDependencies');
  depSelect.innerHTML = '';
  const folderRank = new Map();
  let nextFolderRank = 0;
  function rankFolders(parentId) {
    folders.filter(folder => (folder.parent_id || null) === parentId).forEach(folder => {
      folderRank.set(folder.id, nextFolderRank++);
      rankFolders(folder.id);
    });
  }
  rankFolders(null);
  const originalTaskOrder = new Map(tasks.map((item, index) => [item.id, index]));
  tasks.filter(t => !task || t.id !== task.id)
    .sort((a, b) => (folderRank.get(a.folder_id) ?? Number.MAX_SAFE_INTEGER)
      - (folderRank.get(b.folder_id) ?? Number.MAX_SAFE_INTEGER)
      || originalTaskOrder.get(a.id) - originalTaskOrder.get(b.id))
    .forEach(t => {
    const opt = document.createElement('option');
    opt.value = t.id;
    const folderPath = t.folder_id ? getFolderPath(t.folder_id, folders) : 'Unfiled';
    const indent = '\u00a0\u00a0'.repeat(getFolderDepth(t.folder_id));
    opt.textContent = `${indent}${folderPath ? `${folderPath} / ` : ''}${t.title}`;
    if (task && task.dependencies && task.dependencies.includes(t.id)) {
      opt.selected = true;
    }
    depSelect.appendChild(opt);
  });

  taskModal.classList.remove('hidden');
}

function renderTaskCustomFields(task) {
  const container = document.getElementById('dynamicCustomFieldsContainer');
  container.innerHTML = '';
  document.getElementById('taskCustomFieldsGroup').classList.toggle('hidden', customFields.length === 0);
  customFields.forEach(field => {
    const group = document.createElement('div');
    group.className = 'form-group';
    const value = task?.custom_values?.[field.id] ?? '';
    const inputId = `task-custom-${field.id}`;
    const label = document.createElement('label');
    label.htmlFor = inputId;
    label.textContent = field.name;
    let input;
    if (field.field_type === 'select') {
      input = document.createElement('select');
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = '-- Select --';
      input.appendChild(empty);
      let options = [];
      try { options = JSON.parse(field.options_json || '[]'); } catch { }
      options.forEach(option => {
        const item = document.createElement('option');
        item.value = option;
        item.textContent = option;
        input.appendChild(item);
      });
    } else if (field.field_type === 'checkbox') {
      input = document.createElement('select');
      [['', '-- Select --'], ['Yes', 'Yes'], ['No', 'No']].forEach(([v, text]) => {
        const option = document.createElement('option');
        option.value = v;
        option.textContent = text;
        input.appendChild(option);
      });
    } else {
      input = document.createElement('input');
      input.type = ['text', 'number', 'date'].includes(field.field_type) ? field.field_type : 'text';
      if (input.type === 'number') input.step = /\bgrade\s*weight\b/i.test(field.name) ? 'any' : '0.01';
    }
    input.id = inputId;
    input.dataset.customFieldId = field.id;
    input.value = value;
    group.append(label, input);
    container.appendChild(group);
  });
}

window.openTaskModalById = (id) => {
  const task = tasks.find(t => t.id === id);
  if (task) openTaskModal(task);
};

async function handleSaveTask(e) {
  e.preventDefault();
  if (currentProjectAccess !== 'edit') {
    alert('You have read-only access on this project.');
    return;
  }

  const taskId = document.getElementById('taskId').value;
  const title = document.getElementById('taskTitle').value;
  const description = document.getElementById('taskDesc').value;
  const folder_id = document.getElementById('taskFolder').value;
  const status = document.getElementById('taskStatus').value;
  const status_label = document.getElementById('taskStatusLabel').value.trim();
  const priority = document.getElementById('taskPriority').value;
  const start_date = document.getElementById('taskStartDate').value;
  const due_date = document.getElementById('taskDueDate').value;
  const start_time = document.getElementById('taskStartTime').value;
  const due_time = document.getElementById('taskDueTime').value;
  const open_at = document.getElementById('taskOpenAt').value;
  const progress = parseInt(document.getElementById('taskProgress').value, 10);
  const earned_points = document.getElementById('taskEarnedPoints').value;
  const max_points = document.getElementById('taskMaxPoints').value;
  const gradeRaw = document.getElementById('taskGrade').value;
  const grade = gradeRaw !== '' ? parseFloat(gradeRaw) : null;
  const extra_credit = document.getElementById('taskExtraCredit').checked;

  const depSelect = document.getElementById('taskDependencies');
  const dependencies = Array.from(depSelect.selectedOptions).map(o => o.value);
  const custom_values = Object.fromEntries(
    Array.from(document.querySelectorAll('#dynamicCustomFieldsContainer [data-custom-field-id]'))
      .map(input => [input.dataset.customFieldId, input.value])
  );
  const gradeWeightField = customFields.find(field => /\bgrade\s*weight\b/i.test(field.name));
  const gradeWeightValue = gradeWeightField ? custom_values[gradeWeightField.id] : undefined;
  const weight_override = gradeWeightValue === undefined || gradeWeightValue === ''
    ? null
    : Number.isFinite(Number(gradeWeightValue)) ? Number(gradeWeightValue) : null;

  const payload = {
    title,
    description,
    folder_id,
    status,
    status_label,
    priority,
    start_date,
    due_date,
    start_time,
    due_time,
    open_at,
    progress,
    earned_points,
    max_points,
    grade,
    ...(gradeWeightField ? { weight_override } : {}),
    extra_credit,
    dependencies,
    custom_values
  };

  try {
    if (taskId) {
      await api(`/api/tasks/${taskId}`, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      await api(`/api/projects/${currentProjectId}/tasks`, { method: 'POST', body: JSON.stringify(payload) });
    }
    taskModal.classList.add('hidden');
    await loadTasks();
  } catch (err) {
    alert('Failed to save task: ' + err.message);
  }
}

async function handleDeleteTask() {
  const taskId = document.getElementById('taskId').value;
  if (!taskId || !confirm('Are you sure you want to delete this task?')) return;

  try {
    await api(`/api/tasks/${taskId}`, { method: 'DELETE' });
    taskModal.classList.add('hidden');
    await loadTasks();
  } catch (err) {
    alert('Failed to delete task: ' + err.message);
  }
}

// ----------------- Folder & Subfolder Modal Handlers -----------------
function populateParentFolderDropdown(selectedParentId = '', excludeFolderId = '') {
  const select = document.getElementById('folderParent');
  select.innerHTML = '<option value="">-- None (Root Folder / Class) --</option>';

  // Collect all descendant IDs of the excluded folder to prevent circular nesting
  function getDescendantIds(folderId) {
    const ids = new Set([folderId]);
    folders.filter(f => f.parent_id === folderId).forEach(child => {
      getDescendantIds(child.id).forEach(id => ids.add(id));
    });
    return ids;
  }
  const excluded = excludeFolderId ? getDescendantIds(excludeFolderId) : new Set();

  // Recursive helper: add folder and its children as indented options
  function addParentOption(folder, depth) {
    if (excluded.has(folder.id)) return;
    const opt = document.createElement('option');
    opt.value = folder.id;
    const indent = '\u00a0\u00a0'.repeat(depth);
    opt.textContent = `${indent}${folder.name}`;
    if (folder.id === selectedParentId) opt.selected = true;
    select.appendChild(opt);

    folders.filter(f => f.parent_id === folder.id).forEach(child => addParentOption(child, depth + 1));
  }

  folders.filter(f => !f.parent_id).forEach(root => addParentOption(root, 0));
}

function openFolderModal(folderToEdit = null, presetParentId = '') {
  if (folderToEdit) {
    document.getElementById('folderModalTitle').textContent = 'Edit Folder / Subfolder';
    document.getElementById('folderId').value = folderToEdit.id;
    document.getElementById('folderName').value = folderToEdit.name;
    document.getElementById('folderDesc').value = folderToEdit.description || '';
    document.getElementById('folderWeight').value = folderToEdit.weight_percent ?? '';
    document.getElementById('folderDropLowest').value = Number(folderToEdit.drop_lowest_count) || 0;
    document.getElementById('folderBonusCap').checked = Boolean(folderToEdit.bonus_cap_enabled);
    document.getElementById('folderColor').value = folderToEdit.color || '#25c2fd';
    populateParentFolderDropdown(folderToEdit.parent_id, folderToEdit.id);
    document.getElementById('btnDeleteFolder').classList.remove('hidden');
  } else {
    document.getElementById('folderModalTitle').textContent = 'New Folder / Subfolder';
    document.getElementById('folderId').value = '';
    document.getElementById('folderName').value = '';
    document.getElementById('folderDesc').value = '';
    document.getElementById('folderWeight').value = '';
    document.getElementById('folderDropLowest').value = '0';
    document.getElementById('folderBonusCap').checked = false;
    document.getElementById('folderColor').value = '#25c2fd';
    populateParentFolderDropdown(presetParentId);
    document.getElementById('btnDeleteFolder').classList.add('hidden');
  }
  folderModal.classList.remove('hidden');
}

window.openFolderModalById = (id) => {
  const folder = folders.find(f => f.id === id);
  if (folder) openFolderModal(folder);
};

window.openFolderModal = openFolderModal;
window.openTaskModal = openTaskModal;

async function handleSaveFolder(e) {
  e.preventDefault();
  const folderId = document.getElementById('folderId').value;
  const name = document.getElementById('folderName').value.trim();
  const parent_id = document.getElementById('folderParent').value || null;
  const description = document.getElementById('folderDesc').value;
  const weight_percent = parseFloat(document.getElementById('folderWeight').value) || 0;
  const drop_lowest_count = Math.max(0, Math.floor(Number(document.getElementById('folderDropLowest').value) || 0));
  const bonus_cap_enabled = document.getElementById('folderBonusCap').checked;
  const color = document.getElementById('folderColor').value;

  const payload = { name, parent_id, description, weight_percent, drop_lowest_count, bonus_cap_enabled, color };

  try {
    if (folderId) {
      await api(`/api/folders/${folderId}`, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      await api(`/api/projects/${currentProjectId}/folders`, { method: 'POST', body: JSON.stringify(payload) });
    }
    folderModal.classList.add('hidden');
    await loadFolders();
    await loadTasks();
  } catch (err) {
    alert('Failed to save folder: ' + err.message);
  }
}

async function handleDeleteFolder() {
  const folderId = document.getElementById('folderId').value;
  if (!folderId || !confirm('Are you sure you want to delete this folder and any nested subfolders?')) return;

  try {
    await api(`/api/folders/${folderId}`, { method: 'DELETE' });
    folderModal.classList.add('hidden');
    await loadFolders();
    await loadTasks();
  } catch (err) {
    alert('Failed to delete folder: ' + err.message);
  }
}

// ----------------- Project Members & Permissions Modal -----------------
async function openMembersModal() {
  if (currentUser?.systemRole !== 'admin') {
    membersModal.classList.add('hidden');
    return;
  }
  const hasProject = Boolean(currentProject && currentProjectId);
  document.getElementById('membersModalHeading').textContent = hasProject ? 'Users & Project Permissions' : 'User Accounts';
  document.getElementById('membersModalHelp').innerHTML = hasProject
    ? 'Manage accounts and project access. System administrators retain global access until their system role changes. Current project: <strong id="membersProjectTitle"></strong>.'
    : 'Add or remove user accounts and manage system administrator roles.';
  if (hasProject) document.getElementById('membersProjectTitle').textContent = currentProject.name;
  document.querySelectorAll('.project-access-column').forEach(cell => cell.classList.toggle('hidden', !hasProject));
  membersModal.classList.remove('hidden');

  try {
    const members = await api(hasProject ? `/api/projects/${currentProjectId}/members` : '/api/admin/users');
    const tbody = document.getElementById('projectMembersTableBody');
    tbody.innerHTML = '';
    document.getElementById('newUserForm').reset();

    members.forEach(m => {
      const tr = document.createElement('tr');
      const isSelf = currentUser && currentUser.id === m.userId;

      tr.innerHTML = `
        <td><strong>${escapeHtml(m.username)}</strong> ${isSelf ? '<span class="badge badge-custom">You</span>' : ''}</td>
        <td>${escapeHtml(m.name || '-')}</td>
        <td>
          <select class="system-role-select" data-user-id="${escapeHtml(m.userId)}">
            <option value="user" ${m.systemRole !== 'admin' ? 'selected' : ''}>User</option>
            <option value="admin" ${m.systemRole === 'admin' ? 'selected' : ''}>System administrator</option>
          </select>
        </td>
        <td class="project-access-column ${hasProject ? '' : 'hidden'}">
          <span class="badge ${m.accessLevel === 'edit' ? 'badge-success' : m.accessLevel === 'view' ? 'badge-medium' : 'badge-urgent'}">
            ${(m.accessLevel || 'N/A').toUpperCase()}
          </span>
        </td>
        <td class="project-access-column ${hasProject ? '' : 'hidden'}">
          <select class="member-role-select" data-user-id="${escapeHtml(m.userId)}" ${hasProject ? '' : 'disabled'}>
            <option value="edit" ${m.accessLevel === 'edit' ? 'selected' : ''}>Edit (Full)</option>
            <option value="view" ${m.accessLevel === 'view' ? 'selected' : ''}>View (Read-only)</option>
            <option value="none" ${m.accessLevel === 'none' ? 'selected' : ''}>None (No access)</option>
          </select>
        </td>
        <td><button class="btn-danger remove-user-button" type="button" data-user-id="${escapeHtml(m.userId)}" ${isSelf ? 'disabled title="You cannot remove your own account."' : ''}>Remove</button></td>
      `;

      const memberRoleSelect = tr.querySelector('.member-role-select');
      if (memberRoleSelect) memberRoleSelect.addEventListener('change', async (e) => {
        const newAccess = e.target.value;
        try {
          await api(`/api/projects/${currentProjectId}/members/${encodeURIComponent(m.userId)}`, {
            method: 'PUT',
            body: JSON.stringify({ access_level: newAccess })
          });
          await openMembersModal();
        } catch (err) {
          alert('Failed to update project member access: ' + err.message);
        }
      });

      tr.querySelector('.system-role-select').addEventListener('change', async (e) => {
        const systemRole = e.target.value;
        if (isSelf && systemRole === 'user' && !confirm('Remove system administrator privileges from your account? You may lose access to projects where you are not an editor.')) {
          e.target.value = 'admin';
          return;
        }
        try {
          await api(`/api/admin/users/${encodeURIComponent(m.userId)}/role`, {
            method: 'PUT',
            body: JSON.stringify({ system_role: systemRole })
          });
          if (isSelf) {
            const response = await api('/api/auth/me');
            currentUser = response.user;
            userDisplayName.textContent = currentUser.name;
            userRoleSubtext.textContent = currentUser.systemRole === 'admin' ? '(System Admin)' : '';
            await loadProjects();
            if (currentUser.systemRole === 'admin') await openMembersModal();
            else membersModal.classList.add('hidden');
          } else {
            openMembersModal();
          }
        } catch (err) {
          alert('Failed to update system role: ' + err.message);
          openMembersModal();
        }
      });

      tr.querySelector('.remove-user-button').addEventListener('click', async () => {
        if (isSelf || !confirm(`Remove the account "${m.username}"? Their active sessions and project access will be revoked.`)) return;
        try {
          await api(`/api/admin/users/${encodeURIComponent(m.userId)}`, { method: 'DELETE' });
          await openMembersModal();
        } catch (err) {
          alert('Failed to remove user: ' + err.message);
        }
      });

      tbody.appendChild(tr);
    });
  } catch (err) {
    alert('Failed to load project members: ' + err.message);
  }
}

async function handleCreateUser(event) {
  event.preventDefault();
  const username = document.getElementById('newUserUsername').value.trim();
  const name = document.getElementById('newUserName').value.trim();
  const password = document.getElementById('newUserPassword').value;
  const system_role = document.getElementById('newUserSystemRole').value;
  try {
    await api('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username, name, password, system_role })
    });
    document.getElementById('newUserPassword').value = '';
    await openMembersModal();
  } catch (err) {
    alert('Failed to add user: ' + err.message);
  }
}

// ----------------- Project Modal Handlers -----------------
function parseJsonArray(value, fallback = []) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function renderProjectHolidayList() {
  const list = document.getElementById('projectHolidayList');
  list.innerHTML = '';
  projectHolidayDraft.forEach((date, index) => {
    const row = document.createElement('div');
    row.className = 'project-holiday-row';
    const label = document.createElement('span');
    label.textContent = date;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn-secondary';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      projectHolidayDraft.splice(index, 1);
      renderProjectHolidayList();
    });
    row.append(label, remove);
    list.appendChild(row);
  });
}

function addProjectHoliday() {
  const input = document.getElementById('projectHolidayDate');
  if (!input.value) return;
  if (!projectHolidayDraft.includes(input.value)) projectHolidayDraft.push(input.value);
  projectHolidayDraft.sort();
  input.value = '';
  renderProjectHolidayList();
}

function openProjectModal(projectToEdit = null) {
  const nonWorkingDays = parseJsonArray(projectToEdit?.non_working_days_json, [0, 6]).map(Number);
  document.querySelectorAll('.project-day-checkbox').forEach(input => {
    input.checked = nonWorkingDays.includes(Number(input.value));
  });
  projectHolidayDraft = parseJsonArray(projectToEdit?.holidays_json, []).filter(date => typeof date === 'string');
  renderProjectHolidayList();

  if (projectToEdit) {
    document.getElementById('projectModalTitle').textContent = 'Project Settings & Default View';
    document.getElementById('editProjId').value = projectToEdit.id;
    document.getElementById('projName').value = projectToEdit.name;
    document.getElementById('projDesc').value = projectToEdit.description || '';
    document.getElementById('projColor').value = projectToEdit.color || '#38d8aa';
    document.getElementById('projDefaultView').value = projectToEdit.default_view || 'folder';
    document.getElementById('btnDeleteProject').classList.remove('hidden');
  } else {
    document.getElementById('projectModalTitle').textContent = 'New Project / Workflow';
    document.getElementById('editProjId').value = '';
    document.getElementById('projName').value = '';
    document.getElementById('projDesc').value = '';
    document.getElementById('projColor').value = '#38d8aa';
    document.getElementById('projDefaultView').value = 'folder';
    document.getElementById('btnDeleteProject').classList.add('hidden');
  }
  let statusOptions = { todo: [], in_progress: [], done: [] };
  try {
    statusOptions = JSON.parse(projectToEdit?.status_options_json || '{}');
  } catch { }
  document.getElementById('statusOptionsTodo').value = (statusOptions.todo || []).join('\n');
  document.getElementById('statusOptionsInProgress').value = (statusOptions.in_progress || []).join('\n');
  document.getElementById('statusOptionsDone').value = (statusOptions.done || []).join('\n');
  projectModal.classList.remove('hidden');
}

async function handleSaveProject(e) {
  e.preventDefault();
  const id = document.getElementById('editProjId').value;
  const name = document.getElementById('projName').value;
  const description = document.getElementById('projDesc').value;
  const color = document.getElementById('projColor').value;
  const default_view = document.getElementById('projDefaultView').value;
  const non_working_days = Array.from(document.querySelectorAll('.project-day-checkbox:checked')).map(input => Number(input.value));
  const holidays = [...projectHolidayDraft];
  const status_options = {
    todo: document.getElementById('statusOptionsTodo').value.split(/\r?\n/).map(label => label.trim()).filter(Boolean),
    in_progress: document.getElementById('statusOptionsInProgress').value.split(/\r?\n/).map(label => label.trim()).filter(Boolean),
    done: document.getElementById('statusOptionsDone').value.split(/\r?\n/).map(label => label.trim()).filter(Boolean)
  };

  try {
    if (id) {
      await api(`/api/projects/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ name, description, color, default_view, non_working_days, holidays, status_options })
      });
      projectModal.classList.add('hidden');
      await loadProjects();
      selectProject(id);
    } else {
      const newProj = await api('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ name, description, color, default_view, non_working_days, holidays, status_options })
      });
      projectModal.classList.add('hidden');
      await loadProjects();
      selectProject(newProj.id);
    }
  } catch (err) {
    alert('Failed to save project: ' + err.message);
  }
}

async function handleDeleteProject() {
  const id = document.getElementById('editProjId').value;
  if (!id || !confirm('Permanently delete this project?')) return;

  try {
    await api(`/api/projects/${id}`, { method: 'DELETE' });
    projectModal.classList.add('hidden');
    currentProjectId = null;
    await loadProjects();
  } catch (err) {
    alert('Failed to delete project: ' + err.message);
  }
}

// ----------------- Custom Fields Modal Handlers -----------------
function openFieldsModal() {
  if (!currentProject) return;
  resetFieldForm();
  renderFieldsList();
  fieldsModal.classList.remove('hidden');
}

function resetFieldForm() {
  document.getElementById('editingFieldId').value = '';
  document.getElementById('fieldFormHeading').textContent = 'Add Custom Field';
  document.getElementById('btnSaveField').textContent = '+ Add Field';
  document.getElementById('btnCancelEditField').classList.add('hidden');
  document.getElementById('newFieldName').value = '';
  document.getElementById('newFieldType').value = 'text';
  document.getElementById('newFieldOptions').value = '';
  document.getElementById('selectOptionsGroup').style.display = 'none';
}

function renderFieldsList() {
  const list = document.getElementById('fieldsList');
  list.innerHTML = '';
  if (customFields.length === 0) {
    list.innerHTML = '<p class="form-hint">No custom fields defined yet.</p>';
    return;
  }

  customFields.forEach(f => {
    const item = document.createElement('div');
    item.className = 'field-item-row';
    item.innerHTML = `
      <div style="flex:1;">
        <strong>${escapeHtml(f.name)}</strong> 
        <span style="color:var(--text-muted); font-size:0.75rem;">(${f.field_type})</span>
        ${f.options && f.options.length > 0 ? `<div style="font-size: 0.75rem; color: #25c2fd;">Options: ${escapeHtml(f.options.join(', '))}</div>` : ''}
      </div>
      <div style="display:flex; gap:0.4rem;">
        <button class="btn-secondary edit-required" style="padding: 2px 8px; font-size: 0.75rem;" data-action="edit">Edit</button>
        <button class="btn-danger edit-required" style="padding: 2px 8px; font-size: 0.75rem;" data-action="delete">Delete</button>
      </div>
    `;
    // Wire via addEventListener (CSP blocks inline onclick)
    item.querySelector('[data-action="edit"]').addEventListener('click', () => window.startEditField(f.id));
    item.querySelector('[data-action="delete"]').addEventListener('click', () => window.handleDeleteField(f.id));
    list.appendChild(item);
  });
}

window.startEditField = (fieldId) => {
  const field = customFields.find(f => f.id === fieldId);
  if (!field) return;

  document.getElementById('editingFieldId').value = field.id;
  document.getElementById('fieldFormHeading').textContent = `Edit Field: "${field.name}"`;
  document.getElementById('btnSaveField').textContent = 'Save Changes';
  document.getElementById('btnCancelEditField').classList.remove('hidden');
  document.getElementById('newFieldName').value = field.name;
  document.getElementById('newFieldType').value = field.field_type;

  if (field.field_type === 'select') {
    document.getElementById('selectOptionsGroup').style.display = 'block';
    document.getElementById('newFieldOptions').value = (field.options || []).join(', ');
  } else {
    document.getElementById('selectOptionsGroup').style.display = 'none';
    document.getElementById('newFieldOptions').value = '';
  }
};

async function handleSaveField(e) {
  e.preventDefault();
  const editingId = document.getElementById('editingFieldId').value;
  const name = document.getElementById('newFieldName').value.trim();
  const field_type = document.getElementById('newFieldType').value;
  const optionsInput = document.getElementById('newFieldOptions').value.trim();

  let options = [];
  if (field_type === 'select' && optionsInput) {
    options = optionsInput.split(',').map(s => s.trim()).filter(Boolean);
  }

  try {
    if (editingId) {
      await api(`/api/fields/${editingId}`, {
        method: 'PUT',
        body: JSON.stringify({ name, field_type, options })
      });
    } else {
      await api(`/api/projects/${currentProjectId}/fields`, {
        method: 'POST',
        body: JSON.stringify({ name, field_type, options })
      });
    }

    resetFieldForm();
    await loadCustomFields();
    renderFieldsList();
    renderCurrentView();
  } catch (err) {
    alert('Failed to save field: ' + err.message);
  }
}

window.handleDeleteField = async (fieldId) => {
  if (!confirm('Are you sure you want to delete this custom field?')) return;
  try {
    await api(`/api/fields/${fieldId}`, { method: 'DELETE' });
    await loadCustomFields();
    renderFieldsList();
    await loadTasks();
  } catch (err) {
    alert('Failed to delete custom field: ' + err.message);
  }
};

// ----------------- Utility -----------------
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
