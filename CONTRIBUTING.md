# Contributing to mem

Thanks for wanting to contribute. Please keep the project's [non-negotiables](../README.md#non-negotiables) intact — they are what make mem trustworthy.

## Setup

```bash
git clone <your-fork>
cd mem
npm install
npm run build
```

## Development loop

```bash
npm run typecheck   # noEmit check
npm run build       # compile to dist/
npm test            # unit tests (pure functions — no model download)
```

Before opening a PR, run all three. They are fast and offline.

## Guidelines

- **One concern per PR.** Small, reviewable diffs get merged first.
- **Pure logic gets tests.** Anything in `core.ts`, `seed.ts`, `eval.ts` that has no I/O should have a `node:test` case alongside it.
- **Keep it local-first.** No new code may send memory text off-machine by default. Any LLM path stays behind explicit flags (see `extract.ts`, `mem extract`).
- **Match the existing style.** CommonJS TypeScript, 2-space indent, `node:test` + `node:assert/strict`, commander for CLI options.
- **Update the README** if you change CLI options, MCP tools, or the eval strategy set.

## Testing changes

```bash
# end-to-end CLI smoke test (downloads the embedding model once)
mem remember "smoke test" --tier raw
mem recall "smoke test"
mem list
mem delete $(mem list --json | jq -r '.[] | select(.text=="smoke test") | .id')
```

## Eval

When changing retrieval ranking:

1. Add/adjust `eval/queries.json` cases for your scenario.
2. Run `mem eval`.
3. Report the precision numbers for all three strategies in the PR description.

## Code of conduct

Be respectful. This is a small open-source project; disagreements are welcome, dismissiveness is not.