// PC-05: form parsing for the pause / undo / resume controls. A plain
// module (no 'use server'), so the server actions, the control component
// and the tests can share it.

import type { PauseDevice, PauseSource } from '@/lib/services/automation-pause';

/** Pages that host the pause control (Wave 1: the two places that used to
 *  carry an Emergency pause checkbox). Anything else returns to /autopilot. */
export const PAUSE_CONTROL_PAGES = ['/autopilot', '/mailbox/queue'] as const;
export type PauseControlPage = (typeof PAUSE_CONTROL_PAGES)[number];

export function parsePauseReturnTo(raw: unknown): PauseControlPage {
  const s = typeof raw === 'string' ? raw : '';
  return (PAUSE_CONTROL_PAGES as readonly string[]).includes(s)
    ? (s as PauseControlPage)
    : '/autopilot';
}

/** The audited source of a control on `page`. */
export function pauseSourceFor(page: PauseControlPage): PauseSource {
  return page === '/mailbox/queue' ? 'send_queue_page' : 'autopilot_page';
}

/** Coarse device class from a User-Agent, for the audit row (MOB-07:
 *  pause and resume record the device). */
export function deviceFromUserAgent(ua: string | null | undefined): PauseDevice {
  if (!ua) return 'unknown';
  if (/iPad|Tablet/i.test(ua)) return 'tablet';
  if (/Mobi|Android|iPhone/i.test(ua)) return 'mobile';
  return 'desktop';
}

/** The optional reason field; blank = none. */
export function parsePauseReason(raw: unknown): string | undefined {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return s ? s : undefined;
}
