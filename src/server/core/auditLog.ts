/**
 * Persistent audit trail for the legacy simulation/trading paths in server.ts.
 * Extracted structurally only — same file path, same append-only JSONL format,
 * same callers (trade execution, chaos-mode config changes, etc.).
 */
import fs from "fs";
import path from "path";

export const AUDIT_LOG_FILE = path.join(process.cwd(), "data", "audit_trail.jsonl");

/**
 * Appends a single audit record to the audit trail file as one JSON line,
 * stamping it with the current timestamp.
 * @param entry - The audit record containing action, timestamp, and details.
 */
export function auditLog(entry: Record<string, unknown>): void {
  const logEntry = JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + "\n";
  fs.mkdirSync(path.dirname(AUDIT_LOG_FILE), { recursive: true });
  fs.appendFileSync(AUDIT_LOG_FILE, logEntry);
}
