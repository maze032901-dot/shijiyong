import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function now() {
  return new Date().toISOString();
}

export const MAX_CAPTURE_ATTEMPTS = 3;
const retryDelayMs = (attempts) => Math.min(30 * 60_000, 60_000 * (5 ** Math.max(0, attempts - 1)));
const retryAt = (attempts) => new Date(Date.now() + retryDelayMs(attempts)).toISOString();

export function openIntakeStore(databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS intake_jobs (
      event_id TEXT PRIMARY KEY,
      source_url TEXT NOT NULL,
      trigger TEXT NOT NULL,
      saved_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      aweme_id TEXT,
      result_json TEXT,
      error_type TEXT,
      error_message TEXT,
      last_attempt_at TEXT,
      next_retry_at TEXT,
      manual_retry_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS intake_jobs_status_idx ON intake_jobs(status, created_at);
  `);

  const columns = new Set(db.prepare('PRAGMA table_info(intake_jobs)').all().map((column) => column.name));
  if (!columns.has('last_attempt_at')) db.exec('ALTER TABLE intake_jobs ADD COLUMN last_attempt_at TEXT');
  if (!columns.has('next_retry_at')) db.exec('ALTER TABLE intake_jobs ADD COLUMN next_retry_at TEXT');
  if (!columns.has('manual_retry_at')) db.exec('ALTER TABLE intake_jobs ADD COLUMN manual_retry_at TEXT');

  const list = () => db.prepare(`
    SELECT event_id, source_url, trigger, saved_at, status, attempts, aweme_id,
      result_json, error_type, error_message, last_attempt_at, next_retry_at, manual_retry_at,
      created_at, updated_at
    FROM intake_jobs ORDER BY created_at DESC
  `).all().map(parseRow);

  return {
    enqueue({ eventId, sourceUrl, trigger, savedAt }) {
      const timestamp = now();
      const existing = db.prepare('SELECT * FROM intake_jobs WHERE event_id = ?').get(eventId);
      if (existing) return { created: false, job: parseRow(existing) };
      db.prepare(`
        INSERT INTO intake_jobs (event_id, source_url, trigger, saved_at, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'queued', ?, ?)
      `).run(eventId, sourceUrl, trigger, savedAt, timestamp, timestamp);
      return { created: true, job: this.get(eventId) };
    },
    get(eventId) {
      const row = db.prepare('SELECT * FROM intake_jobs WHERE event_id = ?').get(eventId);
      return row ? parseRow(row) : null;
    },
    takeNextForMac({ excludeEventIds = [], at = now() } = {}) {
      const exclusions = excludeEventIds.filter((id) => typeof id === 'string' && /^[A-Za-z0-9._-]{6,128}$/.test(id)).slice(0, 100);
      const notIn = exclusions.length ? `AND event_id NOT IN (${exclusions.map(() => '?').join(',')})` : '';
      const row = db.prepare(`
        SELECT * FROM intake_jobs
        WHERE (status = 'queued' OR (status = 'retryable' AND attempts < ? AND next_retry_at <= ?)) ${notIn}
        ORDER BY CASE WHEN status = 'queued' THEN 0 ELSE 1 END, created_at ASC LIMIT 1
      `).get(MAX_CAPTURE_ATTEMPTS, at, ...exclusions);
      if (!row) return null;
      db.prepare(`
        UPDATE intake_jobs SET status = 'processing', attempts = attempts + 1,
          last_attempt_at = ?, next_retry_at = NULL, updated_at = ? WHERE event_id = ?
      `).run(now(), now(), row.event_id);
      return this.get(row.event_id);
    },
    saveMacResult(eventId, result) {
      const existing = this.get(eventId);
      if (!existing || existing.status !== 'processing') return null;
      const success = result.status === 'captured' || result.status === 'partial';
      // The server schedules a bounded hand-off back to the Mac; it never
      // downloads or processes Douyin media itself.
      const retryable = !success && result.retryable === true && existing.attempts < MAX_CAPTURE_ATTEMPTS;
      const status = success ? result.status : retryable ? 'retryable' : 'failed';
      db.prepare(`
        UPDATE intake_jobs SET status = ?, aweme_id = ?, result_json = ?, error_type = ?, error_message = ?,
          next_retry_at = ?, updated_at = ?
        WHERE event_id = ?
      `).run(
        status,
        result.aweme_id ?? null,
        JSON.stringify(result),
        result.error_type ?? null,
        result.error ?? null,
        retryable ? retryAt(existing.attempts) : null,
        now(),
        eventId
      );
      return this.get(eventId);
    },
    requeue(eventId, { reason = 'manual' } = {}) {
      const existing = this.get(eventId);
      if (!existing) return null;
      // A successful capture must never be reset by the generic retry button;
      // later stages are resumed by the Mac's local retry queue.
      // The one exception is a capture acknowledged without any usable media:
      // it is a completed metadata response, but there is no asset for the
      // local pipeline.  It must be allowed to restart the capture stage.
      const result = existing.result && typeof existing.result === 'object' ? existing.result : {};
      const manifest = Array.isArray(result.media_manifest) ? result.media_manifest : [];
      const hasUsableMedia = ['video', 'gallery'].includes(result.media_kind) && manifest.length > 0;
      const emptyCapture = ['captured', 'partial'].includes(existing.status) && !hasUsableMedia;
      if (!['retryable', 'failed', 'dismissed'].includes(existing.status) && !emptyCapture) return null;
      db.prepare(`
        UPDATE intake_jobs SET status = 'queued', attempts = 0, aweme_id = NULL, result_json = NULL,
        error_type = NULL, error_message = NULL, last_attempt_at = NULL, next_retry_at = NULL,
          manual_retry_at = ?, updated_at = ?
        WHERE event_id = ?
      `).run(reason === 'manual' ? now() : null, now(), eventId);
      return this.get(eventId);
    },
    dismiss(eventId) {
      const existing = this.get(eventId);
      if (!existing) return null;
      if (existing.status === 'dismissed') return existing;
      db.prepare(`UPDATE intake_jobs SET status = 'dismissed', updated_at = ? WHERE event_id = ?`).run(now(), eventId);
      return this.get(eventId);
    },
    markPublished(eventId) {
      const existing = this.get(eventId);
      if (!existing || existing.status === 'dismissed') return null;
      db.prepare(`UPDATE intake_jobs SET status = 'published', updated_at = ? WHERE event_id = ?`).run(now(), eventId);
      return this.get(eventId);
    },
    recoverInterrupted() {
      for (const row of db.prepare(`SELECT event_id, attempts FROM intake_jobs WHERE status = 'processing'`).all()) {
        const canRetry = row.attempts < MAX_CAPTURE_ATTEMPTS;
        db.prepare(`UPDATE intake_jobs SET status = ?, next_retry_at = ?, updated_at = ? WHERE event_id = ?`)
          .run(canRetry ? 'retryable' : 'failed', canRetry ? retryAt(row.attempts) : null, now(), row.event_id);
      }
    },
    list,
    close() { db.close(); }
  };
}

function parseRow(row) {
  return {
    eventId: row.event_id,
    sourceUrl: row.source_url,
    trigger: row.trigger,
    savedAt: row.saved_at,
    status: row.status,
    attempts: row.attempts,
    awemeId: row.aweme_id,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    errorType: row.error_type,
    error: row.error_message,
    lastAttemptAt: row.last_attempt_at,
    nextRetryAt: row.next_retry_at,
    manualRetryAt: row.manual_retry_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
