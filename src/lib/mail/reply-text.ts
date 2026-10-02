// The part of an inbound reply its sender actually wrote (flow:F-01).
//
// Replies quote our message, and our message ends with the unsubscribe
// footer ("Don't want these messages? Unsubscribe: …/api/unsubscribe/…").
// Classifying the whole body therefore read almost every quoted reply as
// an unsubscribe request. Before classification we cut:
//   - everything from the first quote attribution on ("On … wrote:",
//     "-----Original Message-----", an Outlook "From:/Sent:" block, and the
//     PL/DE/FR/IT/ES equivalents);
//   - any remaining '>'-quoted lines (inline answers above them survive);
//   - our own footer lines, wherever they still appear.
// Pure and heuristic: when nothing matches, the body is returned trimmed.

import { allUnsubscribeFooterPrompts } from '@/lib/i18n/email-footer';

/** A single-line quote attribution, checked on a line and on a line joined
 *  with the next one (clients wrap long attributions). */
const ATTRIBUTION_PATTERNS: ReadonlyArray<RegExp> = [
  /^on\b.{0,300}\bwrote:\s*$/i,
  /^am\b.{0,300}\bschrieb\b.{0,300}:\s*$/i,
  /\bnapisał(?:a|\(a\))?:\s*$/i,
  /^le\b.{0,300}\ba écrit\s*:\s*$/i,
  /\bha scritto:\s*$/i,
  /\bescribió:\s*$/i,
];

const SEPARATOR_PATTERN =
  /^\s*-{2,}\s*(?:original message|forwarded message|ursprüngliche nachricht|oryginalna wiadomość|wiadomość oryginalna|message d'origine|messaggio originale|mensaje original)\s*-{2,}\s*$/i;

const HEADER_FROM = /^\s*\*?(?:from|od|von|de|da)\s*:\*?\s+\S/i;
const HEADER_SENT = /^\s*\*?(?:sent|date|wysłano|data|gesendet|datum|envoyé|inviato|enviado)\s*:\*?\s+\S/i;
const UNDERLINE = /^\s*_{10,}\s*$/;

/** Path of our one-click unsubscribe URL (mail.ts → /api/unsubscribe/<token>). */
const OUR_UNSUBSCRIBE_PATH = '/api/unsubscribe/';

function isOutlookHeaderBlock(lines: ReadonlyArray<string>, i: number): boolean {
  if (!HEADER_FROM.test(lines[i] ?? '')) return false;
  for (let j = i + 1; j <= i + 3 && j < lines.length; j++) {
    if (HEADER_SENT.test(lines[j] ?? '')) return true;
  }
  return false;
}

function quoteBoundary(lines: ReadonlyArray<string>): number {
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (!line) continue;
    const joined = `${line} ${(lines[i + 1] ?? '').trim()}`.trim();
    if (ATTRIBUTION_PATTERNS.some((re) => re.test(line) || re.test(joined))) return i;
    if (SEPARATOR_PATTERN.test(line)) return i;
    if (isOutlookHeaderBlock(lines, i)) return i;
    if (UNDERLINE.test(line)) {
      let j = i + 1;
      while (j < lines.length && !(lines[j] ?? '').trim()) j++;
      if (isOutlookHeaderBlock(lines, j)) return i;
    }
  }
  return lines.length;
}

/**
 * The sender's own words: quoted history and our footer removed. Returns
 * '' when nothing is left (e.g. a reply that only quotes).
 */
export function extractReplyText(body: string | null | undefined): string {
  if (!body) return '';
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const kept = lines.slice(0, quoteBoundary(lines));
  const prompts = allUnsubscribeFooterPrompts().map((p) => p.toLowerCase());

  const out: string[] = [];
  for (const raw of kept) {
    const line = raw.trim();
    if (line.startsWith('>')) continue;
    const lower = line.toLowerCase();
    if (lower.includes(OUR_UNSUBSCRIBE_PATH) || prompts.some((p) => lower.startsWith(p))) {
      // Our footer is "---\n<prompt> <url>": drop the rule above it too.
      while (out.length > 0 && /^-{2,3}$/.test((out[out.length - 1] ?? '').trim())) out.pop();
      continue;
    }
    out.push(raw);
  }
  return out.join('\n').trim();
}
