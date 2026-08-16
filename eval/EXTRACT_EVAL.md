# Extraction eval labels

`mem extract-eval <labels.json>` runs the extraction pipeline against hand-labeled
commits and reports precision / recall / F1 (see README "LLM-assisted extraction").

Format — one entry per commit you want scored (add 20-30 for a trustworthy number):

```json
[
  { "hash": "71a33bb9", "expected": "yes", "expected_tier": "decision" },
  { "hash": "1f4d0000", "expected": "no" }
]
```

- `hash`: git commit hash (short prefixes work) — must exist in the repo you run the command in.
- `expected`: `"yes"` if this commit contains a durable decision/constraint/failed-approach worth remembering, else `"no"`.
- `expected_tier` (optional): the tier you'd assign; recorded for reporting.

To build a labeled set from a repo:
```bash
git log --oneline -30
# copy hashes, label each yes/no by reading the commit
mem extract-eval my-labels.json --provider ollama
```

Notice: eval results go to console, not files. `eval/results/` is gitignored
intentionally — hand-labels belong in `eval/` only if you want them in the repo
(as `eval/queries.json` deliberately is: test queries carry no private memory).