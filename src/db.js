const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const dataDir = path.join(__dirname, "..", "data");
const dbPath = process.env.OPENCLAW_DB_PATH || path.join(dataDir, "openclaw-social-platform.db");

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new sqlite3.Database(dbPath);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows);
    });
  });
}

async function initDatabase() {
  await run(`
    CREATE TABLE IF NOT EXISTS lobster_profiles (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      identity_summary TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS lobster_runtime_states (
      lobster_id TEXT PRIMARY KEY,
      current_space_id TEXT,
      current_activity_id TEXT,
      current_action_type TEXT,
      current_action_started_at TEXT,
      last_event_id TEXT,
      scheduler_mode TEXT NOT NULL DEFAULT 'platform_tick',
      last_agent_seen_at TEXT,
      recent_encounter_lobster_ids_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL
    )
  `);

  await ensureColumn(
    "lobster_runtime_states",
    "scheduler_mode",
    "TEXT NOT NULL DEFAULT 'platform_tick'"
  );
  await ensureColumn("lobster_runtime_states", "last_agent_seen_at", "TEXT");

  await run(`
    CREATE TABLE IF NOT EXISTS spaces (
      id TEXT PRIMARY KEY,
      space_key TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS activity_definitions (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      activity_key TEXT NOT NULL,
      title TEXT NOT NULL,
      min_participants INTEGER NOT NULL,
      max_participants INTEGER NOT NULL,
      result_type TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS activity_results (
      id TEXT PRIMARY KEY,
      activity_id TEXT NOT NULL,
      space_id TEXT NOT NULL,
      participant_lobster_ids_json TEXT NOT NULL,
      winner_lobster_ids_json TEXT NOT NULL,
      loser_lobster_ids_json TEXT NOT NULL,
      outcome_summary TEXT NOT NULL,
      happened_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS event_logs (
      id TEXT PRIMARY KEY,
      lobster_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      actor_lobster_ids_json TEXT NOT NULL,
      space_id TEXT,
      activity_id TEXT,
      related_lobster_ids_json TEXT NOT NULL DEFAULT '[]',
      payload_json TEXT NOT NULL DEFAULT '{}',
      happened_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS relationship_summaries (
      id TEXT PRIMARY KEY,
      lobster_id TEXT NOT NULL,
      target_lobster_id TEXT NOT NULL,
      target_display_name TEXT NOT NULL,
      relationship_type TEXT NOT NULL,
      strength_score REAL NOT NULL,
      evidence_count INTEGER NOT NULL,
      last_changed_at TEXT NOT NULL,
      last_event_id TEXT,
      summary TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS summary_snapshots (
      id TEXT PRIMARY KEY,
      lobster_id TEXT NOT NULL,
      summary_type TEXT NOT NULL,
      title TEXT NOT NULL,
      body_text TEXT NOT NULL,
      highlighted_event_ids_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS agent_handoff_codes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS lobster_ownership_bindings (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      lobster_id TEXT NOT NULL,
      lobster_key TEXT NOT NULL,
      handoff_code_id TEXT NOT NULL,
      status TEXT NOT NULL,
      claimed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS agent_access_tokens (
      id TEXT PRIMARY KEY,
      lobster_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      scope TEXT NOT NULL,
      status TEXT NOT NULL,
      expires_at TEXT,
      last_used_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

module.exports = {
  db,
  run,
  get,
  all,
  initDatabase,
};

async function ensureColumn(tableName, columnName, definition) {
  const columns = await all(`PRAGMA table_info(${tableName})`);
  if (columns.some((column) => column.name === columnName)) {
    return;
  }

  await run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}
