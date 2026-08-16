-- 002_add_embedding_model_version.sql — safe-swap guard for embedding models (§8)
ALTER TABLE memories ADD COLUMN embedding_model_version TEXT NOT NULL DEFAULT 'minilm-l6-v2';