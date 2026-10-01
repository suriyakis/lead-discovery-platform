// DS-04 backstops: the typed action-error helper every hardened form
// action relies on. Pure — no database.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { notFound, redirect } from 'next/navigation';
import {
  DEFAULT_ACTION_MESSAGES,
  FALLBACK_ACTION_MESSAGE,
  MAX_FLASH_LENGTH,
  describeActionError,
  flashText,
  withFlash,
} from '@/lib/action-errors';
import { isNextRedirectError } from '@/lib/server-redirect';
import { ReviewServiceError } from '@/lib/services/review';
import { OutreachServiceError } from '@/lib/services/outreach';
import { TokenError } from '@/lib/services/token-ledger';

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected the function to throw');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isNextRedirectError', () => {
  it('recognises redirect() and Next 15 notFound() control-flow throws', () => {
    expect(isNextRedirectError(thrown(() => redirect('/x')))).toBe(true);
    // Next 15 notFound() digest is NEXT_HTTP_ERROR_FALLBACK;404 — the old
    // NEXT_NOT_FOUND check missed it, so catch blocks swallowed 404s.
    expect(isNextRedirectError(thrown(() => notFound()))).toBe(true);
    expect(isNextRedirectError({ digest: 'NEXT_NOT_FOUND' })).toBe(true);
  });

  it('ignores ordinary errors', () => {
    expect(isNextRedirectError(new Error('boom'))).toBe(false);
    expect(isNextRedirectError({ digest: 'DYNAMIC_SERVER_USAGE' })).toBe(false);
    expect(isNextRedirectError(null)).toBe(false);
  });
});

describe('describeActionError', () => {
  it('rethrows Next redirect and notFound throws untouched', () => {
    const r = thrown(() => redirect('/somewhere'));
    expect(thrown(() => describeActionError(r, [ReviewServiceError]))).toBe(r);
    const nf = thrown(() => notFound());
    expect(thrown(() => describeActionError(nf, [ReviewServiceError]))).toBe(nf);
  });

  it('rethrows errors it was not told to expect (they belong to error.tsx)', () => {
    const plain = new Error('connection terminated unexpectedly');
    expect(thrown(() => describeActionError(plain, [ReviewServiceError]))).toBe(plain);
    // A service error of a class the action did not list is also unexpected.
    const other = new OutreachServiceError('Permission denied: x', 'permission_denied');
    expect(thrown(() => describeActionError(other, [ReviewServiceError]))).toBe(other);
    // Duck-typed `code` (e.g. a pg error '23505') is not enough.
    const pgLike = Object.assign(new Error('duplicate key value'), { code: '23505' });
    expect(thrown(() => describeActionError(pgLike, [ReviewServiceError]))).toBe(pgLike);
    expect(thrown(() => describeActionError('string thrown', [ReviewServiceError]))).toBe(
      'string thrown',
    );
  });

  it('phrases permission, token, not-found and conflict codes for people, not as raw codes', () => {
    const perm = describeActionError(
      new ReviewServiceError('Permission denied: set review state -> approved', 'permission_denied'),
      [ReviewServiceError],
    );
    expect(perm).toEqual({
      code: 'permission_denied',
      message: DEFAULT_ACTION_MESSAGES.permission_denied,
    });
    expect(perm.message).not.toMatch(/permission_denied|->/);

    const tokens = describeActionError(
      new TokenError('No tokens left — buy a token pack in Settings → Billing to continue.', 'insufficient_tokens'),
      [OutreachServiceError, TokenError],
    );
    expect(tokens.code).toBe('insufficient_tokens');
    expect(tokens.message).toMatch(/buy a token pack/);

    expect(
      describeActionError(new ReviewServiceError('review_item not found', 'not_found'), [
        ReviewServiceError,
      ]).message,
    ).toBe(DEFAULT_ACTION_MESSAGES.not_found);
    expect(
      describeActionError(new ReviewServiceError("terminal state 'archived'", 'conflict'), [
        ReviewServiceError,
      ]).message,
    ).toBe(DEFAULT_ACTION_MESSAGES.conflict);
  });

  it('lets the action override the wording per code', () => {
    const r = describeActionError(
      new ReviewServiceError("review item is in terminal state 'archived'", 'conflict'),
      [ReviewServiceError],
      { conflict: 'This item was archived in the meantime.' },
    );
    expect(r).toEqual({ code: 'conflict', message: 'This item was archived in the meantime.' });
  });

  it('normalises the forbidden alias to permission_denied', () => {
    const r = describeActionError(new ReviewServiceError('nope', 'forbidden'), [ReviewServiceError]);
    expect(r.code).toBe('permission_denied');
    expect(r.message).toBe(DEFAULT_ACTION_MESSAGES.permission_denied);
  });

  it('shows invalid_input messages as a tidy sentence', () => {
    const r = describeActionError(
      new OutreachServiceError('product profile is archived', 'invalid_input'),
      [OutreachServiceError],
    );
    expect(r).toEqual({ code: 'invalid_input', message: 'Product profile is archived.' });
    const long = describeActionError(
      new ReviewServiceError('x'.repeat(1000), 'invalid_input'),
      [ReviewServiceError],
    );
    expect(long.message.length).toBeLessThanOrEqual(MAX_FLASH_LENGTH);
  });

  it('hides unknown codes behind a generic sentence and logs the detail', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = describeActionError(
      new ReviewServiceError('review_items update returned no row', 'invariant_violation'),
      [ReviewServiceError],
    );
    expect(r).toEqual({ code: 'invariant_violation', message: FALLBACK_ACTION_MESSAGE });
    expect(r.message).not.toMatch(/review_items/);
    expect(spy).toHaveBeenCalledOnce();
  });
});

describe('withFlash / flashText', () => {
  it('adds encoded flash params and keeps existing query and hash', () => {
    expect(withFlash('/review/7', { error: 'No tokens left — buy a pack & retry' })).toBe(
      '/review/7?error=No+tokens+left+%E2%80%94+buy+a+pack+%26+retry',
    );
    expect(withFlash('/admin/workspaces/3?tab=x#feature-flags', { message: 'Done.' })).toBe(
      '/admin/workspaces/3?tab=x&message=Done.#feature-flags',
    );
    expect(withFlash('/review', {})).toBe('/review');
    // Round-trips through URLSearchParams the way Next parses searchParams.
    const url = withFlash('/r', { message: 'a+b c', error: 'ünï' });
    const sp = new URLSearchParams(url.split('?')[1]);
    expect(sp.get('message')).toBe('a+b c');
    expect(sp.get('error')).toBe('ünï');
  });

  it('clamps very long flash text', () => {
    const url = withFlash('/r', { error: 'y'.repeat(5000) });
    const sp = new URLSearchParams(url.split('?')[1]);
    expect(sp.get('error')!.length).toBe(MAX_FLASH_LENGTH);
  });

  it('flashText accepts only non-empty strings', () => {
    expect(flashText('  Saved.  ')).toBe('Saved.');
    expect(flashText('')).toBeNull();
    expect(flashText(['a', 'b'])).toBeNull();
    expect(flashText(undefined)).toBeNull();
  });
});
