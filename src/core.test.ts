import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ageLabel,
  parseFileTags,
  fileOverlap,
  projectName,
  ensureMemHome,
} from './core';

test('ageLabel formats relative time', () => {
  const now = new Date('2026-08-16T12:00:00Z');
  assert.equal(ageLabel(new Date('2026-08-16T12:00:00Z').toISOString(), now), 'just now');
  assert.equal(ageLabel(new Date('2026-08-16T11:59:00Z').toISOString(), now), '1 minute ago');
  assert.equal(ageLabel(new Date('2026-08-16T11:00:00Z').toISOString(), now), '1 hour ago');
  assert.equal(ageLabel(new Date('2026-08-10T12:00:00Z').toISOString(), now), '6 days ago');
  assert.equal(ageLabel(new Date('2026-05-16T12:00:00Z').toISOString(), now), '3 months ago');
  assert.equal(ageLabel(new Date('2024-08-16T12:00:00Z').toISOString(), now), '2 years ago');
  assert.match(ageLabel(new Date('2026-08-16T11:45:00Z').toISOString(), now), /minutes ago/);
});

test('parseFileTags handles valid, empty, and malformed JSON', () => {
  assert.deepEqual(parseFileTags('["a.ts","b.ts"]'), ['a.ts', 'b.ts']);
  assert.deepEqual(parseFileTags('[]'), []);
  assert.deepEqual(parseFileTags('not json'), []);
  assert.deepEqual(parseFileTags('{"a":1}'), []);
});

test('fileOverlap counts exact path matches', () => {
  assert.equal(fileOverlap(['a.ts', 'b.ts'], ['b.ts', 'c.ts']), 1);
  assert.equal(fileOverlap(['a.ts'], ['b.ts']), 0);
  assert.equal(fileOverlap([], ['b.ts']), 0);
  assert.equal(fileOverlap(['a.ts'], []), 0);
  // relative vs absolute paths do not overlap (exact match only)
  assert.equal(fileOverlap(['a.ts'], ['src/a.ts']), 0);
});

test('projectName extracts last path segment', () => {
  assert.equal(projectName('C:\\Users\\DELL\\Project Files\\Memory'), 'Memory');
  assert.equal(projectName('/home/user/repo'), 'repo');
});

test('ensureMemHome creates dirs without throwing', () => {
  assert.doesNotThrow(() => ensureMemHome());
});