<div align="center">

# mem

**Universal contextual memory for AI coding tools**

A local-first CLI + MCP server that gives AI assistants — in any IDE or CLI — memory of past decisions, constraints, and failed approaches, surfaced by *relevance to the work in focus*, not dumped into every prompt like a static `CLAUDE.md`.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript)](package.json)
[![npm](https://img.shields.io/badge/npm-12+-CB3837?logo=npm)](package.json)
[![Node](https://img.shields.io/badge/Node.js-22+-339933?logo=nodedotjs)](package.json)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](https://github.com/)

</div>

---

## Why

AI coding assistants forget. Between sessions they lose why you picked SQLite over Postgres, that Redis broke your local-first constraint, or that the Raphson approach for ASCII art never worked. `mem` gives them a project-scoped memory they can actually query — with the age of every fact shown, so stale knowledge is never presented as current truth.

**Universality by design:** one core engine (a plain CLI + MCP server on stdio), wired into whichever tool *you* use through that tool's own config. No per-tool forks of the core logic.

## Features

- **Local-only by default.** Memory text never leaves your machine. Embeddings run in-process via `@xenova/transformers` (no API keys, no cloud).
- **Semantic retrieval.** `sqlite-vec` vector search over `all-MiniLM-L6-v2` embeddings (384-dim), with optional file-path overlap boost and recency decay.
- **Tiered memories** — `decision` / `constraint` / `failed_approach` / `raw`.
- **Measured, not assumed.** `mem eval` benchmarks retrieval precision across three ranking strategies (currently **100% top-3 on the bundled eval set**).
- **Confirm before store.** `mem init` and `mem extract` propose candidates and wait for your `y/n`/edit — they never auto-commit.
- **Always shows its age.** `recall` prints e.g. `noted 4 months ago` for every result.
- **One MCP server, many clients.** Claude Code, Cursor, VS Code Copilot, Continue.dev, Windsurf, JetBrains — same stdio command. Plus a plain-CLI fallback for tools without MCP (Aider, raw terminal).

## Tech stack

| Layer | Choice |
|---|---|
| Language | TypeScript / Node.js ([CommonJS](package.json)) |
| Storage | SQLite via [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) |
| Vector search | [`sqlite-vec`](https://github.com/asg017/sqlite-vec) extension |
| Embeddings | [`@xenova/transformers`](https://github.com/xenova/transformers.js) + `all-MiniLM-L6-v2` |
| MCP | [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) (stdio) |
| CLI | [`commander`](https://github.com/tj/commander.js) |

## Install

Requires **Node.js 22+** and `npm`. Native dependencies (`better-sqlite3`) need a compatible build toolchain; prebuilt binaries are used where available.

```bash
git clone https://github.com/RahulSamariya/mem.git
cd mem
npm install

# recommended: put it on your PATH so `mem` works anywhere
npm run build
npm link
```

The embedding model downloads to `~/.mem/models` on first use (one-time, ~80 MB), then runs fully offline.

> **Windows / npm note:** if `npm install` reports a blocked install script (npm ≥ 11 blocks scripts by default), approve it and reinstall:
> ```bash
> npm install-scripts approve better-sqlite3@13.0.3 sharp protobufjs
> npm rebuild
> ```

## Data

Everything lives under `~/.mem/`:

```
~/.mem/
  memories.db        # SQLite store + sqlite-vec virtual table
  models/            # local embedding model cache
```

Delete this folder to wipe all memory.

## CLI usage

### Remember

```bash
mem remember "Chose SQLite over Postgres — zero external services, local-first" --tier decision
mem remember "Redis broke the local-first constraint" --tier failed_approach --files src/store.ts
mem remember "Never auto-commit extracted memories" --tier constraint
```

Options: `--tier decision|constraint|failed_approach|raw` · `--files a.ts,b.ts` · `--project <name>`

### Recall

```bash
mem recall "why did we pick sqlite"
mem recall "what broke when we tried redis" --limit 3
mem recall "vector search" --files src/store.ts          # file-path boost
mem recall "sqlite decision" --strategy file_boost_recency --json
mem recall "banking app" --project Java1                # scope to one project
```

Every result shows its tier, score, age, project, and id. `--json` emits structured output (scriptable).

### Seed from git history

```bash
mem init                     # in a repo — proposes candidates from git log, you accept y/n/e each
mem init --yes               # accept everything (for repos you trust the history of)
```

### Evaluate retrieval

```bash
mem eval                     # reads eval/queries.json, reports precision@1/@3 per strategy
mem eval --queries my-eval.json
```

### Manage & annotate

```bash
mem list                     # newest-first
mem list --project Java1     # only one project
mem list --json
mem delete <id>
mem db                       # db path + memory count
mem migrate                  # show/apply schema migrations
```

### LLM-assisted extraction (Phase 5, opt-in)

Extracts durable knowledge from **git history** (the one signal every tool touches identically — keeps the core universal). Batch, on demand. Nothing writes without your `y/n`.

```bash
# 1. configure a provider first (required — nothing calls a cloud silently)
mem config set-provider ollama      # local, free; uses Ollama at localhost:11434
mem config set-provider anthropic   # cloud; requires ANTHROPIC_API_KEY env
mem config                          # show current provider

# 2. extract from recent commits (propose + y/n per candidate, stores with source=git_seed)
mem extract --since HEAD~20
mem extract --dry-run               # propose only, store nothing
mem extract --provider anthropic    # override provider for this run only

# 3. measure it before trusting it (hand-label 20-30 commits you know)
mem extract-eval eval/labels.json --provider ollama   # precision / recall / F1
```

- **Dedup before proposing:** each candidate is checked against existing memories (semantic score > 0.87 skips it as a near-duplicate).
- **Unconfigured state errors** with setup instructions — it never silently calls a cloud API.
- Anthropic mode prints a visible note that diffs are being sent off-machine.
- Extracted memories carry `last_validated_at` and `source: git_seed` just like everything else — extraction doesn't get a pass on staleness.

## Configuration

Persisted in `~/.mem/config.json`.

```bash
mem config set-provider <ollama|anthropic> [--endpoint <url>] [--model <name>]
mem config
```

Provider overrides for a single run: `--provider`, `--endpoint`, `--api-key`, `--model` on `mem extract`.

## Schema migrations

Schema is versioned, never hand-edited in place. Numbered SQL files live in `migrations/`, tracked in a `schema_migrations` table, and are applied in order on startup.

```bash
mem migrate       # show applied/pending migrations (also auto-applies)
```

Add a migration (e.g. `migrations/003_something.sql`) rather than editing `001_init.sql` once real data exists.

## Embedding model upgrades

Swapping the embedding model invalidates every stored vector (different vector space → silently worse recall). Every row records its `embedding_model_version`. Guard rails:

- `recall` warns if any memory has a stale model version.
- After an upgrade, re-run all memories through the current model:

```bash
mem reembed       # re-embeds every memory in place
```

## MCP server

One server binary, usable by every MCP-capable tool. No tool-specific logic.

```bash
node dist/mcp-server.js              # stdio transport
```

Exposed tools:

| Tool | Arguments | Purpose |
|---|---|---|
| `recall` | `query`, `limit?`, `files?` | Ranked memories relevant to the query (file_boost_recency strategy) |
| `remember` | `text`, `tier?`, `files?` | Store a new memory (source `session`) |

### Per-tool config

| Tool | Config |
|---|---|
| **opencode** | Global `~/.config/opencode/opencode.json` — `"mcp": { "mem": { "type": "local", "command": ["node", "/abs/path/to/mem/dist/mcp-server.js"] } }` |
| **Claude Code** | `claude mcp add --transport stdio mem -- node /abs/path/to/mem/dist/mcp-server.js` (or project `.mcp.json`) |
| **Cursor** | `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global) |
| **VS Code (Copilot)** | MCP settings in workspace config |
| **Continue.dev** | YAML MCP config pointing at the same command |
| **Windsurf** | `~/.codeium/windsurf/mcp_config.json` |
| **JetBrains IDEs** | "MCP Servers for AI Assistants" community plugin |

### Non-MCP fallback

Aider and terminal-only workflows just call the CLI:

```bash
mem recall "what broke when we tried redis caching"
mem remember "Redis broke local-first" --tier failed_approach
```

## Retrieval evaluation

`mem eval` compares three ranking strategies on `eval/queries.json`:

1. **`semantic`** — cosine similarity only
2. **`file_boost`** — semantic `+` file-path overlap boost
3. **`file_boost_recency`** — file boost `+` recency decay (halves per ~month)

Bundled eval set (16 queries): **100% top-3 precision on all three strategies** — but the number that matters is the one you reproduce. Run it yourself against your own project's memories to decide shipping strategy. Extraction (Phase 5) has its own hand-labeled eval via `mem extract-eval`.

## Design & data model

Single table, fine for MVP:

```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  embedding BLOB NOT NULL,          -- via sqlite-vec
  tier TEXT NOT NULL,               -- decision | constraint | failed_approach | raw
  file_tags TEXT,                   -- JSON array of file paths
  project TEXT NOT NULL,
  source TEXT NOT NULL,             -- manual | git_seed | session
  created_at TEXT NOT NULL,
  last_validated_at TEXT NOT NULL
);
```

Plus a `memory_vec` virtual table (`vec0`) holding the 384-dim float vectors.

## Non-negotiables

- **Local-only by default.** No memory text leaves the machine for storage/retrieval. Any LLM-assisted extraction (Phase 5) is opt-in, behind explicit flags, with a documented `--local-only` mode.
- **Every memory shows its age.** `last_validated_at` is surfaced in every `recall`.
- **Confirm before auto-store.** `mem init` / `mem extract` propose; a human must accept.
- **Prove retrieval before building higher layers.** Phases 3 → 4 ordering was done on purpose; `mem eval` gates any claim of quality.

## Development

```bash
npm run build        # tsc -> dist/
npm run typecheck    # noEmit
npm test             # build + unit tests (pure functions; no model download needed)
```

Layout:

```
src/
  core.ts        # constants, schema/migration init, helpers (age labels, file overlap, config)
  migrate.ts     # schema migration runner (migrations/ dir + schema_migrations table)
  embed.ts       # local embeddings via @xenova/transformers
  store.ts       # DB read/write, `recall` ranking strategies, reembed
  seed.ts        # git-log candidate extraction for `mem init`
  eval.ts        # retrieval eval runner + strategy comparison
  extract.ts     # Phase 5: git-based extraction providers (ollama/anthropic) + extraction eval
  index.ts       # CLI (commander)
  mcp-server.ts  # MCP stdio server
migrations/      # numbered schema migrations (001_init.sql, 002_add_embedding_model_version.sql)
eval/queries.json     # bundled retrieval eval set
eval/EXTRACT_EVAL.md  # how to build labels for mem extract-eval
```

## Roadmap

- [x] Phase 1 — Core CLI: `remember` / `recall`
- [x] Phase 2 — `mem init` git-history seeding
- [x] Phase 3 — `mem eval` retrieval benchmarking
- [x] Phase 4 — MCP stdio wrapper + multi-tool config docs
- [x] Phase 5 — git-based LLM extraction (providers, dedup, extraction eval)
- [x] §8 — Schema migrations + embedding-model versioning (`mem migrate`, `mem reembed`)
- [ ] Session-scoped recall (`--session <id>`) and per-project DBs
- [ ] `last_validated_at` updates on confirmed recalls

## Contributing

PRs welcome. Keep the non-negotiables intact, add a test for new pure logic, and `npm test` + `npm run typecheck` before pushing.

1. Fork & clone.
2. `npm install && npm run build`.
3. Branch, implement, test.
4. Open a PR.

See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## License

[MIT](LICENSE)