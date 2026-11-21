import test from 'node:test';
import assert from 'node:assert/strict';
import { detectCsvProfile, getCsvProfile, normalizeImportRow, parseTransferDateValue, parseTransferTimeValue } from '../public/transfer-utils.js';

function localDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function localTime(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

test('maps ClickUp export headers to task fields and retains remaining categories as custom values', () => {
  const headers = [
    'Task ID', 'Task Custom ID', 'Task Name', 'Task Content', 'Status', 'Due date', 'Due date Text',
    'Priority', 'List Name', 'Folder Name/Path', 'Assignees', 'Tags', 'Task Type', 'Parent ID'
  ];
  const record = {
    'Task ID': 'abc-123', 'Task Custom ID': 'OPS-12', 'Task Name': 'Prepare report',
    'Task Content': 'Summarize findings', Status: 'in progress', 'Due date': '1795217696000',
    'Due date Text': '2026-11-21 3:34 PM', Priority: 'High', 'List Name': 'Assignments',
    'Folder Name/Path': 'School / Biology / Labs', Assignees: '[Alex Smith]', Tags: '[writing,review]',
    'Task Type': 'Task', 'Parent ID': 'parent-1'
  };
  const row = normalizeImportRow(record, headers);
  assert.equal(row.id, 'abc-123');
  assert.equal(row.title, 'Prepare report');
  assert.equal(row.description, 'Summarize findings');
  assert.equal(row.due_date, '1795217696000');
  assert.equal(row.due_date_text, '2026-11-21 3:34 PM');
  assert.equal(row.folder_path, 'School / Biology / Labs');
  assert.equal(row.custom['Assignees'], 'Alex Smith');
  assert.equal(row.custom['Tags'], 'writing,review');
  assert.equal(row.custom['Task Type'], 'Task');
  assert.equal(row.custom['Parent ID'], 'parent-1');
});

test('parses Unix millisecond due dates into local date and time', () => {
  const timestamp = Date.UTC(2026, 10, 21, 22, 45, 0);
  const expected = new Date(timestamp);
  const date = `${expected.getFullYear()}-${String(expected.getMonth() + 1).padStart(2, '0')}-${String(expected.getDate()).padStart(2, '0')}`;
  const time = `${String(expected.getHours()).padStart(2, '0')}:${String(expected.getMinutes()).padStart(2, '0')}`;
  assert.equal(parseTransferDateValue(String(timestamp)), date);
  assert.equal(parseTransferTimeValue(String(timestamp)), time);
});

test('parses ClickUp text and ISO due dates with their times', () => {
  assert.equal(parseTransferDateValue('2026-11-21T15:34:00.000Z'), localDate(new Date('2026-11-21T15:34:00.000Z')));
  assert.equal(parseTransferTimeValue('2026-11-21 3:34 PM'), '15:34');
  assert.equal(parseTransferTimeValue('2026-11-21T15:34:00.000Z'), localTime(new Date('2026-11-21T15:34:00.000Z')));
});

test('imports ClickUp normal date strings with ordinal days, time, and timezone', () => {
  const value = 'Thursday, September 3rd 2026, 11:59:00 pm -06:00';
  const expected = new Date('2026-09-03T23:59:00-06:00');
  assert.equal(parseTransferDateValue(value), localDate(expected));
  assert.equal(parseTransferTimeValue(value), localTime(expected));
});

test('detects ClickUp task exports and retains estimate and assignee columns as custom fields', () => {
  const headers = ['Task ID', 'Task Name', 'Start Date', 'Time Estimate (hours)', 'Time Estimate Rolled Up (hours)', 'Due Date', 'Priority', 'Assignee'];
  assert.equal(detectCsvProfile(headers), 'clickup');
  const row = normalizeImportRow({
    'Task ID': '868m14uqn', 'Task Name': 'IPF1 Course Mechanics', 'Start Date': '',
    'Time Estimate (hours)': '2.5', 'Time Estimate Rolled Up (hours)': '6',
    'Due Date': 'Thursday, September 3rd 2026, 11:59:00 pm -06:00', Priority: 'none', Assignee: '[Wesley Forsberg ]'
  }, headers);
  assert.equal(row.title, 'IPF1 Course Mechanics');
  assert.equal(row.due_date, 'Thursday, September 3rd 2026, 11:59:00 pm -06:00');
  assert.equal(row.custom['Time Estimate (hours)'], '2.5');
  assert.equal(row.custom['Time Estimate Rolled Up (hours)'], '6');
  assert.equal(row.custom.Assignee, 'Wesley Forsberg');
});

test('maps ClickUp Lists values to a folder path and removes export brackets', () => {
  const headers = ['Task ID', 'Task Name', 'Start Date', 'Time Estimate', 'Time Estimate Rolled Up', 'Due Date', 'Priority', 'Assignee', 'Lists'];
  assert.equal(detectCsvProfile(headers), 'clickup');
  const row = normalizeImportRow({
    'Task ID': '868m14uqn', 'Task Name': 'IPF1 Course Mechanics', 'Start Date': '',
    'Time Estimate': '', 'Time Estimate Rolled Up': '',
    'Due Date': 'Thursday, September 3rd 2026, 11:59:00 pm -06:00',
    Priority: 'none', Assignee: '[Wesley Forsberg ]', Lists: '[Instructional Packets]'
  }, headers);
  assert.equal(row.folder_path, 'Instructional Packets');
  assert.equal(row.custom.Lists, undefined);
  assert.equal(row.due_date, 'Thursday, September 3rd 2026, 11:59:00 pm -06:00');
});

test('imports and exports the extra credit flag in generic CSV', () => {
  const mapped = normalizeImportRow({ 'Task Name': 'Bonus assignment', 'Extra Credit': 'Yes' }, ['Task Name', 'Extra Credit']);
  assert.equal(mapped.extra_credit, 'Yes');
  assert.ok(getCsvProfile('generic').some(([header]) => header === 'Extra Credit'));
});
