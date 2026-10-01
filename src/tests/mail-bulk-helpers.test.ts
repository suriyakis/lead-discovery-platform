// The helpers shared by the /communication and /mailbox/[id] bulk
// actions (src/lib/mail-bulk-actions.ts). Pure functions, no database;
// the actions themselves are covered by mailbox-bulk-actions.test.ts and
// communication.test.ts.

import { describe, expect, it } from 'vitest';
import { affectedNote, parseSelectedIds, retrySummary } from '@/lib/mail-bulk-actions';

function idsForm(values: string[]): FormData {
  const fd = new FormData();
  for (const v of values) fd.append('ids', v);
  return fd;
}

describe('parseSelectedIds', () => {
  it('keeps plain positive integers, in order, and ignores the rest', () => {
    expect(parseSelectedIds(idsForm(['3', 'x', '12', '-1', '1.5', '', ' 4', '9007199254740993']))).toEqual([
      3n,
      12n,
      9007199254740993n,
    ]);
  });

  it('is empty when nothing is ticked', () => {
    expect(parseSelectedIds(new FormData())).toEqual([]);
  });
});

describe('affectedNote', () => {
  it('reads naturally for none, one and many', () => {
    expect(affectedNote('moved to trash', 0)).toBe(
      'No messages moved to trash (nothing was selected or eligible).',
    );
    expect(affectedNote('restored', 1)).toBe('1 message restored.');
    expect(affectedNote('flagged as spam', 4)).toBe('4 messages flagged as spam.');
  });
});

describe('retrySummary', () => {
  it('lists every non-empty outcome', () => {
    expect(
      retrySummary({ retried: [1, 2], skippedHardBounce: [3], skippedIneligible: [4], errors: [5] }),
    ).toBe('2 messages resent, 1 hard-bounced (skipped), 1 ineligible, 1 failed.');
    expect(
      retrySummary({ retried: [1], skippedHardBounce: [], skippedIneligible: [], errors: [] }),
    ).toBe('1 message resent.');
  });

  it('says so when there was nothing to retry', () => {
    expect(
      retrySummary({ retried: [], skippedHardBounce: [], skippedIneligible: [], errors: [] }),
    ).toBe('Nothing to retry.');
  });
});
