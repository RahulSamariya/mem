import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractCandidatesFromSubject,
  getGitLog,
  hasGitRemote,
  semanticFilter,
  CommitInfo,
} from './seed';

test('extractCandidatesFromSubject classifies decisions', () => {
  const out = extractCandidatesFromSubject("feat: chose SQLite over Postgres for storage");
  assert.equal(out.length, 1);
  assert.equal(out[0].tier, 'decision');
  assert.match(out[0].text, /Chose SQLite over Postgres/);
});

test('extractCandidatesFromSubject classifies constraints', () => {
  const out = extractCandidatesFromSubject("refactor: embedding model must run locally");
  assert.equal(out.length, 1);
  assert.equal(out[0].tier, 'constraint');
});

test('extractCandidatesFromSubject classifies failed approaches', () => {
  const out = extractCandidatesFromSubject("Raphson approach still didnt worked");
  assert.equal(out.length, 1);
  assert.equal(out[0].tier, 'failed_approach');
});

test('extractCandidatesFromSubject strips conventional-commit prefixes', () => {
  const out = extractCandidatesFromSubject("fix(api): switched to streaming responses");
  assert.equal(out.length, 1);
  assert.equal(out[0].tier, 'decision');
  assert.equal(out[0].text.startsWith('Switched to streaming responses'), true);
});

test('extractCandidatesFromSubject ignores noise commits', () => {
  for (const s of [
    "Merge pull request #3 from guanyang/dependabot",
    "chore: bump deps",
    "Bump qs",
    "first commit",
    "Initial commit",
    "Update README",
    "release v2.1.0",
  ]) {
    assert.deepEqual(extractCandidatesFromSubject(s), [], `expected no candidate for: ${s}`);
  }
});

test('extractCandidatesFromSubject emits at most one candidate per commit', () => {
  const out = extractCandidatesFromSubject("chose sqlite, must stay local, and it failed before");
  assert.ok(out.length <= 1);
});

test('semanticFilter drops generic candidates', () => {
  const kept = semanticFilter([
    { text: 'Added parallel builds (from commit message)', tier: 'decision' as const, files: [] },
    { text: 'The file update the implementation detail', tier: 'raw' as const, files: [] },
  ]);
  assert.equal(kept.length, 1);
  assert.match(kept[0].text, /parallel builds/);
});

test('hasGitRemote returns boolean', () => {
  assert.equal(typeof hasGitRemote(process.cwd()), 'boolean');
});

test('getGitLog returns array of commits', () => {
  const commits: CommitInfo[] = getGitLog(process.cwd(), 10);
  assert.ok(Array.isArray(commits));
  for (const c of commits) {
    assert.ok(c.hash && c.date && typeof c.subject === 'string');
  }
});