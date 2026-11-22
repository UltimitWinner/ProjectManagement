import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLearningSuiteCategoryWeights } from '../public/learning-suite-utils.js';

test('normalizes regular Learning Suite category weights while preserving extra-credit cap weight', () => {
  const source = [
    { id: 'a', weight_percent: 15, bonus_cap_enabled: false },
    { id: 'b', weight_percent: 8, bonus_cap_enabled: false },
    { id: 'c', weight_percent: 22, bonus_cap_enabled: false },
    { id: 'd', weight_percent: 13, bonus_cap_enabled: false },
    { id: 'e', weight_percent: 30, bonus_cap_enabled: false },
    { id: 'f', weight_percent: 11, bonus_cap_enabled: false },
    { id: 'extra', weight_percent: 1, bonus_cap_enabled: true },
  ];

  const normalized = normalizeLearningSuiteCategoryWeights(source);
  const regularTotal = normalized
    .filter(folder => !folder.bonus_cap_enabled)
    .reduce((sum, folder) => sum + folder.weight_percent, 0);

  assert.ok(Math.abs(regularTotal - 100) < 1e-9);
  assert.equal(normalized.find(folder => folder.id === 'extra').weight_percent, 1);
  assert.equal(source[0].weight_percent, 15, 'normalization must not mutate the source categories');
});

test('preserves Learning Suite category weights when regular weights already total 100', () => {
  const source = [
    { id: 'a', weight_percent: 35, bonus_cap_enabled: false },
    { id: 'b', weight_percent: 65, bonus_cap_enabled: false },
    { id: 'extra', weight_percent: 2, bonus_cap_enabled: true },
  ];

  const normalized = normalizeLearningSuiteCategoryWeights(source);
  assert.deepEqual(normalized.map(folder => folder.weight_percent), [35, 65, 2]);
});
