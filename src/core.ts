import path from 'path';
import fs from 'fs';
import os from 'os';
import Database from 'better-sqlite3';
import * as vec from 'sqlite-vec';

export const MEM_HOME = path.join(os.homedir(), '.mem');

export const DB_PATH = path.join(MEM_HOME, 'memories.db');

export const MODEL_CACHE_DIR = path.join(MEM_HOME, 'models');

export const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';

export const EMBEDDING_DIMS = 384;

export type Tier = 'decision' | 'constraint' | 'failed_approach' | 'raw';
export type Source = 'manual' | 'git_seed' | 'session';

export interface MemoryRow {
  id: string;
  text: string;
  tier: Tier;
  file_tags: string;
  project: string;
  source: Source;
  created_at: string;
  last_validated_at: string;
}

export interface RecallResult {
  id: string;
  text: string;
  tier: Tier;
  file_tags: string[];
  project: string;
  source: Source;
  created_at: string;
  last_validated_at: string;
  score: number;
  age_label: string;
}

export function ensureMemHome(): void {
  fs.mkdirSync(MEM_HOME, { recursive: true });
  fs.mkdirSync(MODEL_CACHE_DIR, { recursive: true });
}

export function openDb(): Database.Database {
  ensureMemHome();
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.loadExtension(vec.getLoadablePath());
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      embedding BLOB NOT NULL,
      tier TEXT NOT NULL,
      file_tags TEXT NOT NULL,
      project TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_validated_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(
      memory_id TEXT PRIMARY KEY,
      embedding FLOAT[384]
    );
  `);
  return db;
}

export function projectName(cwd: string): string {
  const normalized = cwd.split('\\').join('/').replace(/\/+$/, '');
  const segments = normalized.split('/').filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : 'unknown';
}

export function getCwdProject(): { cwd: string; project: string } {
  const cwd = process.cwd();
  return { cwd, project: projectName(cwd) };
}

export function ageLabel(createdAt: string, now: Date = new Date()): string {
  const diffMs = now.getTime() - new Date(createdAt).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

export function parseFileTags(raw: string): string[] {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

export function fileOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  let hits = 0;
  for (const f of a) if (setB.has(f)) hits++;
  return hits;
}

export function detectOpenFiles(cwd: string): string[] {
  // Best-effort: use the working tree's git status to guess files in focus is
  // too slow per call; fall back to empty and let the caller decide.
  return [];
}
