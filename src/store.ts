import { randomUUID } from 'crypto';
import {
  MemoryRow,
  RecallResult,
  Tier,
  Source,
  openDb,
  parseFileTags,
  ageLabel,
  fileOverlap,
  EMBEDDING_MODEL_VERSION,
} from './core';
import { embed, toBuffer } from './embed';

export interface InsertInput {
  text: string;
  tier: Tier;
  files: string[];
  project: string;
  source: Source;
}

export async function storeMemory(input: InsertInput): Promise<MemoryRow> {
  const db = openDb();
  const vector = await embed(input.text);
  const id = randomUUID();
  const now = new Date().toISOString();
  const fileTags = JSON.stringify(input.files);
  const row: MemoryRow = {
    id,
    text: input.text,
    tier: input.tier,
    file_tags: fileTags,
    project: input.project,
    source: input.source,
    created_at: now,
    last_validated_at: now,
    embedding_model_version: EMBEDDING_MODEL_VERSION,
  };
  const insertTx = db.transaction(() => {
    db.prepare(
      `INSERT INTO memories (id, text, embedding, tier, file_tags, project, source, created_at, last_validated_at, embedding_model_version)
       VALUES (@id, @text, @embedding, @tier, @file_tags, @project, @source, @created_at, @last_validated_at, @embedding_model_version)`
    ).run({ ...row, embedding: toBuffer(vector) });
    db.prepare(
      `INSERT INTO memory_vec (memory_id, embedding) VALUES (?, ?)`
    ).run(id, toBuffer(vector));
  });
  insertTx();
  db.close();
  return row;
}

export interface RecallOptions {
  limit?: number;
  strategy?: 'semantic' | 'file_boost' | 'file_boost_recency';
  files?: string[];
  projectFilter?: string;
}

export async function recall(query: string, opts: RecallOptions = {}): Promise<RecallResult[]> {
  const limit = opts.limit ?? 5;
  const strategy = opts.strategy ?? 'semantic';
  const db = openDb();
  // §8 safety: warn if any stored vectors are from a different embedding model.
  try {
    const versions = db
      .prepare(`SELECT DISTINCT embedding_model_version AS v FROM memories`)
      .all() as { v: string | null }[];
    if (versions.some((r) => r.v !== EMBEDDING_MODEL_VERSION)) {
      console.warn(
        `[mem] WARNING: some memories were embedded with a different model (expected ${EMBEDDING_MODEL_VERSION}). ` +
          `Run "mem reembed" before trusting recall results.`
      );
    }
  } catch {
    // column may not exist on very old DBs; fail soft
  }
  const qv = await embed(query);
  const q = JSON.stringify(qv);

  // Query the vec0 table with KNN. sqlite-vec returns k nearest by distance.
  const k = Math.max(limit * 4, 50);
  const vecRows = db
    .prepare(
      `SELECT memory_id, distance FROM memory_vec WHERE embedding MATCH ? AND k = ?`
    )
    .all(q, k) as { memory_id: string; distance: number }[];

  if (vecRows.length === 0) {
    db.close();
    return [];
  }

  const ids = vecRows.map((r) => r.memory_id);
  const placeholders = ids.map(() => '?').join(',');
  const memRows = db
    .prepare(
      `SELECT * FROM memories WHERE id IN (${placeholders})`
    )
    .all(...ids) as MemoryRow[];

  const byId = new Map(memRows.map((m) => [m.id, m]));

  const now = new Date();
  const scored: RecallResult[] = [];
  for (const vr of vecRows) {
    const mem = byId.get(vr.memory_id);
    if (!mem) continue;
    const semScore = 1 / (1 + vr.distance); // 0..1, higher = more similar
    let score = semScore;
    if (strategy === 'file_boost' || strategy === 'file_boost_recency') {
      const overlap = fileOverlap(parseFileTags(mem.file_tags), opts.files ?? []);
      score = semScore * (1 + overlap * 0.5);
    }
    if (strategy === 'file_boost_recency') {
      const daysOld = Math.max(0, (now.getTime() - new Date(mem.created_at).getTime()) / 86400000);
      const recency = Math.exp(-daysOld / 30); // halves roughly every month
      score = score * (0.5 + 0.5 * recency);
    }
    if (opts.projectFilter && mem.project !== opts.projectFilter) continue;
    scored.push({
      id: mem.id,
      text: mem.text,
      tier: mem.tier,
      file_tags: parseFileTags(mem.file_tags),
      project: mem.project,
      source: mem.source,
      created_at: mem.created_at,
      last_validated_at: mem.last_validated_at,
      score,
      age_label: ageLabel(mem.created_at, now),
      embedding_model_version: mem.embedding_model_version ?? EMBEDDING_MODEL_VERSION,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  db.close();
  return scored.slice(0, limit);
}

export async function reembedAll(): Promise<{ total: number; done: number; failed: number }> {
  // §8: re-run every stored memory's text through the current embedding model and
  // update its vector + model-version tag. Run after any embedding model upgrade.
  const db = openDb();
  const rows = db.prepare(`SELECT * FROM memories`).all() as MemoryRow[];
  let done = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const vector = await embed(row.text);
      db.transaction(() => {
        db.prepare(`UPDATE memories SET embedding = ?, embedding_model_version = ? WHERE id = ?`).run(
          toBuffer(vector),
          EMBEDDING_MODEL_VERSION,
          row.id
        );
        db.prepare(`UPDATE memory_vec SET embedding = ? WHERE memory_id = ?`).run(
          toBuffer(vector),
          row.id
        );
      })();
      done++;
    } catch {
      failed++;
    }
  }
  db.close();
  return { total: rows.length, done, failed };
}

export async function getAllMemories(): Promise<MemoryRow[]> {
  const db = openDb();
  const rows = db.prepare(`SELECT * FROM memories ORDER BY created_at DESC`).all() as MemoryRow[];
  db.close();
  return rows;
}

export async function deleteMemory(id: string): Promise<boolean> {
  const db = openDb();
  const delTx = db.transaction(() => {
    db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
    db.prepare(`DELETE FROM memory_vec WHERE memory_id = ?`).run(id);
  });
  delTx();
  db.close();
  return true;
}

export async function updateValidatedAt(id: string): Promise<void> {
  const db = openDb();
  db.prepare(`UPDATE memories SET last_validated_at = ? WHERE id = ?`).run(
    new Date().toISOString(),
    id
  );
  db.close();
}

export async function countMemories(): Promise<number> {
  const db = openDb();
  const row = db.prepare(`SELECT COUNT(*) AS n FROM memories`).get() as { n: number };
  db.close();
  return row.n;
}
