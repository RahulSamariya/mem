# Build Brief: Universal Contextual Memory for AI Coding Tools ("mem")

**Handoff target:** OpenCode
**Purpose of this doc:** Everything needed to implement without re-deriving design decisions. Follow phase order — do not skip ahead to Phase 4 (MCP wiring) before Phase 3 (retrieval eval) passes. "Universal" means one core engine (CLI + MCP server) that every tool connects to via its own config — not separate implementations per tool.

---

## 1. One-line pitch

A local-first CLI + MCP server that gives AI coding assistants — across every major IDE and CLI, not just one — contextual memory of past decisions, constraints, and failed approaches, surfaced by relevance to the files currently in focus, not just dumped into every prompt like a static `CLAUDE.md`.

**Key design insight:** universality is a config/packaging concern, not an architecture concern. Because the core (Phase 1) is a plain CLI + MCP server on stdio, it already works with any MCP-capable client. The work in Phase 4 is: (a) document the config file per tool, (b) provide a non-MCP CLI fallback for tools that don't speak MCP yet. Do not build tool-specific versions of the core logic — one server, many config entries.

**Current MCP support landscape (verify again before Phase 4, this shifts fast):**
| Tool | MCP support | Config location |
|---|---|---|
| Claude Code | Native, deepest integration | `claude mcp add --transport stdio ...` or project `.mcp.json` |
| Cursor | Native | `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global) |
| Windsurf | Native | `~/.codeium/windsurf/mcp_config.json` |
| VS Code (Copilot) | Native | VS Code MCP settings / workspace config |
| Continue.dev | Native, imports other tools' configs | YAML config |
| JetBrains IDEs | Via community plugin ("MCP Servers for AI Assistants") | Plugin settings |
| Aider | **No native MCP support as of early 2026** | N/A — use CLI fallback |
| Any terminal-based tool that can shell out | N/A | Call `mem recall` / `mem remember` directly |

## 2. Tech stack

- **Language:** TypeScript / Node.js (matches your existing Chrome extension + Express bridge stack, and the official MCP SDK is TS-first)
- **Storage:** SQLite via `better-sqlite3`
- **Vector search:** `sqlite-vec` extension (lightweight, no external service)
- **Embeddings:** local, via `@xenova/transformers` (runs in-process, no API key, keeps the tool local-only by default)
- **MCP:** `@modelcontextprotocol/sdk` (official TS SDK), stdio transport
- **CLI:** `commander` or `yargs`

## 3. Data model

```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  embedding BLOB NOT NULL,          -- via sqlite-vec
  tier TEXT NOT NULL,               -- 'decision' | 'constraint' | 'failed_approach' | 'raw'
  file_tags TEXT,                   -- JSON array of file paths
  project TEXT NOT NULL,
  source TEXT NOT NULL,             -- 'manual' | 'git_seed' | 'session'
  created_at TEXT NOT NULL,
  last_validated_at TEXT NOT NULL
);
```

Keep this table alone for MVP. Do not add extra tables (tags table, users table, etc.) until Phase 5 — YAGNI.

## 4. Phased build plan

### Phase 1 — Core CLI (storage + retrieval, no MCP yet)
**Goal:** prove `remember` / `recall` work in isolation.

Commands:
- `mem remember "<text>" [--tier decision|constraint|failed_approach] [--files path1,path2]`
- `mem recall "<query>" [--limit 5]`

Tasks:
1. SQLite setup with schema above, `sqlite-vec` loaded as extension.
2. Embedding function: text → vector, using local `@xenova/transformers` model (e.g. `all-MiniLM-L6-v2` — small, fast, good enough for this use case).
3. `remember`: embed text, infer `file_tags` from `--files` flag or from files currently open in the CWD if detectable, insert row.
4. `recall`: embed query, run vector similarity search, return top N with tier + age shown.

**Acceptance criteria:** can manually remember 10 things and recall the right one for 8+ of 10 obvious queries.

### Phase 2 — Cold start seeding
**Goal:** solve the "empty on day one" problem.

- `mem init` — walks `git log` in the current repo, extracts commit messages (and PR descriptions if a GitHub remote + `gh` CLI is available), and proposes candidate memories.
- Do NOT auto-commit these. Print a numbered list, let the user accept/reject/edit each one (`y/n/e`) before writing to DB.
- Test this against a real repo you already know — the Hinglish classifier or the web-to-Figma extension repo. You'll immediately be able to judge whether the extracted candidates are actually good.

**Acceptance criteria:** running `mem init` on a real repo with 50+ commits produces at least 10 genuinely useful candidate memories (your subjective judgment, since you know the repo).

### Phase 3 — Retrieval evaluation (do not skip this)
**Goal:** prove the ranking approach is actually good before building on top of it.

1. From the seeded memory store (Phase 2 output on one of your real repos), write 15-20 queries with a known-correct memory ID for each. Save as `eval/queries.json`:
```json
[
  { "query": "why did we choose SQLite over Postgres", "expected_memory_id": "..." },
  { "query": "what broke when we tried Redis caching", "expected_memory_id": "..." }
]
```
2. Build `mem eval` — runs all queries, checks if expected memory is in top-3 results, reports precision.
3. Compare three ranking strategies:
   - semantic similarity only
   - semantic + file-path overlap boost
   - semantic + file-path boost + recency decay
4. Ship whichever wins on your own eval set. Record the numbers — this is your resume line.

**Acceptance criteria:** best strategy hits ≥70% top-3 precision on your eval set. If none hit that, the embedding model or query set needs revisiting before Phase 4.

### Phase 4 — MCP server wrapper (one server, many tools)
**Goal:** wire the proven CLI into Claude Code first (fastest feedback loop, your primary daily tool), then extend to other MCP clients without touching core logic.

**4a — Build the MCP wrapper once:**
- Wrap `remember` and `recall` as MCP tools using `@modelcontextprotocol/sdk`, stdio transport.
- Tool definitions:
  - `recall(query: string, limit?: number)` — returns ranked memories
  - `remember(text: string, tier?: string, files?: string[])` — stores a new memory
- This same built server binary/script is what every tool in the table above will point to. No per-tool branching in the server code.

**4b — Validate in Claude Code first:**
```
claude mcp add --transport stdio mem -- node /path/to/mem/dist/mcp-server.js
```
(Use `--scope project` with a `.mcp.json` if you want it repo-shareable.) Test inside a real session: open a real project, ask it something that should trigger `recall`, confirm it calls the tool and gets useful results.

**4c — Extend to other MCP clients:**
Once Claude Code confirms the tool works, add config for at minimum one or two others to prove portability (pick based on what you and teammates actually use — Cursor and VS Code Copilot are the most common):
- Cursor: add the same stdio command to `.cursor/mcp.json`
- VS Code / Continue.dev: add to the relevant MCP settings
- Document the rest (Windsurf, JetBrains) in the README even if you don't personally test every one — the point is the server is portable by design, not that you've manually verified all six.

**4d — Non-MCP fallback (Aider, plain terminal workflows):**
Since Aider has no native MCP client, ship the plain `mem recall` / `mem remember` CLI commands as a documented fallback — usable via Aider's shell/run command, or just manually alongside any tool. This is why Phase 1 building a real standalone CLI (not an MCP-only tool) mattered — it's the fallback for everything MCP doesn't reach yet.

**Acceptance criteria:** `recall` gets called naturally (not just when explicitly told to) inside at least two different MCP-capable tools, and the plain CLI works standalone for a non-MCP workflow.

### Phase 5 — Stretch: LLM-assisted extraction
**Goal:** reduce manual `remember` burden.

- After a coding session (or on git commit), run a small LLM call: "does this diff/conversation contain a durable decision, constraint, or abandoned approach worth remembering? If yes, summarize in 1-2 sentences."
- Always propose, never auto-commit — same accept/reject flow as `mem init`.
- Only build this after Phase 4 works end-to-end. It's the least reliable part of the system; don't let it block anything else.

## 5. Non-negotiables (carried over from design review — do not cut these for speed)

- **Local-only by default.** No memory text leaves the machine for storage/retrieval. Embedding model runs locally. Any Phase 5 LLM call must be behind a clear flag, with a `--local-only` mode documented even if it's a stub for MVP.
- **Every memory shows its age.** `last_validated_at` must be surfaced in `recall` output (e.g. "noted 4 months ago") — never presented as unqualified current fact.
- **Confirm before auto-store.** Both `mem init` (Phase 2) and LLM extraction (Phase 5) propose candidates; they never write to the DB without explicit human accept.
- **Don't build Phase 4 before Phase 3 passes.** The whole pitch depends on retrieval actually being good — prove it on your own eval set first.

## 6. What "done" looks like if time runs out

Stopping after Phase 3 is a complete, demoable story: a local CLI with measured retrieval precision across ranking strategies, seeded from a real repo. That alone is a stronger portfolio piece than an unfinished MCP integration — lead with the numbers from the eval, not just the pitch.
