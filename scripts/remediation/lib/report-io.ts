// Pure helpers shared by remediation scripts (flow:F-06): canonical hashing,
// batch ids, a small RFC 4180 CSV reader/writer, address masking and
// private report files. No database access here.

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export class RemediationError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'RemediationError';
    this.code = code;
  }
}

// ---- hashing -------------------------------------------------------------

/** JSON with object keys sorted at every level; bigint → decimal string. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// ---- batch ids -------------------------------------------------------------

const BATCH_ID_RE = /^[a-z0-9-]+\.[a-z0-9-]+\.\d{8}T\d{6}Z\.[a-f0-9]{6}$/;

/** e.g. `2026-10-funnel.mail.20261001T120000Z.ab12cd`. */
export function newBatchId(script: string, module: string, now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return `${script}.${module}.${stamp}.${randomBytes(3).toString('hex')}`;
}

export function isBatchId(value: string): boolean {
  return BATCH_ID_RE.test(value);
}

// ---- database target -----------------------------------------------------------

/** Host and database name of a postgres URL — never the credentials. */
export function databaseTarget(url: string | undefined = process.env.DATABASE_URL): {
  host: string;
  name: string;
} {
  if (!url) throw new RemediationError('DATABASE_URL is not set', 'no_database');
  const parsed = new URL(url);
  return {
    host: `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`,
    name: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
  };
}

// ---- privacy ---------------------------------------------------------------

const ADDRESS_RE = /[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+/g;

/** Replace every e-mail address in free text (e.g. a stored SMTP error). */
export function maskAddresses(text: string): string {
  return text.replace(ADDRESS_RE, '<address>');
}

// ---- CSV (RFC 4180) ---------------------------------------------------------------

export function formatCsv(
  header: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<string>>,
): string {
  const line = (cells: ReadonlyArray<string>) => cells.map(csvCell).join(',');
  return [line(header), ...rows.map(line)].join('\r\n') + '\r\n';
}

function csvCell(value: string): string {
  // A leading = + - @ would be evaluated as a formula by spreadsheet apps
  // the owner may open the file in; prefix it so it stays text.
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** The separator of a CSV file: ',' unless its first line only has ';'
 *  (spreadsheet apps save with ';' in locales that use a decimal comma). */
export function detectDelimiter(text: string): ',' | ';' {
  const first = text.replace(/^﻿/, '').split(/\r?\n/, 1)[0] ?? '';
  return first.includes(';') && !first.includes(',') ? ';' : ',';
}

/** Parse CSV text into rows of cells. Handles quotes, escaped quotes and
 *  CRLF / LF line ends; ignores a UTF-8 BOM and blank lines. */
export function parseCsv(text: string, delimiter: ',' | ';' = detectDelimiter(text)): string[][] {
  const src = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((c) => c.length > 0)) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (inQuotes) throw new RemediationError('CSV ends inside a quoted cell', 'invalid_csv');
  row.push(cell);
  if (row.some((c) => c.length > 0)) rows.push(row);
  return rows;
}

/** Undo csvCell's formula guard. */
export function unguardCell(value: string): string {
  return /^'[=+\-@]/.test(value) ? value.slice(1) : value;
}

// ---- report files ------------------------------------------------------------

/**
 * Write a report file readable by the current user only: reports carry
 * addresses (personal data) and must never be committed — the default
 * output folder, remediation-reports/, is git-ignored.
 */
export function writePrivateFile(dir: string, name: string, content: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, name);
  writeFileSync(file, content, { encoding: 'utf8', mode: 0o600 });
  return file;
}

/** Markdown table cell: escape pipes, flatten new lines. */
export function mdCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '–';
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
