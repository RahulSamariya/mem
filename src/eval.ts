import { recall } from './store';

export interface EvalCase {
  query: string;
  expected_memory_id: string | null;
}

export interface EvalSummary {
  total: number;
  precision_at_1: number;
  precision_at_3: number;
  samples: Array<{
    query: string;
    expected: string | null;
    found_in_top1: boolean;
    found_in_top3: boolean;
    top3: string[];
  }>;
}

export async function runEval(
  cases: EvalCase[],
  strategy: 'semantic' | 'file_boost' | 'file_boost_recency',
  limit: number = 3,
  files: string[] = []
): Promise<EvalSummary> {
  const hits1 = [];
  const hits3 = [];
  const samples = [];
  for (const c of cases) {
    const results = await recall(c.query, { limit, strategy, files });
    const topIds = results.map((r) => r.id);
    // "none" = negative query: pass when nothing is retrieved with confidence.
    const isNegative = c.expected_memory_id === 'none';
    let in1: boolean;
    let in3: boolean;
    if (isNegative) {
      const topScore = results.length > 0 ? results[0].score : 0;
      in1 = results.length === 0 || topScore < 0.35; // low-confidence match counts as "nothing relevant"
      in3 = in1;
    } else {
      in1 = c.expected_memory_id !== null && topIds[0] === c.expected_memory_id;
      in3 = c.expected_memory_id !== null && topIds.includes(c.expected_memory_id);
    }
    hits1.push(in1);
    hits3.push(in3);
    samples.push({
      query: c.query,
      expected: c.expected_memory_id,
      found_in_top1: in1,
      found_in_top3: in3,
      top3: topIds,
    });
  }
  const total = cases.length;
  return {
    total,
    precision_at_1: total === 0 ? 0 : hits1.filter(Boolean).length / total,
    precision_at_3: total === 0 ? 0 : hits3.filter(Boolean).length / total,
    samples,
  };
}

export function formatSummary(s: EvalSummary, strategy: string): string {
  const lines = [
    `strategy: ${strategy}`,
    `total: ${s.total}`,
    `precision@1: ${(s.precision_at_1 * 100).toFixed(1)}%`,
    `precision@3: ${(s.precision_at_3 * 100).toFixed(1)}%`,
    '',
  ];
  for (const sample of s.samples) {
    lines.push(
      `  ${sample.found_in_top3 ? 'PASS' : 'FAIL'} :: ${sample.query} :: ` +
      `top3=${JSON.stringify(sample.top3)}`
    );
  }
  return lines.join('\n');
}

export function bestStrategy(a: EvalSummary, b: EvalSummary, c: EvalSummary): { name: string; summary: EvalSummary } {
  const strategies: Array<{ name: string; summary: EvalSummary }> = [
    { name: 'semantic', summary: a },
    { name: 'file_boost', summary: b },
    { name: 'file_boost_recency', summary: c },
  ];
  strategies.sort((x, y) => {
    const dx = y.summary.precision_at_3 - x.summary.precision_at_3;
    if (dx !== 0) return dx;
    return y.summary.precision_at_1 - x.summary.precision_at_1;
  });
  return strategies[0];
}