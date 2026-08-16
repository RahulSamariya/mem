import { execSync } from 'child_process';
import * as readline from 'readline';
import { Tier, getCwdProject, readConfig } from './core';
import { storeMemory, recall } from './store';

export interface ExtractConfig {
  since?: string;
  provider?: string;
  endpoint?: string;
  apiKey?: string;
  model?: string;
  dryRun?: boolean;
  localOnly?: boolean;
}

export interface ExtractionProposal {
  tier: Tier;
  text: string;
}

export interface CommitUnit {
  hash: string;
  subject: string;
  diff: string;
}

export interface LabeledCommit {
  hash: string;
  subject?: string;
  expected: 'yes' | 'no';
  expected_tier?: Tier;
}

export const PROVIDERS = ['ollama', 'anthropic'] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export interface ProviderConfig {
  name: ProviderName | null;
  endpoint: string | null;
  model: string | null;
}

const PROMPT =
  'You are extracting durable knowledge from a coding session.\n' +
  'Given the commit message and diff below, decide whether it contains a durable ' +
  'DECISION, CONSTRAINT, or FAILED/ABANDONED APPROACH worth remembering for future work.\n' +
  '- A durable item is something whose loss would cost real time later (why a choice was made, a rule that cannot be broken, an approach that stopped working).\n' +
  '- Output NONE for formatting changes, dependency bumps, typo fixes, docs-only changes, and boring refactors.\n' +
  'Respond with a JSON array, e.g. [{"tier":"decision","text":"1-2 sentence memory"}]. ' +
  'Use tier one of: decision, constraint, failed_approach. If nothing worth remembering, respond with [].';

export function loadConfig(): ProviderConfig {
  const file = readConfig().provider ?? {};
  return {
    name: (file.name as ProviderName) ?? null,
    endpoint: file.endpoint ?? process.env.MEM_OLLAMA_ENDPOINT ?? null,
    model: file.model ?? process.env.MEM_OLLAMA_MODEL ?? null,
  };
}

export function describeConfig(c: ProviderConfig): string {
  return c.name
    ? `provider=${c.name}${c.endpoint ? ` endpoint=${c.endpoint}` : ''}${c.model ? ` model=${c.model}` : ''}`
    : 'not configured';
}

function getCommitUnit(commitHash: string): CommitUnit | null {
  const { cwd } = getCwdProject();
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    return null;
  }
  try {
    const subject = execSync(`git log -1 ${commitHash} --pretty=format:%s`, {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const diff = execSync(`git show ${commitHash} --format= --stat --patch --unified=3`, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
    return { hash: commitHash, subject, diff };
  } catch {
    return null;
  }
}

function getGitCommits(cwd: string, since: string | undefined): CommitUnit[] {
  const base = since ?? 'origin/HEAD~20';
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    return [];
  }
  let range = '';
  try {
    // Resolve since against available refs; fall back to a plain HEAD walk.
    execSync(`git rev-parse --verify ${base}`, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    range = `${base}..HEAD`;
  } catch {
    range = `-20`;
  }
  try {
    const raw = execSync(
      `git log ${range} --pretty=format:%H%x1f%s`,
      { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const lines = raw.split('\n').filter(Boolean);
    const units: CommitUnit[] = [];
    for (const line of lines) {
      const [hash, subject] = line.split('\x1f');
      let diff = '';
      try {
        diff = execSync(`git show ${hash} --format= --stat --patch --unified=3`, {
          cwd,
          encoding: 'utf8',
          maxBuffer: 20 * 1024 * 1024,
        });
      } catch {
        diff = '';
      }
      units.push({ hash, subject: subject ?? '', diff });
    }
    return units;
  } catch {
    return [];
  }
}

async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) =>
    rl.question(question, (ans) => {
      rl.close();
      res(ans.trim());
    })
  );
}

async function ollamaExtract(unit: CommitUnit, cfg: ExtractConfig): Promise<ExtractionProposal[]> {
  const endpoint = cfg.endpoint ?? process.env.MEM_OLLAMA_ENDPOINT ?? 'http://localhost:11434';
  const model = cfg.model ?? process.env.MEM_OLLAMA_MODEL ?? 'qwen2.5:3b';
  const body = {
    model,
    messages: [
      { role: 'system', content: PROMPT },
      { role: 'user', content: `Commit: ${unit.subject}\n\nDiff:\n${unit.diff.slice(0, 20000)}` },
    ],
    stream: false,
  };
  const res = await fetch(`${endpoint}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Ollama ${endpoint} returned ${res.status} ${await res.text()}`);
  const data: any = await res.json();
  return parseProposals(data?.message?.content ?? '');
}

async function anthropicExtract(unit: CommitUnit, cfg: ExtractConfig): Promise<ExtractionProposal[]> {
  const apiKey = cfg.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Anthropic provider requires ANTHROPIC_API_KEY.');
  const model = cfg.model ?? process.env.ANTHROPIC_MODEL ?? 'claude-3-5-haiku-latest';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: PROMPT,
      messages: [
        { role: 'user', content: `Commit: ${unit.subject}\n\nDiff:\n${unit.diff.slice(0, 20000)}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic returned ${res.status} ${await res.text()}`);
  const data: any = await res.json();
  const text = (data?.content ?? []).map((b: any) => b?.text ?? '').join('');
  return parseProposals(text);
}

export function parseProposals(raw: string): ExtractionProposal[] {
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const arr = JSON.parse(match[0]);
    if (!Array.isArray(arr)) return [];
    const proposals: ExtractionProposal[] = [];
    for (const x of arr) {
      if (!x || typeof x.text !== 'string') continue;
      const tier: Tier = /constraint/i.test(x.tier)
        ? 'constraint'
        : /failed/i.test(x.tier)
          ? 'failed_approach'
          : 'decision';
      const text = x.text.trim().replace(/^[\"\']|[\"\']$/g, '');
      if (text.length > 0) proposals.push({ tier, text });
    }
    return proposals;
  } catch {
    return [];
  }
}

async function extractProposals(unit: CommitUnit, cfg: ExtractConfig): Promise<ExtractionProposal[]> {
  const config = loadConfig();
  const provider = cfg.provider ?? config.name;
  if (!provider || provider === '') {
    throw new Error(
      'No extraction provider configured.\n' +
        'Run one of:\n' +
        '  mem config set-provider ollama    # local, free (needs Ollama running)\n' +
        '  mem config set-provider anthropic # cloud; requires ANTHROPIC_API_KEY'
    );
  }
  if (provider === 'ollama') return ollamaExtract(unit, cfg);
  if (provider === 'anthropic') return anthropicExtract(unit, cfg);
  throw new Error(`Unknown provider "${provider}". Use ollama or anthropic.`);
}

// Dedup: skip proposals that are near-duplicates of memories already in the DB or already proposed this run.
async function isNearDuplicate(text: string) {
  try {
    const results = await recall(text, { limit: 1, strategy: 'semantic' });
    return results.length > 0 && results[0].score > 0.87;
  } catch {
    return false;
  }
}

export async function extractAndStore(cfg: ExtractConfig): Promise<number> {
  const { cwd, project } = getCwdProject();
  const units = getGitCommits(cwd, cfg.since);
  if (units.length === 0) {
    console.log('No git commits found to extract from. Run inside a git repo (optionally with --since <ref>).');
    return 0;
  }

  const config = loadConfig();
  const provider = cfg.provider ?? config.name;
  if (!provider || provider === '') {
    console.error(
      '[mem] No extraction provider configured. Nothing sent off-machine.\n' +
        '      Configure one first:\n' +
        '        mem config set-provider ollama      (local, free — needs Ollama running)\n' +
        '        mem config set-provider anthropic    (cloud — requires ANTHROPIC_API_KEY)\n' +
        '      Or pass --provider <name> for this run only.'
    );
    return 0;
  }
  if (provider === 'anthropic' && !cfg.dryRun) {
    console.warn('[mem] NOTE: using Anthropic — commit diffs will be sent off-machine.');
  }

  const seen = new Set<string>();
  let accepted = 0;
  let skipped = 0;
  let duplicates = 0;

  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    let proposals: ExtractionProposal[];
    try {
      proposals = await extractProposals(unit, cfg);
    } catch (err: any) {
      console.error(`[extract] ${unit.hash.slice(0, 8)} failed: ${err.message}`);
      continue;
    }
    for (const p of proposals) {
      if (seen.has(p.text)) continue;
      if (await isNearDuplicate(p.text)) {
        duplicates++;
        console.log(`[${unit.hash.slice(0, 8)}] SKIP (near-dup) :: (${p.tier}) ${p.text}`);
        continue;
      }
      seen.add(p.text);
      console.log(`[${unit.hash.slice(0, 8)}] (${p.tier}) ${p.text}`);
      let choice = 'y';
      if (!cfg.dryRun) {
        const ans = await ask('  keep? (y/n): ');
        choice = ans.toLowerCase().startsWith('y') ? 'y' : 'n';
      }
      if (choice === 'y') {
        if (!cfg.dryRun) {
          await storeMemory({ text: p.text, tier: p.tier, files: [], project, source: 'git_seed' });
        }
        accepted++;
      } else {
        skipped++;
      }
    }
  }
  console.log(`\nDone. accepted=${accepted} skipped=${skipped} near-duplicates_skipped=${duplicates}.`);
  return accepted;
}

// Extraction eval: hand-labeled commits -> precision/recall of this extraction pipeline.
export interface ExtractionEvalResult {
  total: number;
  precision: number;
  recall: number;
  f1: number;
  tp: number;
  fp: number;
  fn: number;
  perCommit: Array<{ hash: string; subject: string; label: string; proposals: ExtractionProposal[] }>;
}

export async function runExtractionEval(labels: LabeledCommit[], cfg: ExtractConfig): Promise<ExtractionEvalResult> {
  const provider = cfg.provider ?? loadConfig().name;
  if (!provider || provider === '') {
    throw new Error(
      'No extraction provider configured. Run "mem config set-provider ollama|anthropic" first, or pass --provider.'
    );
  }
  const perCommit: ExtractionEvalResult['perCommit'] = [];
  let tp = 0;
  let fp = 0;
  let fn = 0;

  for (const label of labels) {
    const unit = getCommitUnit(label.hash);
    if (!unit) {
      console.error(`[eval] ${label.hash.slice(0, 8)} not found; skipping (is this commit in this repo?).`);
      continue;
    }
    let proposals: ExtractionProposal[] = [];
    try {
      proposals = await extractProposals(unit, { ...cfg, dryRun: true });
    } catch (err: any) {
      console.error(`[eval] ${unit.hash.slice(0, 8)} failed: ${err.message}`);
    }
    const expecting = label.expected === 'yes';
    const got = proposals.length > 0;
    if (expecting && got) tp++;
    else if (!expecting && got) fp++;
    else if (expecting && !got) fn++;
    perCommit.push({
      hash: unit.hash.slice(0, 8),
      subject: unit.subject,
      label: label.expected,
      proposals,
    });
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { total: tp + fp + fn, precision, recall, f1, tp, fp, fn, perCommit };
}