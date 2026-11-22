import test from 'node:test';
import assert from 'node:assert/strict';
import { canvasCourseToBackup, canvasCourseLabel, parseCanvasAssignmentsHtml, detectCanvasAssignmentsHtml } from '../public/canvas-utils.js';

test('imports weighted Canvas groups, grades, dates, omissions, and drop-lowest rules', () => {
  const backup = canvasCourseToBackup({
    id: 42,
    name: 'Biology 101',
    course_code: 'BIOL 101',
    apply_assignment_group_weights: true
  }, [
    {
      id: 7, name: 'Homework', position: 1, group_weight: 80,
      rules: { drop_lowest: 1, drop_highest: 2, never_drop: [101] },
      assignments: [
        { id: 101, name: 'Cell Worksheet', points_possible: 20, due_at: '2026-09-03T23:59:00-06:00', unlock_at: '2026-09-01T08:00:00-06:00', submission: { score: 18, workflow_state: 'graded' } },
        { id: 102, name: 'Practice (not graded)', points_possible: 5, omit_from_final_grade: true, submission: { score: null } }
      ]
    },
    {
      id: 8, name: 'Extra Credit', position: 2, group_weight: 5, assignments: [
        { id: 103, name: 'Optional Review', points_possible: 0, submission: { score: 2, workflow_state: 'graded' } }
      ]
    }
  ], 'https://canvas.example.edu');

  assert.equal(backup.source.system, 'canvas');
  assert.equal(backup.folders.find(folder => folder.name === 'Homework').weight_percent, 80);
  assert.equal(backup.folders.find(folder => folder.name === 'Homework').drop_lowest_count, 1);
  assert.equal(backup.folders.find(folder => folder.name === 'Homework').drop_highest_count, 2);
  assert.equal(backup.folders.find(folder => folder.name === 'Extra Credit').bonus_cap_enabled, true);
  const graded = backup.tasks.find(task => task.id.endsWith('-101'));
  assert.equal(graded.earned_points, 18);
  assert.equal(graded.max_points, 20);
  assert.equal(graded.never_drop, true);
  assert.match(graded.due_date, /^\d{4}-\d\d-\d\d$/);
  assert.match(graded.due_time, /^\d\d:\d\d$/);
  assert.ok(graded.open_at);
  const omitted = backup.tasks.find(task => task.id.endsWith('-102'));
  assert.equal(omitted.weight_override, 0);
  assert.equal(omitted.status, 'todo', 'an ungraded Canvas submission with a null score stays ungraded');
  assert.equal(omitted.never_drop, false);
  const extra = backup.tasks.find(task => task.id.endsWith('-103'));
  assert.equal(extra.extra_credit, true);
  assert.equal(extra.weight_override, 2);
});

test('derives Canvas group weights from points when assignment groups are not weighted', () => {
  const backup = canvasCourseToBackup({ id: 9, name: 'Unweighted course', apply_assignment_group_weights: false }, [
    { id: 1, name: 'Short work', group_weight: 0, assignments: [{ id: 11, name: 'Quiz', points_possible: 25 }] },
    { id: 2, name: 'Long work', group_weight: 0, assignments: [{ id: 22, name: 'Project', points_possible: 75 }] }
  ]);
  assert.deepEqual(backup.folders.slice(1).map(folder => folder.weight_percent), [25, 75]);
});

test('formats Canvas course labels with the course code', () => {
  assert.equal(canvasCourseLabel({ name: 'Biology', course_code: 'BIOL 101' }), 'BIOL 101 — Biology');
  assert.equal(canvasCourseLabel({ name: 'BIOL 101 - Biology', course_code: 'BIOL 101' }), 'BIOL 101 - Biology');
});

test('parses a downloaded Canvas assignments table without executing page scripts', () => {
  const html = `<!doctype html><html><head><title>Biology 101 - Assignments</title></head><body>
    <script>throw new Error('must not run');</script>
    <table id="assignments"><thead><tr><th>Assignment</th><th>Due</th><th>Points</th><th>Score</th></tr></thead>
    <tbody><tr data-assignment-id="701" data-course-id="42"><td><a href="/courses/42/assignments/701">Lab &amp; Report</a></td><td>Sep 3, 2026 at 11:59pm</td><td>20</td><td>18 / 20</td></tr>
    <tr data-assignment-id="702" data-course-id="42"><td><a href="/courses/42/assignments/702">Final Project</a></td><td>No Due Date</td><td>100</td><td>--</td></tr></tbody></table></body></html>`;
  const parsed = parseCanvasAssignmentsHtml(html, { instanceUrl: 'https://canvas.example.edu' });
  assert.equal(parsed.courseId, '42');
  assert.equal(parsed.courseName, 'Biology 101');
  assert.equal(parsed.backup.tasks.length, 2);
  const graded = parsed.backup.tasks.find(task => task.title === 'Lab & Report');
  assert.equal(graded.earned_points, 18);
  assert.equal(graded.max_points, 20);
  assert.equal(graded.status, 'done');
  assert.match(graded.due_date, /^2026-09-03$/);
  assert.equal(parsed.backup.tasks.find(task => task.title === 'Final Project').due_date, null);
});

test('rejects HTML without a Canvas assignments table', () => {
  assert.throws(() => parseCanvasAssignmentsHtml('<html><title>Canvas</title><body>Not an assignments page</body></html>'), /Could not find a Canvas assignments table/);
});

test('identifies Canvas assignments HTML for automatic import selection', () => {
  assert.equal(detectCanvasAssignmentsHtml('<table><tr><th>Assignment</th></tr><tr><td><a href="/courses/1/assignments/2">Quiz</a></td></tr></table>'), true);
  assert.equal(detectCanvasAssignmentsHtml('<script>const studentAssignmentsData = {};</script>'), false);
});
