export const WEIGHT_TOTAL_TOLERANCE = 0.00001;

export const RECOMMENDED_SWARA_VERSION = 'gdss-borda-final-2026-07-28';

export const RECOMMENDED_SWARA_WEIGHTS = {
  K1: '0.09523809524',
  K2: '0.05119047619',
  K3: '0.06666666667',
  K4: '0.08333333333',
  K5: '0.06190476190',
  K6: '0.05000000000',
  K7: '0.01190476190',
  K8: '0.05476190476',
  K9: '0.05119047619',
  K10: '0.03571428571',
  K11: '0.06785714286',
  K12: '0.08571428571',
  K13: '0.07023809524',
  K14: '0.009523809524',
  K15: '0.009523809524',
  K16: '0.02738095238',
  K17: '0.05119047619',
  K18: '0.03809523810',
  K19: '0.03571428571',
  K20: '0.04285714286',
};

export function parseWeight(value) {
  if (Array.isArray(value)) return parseWeight(value[0]);
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return Number.NaN;
  const normalized = value.trim().replace(/,/g, '.');
  const matches = normalized.match(/\d+(?:\.\d+)?/g);
  if (!matches?.length) return Number.NaN;
  return Number(matches.at(-1));
}

export function validateWeights(values, expectedCount, tolerance = WEIGHT_TOTAL_TOLERANCE) {
  const weights = values.map(parseWeight);
  const invalidIndexes = weights
    .map((value, index) => ({ value, index }))
    .filter(({ value }) => !Number.isFinite(value) || value < 0 || value > 1)
    .map(({ index }) => index);
  const total = invalidIndexes.length
    ? Number.NaN
    : weights.reduce((sum, value) => sum + value, 0);

  return {
    valid: weights.length === expectedCount
      && invalidIndexes.length === 0
      && Math.abs(total - 1) <= tolerance,
    total,
    weights,
    invalidIndexes,
  };
}

export function calculateMabac(candidates, criteria, scores) {
  if (!candidates.length || !criteria.length) return { rows: [], details: {} };

  const matrix = {};
  const normalized = {};
  const weighted = {};
  const baa = {};

  for (const candidate of candidates) {
    matrix[candidate.id] = {};
    normalized[candidate.id] = {};
    weighted[candidate.id] = {};
    for (const criterion of criteria) {
      matrix[candidate.id][criterion.id] = Number(scores[candidate.id]?.[criterion.id] ?? 0);
    }
  }

  for (const criterion of criteria) {
    const values = candidates.map((candidate) => matrix[candidate.id][criterion.id]);
    const minimum = Math.min(...values);
    const maximum = Math.max(...values);
    const range = maximum - minimum;

    for (const candidate of candidates) {
      const value = matrix[candidate.id][criterion.id];
      const r = range === 0
        ? 0
        : criterion.type === 'cost'
          ? (maximum - value) / range
          : (value - minimum) / range;
      normalized[candidate.id][criterion.id] = r;
      weighted[candidate.id][criterion.id] = Number(criterion.weight) * (r + 1);
    }

    const product = candidates.reduce(
      (result, candidate) => result * Math.max(weighted[candidate.id][criterion.id], 1e-9),
      1,
    );
    baa[criterion.id] = product ** (1 / candidates.length);
  }

  const distances = {};
  const rows = candidates.map((candidate) => {
    distances[candidate.id] = {};
    const value = criteria.reduce((total, criterion) => {
      const distance = weighted[candidate.id][criterion.id] - baa[criterion.id];
      distances[candidate.id][criterion.id] = distance;
      return total + distance;
    }, 0);
    return { candidate, value };
  });

  rows.sort((a, b) => b.value - a.value);
  rows.forEach((row, index) => { row.rank = index + 1; });

  return { rows, details: { matrix, normalized, weighted, baa, distances } };
}
