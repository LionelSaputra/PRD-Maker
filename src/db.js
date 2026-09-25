import Database from 'better-sqlite3';
import { join } from 'path';

const dbPath = process.env.DB_PATH || join(process.cwd(), 'data.db');
export const db = new Database(dbPath);

// Enable WAL mode for high performance
db.pragma('journal_mode = WAL');

// Initialize tables
db.exec(`
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  tagline TEXT,
  summary TEXT,
  tech_stack TEXT,
  architecture TEXT,
  features_json TEXT,
  db_schema_json TEXT,
  api_endpoints_json TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  spec TEXT NOT NULL,
  status TEXT DEFAULT 'todo', -- 'todo', 'in_progress', 'done', 'failed'
  reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
`);

// Arah visual yang dipilih user (kosong = AI yang memilih). Ditambahkan
// terpisah supaya workspace lama tetap bisa dibaca tanpa migrasi data.
if (!db.prepare('PRAGMA table_info(workspaces)').all().some(c => c.name === 'design_direction')) {
  db.exec('ALTER TABLE workspaces ADD COLUMN design_direction TEXT');
}
