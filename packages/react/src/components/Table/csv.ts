/**
 * RFC-4180 CSV serialization with formula-injection neutralization.
 *
 * Contract:
 * - records join with CRLF (no trailing record terminator);
 * - a cell is quoted iff its text contains a double quote, comma, CR, or
 * LF; embedded double quotes double;
 * - NEUTRALIZATION (default on): a NON-NUMERIC cell whose text begins with
 * `=`, `+`, `-`, `@`, TAB, or CR gets a leading apostrophe — attr values
 * are untrusted and must never export as live spreadsheet
 * formulas. Cells whose RAW value is a finite number are exempt and
 * serialize as plain numbers (`-5` stays `-5`). Neutralization runs
 * BEFORE quoting, so a prefixed cell still quotes correctly.
 * - header cells are strings and follow the same rules (attr KEYS are
 * untrusted too).
 *
 * The documented opt-out (`neutralizeFormulas: false`) is for callers
 * exporting legitimate formulas; the default stays safe.
 */

import { cellText } from './model';

const FORMULA_LEADS = '=+-@\t\r';

export function csvCell(value: unknown, neutralize: boolean): string {
  const numericExempt = typeof value === 'number' && Number.isFinite(value);
  let text = cellText(value);
  if (neutralize && !numericExempt && text.length > 0 && FORMULA_LEADS.includes(text[0]!)) {
    text = `'${text}`;
  }
  if (/[",\r\n]/.test(text)) {
    text = `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

export function toCsvString(
  header: readonly string[],
  rows: readonly (readonly unknown[])[],
  neutralize: boolean,
): string {
  const records: string[] = [header.map((h) => csvCell(h, neutralize)).join(',')];
  for (const row of rows) {
    records.push(row.map((cell) => csvCell(cell, neutralize)).join(','));
  }
  return records.join('\r\n');
}
