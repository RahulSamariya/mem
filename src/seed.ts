import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import { Tier, Source, projectName } from './core';
import { storeMemory } from './store';

export interface CommitInfo {
  hash: string;
  date: string;
  subject: string;
}

export interface CandidateMemory {
  text: string;
  tier: Tier;
  files: string[];
}

const COMMIT_KEYWORDS: Array<[RegExp, Tier]> = [
  [/\b(?:decision|chose|switched to|moved to|migrat|migrat(?:e|ion)|introduc|adopt)\b/i, 'decision'],
  [/\b(?:must|should|can'?t|cannot|don'?t|do ?not|no longer|deprecat|rely on|required for)\b/i, 'constraint'],
  [/\b(?:revert|rolled back|removed.*because|didn'?t|still didn'?t|broke|failed|abandon|broke down|wouldn'?t|couldn'?t)\b/i, 'failed_approach'],
];

const NOISE_PREFIX = /^(Merge|chore|deps|Bump|Sync|sync|Update.*(?:readme|readme\.md|workflow)|Release v?|Initial commit|first commit)/i;

export function extractCandidatesFromSubject(subject: string): CandidateMemory[] {
  const cleaned = subject
    .replace(/^(fix|feat|refactor|docs|chore|test|style|perf|build|ci|revert)(\([^)]*\))?:\s*/i, '')
    .trim();
  if (!cleaned) return [];
  if (NOISE_PREFIX.test(cleaned)) return [];
  const out: CandidateMemory[] = [];
  for (const [re, tier] of COMMIT_KEYWORDS) {
    if (re.test(subject)) {
      out.push({
        text: `${cleaned.charAt(0).toUpperCase() + cleaned.slice(1)} (from commit message)`,
        tier,
        files: [],
      });
      return out;
    }
  }
  return out;
}

export function getGitLog(cwd: string, num: number = 200): CommitInfo[] {
  try {
    const raw = execSync(
      `git log -${num} --pretty=format:%H%x1f%aI%x1f%s`,
      { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, date, subject] = line.split('\x1f');
        return { hash, date, subject: subject ?? '' };
      });
  } catch {
    return [];
  }
}

export function hasGitRemote(cwd: string): boolean {
  try {
    execSync('git remote get-url origin', { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

export function hasGh(): boolean {
  try {
    execSync('gh --version', { stdio: 'pipe', encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

const SEMANTIC_STOPWORDS = new RegExp(
  '^(ai code assistant|implementation detail|adjust code|in the file|the file|update the)',
  'i'
);

export function semanticFilter(candidates: CandidateMemory[]): CandidateMemory[] {
  // Drop very generic subjects that carry no durable knowledge.
  return candidates.filter((c) => !SEMANTIC_STOPWORDS.test(c.text));
}

export async function seedFromRepo(cwd: string, maxCommits: number = 200): Promise<CandidateMemory[]> {
  const commits = getGitLog(cwd, maxCommits);
  const candidates: CandidateMemory[] = [];
  for (const commit of commits) {
    candidates.push(...extractCandidatesFromSubject(commit.subject));
  }
  return semanticFilter(candidates);
}

export function formatCandidates(candidates: CandidateMemory[]): string {
  return candidates
    .map(
      (c, i) =>
        `[${i}] (${c.tier}) ${c.text}`
    )
    .join('\n');
}