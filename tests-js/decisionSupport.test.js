import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateMabac, validateWeights } from '../src-js/services/decisionSupport.js';

test('bobot final SWARA harus lengkap dan berjumlah 1', () => {
  assert.equal(validateWeights([0.4, 0.35, 0.25], 3).valid, true);
  assert.equal(validateWeights([0.169749, 0.048199, 0.782051], 3).valid, true);
  assert.equal(validateWeights(['0,4', '0,35', '0,25'], 3).valid, true);
  assert.equal(validateWeights([0.4, 0.35, 0.20], 3).valid, false);
  assert.equal(validateWeights([0.5, 0.5], 3).valid, false);
  assert.deepEqual(validateWeights(['', 0.5, 0.5], 3).invalidIndexes, [0]);
});

test('MABAC mengutamakan benefit tinggi dan cost rendah', () => {
  const candidates = [
    { id: 1, name: 'Terbaik' },
    { id: 2, name: 'Pembanding' },
  ];
  const criteria = [
    { id: 1, type: 'benefit', weight: 0.5 },
    { id: 2, type: 'cost', weight: 0.5 },
  ];
  const scores = { 1: { 1: 5, 2: 1 }, 2: { 1: 3, 2: 5 } };
  const result = calculateMabac(candidates, criteria, scores);
  assert.equal(result.rows[0].candidate.name, 'Terbaik');
  assert.equal(result.rows[0].rank, 1);
});
