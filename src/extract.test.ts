import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProposals, PROVIDERS } from './extract';

test('parseProposals handles valid JSON array', () => {
  const out = parseProposals('[{"tier":"decision","text":"Chose SQLite over Postgres"}]');
  assert.deepEqual(out, [{ tier: 'decision', text: 'Chose SQLite over Postgres' }]);
});

test('parseProposals maps constraint and failed tiers', () => {
  const out = parseProposals(
    '[{"tier":"constraint","text":"must be local-only"},{"tier":"failed_approach","text":"redis broke"}]'
  );
  assert.equal(out[0].tier, 'constraint');
  assert.equal(out[1].tier, 'failed_approach');
});

test('parseProposals rejects empty arrays and junk', () => {
  assert.deepEqual(parseProposals('[]'), []);
  assert.deepEqual(parseProposals('not json at all'), []);
  assert.deepEqual(parseProposals('{"tier":"decision"}'), []);
});

test('parseProposals handles markdown-fenced JSON', () => {
  const out = parseProposals('```json\n[{"tier":"decision","text":"picked sqlite"}]\n```');
  assert.equal(out.length, 1);
});

test('PROVIDERS list matches config setter', () => {
  assert.deepEqual(PROVIDERS, ['ollama', 'anthropic']);
});