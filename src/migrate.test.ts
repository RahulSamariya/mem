import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import * as vec from 'sqlite-vec';
import { discoverMigrations, getAppliedVersions, migrate, setMigrationsDir } from './migrate';
import fs from 'fs';
import os from 'os';
import path from 'path';

function openTestDb(dir: string): Database.Database {
  const db = new Database(path.join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.loadExtension(vec.getLoadablePath());
  return db;
}

test('migrations ship with the correct versions in order', () => {
  const m = discoverMigrations();
  assert.ok(Array.isArray(m) && m.length >= 2, 'expected at least 2 migrations');
  assert.equal(m[0].version, 1);
  assert.equal(m[1].version, 2);
});

test('migrate applies pending and records schema_migrations', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-migrate-'));
  const db = openTestDb(dir);
  setMigrationsDir(path.join(__dirname, '..', 'migrations'));
  const applied = migrate(db);
  assert.ok(applied.length >= 1, 'expected migrations applied');
  const versions = getAppliedVersions(db);
  assert.deepEqual(versions, applied.map((m) => m.version));
  // second run applies nothing new
  const again = migrate(db);
  assert.equal(again.length, 0);
  db.close();
});

test('applied migrations create the memories tables', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-migrate-'));
  const db = openTestDb(dir);
  setMigrationsDir(path.join(__dirname, '..', 'migrations'));
  migrate(db);
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name IN ('memories','memory_vec','schema_migrations')`)
    .all() as { name: string }[];
  assert.ok(tables.some((t) => t.name === 'memories'));
  assert.ok(tables.some((t) => t.name === 'memory_vec'));
  assert.ok(tables.some((t) => t.name === 'schema_migrations'));
  db.close();
});