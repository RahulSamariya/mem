import { test } from 'node:test';
import assert from 'node:assert/strict';
import { templatedQueries, generateEvalCases, shuffle } from './gen';
import type { MemoryRow } from './core';

const mem: MemoryRow = {
  id: 'abc-123',
  text: 'Chose SQLite over Postgres because we need zero external services and local-first storage (from commit message)',
  tier: 'decision',
  file_tags: '["src/store.ts"]',
  project: 'demo',
  source: 'git_seed',
  created_at: '2026-01-01T00:00:00Z',
  last_validated_at: '2026-01-01T00:00:00Z',
  embedding_model_version: 'minilm-l6-v2',
};

test('templatedQueries produces multiple unique queries for one memory', () => {
  const qs = templatedQueries(mem, 10);
  assert.ok(qs.length > 0 && qs.length <= 10);
  assert.equal(new Set(qs.map((q) => q.toLowerCase())).size, qs.length, 'queries should be unique');
});

test('templatedQueries respects per-memory cap', () => {
  const qs = templatedQueries(mem, 3);
  assert.ok(qs.length <= 3);
});

test('generateEvalCases fills expected_memory_id and adds negatives', () => {
  const cases = generateEvalCases([mem], { perMemory: 4, negatives: 2 });
  const positive = cases.filter((c) => c.expected_memory_id === 'abc-123');
  const negative = cases.filter((c) => c.expected_memory_id === 'none');
  assert.ok(positive.length >= 1, 'expected positive cases for the memory');
  assert.equal(negative.length, 2, 'expected 2 negative cases');
});

test('generateEvalCases filters by project', () => {
  const cases = generateEvalCases([mem], { perMemory: 3, project: 'other' });
  assert.ok(!cases.some((c) => c.expected_memory_id === 'abc-123'), 'no cases from excluded project');
});

test('shuffle keeps same elements', () => {
  const input = [1, 2, 3, 4, 5];
  const out = shuffle(input);
  assert.deepEqual([...out].sort(), [...input].sort());
});

test('tier-specific prefixes exist for all tiers', () => {
  for (const tier of ['decision', 'constraint', 'failed_approach', 'raw']) {
    const qs = templatedQueries({ ...mem, tier: tier as any }, 4);
    assert.ok(qs.length > 0, `expected queries for tier ${tier}`);
  }
});