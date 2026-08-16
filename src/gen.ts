import { getCwdProject, Tier, MEM_HOME, MemoryRow } from './core';
import { getAllMemories } from './store';
import fs from 'fs';
import path from 'path';
import { EvalCase } from './eval';

// ---------------------------------------------------------------------------
// Template-based paraphrase generation. Each memory -> many queries that all
// point back to the same expected_memory_id. Deterministic, offline, and the
// dominant source for bulk eval sets.
// ---------------------------------------------------------------------------

const TIER_PREFIX: Record<Tier, string[]> = {
  decision: ['why did we choose', 'why did we pick', 'what was the decision about', 'why do we use', 'decision on'],
  constraint: ['what are we not allowed to do regarding', 'what constraint applies to', 'is there a rule about', 'what must we remember about', 'what cannot change about'],
  failed_approach: ['what went wrong with', 'what did we try before for', 'what failed with', 'what broke when we tried', 'why did we abandon'],
  raw: ['tell me about', 'what do we know about', 'context on', 'what is the deal with'],
};

const SUFFIX: Record<Tier, string[]> = {
  decision: ['?', ' and why?', ' — what was decided?', '? (recall prior context)'],
  constraint: ['?', ' — is there a restriction?', '? what rule governs this?'],
  failed_approach: ['?', ' and what happened?', '? why did that not work?'],
  raw: ['?', '? anything we noted?'],
};

// Keyword-only short forms (stress the embedding on sparse input).
const SHORT = ['', 'sqlite', 'redis', 'vector', 'embedding', 'deployment', 'cache', 'schema', 'migration', 'api', 'auth', 'model'];

// Trim a phrase to a compact subject so the template reads naturally.
function subjectOf(text: string): string {
  let s = text
    .replace(/^[A-Z]/, (m) => m.toLowerCase())
    .replace(/\.$/, '')
    .replace(/\(from commit message\)/g, '')
    .replace(/\(.*?\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // shorten to first clause-ish chunk, keep under ~8 words for readability
  const words = s.split(' ');
  if (words.length > 9) s = words.slice(0, 9).join(' ') + '…';
  return s;
}

export function templatedQueries(mem: MemoryRow, maxPerMemory: number): string[] {
  const subj = subjectOf(mem.text);
  const tier: Tier = mem.tier in TIER_PREFIX ? mem.tier : 'raw';
  const prefixes = TIER_PREFIX[tier];
  const suffixes = SUFFIX[tier];
  const out: string[] = [];
  // full-template variants: <prefix> <subject><suffix>
  for (const p of prefixes) {
    for (const s of suffixes) {
      out.push(`${p} ${subj}${s}`);
    }
  }
  // fragment variant: just the subject phrased as a question
  out.push(subj.charAt(0).toUpperCase() + subj.slice(1) + '?');
  // few of the shared short keywords (rare, one-off)
  if (Math.random() < 0.3) {
    const kw = SHORT[Math.floor(Math.random() * SHORT.length)];
    if (kw && kw.length > 2) out.push(kw);
  }
  // dedupe preserving order
  const seen = new Set<string>();
  return out.filter((q) => {
    const key = q.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, maxPerMemory);
}

export interface GenOptions {
  perMemory?: number;
  project?: string;
  negatives?: number;
  out?: string;
  llm?: boolean;
}

const NEGATIVE_SUBJECTS = [
  'docker container orchestration on kubernetes',
  'deploying a react native mobile app to app stores',
  'setting up a CI pipeline for terraform infrastructure',
  'designing a recommendation engine using collaborative filtering',
  'integrating stripe payments into the mobile checkout flow',
  'migrating our kubernetes workloads to a serverless platform',
];

export function generateEvalCases(rows: MemoryRow[], opts: GenOptions): EvalCase[] {
  const cases: EvalCase[] = [];
  const per = Math.max(1, opts.perMemory ?? 6);
  for (const mem of rows) {
    if (opts.project && mem.project !== opts.project) continue;
    for (const q of templatedQueries(mem, per)) {
      cases.push({ query: q, expected_memory_id: mem.id });
    }
  }
  // negative queries: expect nothing (memories "none" support in eval)
  for (let i = 0; i < (opts.negatives ?? 4); i++) {
    const base = NEGATIVE_SUBJECTS[i % NEGATIVE_SUBJECTS.length];
    cases.push({ query: `why did we choose ${base}`, expected_memory_id: 'none' });
  }
  return cases;
}

export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------------------
// LLM-assisted generation: ask the configured provider to paraphrase each
// memory into natural questions. Falls back to templates if no provider.
// ---------------------------------------------------------------------------

const LLM_PROMPT =
  'You generate eval queries for a memory-retrieval system. Given a memory, ' +
  'produce a JSON array of 5 natural user questions (strings) that an AI coding ' +
  'assistant would realistically ask, and whose correct answer is exactly that memory. ' +
  'Vary phrasing: some full questions, some short fragments. Do not add quotes. Output only JSON, e.g. ["why did we pick sqlite?", "sqlite storage decision"].';

async function llmQueries(text: string, provider: { name: string; endpoint: string | null; model: string | null }, cfg: { apiKey?: string }): Promise<string[]> {
  if (provider.name === 'ollama') {
    const endpoint = provider.endpoint ?? 'http://localhost:11434';
    const model = provider.model ?? 'qwen2.5:3b';
    const res = await fetch(`${endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: LLM_PROMPT },
          { role: 'user', content: `Memory: ${text}` },
        ],
        stream: false,
      }),
    });
    if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
    const data: any = await res.json();
    return parseStringArray(data?.message?.content ?? '');
  }
  if (provider.name === 'anthropic') {
    const apiKey = cfg.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('Anthropic requires ANTHROPIC_API_KEY.');
    const model = provider.model ?? 'claude-3-5-haiku-latest';
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system: LLM_PROMPT,
        messages: [{ role: 'user', content: `Memory: ${text}` }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic returned ${res.status}`);
    const data: any = await res.json();
    const t = (data?.content ?? []).map((b: any) => b?.text ?? '').join('');
    return parseStringArray(t);
  }
  throw new Error('unknown provider');
}

function parseStringArray(raw: string): string[] {
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    return Array.isArray(arr) ? arr.map(String).filter((s) => s.length > 0) : [];
  } catch {
    return [];
  }
}

export async function generateEval(
  opts: GenOptions & { provider?: { name: string; endpoint: string | null; model: string | null }; apiKey?: string }
): Promise<EvalCase[]> {
  const rows = await getAllMemories();
  let cases: EvalCase[];
  if (opts.llm && opts.provider?.name) {
    cases = [];
    const per = Math.max(1, opts.perMemory ?? 5);
    for (const mem of rows) {
      if (opts.project && mem.project !== opts.project) continue;
      try {
        const qs = await llmQueries(mem.text, opts.provider, { apiKey: opts.apiKey });
        for (const q of qs.slice(0, per)) cases.push({ query: q, expected_memory_id: mem.id });
      } catch (err: any) {
        console.error(`[eval-gen] ${mem.id.slice(0, 8)} failed: ${err.message}`);
      }
    }
  } else {
    cases = generateEvalCases(rows, opts);
  }
  return shuffle(cases);
}

export async function writeEvalFile(cases: EvalCase[], out?: string): Promise<string> {
  const { project } = getCwdProject();
  const dir = out ? path.dirname(path.resolve(out)) : path.join(process.cwd(), 'eval');
  fs.mkdirSync(dir, { recursive: true });
  const file = out ? path.resolve(out) : path.join(dir, 'queries.json');
  fs.writeFileSync(file, JSON.stringify(cases, null, 2) + '\n');
  console.log(`wrote ${cases.length} eval queries to ${file}`);
  console.log(`  sample expected id source project: ${project}`);
  return file;
}

export { MEM_HOME };