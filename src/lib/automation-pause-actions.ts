'use server';

// PC-05: server actions behind the pause control (AutomationPauseControl).
// Module scope (never closures over a page), each resolving the context
// outside its try block and redirecting back to the page it came from
// with a flash; NEXT_REDIRECT is re-thrown by describeActionError.

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { requireActionContext } from '@/lib/action-context';
import { describeActionError, withFlash } from '@/lib/action-errors';
import {
  AutomationPauseError,
  pauseAutomation,
  resumeAutomation,
  undoPause,
} from '@/lib/services/automation-pause';
import {
  deviceFromUserAgent,
  parsePauseReason,
  parsePauseReturnTo,
  pauseSourceFor,
} from '@/lib/automation-pause-form';

const MESSAGES = {
  permission_denied: 'Your role cannot do that here. Owners and admins resume automation.',
  too_late: 'Too late to undo (the undo lasts 10 seconds). An owner or admin can resume.',
  not_paused: 'Automation is not paused.',
} as const;

async function device() {
  const h = await headers();
  return deviceFromUserAgent(h.get('user-agent'));
}

export async function pauseAutomationAction(formData: FormData): Promise<void> {
  const page = parsePauseReturnTo(formData.get('returnTo'));
  const ctx = await requireActionContext();
  let flash: { message?: string; error?: string };
  try {
    const r = await pauseAutomation(ctx, {
      reason: parsePauseReason(formData.get('reason')),
      source: pauseSourceFor(page),
      device: await device(),
    });
    flash = {
      message: r.alreadyPaused
        ? 'Automation was already paused.'
        : 'Automation paused: nothing is sent, composed or run automatically until an owner or admin resumes it. You can undo for 10 seconds.',
    };
  } catch (err) {
    flash = { error: describeActionError(err, [AutomationPauseError], MESSAGES).message };
  }
  redirect(withFlash(`${page}#pause`, flash));
}

export async function undoPauseAction(formData: FormData): Promise<void> {
  const page = parsePauseReturnTo(formData.get('returnTo'));
  const ctx = await requireActionContext();
  let flash: { message?: string; error?: string };
  try {
    await undoPause(ctx, { device: await device() });
    flash = { message: 'Pause undone: automation runs again.' };
  } catch (err) {
    flash = { error: describeActionError(err, [AutomationPauseError], MESSAGES).message };
  }
  redirect(withFlash(`${page}#pause`, flash));
}

export async function resumeAutomationAction(formData: FormData): Promise<void> {
  const page = parsePauseReturnTo(formData.get('returnTo'));
  const ctx = await requireActionContext();
  let flash: { message?: string; error?: string };
  try {
    const r = await resumeAutomation(ctx, {
      reason: parsePauseReason(formData.get('reason')),
      source: pauseSourceFor(page),
      device: await device(),
    });
    flash = {
      message: !r.wasPaused
        ? 'Automation was not paused.'
        : r.heldInboundActions > 0
          ? `Automation resumed. ${r.heldInboundActions} reply auto-action${r.heldInboundActions === 1 ? '' : 's'} waited while paused and ${r.heldInboundActions === 1 ? 'was' : 'were'} not applied — check those replies yourself.`
          : 'Automation resumed.',
    };
  } catch (err) {
    flash = { error: describeActionError(err, [AutomationPauseError], MESSAGES).message };
  }
  redirect(withFlash(`${page}#pause`, flash));
}
