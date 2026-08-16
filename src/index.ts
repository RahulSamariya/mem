#!/usr/bin/env node
import { program } from 'commander';
import { readFileSync, existsSync, statSync } from 'fs';
import * as readline from 'readline';
import { resolve } from 'path';
import packageJson = require('../package.json');
import {
  Tier,
  Source,
  getCwdProject,
  openDb,
  ensureMemHome,
  DB_PATH,
  projectName,
  readConfig,
  writeConfig,
} from './core';
import { storeMemory, recall, getAllMemories, deleteMemory, countMemories, reembedAll } from './store';
import { seedFromRepo, formatCandidates, CandidateMemory } from './seed';
import { runEval, formatSummary, EvalCase, bestStrategy } from './eval';
import { extractAndStore, runExtractionEval, LabeledCommit, describeConfig, loadConfig } from './extract';
import { getAppliedVersions, discoverMigrations } from './migrate';

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
  .version(packageJson.version);

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
  .option('--project <name>', 'only return memories from this project')
  .option('--json', 'JSON output')
  .action(async (query: string, opts: { limit: string; files?: string; strategy: string; project?: string; json?: boolean }) => {
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
    const results = await recall(q, { limit: parseInt(opts.limit, 10) || 5, strategy: opts.strategy as any, files, projectFilter: opts.project });
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
  .option('--project <name>', 'only list memories from this project')
  .option('--json', 'JSON output')
  .action(async (opts: { project?: string; json?: boolean }) => {
    const all = await getAllMemories();
    const rows = opts.project ? all.filter((r) => r.project === opts.project) : all;
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
  .description('Propose durable memories from git history (LLM-assisted; nothing writes without your y/n)')
  .option('--since <ref>', 'git ref to extract since, e.g. HEAD~20 (default: HEAD~20)', undefined)
  .option('--provider <name>', 'override provider: ollama|anthropic')
  .option('--endpoint <url>', 'override provider endpoint')
  .option('--api-key <key>', 'override API key (anthropic)')
  .option('--model <name>', 'override model name')
  .option('--dry-run', 'print proposals without storing anything')
  .action(async (opts: { since?: string; provider?: string; endpoint?: string; apiKey?: string; model?: string; dryRun?: boolean }) => {
    await extractAndStore({
      since: opts.since,
      provider: opts.provider,
      endpoint: opts.endpoint,
      apiKey: opts.apiKey,
      model: opts.model,
      dryRun: opts.dryRun,
    });
  });

program
  .command('extract-eval')
  .description('Precision/recall of extraction against a hand-labeled commit set')
  .argument('<labels>', 'path to labels JSON: [{ "hash", "expected": "yes"|"no", "expected_tier"? }]')
  .option('--provider <name>', 'override provider: ollama|anthropic')
  .option('--endpoint <url>', 'override provider endpoint')
  .option('--api-key <key>', 'override API key (anthropic)')
  .option('--model <name>', 'override model name')
  .action(async (labelsPath: string, opts: { provider?: string; endpoint?: string; apiKey?: string; model?: string }) => {
    const labels = JSON.parse(readFileSync(resolve(labelsPath), 'utf8')) as LabeledCommit[];
    const r = await runExtractionEval(labels, {
      provider: opts.provider,
      endpoint: opts.endpoint,
      apiKey: opts.apiKey,
      model: opts.model,
    });
    console.log(`\nExtraction eval (${r.total} labeled commits)`);
    console.log(`precision: ${(r.precision * 100).toFixed(1)}%  (tp=${r.tp}, fp=${r.fp})`);
    console.log(`recall:    ${(r.recall * 100).toFixed(1)}%  (tp=${r.tp}, fn=${r.fn})`);
    console.log(`f1:        ${(r.f1 * 100).toFixed(1)}%`);
    for (const c of r.perCommit) {
      console.log(
        `  [${c.hash}] label=${c.label} proposals=${c.proposals.length} :: ${c.subject}`
      );
    }
  });

program
  .command('config')
  .description('Show or set mem configuration (extraction provider)')
  .argument('[set]', 'subcommand: set-provider')
  .argument('[value]', 'provider name: ollama|anthropic')
  .option('--endpoint <url>', 'provider endpoint (e.g. Ollama URL)')
  .option('--model <name>', 'provider model name')
  .action((sub, value, opts: { endpoint?: string; model?: string }) => {
    if (sub === 'set-provider') {
      if (value !== 'ollama' && value !== 'anthropic') {
        console.error('provider must be one of: ollama, anthropic');
        process.exit(1);
      }
      const cfg = readConfig();
      cfg.provider = { ...cfg.provider, name: value };
      if (opts.endpoint) {
        cfg.provider.endpoint = opts.endpoint;
      } else if (value === 'ollama') {
        cfg.provider.endpoint = 'http://localhost:11434';
      } else {
        delete cfg.provider.endpoint;
      }
      if (opts.model) {
        cfg.provider.model = opts.model;
      } else {
        delete cfg.provider.model;
      }
      writeConfig(cfg);
      console.log(`configured ${describeConfig({ name: value, endpoint: cfg.provider.endpoint ?? null, model: cfg.provider.model ?? null })}`);
      if (value === 'anthropic') {
        console.log('Note: anthropic reads ANTHROPIC_API_KEY from the environment.');
      }
      return;
    }
    const cfg = loadConfig();
    console.log(`provider: ${describeConfig(cfg)}`);
    console.log(`config file: ${DB_PATH.replace('memories.db', 'config.json')}`);
  });

program
  .command('migrate')
  .description('Show schema migrations and apply any pending ones')
  .action(() => {
    const db = openDb();
    const applied = getAppliedVersions(db);
    for (const m of discoverMigrations()) {
      const done = applied.includes(m.version);
      console.log(`${done ? 'applied  ' : 'pending  '} ${m.name}`);
    }
    db.close();
  });

program
  .command('reembed')
  .description('Re-embed all memories with the current model after an embedding upgrade')
  .action(async () => {
    const { total, done, failed } = await reembedAll();
    console.log(`reembedded ${done}/${total} memories (failed ${failed}).`);
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