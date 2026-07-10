export function validateWeights(values, expectedCount, tolerance = 0.000001) {
  const weights = values.map(Number);
  const total = weights.reduce((sum, value) => sum + value, 0);
  return {
    valid: weights.length === expectedCount
      && weights.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)
      && Math.abs(total - 1) <= tolerance,
    total,
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
