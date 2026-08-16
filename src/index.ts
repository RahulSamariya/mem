#!/usr/bin/env node
import { program } from 'commander';
import { readFileSync, existsSync, statSync } from 'fs';
import * as readline from 'readline';
import { resolve } from 'path';
import {
  Tier,
  Source,
  getCwdProject,
  openDb,
  ensureMemHome,
  DB_PATH,
  projectName,
} from './core';
import { storeMemory, recall, getAllMemories, deleteMemory, countMemories } from './store';
import { seedFromRepo, formatCandidates, CandidateMemory } from './seed';
import { runEval, formatSummary, EvalCase, bestStrategy } from './eval';
import { extractAndStore } from './extract';

const VALID_TIERS: Tier[] = ['decision', 'constraint', 'failed_approach', 'raw'];

function parseTier(raw: string | undefined): Tier {
  if (!raw) return 'decision';
  const t = raw as Tier;
  if (!VALID_TIERS.includes(t)) {
    console.error(`Invalid tier "${raw}". Use one of: ${VALID_TIERS.join(', ')}`);
    process.exit(1);
  }
  return t;
}

function ask(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolveP) =>
    rl.question(prompt, (ans) => {
      rl.close();
      resolveP(ans);
    })
  );
}

program
  .name('mem')
  .description('Universal contextual memory for AI coding tools (CLI + MCP)')
  .version('1.0.0');

program
  .command('remember')
  .argument('<text>', 'the memory text to store')
  .option('--tier <tier>', 'tier: decision|constraint|failed_approach|raw', 'decision')
  .option('--files <files>', 'comma-separated file paths')
  .option('--project <name>', 'project name override')
  .action(async (text: string, opts: { tier?: string; files?: string; project?: string }) => {
    const { project } = getCwdProject();
    const files = opts.files ? opts.files.split(',').map((f) => f.trim()).filter(Boolean) : [];
    const mem = await storeMemory({
      text,
      tier: parseTier(opts.tier),
      files,
      project: opts.project ?? project,
      source: 'manual',
    });
    console.log(`stored ${mem.tier} memory "${mem.text}" -> ${mem.id}`);
  });

program
  .command('recall')
  .argument('[query]', 'the query text (reads stdin if omitted)')
  .option('--limit <n>', 'number of results', '5')
  .option('--files <files>', 'comma-separated file paths for file boost')
  .option('--strategy <name>', 'semantic|file_boost|file_boost_recency', 'semantic')
  .option('--json', 'JSON output')
  .action(async (query: string, opts: { limit: string; files?: string; strategy: string; json?: boolean }) => {
    let q = query;
    if (!q) {
      q = await new Promise<string>((res) => {
        const rl = readline.createInterface({ input: process.stdin });
        const chunks: string[] = [];
        rl.on('line', (l) => chunks.push(l));
        rl.on('close', () => res(chunks.join('\n')));
      });
    }
    q = q.trim();
    if (!q) {
      console.error('no query provided (argument or stdin)');
      process.exit(1);
    }
    const files = opts.files ? opts.files.split(',').map((f) => f.trim()).filter(Boolean) : [];
    const results = await recall(q, { limit: parseInt(opts.limit, 10) || 5, strategy: opts.strategy as any, files });
    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }
    if (results.length === 0) {
      console.log('no memories found');
      return;
    }
    for (const r of results) {
      console.log(`- [${r.tier}] ${r.text}`);
      console.log(`  score=${r.score.toFixed(3)} | ${r.age_label} | project=${r.project} | ${r.id}`);
      if (r.file_tags.length) console.log(`  files: ${r.file_tags.join(', ')}`);
    }
  });

program
  .command('init')
  .description('Seed memory store from git history of the current repo')
  .option('--max <n>', 'max commits to scan', '200')
  .option('--yes', 'accept all candidates without prompting', undefined)
  .action(async (opts: { max: string; yes?: boolean }) => {
    const { cwd, project } = getCwdProject();
    const candidates = await seedFromRepo(cwd, parseInt(opts.max, 10) || 200);
    if (candidates.length === 0) {
      console.log('No candidate memories extracted from git history.');
      console.log('Tip: this works best on a repo with descriptive commit messages.');
      return;
    }
    console.log(`Found ${candidates.length} candidate memories for "${project}":\n`);
    console.log(formatCandidates(candidates));
    console.log('');

    let accepted = 0;
    let skipped = 0;
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      let choice = 'y';
      if (!opts.yes) {
        const ans = (await ask(`Keep [${i}]? (y/n/e/edit) `)).trim().toLowerCase();
        if (ans === 'n') { skipped++; continue; }
        if (ans.startsWith('e')) {
          choice = 'e';
        }
        if (choice === 'e') {
          const edited = (await ask('  edit: ')).trim();
          if (edited) { c.text = edited; choice = 'y'; }
          else { skipped++; continue; }
        }
      }
      if (choice === 'y') {
        await storeMemory({ text: c.text, tier: c.tier, files: c.files, project, source: 'git_seed' });
        accepted++;
      }
    }
    console.log(`\nDone. Accepted ${accepted}, skipped ${skipped}.`);
  });

program
  .command('list')
  .description('List all memories')
  .option('--json', 'JSON output')
  .action(async (opts: { json?: boolean }) => {
    const rows = await getAllMemories();
    if (opts.json) { console.log(JSON.stringify(rows, null, 2)); return; }
    console.log(`${rows.length} memories.`);
    for (const r of rows) {
      console.log(`- [${r.tier}] ${r.text} (${r.id})`);
    }
  });

program
  .command('delete')
  .argument('<id>', 'memory id')
  .action(async (id: string) => {
    await deleteMemory(id);
    console.log(`deleted ${id}`);
  });

program
  .command('eval')
  .description('Run retrieval evaluation against eval/queries.json')
  .option('--queries <path>', 'path to queries.json', undefined)
  .option('--files <files>', 'comma-separated file paths for file boost', '')
  .action(async (opts: { queries?: string; files: string }) => {
    const candidates = [
      opts.queries,
      resolve(process.cwd(), 'eval', 'queries.json'),
      resolve(process.cwd(), 'queries.json'),
    ].filter((p): p is string => !!p && existsSync(p) && !statSync(p).isDirectory());
    const f = candidates[0];
    if (!f) {
      console.error('No eval/queries.json found. Create one, e.g. [{"query":"...","expected_memory_id":"..."}].');
      process.exit(1);
    }
    const cases = JSON.parse(readFileSync(f, 'utf8')) as EvalCase[];
    if (cases.length === 0) { console.error('empty eval file'); process.exit(1); }
    const files = opts.files.split(',').map((s) => s.trim()).filter(Boolean);
    const foo = await runEval(cases, 'semantic', 3, files);
    const fbo = await runEval(cases, 'file_boost', 3, files);
    const fbr = await runEval(cases, 'file_boost_recency', 3, files);
    console.log(formatSummary(foo, 'semantic'));
    console.log(formatSummary(fbo, 'file_boost'));
    console.log(formatSummary(fbr, 'file_boost_recency'));
    const best = bestStrategy(foo, fbo, fbr);
    console.log(`\nBEST: ${best.name} @ precision@3 = ${(best.summary.precision_at_3 * 100).toFixed(1)}%`);
  });

program
  .command('extract')
  .description('Propose durable memories from the current git diff (LLM-assisted, never auto-stores)')
  .option('--endpoint <url>', 'LLM endpoint (or MEM_LLM_ENDPOINT env)')
  .option('--api-key <key>', 'LLM API key (or MEM_LLM_API_KEY env)')
  .option('--model <name>', 'LLM model (default: MEM_LLM_MODEL or gpt-4o-mini)')
  .option('--local-only', 'use only local heuristics, never send anything to an LLM')
  .option('--dry-run', 'print proposals without storing anything')
  .action(async (opts: { endpoint?: string; apiKey?: string; model?: string; localOnly?: boolean; dryRun?: boolean }) => {
    if (opts.localOnly) {
      process.env.MEM_LLM_ENDPOINT = '';
    }
    await extractAndStore({
      endpoint: opts.endpoint,
      apiKey: opts.apiKey,
      model: opts.model,
      dryRun: opts.dryRun,
    });
  });

program
  .command('db')
  .description('Print database location and memory count')
  .action(async () => {
    ensureMemHome();
    console.log(`db: ${DB_PATH}`);
    console.log(`memories: ${await countMemories()}`);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});