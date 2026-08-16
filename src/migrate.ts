import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

let migrationsDir: string | null = null;

export function setMigrationsDir(dir: string): void {
  migrationsDir = dir;
}

export function getMigrationsDir(): string {
  if (migrationsDir) return migrationsDir;
  const candidates = [
    path.join(__dirname, '..', 'migrations'),
    path.join(process.cwd(), 'migrations'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isDirectory()) {
      migrationsDir = c;
      return c;
    }
  }
  throw new Error('Could not locate migrations/ directory');
}

export function discoverMigrations(): Migration[] {
  const dir = getMigrationsDir();
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d+_.*\.sql$/i.test(f))
    .sort((a, b) => {
      const av = parseInt(a.split('_')[0], 10);
      const bv = parseInt(b.split('_')[0], 10);
      return av - bv;
    });
  return files.map((f) => ({
    version: parseInt(f.split('_')[0], 10),
    name: f,
    sql: fs.readFileSync(path.join(dir, f), 'utf8'),
  }));
}

export function getAppliedVersions(db: Database.Database): number[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const rows = db.prepare(`SELECT version FROM schema_migrations`).all() as { version: number }[];
  return rows.map((r) => r.version);
}

export function migrate(db: Database.Database): Migration[] {
  const applied = new Set(getAppliedVersions(db));
  const pending = discoverMigrations().filter((m) => !applied.has(m.version));
  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`).run(
        m.version,
        new Date().toISOString()
      );
    })();
  }
  return pending;
}