-- 001_init.sql — initial schema (Phase 1)
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