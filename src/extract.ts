import { execSync } from 'child_process';
import { Tier, getCwdProject } from './core';
import { storeMemory, recall } from './store';

export interface ExtractConfig {
  endpoint?: string;
  apiKey?: string;
  model?: string;
  diff?: string;
  dryRun?: boolean;
}

const PROMPT = `You are extracting durable knowledge from a coding session.
Given the following diff, identify any DECISION, CONSTRAINT, or FAILED_APPROACH worth remembering for future work.
Respond with a JSON array of objects: {"tier":"decision"|"constraint"|"failed_approach","text":"..."}.
If nothing is durable, return [].
Keep each text to 1-2 sentences. Do not include trivial formatting or refactors.`;

export function readDiff(cwd: string, against: string = 'HEAD'): string {
  try {
    return execSync(`git diff ${against}`, { cwd, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  } catch {
    return '';
  }
}

async function callLLM(diff: string, cfg: ExtractConfig): Promise<Array<{ tier: Tier; text: string }>> {
  const endpoint = cfg.endpoint ?? process.env.MEM_LLM_ENDPOINT;
  const apiKey = cfg.apiKey ?? process.env.MEM_LLM_API_KEY;
  const model = cfg.model ?? process.env.MEM_LLM_MODEL ?? 'gpt-4o-mini';
  if (!endpoint) {
    throw new Error(
      'No LLM endpoint configured. Set MEM_LLM_ENDPOINT (and optionally MEM_LLM_API_KEY / MEM_LLM_MODEL) or pass --endpoint.'
    );
  }
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: diff.slice(0, 20000) }] }),
  });
  if (!res.ok) {
    throw new Error(`LLM request failed: ${res.status} ${await res.text()}`);
  }
  const data: any = await res.json();
  const content: string = data?.choices?.[0]?.message?.content ?? '';
  try {
    const arr = JSON.parse(content);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export async function extractAndStore(cfg: ExtractConfig): Promise<number> {
  const { cwd, project } = getCwdProject();
  const diff = cfg.diff ?? readDiff(cwd);
  if (!diff.trim()) {
    console.log('No diff found. Nothing to extract.');
    return 0;
  }
  console.log('Analyzing diff for durable knowledge...');
  let proposals: Array<{ tier: Tier; text: string }>;
  if (!cfg.endpoint && !process.env.MEM_LLM_ENDPOINT) {
    console.log('No LLM endpoint configured; falling back to local heuristic keywords.');
    proposals = localHeuristic(diff);
  } else {
    proposals = await callLLM(diff, cfg);
  }
  console.log();

  let accepted = 0;
  let skipped = 0;
  for (let i = 0; i < proposals.length; i++) {
    const p = proposals[i];
    const dup = await hasNearDuplicate(p.text);
    if (dup) {
      console.log(`[${i}] SKIP (duplicate of existing) :: (${p.tier}) ${p.text}`);
      skipped++;
      continue;
    }
    console.log(`[${i}] (${p.tier}) ${p.text}`);
    let choice = 'y';
    if (!cfg.dryRun) {
      const rl = await import('readline').then(({ createInterface }) =>
        new Promise<string>((res) => {
          const r = createInterface({ input: process.stdin, output: process.stdout });
          r.question(`  hold? (y/n): `, (ans) => { r.close(); res(ans.trim().toLowerCase() || 'n'); });
        })
      );
      if (rl !== 'y') { skipped++; continue; }
    }
    await storeMemory({ text: p.text, tier: p.tier, files: [], project, source: 'session' });
    accepted++;
  }
  console.log(`\nDone. Accepted ${accepted}, skipped ${skipped}.`);
  return accepted;
}

async function hasNearDuplicate(text: string): Promise<boolean> {
  try {
    const results = await recall(text, { limit: 1, strategy: 'semantic' });
    return results.length > 0 && results[0].score > 0.9;
  } catch {
    return false;
  }
}

function localHeuristic(diff: string): Array<{ tier: Tier; text: string }> {
  const out: Array<{ tier: Tier; text: string }> = [];
  for (const line of diff.split('\n').slice(0, 400)) {
    const m = line.match(/^[+-]\s*\/\/\s*(?:DECISION|CONSTRAINT|FAILED):\s*(.+)$/i);
    if (m) {
      const tier: Tier = /decision/i.test(line) ? 'decision' : /constraint/i.test(line) ? 'constraint' : 'failed_approach';
      out.push({ tier, text: m[1].trim() });
    }
  }
  return out;
}