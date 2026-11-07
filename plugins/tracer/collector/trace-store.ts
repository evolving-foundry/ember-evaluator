/** SQLite persistence for runs, traces, events, outcomes, sessions and analyses. */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DDL = `
CREATE TABLE IF NOT EXISTS runs(
  epoch TEXT PRIMARY KEY,
  candidate_id TEXT,
  parent_id TEXT,
  fingerprint TEXT,
  started_at REAL,
  finished_at REAL,
  status TEXT
);
CREATE TABLE IF NOT EXISTS traces(
  epoch TEXT,
  session TEXT,
  seq INTEGER,
  kind TEXT,
  payload TEXT,
  ingested_at REAL,
  event_id TEXT,
  PRIMARY KEY(epoch, session, seq)
);
CREATE TABLE IF NOT EXISTS outcomes(
  epoch TEXT,
  task_id TEXT,
  success INTEGER,
  reward REAL,
  latency_ms REAL,
  cost_usd REAL,
  recorded_at REAL,
  attempt_id TEXT,
  payload TEXT,
  PRIMARY KEY(epoch, task_id)
);
CREATE TABLE IF NOT EXISTS sessions(
  epoch TEXT,
  session TEXT,
  kind TEXT,
  count INTEGER,
  first_at REAL,
  updated_at REAL,
  stats TEXT,
  PRIMARY KEY(epoch, session)
);
CREATE TABLE IF NOT EXISTS events(
  epoch TEXT,
  attempt TEXT,
  seq INTEGER,
  type TEXT,
  at TEXT,
  payload TEXT,
  ingested_at REAL,
  PRIMARY KEY(epoch, attempt, seq)
);
CREATE TABLE IF NOT EXISTS feedback(
  epoch TEXT PRIMARY KEY,
  payload TEXT,
  generated_at REAL
);
CREATE TABLE IF NOT EXISTS analyses(
  epoch TEXT,
  digest_hash TEXT,
  model TEXT,
  scope TEXT NOT NULL DEFAULT 'epoch',
  payload TEXT,
  generated_at REAL,
  PRIMARY KEY(epoch, digest_hash, model, scope)
);
CREATE TABLE IF NOT EXISTS experience(
  pattern_key TEXT,
  change TEXT,
  delta TEXT,
  n_samples INTEGER,
  updated_at REAL,
  PRIMARY KEY(pattern_key, change)
);
`;

const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_traces_epoch ON traces(epoch);
CREATE INDEX IF NOT EXISTS idx_events_attempt ON events(epoch, attempt);
CREATE INDEX IF NOT EXISTS idx_outcomes_epoch ON outcomes(epoch);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);
CREATE INDEX IF NOT EXISTS idx_analyses_epoch ON analyses(epoch);
CREATE UNIQUE INDEX IF NOT EXISTS idx_traces_event
  ON traces(epoch, event_id) WHERE event_id IS NOT NULL;
`;

/** Columns added after the first release; created on demand for existing databases. */
const ADDED_COLUMNS: Record<string, Record<string, string>> = {
  traces: { event_id: "TEXT" },
  runs: { status: "TEXT", finished_at: "REAL", artifacts: "TEXT", config: "TEXT" },
  outcomes: { attempt_id: "TEXT", payload: "TEXT" },
};

export type Row = Record<string, unknown>;
export type SqlValue = string | number | null | Uint8Array;

export function nowSeconds(): number {
  return Date.now() / 1000;
}

export function parseJson<T = unknown>(text: unknown): T | null {
  if (typeof text !== "string" || !text) return null;
  return JSON.parse(text) as T;
}

export class TraceStore {
  private readonly db: DatabaseSync;
  private auto = 0;

  constructor(readonly path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec(DDL);
    this.addMissingColumns();
    this.db.exec(INDEXES);
  }

  private addMissingColumns(): void {
    for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
      const existing = new Set(
        (this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map(row => String(row.name)),
      );
      for (const [name, kind] of Object.entries(columns)) {
        if (!existing.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${kind}`);
      }
    }
  }

  close(): void {
    this.db.close();
  }

  upsertRun(
    epoch: string,
    candidateId: string | null = null,
    parentId: string | null = null,
    fingerprint: unknown = null,
    config: Record<string, unknown> | null = null,
  ): void {
    const fp = fingerprint === null ? null : JSON.stringify(fingerprint);
    const cfg = config !== null && typeof config === "object" ? JSON.stringify(config) : null;
    this.db
      .prepare(
        "INSERT INTO runs(epoch,candidate_id,parent_id,fingerprint,config,started_at,status) " +
          "VALUES(?,?,?,?,?,?,'running') " +
          "ON CONFLICT(epoch) DO UPDATE SET " +
          "candidate_id=COALESCE(excluded.candidate_id,candidate_id)," +
          "parent_id=COALESCE(excluded.parent_id,parent_id)," +
          "fingerprint=COALESCE(excluded.fingerprint,fingerprint)," +
          "config=COALESCE(excluded.config,config)",
      )
      .run(epoch, candidateId, parentId, fp, cfg, nowSeconds());
  }

  /** Overwrite parent_id directly: COALESCE in upsertRun can only fill, never clear, so unlinking needs this. */
  setParent(epoch: string, parentId: string | null): void {
    this.db.prepare("UPDATE runs SET parent_id=? WHERE epoch=?").run(parentId, epoch);
  }

  /** Record where deterministic results were written so the panel can show the saved location. */
  setArtifacts(epoch: string, artifacts: unknown): void {
    this.db.prepare("UPDATE runs SET artifacts=? WHERE epoch=?").run(JSON.stringify(artifacts), epoch);
  }

  finishRun(epoch: string): Row | null {
    this.db
      .prepare(
        "INSERT INTO runs(epoch,finished_at,status) VALUES(?,?,'finished') " +
          "ON CONFLICT(epoch) DO UPDATE SET " +
          "status='finished', " +
          "finished_at=COALESCE(runs.finished_at,excluded.finished_at)",
      )
      .run(epoch, nowSeconds());
    return this.getRun(epoch);
  }

  getRun(epoch: string): Row | null {
    return (this.db.prepare("SELECT * FROM runs WHERE epoch=?").get(epoch) as Row | undefined) ?? null;
  }

  findRunByCandidate(candidateId: string, excludeEpoch?: string | null): Row | null {
    let sql = "SELECT * FROM runs WHERE candidate_id=?";
    const args: SqlValue[] = [candidateId];
    if (excludeEpoch) {
      sql += " AND epoch<>?";
      args.push(excludeEpoch);
    }
    sql += " ORDER BY COALESCE(finished_at,started_at) DESC LIMIT 1";
    return (this.db.prepare(sql).get(...args) as Row | undefined) ?? null;
  }

  addTrace(epoch: string, session: string, seq: number | null, kind: string, payload: unknown, eventId: string | null = null): boolean {
    if (seq === null) {
      this.auto += 1;
      seq = Math.trunc(nowSeconds() * 1000) * 1000 + (this.auto % 1000);
    }
    const result = this.db
      .prepare(
        "INSERT OR IGNORE INTO traces(epoch,session,seq,kind,payload,ingested_at,event_id) " +
          "VALUES(?,?,?,?,?,?,?)",
      )
      .run(epoch, session, Math.trunc(seq), kind, JSON.stringify(payload), nowSeconds(), eventId);
    return Number(result.changes) > 0;
  }

  /**
   * Write or overwrite a rebuilt trace; returns whether it was inserted for the first time.
   *
   * The same attempt is rebuilt incrementally from events; later results overwrite earlier ones without double counting.
   */
  putTrace(epoch: string, session: string, seq: number, kind: string, payload: unknown): boolean {
    const exists =
      this.db.prepare("SELECT 1 FROM traces WHERE epoch=? AND session=? AND seq=?").get(epoch, session, Math.trunc(seq)) !== undefined;
    this.db
      .prepare(
        "INSERT INTO traces(epoch,session,seq,kind,payload,ingested_at,event_id) " +
          "VALUES(?,?,?,?,?,?,NULL) " +
          "ON CONFLICT(epoch,session,seq) DO UPDATE SET " +
          "kind=excluded.kind, payload=excluded.payload, ingested_at=excluded.ingested_at",
      )
      .run(epoch, session, Math.trunc(seq), kind, JSON.stringify(payload), nowSeconds());
    return !exists;
  }

  /** Store one raw event row; only the first row per (epoch, attempt, seq) is kept. */
  addEvent(epoch: string, attempt: string, seq: number | null, type: string, at: string | null, payload: unknown): boolean {
    if (seq === null) {
      this.auto += 1;
      seq = this.auto;
    }
    const result = this.db
      .prepare(
        "INSERT OR IGNORE INTO events(epoch,attempt,seq,type,at,payload,ingested_at) " +
          "VALUES(?,?,?,?,?,?,?)",
      )
      .run(epoch, attempt, Math.trunc(seq), type, at, JSON.stringify(payload), nowSeconds());
    return Number(result.changes) > 0;
  }

  listEvents(epoch: string, attempt: string): unknown[] {
    const rows = this.db
      .prepare("SELECT payload FROM events WHERE epoch=? AND attempt=? ORDER BY seq")
      .all(epoch, attempt) as Row[];
    return rows.map(row => JSON.parse(String(row.payload)) as unknown);
  }

  touchSession(
    epoch: string,
    session: string,
    kind: string | null,
    stats: unknown = null,
    bump = true,
  ): void {
    const statsJson = stats === null ? null : JSON.stringify(stats);
    const now = nowSeconds();
    const increment = bump ? 1 : 0;
    this.db
      .prepare(
        "INSERT INTO sessions(epoch,session,kind,count,first_at,updated_at,stats) " +
          "VALUES(?,?,?,?,?,?,?) " +
          "ON CONFLICT(epoch,session) DO UPDATE SET " +
          "kind=CASE " +
          "  WHEN excluded.kind='trajectory' THEN 'trajectory' " +
          "  WHEN sessions.kind IS NULL OR sessions.kind='unknown' THEN excluded.kind " +
          "  ELSE sessions.kind END, " +
          "count=sessions.count+?, " +
          "updated_at=excluded.updated_at, " +
          "stats=COALESCE(excluded.stats, sessions.stats)",
      )
      .run(epoch, session, kind || "unknown", 1, now, now, statsJson, increment);
  }

  listSessions(epoch?: string | null): Row[] {
    let sql = "SELECT epoch,session,kind,count,first_at,updated_at,stats FROM sessions";
    const args: SqlValue[] = [];
    if (epoch) {
      sql += " WHERE epoch=?";
      args.push(epoch);
    }
    sql += " ORDER BY updated_at DESC";
    const rows = this.db.prepare(sql).all(...args) as Row[];
    return rows.map(sessionRow);
  }

  getSession(epoch: string, session: string): Row | null {
    const row = this.db
      .prepare(
        "SELECT epoch,session,kind,count,first_at,updated_at,stats " +
          "FROM sessions WHERE epoch=? AND session=?",
      )
      .get(epoch, session) as Row | undefined;
    return row === undefined ? null : sessionRow(row);
  }

  latestSessionEpoch(session: string): string | null {
    const row = this.db
      .prepare("SELECT epoch FROM sessions WHERE session=? ORDER BY updated_at DESC LIMIT 1")
      .get(session) as Row | undefined;
    return row === undefined ? null : String(row.epoch);
  }

  deleteSession(session: string, epoch?: string | null): void {
    if (epoch) {
      this.db.prepare("DELETE FROM sessions WHERE session=? AND epoch=?").run(session, epoch);
    } else {
      this.db.prepare("DELETE FROM sessions WHERE session=?").run(session);
    }
  }

  addOutcome(epoch: string, data: Record<string, unknown>): void {
    const taskId = String(data.task_id ?? data.taskId ?? "");
    this.db
      .prepare(
        "INSERT OR REPLACE INTO outcomes(epoch,task_id,success,reward,latency_ms,cost_usd," +
          "recorded_at,attempt_id,payload) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        epoch,
        taskId,
        data.success ? 1 : 0,
        (data.reward ?? null) as SqlValue,
        (data.latency_ms ?? data.latencyMs ?? null) as SqlValue,
        (data.cost_usd ?? data.costUsd ?? null) as SqlValue,
        nowSeconds(),
        String(data.attempt_id ?? ""),
        JSON.stringify(data),
      );
  }

  /** Find an outcome by attempt to attach scoring details to trajectory-level analysis. */
  getOutcome(epoch: string, attemptId: string | null): Record<string, unknown> | null {
    if (!attemptId) return null;
    const row = this.db
      .prepare("SELECT payload FROM outcomes WHERE epoch=? AND attempt_id=? LIMIT 1")
      .get(epoch, String(attemptId)) as Row | undefined;
    return row === undefined ? null : (parseJson<Record<string, unknown>>(row.payload) ?? null);
  }

  listTraces(epoch: string, session?: string | null, limit?: number | null, offset = 0): Row[] {
    let sql = "SELECT session,seq,kind,payload FROM traces WHERE epoch=?";
    const args: SqlValue[] = [epoch];
    if (session) {
      sql += " AND session=?";
      args.push(session);
    }
    sql += " ORDER BY ingested_at,seq";
    if (limit !== undefined && limit !== null) {
      sql += " LIMIT ? OFFSET ?";
      args.push(Math.trunc(limit), Math.trunc(offset));
    }
    const rows = this.db.prepare(sql).all(...args) as Row[];
    return rows.map(row => ({
      session: row.session,
      seq: row.seq,
      kind: row.kind,
      payload: JSON.parse(String(row.payload)) as unknown,
    }));
  }

  replayTraces(session?: string | null, epoch?: string | null, limit = 2000): Row[] {
    let sql = "SELECT epoch,session,seq,kind,payload FROM traces";
    const where: string[] = [];
    const args: SqlValue[] = [];
    if (epoch) {
      where.push("epoch=?");
      args.push(epoch);
    }
    if (session) {
      where.push("session=?");
      args.push(session);
    }
    if (where.length > 0) sql += " WHERE " + where.join(" AND ");
    sql += " ORDER BY ingested_at DESC, seq DESC LIMIT ?";
    args.push(Math.trunc(limit));
    const rows = (this.db.prepare(sql).all(...args) as Row[]).reverse();
    return rows.map(row => ({
      epoch: row.epoch,
      session: row.session,
      seq: row.seq,
      kind: row.kind,
      payload: JSON.parse(String(row.payload)) as unknown,
    }));
  }

  countTraces(epoch: string, session?: string | null): number {
    let sql = "SELECT COUNT(*) FROM traces WHERE epoch=?";
    const args: SqlValue[] = [epoch];
    if (session) {
      sql += " AND session=?";
      args.push(session);
    }
    const row = this.db.prepare(sql).get(...args) as Row;
    return Number(Object.values(row)[0]);
  }

  listOutcomes(epoch: string): Row[] {
    const rows = this.db.prepare("SELECT * FROM outcomes WHERE epoch=?").all(epoch) as Row[];
    return rows.map(row => {
      const item: Row = { ...row };
      const raw = item.payload;
      delete item.payload;
      if (typeof raw === "string" && raw) {
        try {
          const merged = JSON.parse(raw) as unknown;
          if (merged !== null && typeof merged === "object" && !Array.isArray(merged)) {
            for (const [key, value] of Object.entries(merged)) {
              if (!(key in item)) item[key] = value;
            }
          }
        } catch {
          // Ignore unreadable legacy payloads.
        }
      }
      return item;
    });
  }

  saveFeedback(epoch: string, payload: unknown): void {
    this.db
      .prepare(
        "INSERT INTO feedback(epoch,payload,generated_at) VALUES(?,?,?) " +
          "ON CONFLICT(epoch) DO UPDATE SET payload=excluded.payload,generated_at=excluded.generated_at",
      )
      .run(epoch, JSON.stringify(payload), nowSeconds());
  }

  getFeedback(epoch: string): unknown {
    const row = this.db.prepare("SELECT payload FROM feedback WHERE epoch=?").get(epoch) as Row | undefined;
    return row === undefined ? null : (parseJson(row.payload) ?? null);
  }

  /** Store an LLM analysis keyed by input digest, model and scope. */
  saveAnalysis(epoch: string, digestHash: string, model: string, payload: unknown, scope = "epoch"): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO analyses(epoch,digest_hash,model,scope,payload," +
          "generated_at) VALUES(?,?,?,?,?,?)",
      )
      .run(epoch, digestHash, model, scope, JSON.stringify(payload), nowSeconds());
  }

  getAnalysis(epoch: string, digestHash: string, model: string, scope = "epoch"): unknown {
    const row = this.db
      .prepare("SELECT payload FROM analyses WHERE epoch=? AND digest_hash=? AND model=? AND scope=?")
      .get(epoch, digestHash, model, scope) as Row | undefined;
    return row === undefined ? null : (parseJson(row.payload) ?? null);
  }

  getLatestAnalysis(epoch: string, scope = "epoch"): unknown {
    const row = this.db
      .prepare(
        "SELECT payload FROM analyses WHERE epoch=? AND scope=? " +
          "ORDER BY generated_at DESC LIMIT 1",
      )
      .get(epoch, scope) as Row | undefined;
    return row === undefined ? null : (parseJson(row.payload) ?? null);
  }

  latestEpoch(): string | null {
    const rows = this.listEpochs();
    return rows.length > 0 ? String(rows[0]!.epoch) : null;
  }

  listEpochs(): Row[] {
    return this.db
      .prepare(
        "WITH epochs AS (" +
          "  SELECT epoch FROM runs" +
          "  UNION SELECT epoch FROM traces" +
          "  UNION SELECT epoch FROM outcomes" +
          "  UNION SELECT epoch FROM events" +
          ") " +
          "SELECT e.epoch,r.candidate_id,r.parent_id,r.started_at," +
          "COALESCE(r.status,'unknown') AS status,r.finished_at," +
          "(SELECT COUNT(*) FROM traces t WHERE t.epoch=e.epoch) AS traces," +
          "(SELECT COUNT(*) FROM outcomes o WHERE o.epoch=e.epoch) AS outcomes," +
          "COALESCE(r.started_at," +
          "  (SELECT MAX(ingested_at) FROM traces t WHERE t.epoch=e.epoch)," +
          "  (SELECT MAX(ingested_at) FROM events ev WHERE ev.epoch=e.epoch)," +
          "  (SELECT MAX(recorded_at) FROM outcomes o WHERE o.epoch=e.epoch),0) AS last_at " +
          "FROM epochs e LEFT JOIN runs r ON r.epoch=e.epoch " +
          "ORDER BY last_at DESC",
      )
      .all() as Row[];
  }

  deleteEpoch(epoch: string): boolean {
    for (const table of ["traces", "outcomes", "sessions", "feedback", "events", "analyses"]) {
      this.db.prepare(`DELETE FROM ${table} WHERE epoch=?`).run(epoch);
    }
    this.db.prepare("DELETE FROM runs WHERE epoch=?").run(epoch);
    return true;
  }

  /** Return epochs whose last activity is older than cutoffTs; epochs still running are never stale. */
  staleEpochs(cutoffTs: number): string[] {
    const rows = this.db
      .prepare(
        "WITH epochs AS (" +
          "  SELECT epoch FROM runs" +
          "  UNION SELECT epoch FROM traces" +
          "  UNION SELECT epoch FROM outcomes" +
          "  UNION SELECT epoch FROM events" +
          ") " +
          "SELECT e.epoch, COALESCE(r.status,'unknown') AS status, " +
          "MAX(COALESCE(r.finished_at,0)," +
          "  COALESCE((SELECT MAX(ingested_at) FROM traces t WHERE t.epoch=e.epoch),0)," +
          "  COALESCE((SELECT MAX(ingested_at) FROM events ev WHERE ev.epoch=e.epoch),0)," +
          "  COALESCE((SELECT MAX(recorded_at) FROM outcomes o WHERE o.epoch=e.epoch),0)," +
          "  COALESCE(r.started_at,0)) AS last_at " +
          "FROM epochs e LEFT JOIN runs r ON r.epoch=e.epoch",
      )
      .all() as Row[];
    return rows
      .filter(row => Number(row.last_at) < cutoffTs && row.status !== "running")
      .map(row => String(row.epoch));
  }

  purgeOlderThan(cutoffTs: number): string[] {
    const epochs = this.staleEpochs(cutoffTs);
    for (const epoch of epochs) this.deleteEpoch(epoch);
    return epochs;
  }

  purge(vacuum = true): boolean {
    for (const table of ["traces", "outcomes", "sessions", "feedback", "runs", "experience", "events"]) {
      this.db.exec(`DELETE FROM ${table}`);
    }
    if (vacuum) this.db.exec("VACUUM");
    return true;
  }
}

function sessionRow(row: Row): Row {
  const item: Row = { ...row };
  item.stats = typeof item.stats === "string" && item.stats ? (JSON.parse(item.stats) as unknown) : null;
  return item;
}
