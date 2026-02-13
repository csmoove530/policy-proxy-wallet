/**
 * In-memory spending ledger that tracks recent transactions.
 * Backed by the SQLite audit log on startup, then kept in sync.
 */
export interface LedgerEntry {
  amountUSD: number;
  timestamp: number; // unix seconds
}

export class SpendingLedger {
  private entries: LedgerEntry[] = [];

  record(amountUSD: number, timestamp?: number): void {
    this.entries.push({
      amountUSD,
      timestamp: timestamp ?? Math.floor(Date.now() / 1000),
    });
  }

  totalSpentInWindow(windowSeconds: number): number {
    const cutoff = Math.floor(Date.now() / 1000) - windowSeconds;
    return this.entries
      .filter((e) => e.timestamp >= cutoff)
      .reduce((sum, e) => sum + e.amountUSD, 0);
  }

  transactionCountInWindow(windowSeconds: number): number {
    const cutoff = Math.floor(Date.now() / 1000) - windowSeconds;
    return this.entries.filter((e) => e.timestamp >= cutoff).length;
  }

  /** Load historical entries (e.g., from audit log on startup) */
  loadHistory(entries: LedgerEntry[]): void {
    this.entries = [...entries, ...this.entries];
  }

  /** Remove a specific record (used when tx fails after pre-recording) */
  removeLastRecord(_id: string, amountUSD: number, timestamp: number): void {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (entry && entry.amountUSD === amountUSD && entry.timestamp === timestamp) {
        this.entries.splice(i, 1);
        return;
      }
    }
  }

  /** Prune entries older than maxAgeSeconds to prevent unbounded growth */
  prune(maxAgeSeconds: number): void {
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeSeconds;
    this.entries = this.entries.filter((e) => e.timestamp >= cutoff);
  }
}
