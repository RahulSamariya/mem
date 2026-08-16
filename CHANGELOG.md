# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned

- Session-scoped recall (`--session <id>`) and per-project DBs.
- `last_validated_at` updates on confirmed recalls.
- LLM extraction tuning against longer diffs.

## [1.0.0] - 2026-08-16

### Added

- Core CLI (`mem remember` / `mem recall`) with local-only embeddings (`@xenova/transformers`, `all-MiniLM-L6-v2`, 384-dim).
- SQLite persistence via `better-sqlite3` + `sqlite-vec` vector search.
- Tiered memories: `decision` | `constraint` | `failed_approach` | `raw`.
- `mem init` — propose candidate memories from git history with `y/n/e` accept flow.
- `mem eval` — retrieval precision benchmarking across three ranking strategies.
- `mem list`, `mem delete`, `mem db` management commands.
- MCP stdio server exposing `recall` and `remember` tools.
- `mem extract` — opt-in LLM-assisted extraction (local-only fallback mode included).
- Unit tests (`node:test`) for core and seed pure logic.
- GitHub Actions CI (build + typecheck + test on Node 22/24).
- Bundled eval set at `eval/queries.json` (16 queries, 100% top-3 on all strategies).