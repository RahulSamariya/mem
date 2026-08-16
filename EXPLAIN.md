# EXPLAIN.md — Orientation for AI coding assistants

This file is written for an AI assistant (Claude Code, opencode, Cursor, etc.) picking up work in this repo. It tells you what this project is, how it is built, and everything you need to know before editing it. Read it once, up front — it saves you re-deriving 20 design decisions.

---

## 1. What this project is

**mem** — a local-first CLI + MCP server that gives AI coding tools contextual memory of past **decisions**, **constraints**, and **failed approaches**, surfaced by relevance to the work in focus.

The pitch: an assistant asked "why did we pick SQLite?" should be able to recall an explicitly-stored answer, with its age shown — instead of only having its in-session context or a static `CLAUDE.md`.

**Design axiom (do not break):** universality is a *packaging* concern, not an *architecture* concern. There is ONE core engine (a plain CLI + MCP server on stdio). Every tool (Claude Code, Cursor, VS Code, opencode, Continue.dev, Windsurf, JetBrains, Aider…) points its own config at the same server. **Never add per-tool branching in the core logic.** The plain CLI is the documented fallback for tools without MCP support (e.g. Aider).

## 2. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript / Node.js (CommonJS, `tsc` → `dist/`) | MCP SDK is TS-first, matches the ecosystem |
| DB | SQLite via `better-sqlite3` | Local-first, zero external services |
| Vector search | `sqlite-vec` (`vec0` virtual table) | No separate vector DB; loaded with `db.loadExtension(...)` |
| Embeddings | `@xenova/transformers` + `all-MiniLM-L6-v2` | Runs in-process, no API key, 384-dim |
| MCP | `@modelcontextprotocol/sdk` (stdio) | Official TS SDK |
| CLI | `commander` | Simple option handling |

**Native deps caveat:** `better-sqlite3` needs a compile step. npm ≥ 11 blocks install scripts by default — if `npm install` fails, run:
`npm install-scripts approve better-sqlite3@13.0.3 sharp protobufjs && npm rebuild`.

## 3. Where data lives

Everything under `~/.mem/` (never in the repo):
- `memories.db` — SQLite store (memories table + memory_vec virtual table)
- `config.json` — extraction provider config (`mem config set-provider …`)
- `models/` — local embedding model cache (downloaded once on first use)

Delete `~/.mem` to wipe all memory. **A memory DB must never be committed** — a public repo containing private decision history defeats the whole local-first principle.

## 4. Data model

One table (`migrations/001_init.sql` + `migrations/002_...`):

```sql
memories (
  id TEXT PRIMARY KEY,                    -- uuid
  text TEXT NOT NULL,                     -- the memory
  embedding BLOB NOT NULL,                -- 384-dim float vector
  tier TEXT NOT NULL,                     -- decision | constraint | failed_approach | raw
  file_tags TEXT,                         -- JSON array of file paths
  project TEXT NOT NULL,                  -- project name (last path segment of cwd)
  source TEXT NOT NULL,                   -- manual | git_seed | session
  created_at TEXT NOT NULL,
  last_validated_at TEXT NOT NULL,        -- surfaced as age in every recall
  embedding_model_version TEXT NOT NULL   -- guards against silent vector-space changes
);
CREATE VIRTUAL TABLE memory_vec (memory_id TEXT PRIMARY KEY, embedding FLOAT[384]);
```

Plus `schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`.

**Schema rule:** never hand-edit a migration or the schema in place once data exists. Add a new numbered file in `migrations/`. Migrations auto-apply on `openDb()`. `mem migrate` shows status.

## 5. How a recall actually works (ranking)

1. Query text → embedded with the **same model** → query vector.
2. sqlite-vec KNN over `memory_vec` → top `k` candidate ids by cosine distance (k = max(limit×4, 50)).
3. Each candidate scored: `semScore = 1 / (1 + distance)`.
4. Optional boosts (selected by `--strategy` / MCP server):
   - `file_boost`: `score × (1 + overlap × 0.5)` for exact file-tag matches.
   - `file_boost_recency`: additionally `× (0.5 + 0.5 × e^(−days/30))` — halves roughly per month.
5. Sort desc, slice to `limit`, print tier + age + score + project + id.

Retrieval quality is **measured**, never assumed: `mem eval` runs `eval/queries.json` and reports precision@1/@3 for all three strategies. Current bundled result: 100% top-3. **Never ship a ranking change without re-running `mem eval`.**

## 6. The CLI commands

```
mem remember "<text>" [--tier …] [--files a,b] [--project …]   store a memory (manual)
mem recall "<query>" [--limit n] [--strategy …] [--files …] [--project …] [--json]   search
mem init               seed candidates from git log; y/n/e per candidate (source=git_seed)
mem eval [--queries p] retrieval benchmark across 3 strategies
mem list [--project] [--json]
mem delete <id>
mem db
mem migrate            show/apply schema migrations
mem reembed            re-embed all memories after an embedding model upgrade
mem config set-provider <ollama|anthropic> [--endpoint] [--model]   extraction provider
mem extract [--since <ref>] [--provider …] [--dry-run]   LLM-assisted extraction
mem extract-eval <labels.json> [--provider …]   precision/recall/F1 vs hand labels
node dist/mcp-server.js                          MCP stdio server
```

**Non-negotiables (hard rules, do not sidestep):**
1. **Local-only by default.** No memory text leaves the machine unless the user explicitly configures a provider. Embeddings never use a cloud.
2. **Every memory shows its age.** `last_validated_at` is always surfaced (e.g. "noted 4 months ago"). Never present a memory as unqualified current fact.
3. **Confirm before auto-store.** `mem init` / `mem extract` *propose*; a human must accept (y/n). Nothing writes autonomously.
4. `recall` warns if any stored vector has a stale `embedding_model_version` (vectors live in different spaces after a model swap → silently bad ranking).

## 7. Phase 5 extraction (the least-reliable part, gated hard)

Design: extract from **git history** (the one signal every tool touches identically), NOT from AI-tool sessions (session capture would need per-editor integrations and breaks universality).

- `mem extract --since HEAD~20` walks commits, sends each commit message + diff to the provider, asks whether it contains a durable decision/constraint/failed-approach (weighs formatting/dep-bump/typo-fix commits as NONE).
- Provider is **opt-in**: `mem config set-provider ollama|anthropic` (persisted in `~/.mem/config.json`). Unconfigured → error with setup help, never a silent cloud call.
- **Dedup:** each proposal is checked against existing memories; semantic score > 0.87 is treated as a near-duplicate and skipped before proposing.
- Extracted memories get `source: git_seed` and normal `last_validated_at` — no free pass on staleness.
- `mem extract-eval` scores the pipeline against 20-30 hand-labeled commits (precision/recall/F1). Acceptance: ≥70% precision; false positives degrade the retrieval you already proved out — don't ship on eyeballed examples.

## 8. The MCP server

`dist/mcp-server.js`, stdio. Two tools:
- `recall(query, limit?, files?)` — uses `file_boost_recency` strategy (long-lived sessions).
- `remember(text, tier?, files?)` — stores with `source: session`.

Tool parameter schemas are **Zod** (zod v4). The MCP SDK requires Zod `ZodRawShape` objects — do NOT pass plain `{ type: 'string' }` objects; the call will fail to typecheck.

Per-tool wiring is documented in README.md (Claude Code: `claude mcp add --transport stdio mem -- node <abs>/mem/dist/mcp-server.js`; opencode: `mcp.mem` in opencode.json; Cursor: `.cursor/mcp.json`; etc.). Exact paths are machine-specific in the README examples — keep them portable.

## 9. Source layout

```
src/
  core.ts        constants, mem home/config IO, openDb (runs migrations), age labels, file overlap
  migrate.ts     migration runner (reads migrations/, tracks schema_migrations)
  embed.ts       @xenova/transformers pipeline + float data helpers
  store.ts       DB read/write: storeMemory, recall (ranking strategies), reembedAll
  seed.ts        git-log candidate extraction for `mem init` (keyword heuristics + noise filter)
  eval.ts        retrieval eval runner, strategy comparison, best-strategy picker
  extract.ts     Phase 5: provider config loading, ollama/anthropic calls, dedup, extractAndStore, runExtractionEval
  index.ts       commander CLI wiring
  mcp-server.ts  Zod-defined MCP tools
  *.test.ts      node:test units (pure logic only — no model download)
migrations/      numbered SQL
eval/            queries.json + EXTRACT_EVAL.md (how to build labels)
```

**Testing:** `npm run typecheck` (noEmit), `npm run build`, `npm test` (node:test on compiled `dist/*.test.js`). Add pure-logic tests alongside new logic in `core.ts`/`seed.ts`/`eval.ts`/`extract.ts`/`migrate.ts`.

## 10. Versioning & git practice

- Semver in `package.json` + `CHANGELOG.md` (update on every tag/release).
- Branching: `main` always works; short-lived `feat/…` branches per feature; merge only when acceptance criteria pass.
- CI (`.github/workflows/ci.yml`) runs typecheck + build + tests on Node 22 & 24.

## 11. Known gaps / next steps

- Session-scoped recall (`--session <id>`) and per-project DBs are planned, not built.
- `last_validated_at` is currently set at store time only; confirming recalls to refresh it is not implemented.
- `mem init`'s keyword extractor is intentionally conservative (string substring/subject heuristics) — tune `COMMIT_KEYWORDS`/noise filter in `seed.ts` against a real repo, then re-run `mem eval`/extraction eval.

---

If you are assigned work here, start by running:
```
npm run typecheck && npm test
mem db
mem recall "how does this project work"          # after seeding at least a few memories
```
…then make minimal, reviewable changes that preserve the four non-negotiables.