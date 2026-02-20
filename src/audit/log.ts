import Database from "better-sqlite3";
import type { AuditEntry } from "../policy/types.js";
import type { LedgerEntry } from "../policy/ledger.js";

export class AuditLog {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        service_url TEXT NOT NULL,
        amount TEXT NOT NULL,
        amount_usd REAL NOT NULL,
        token TEXT NOT NULL,
        category TEXT,
        policy_decision TEXT NOT NULL,
        policy_reason TEXT NOT NULL,
        human_decision TEXT,
        final_outcome TEXT NOT NULL,
        tx_hash TEXT,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_outcome ON audit_log(final_outcome);
    `);
  }

  insert(entry: AuditEntry): void {
    const stmt = this.db.prepare(`
      INSERT INTO audit_log (id, timestamp, service_url, amount, amount_usd, token, category,
        policy_decision, policy_reason, human_decision, final_outcome, tx_hash, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      entry.id,
      entry.timestamp,
      entry.serviceUrl,
      entry.amount,
      entry.amountUSD,
      entry.token,
      entry.category,
      entry.policyDecision,
      entry.policyReason,
      entry.humanDecision,
      entry.finalOutcome,
      entry.txHash,
      entry.error,
    );
  }

  getRecent(limit: number = 10): AuditEntry[] {
    const stmt = this.db.prepare(`
      SELECT id, timestamp, service_url as serviceUrl, amount, amount_usd as amountUSD,
        token, category, policy_decision as policyDecision, policy_reason as policyReason,
        human_decision as humanDecision, final_outcome as finalOutcome, tx_hash as txHash, error
      FROM audit_log ORDER BY timestamp DESC LIMIT ?
    `);
    return stmt.all(limit) as AuditEntry[];
  }

  /** Load paid entries for spending ledger initialization */
  getPaidEntriesForWindow(windowSeconds: number): LedgerEntry[] {
    const cutoff = new Date(Date.now() - windowSeconds * 1000).toISOString();
    const stmt = this.db.prepare(`
      SELECT id,
        amount_usd as amountUSD,
        CAST(strftime('%s', timestamp) AS INTEGER) as timestamp
      FROM audit_log 
      WHERE final_outcome = 'paid' AND timestamp >= ?
      ORDER BY timestamp ASC
    `);
    return stmt.all(cutoff) as LedgerEntry[];
  }

  close(): void {
    this.db.close();
  }
}
