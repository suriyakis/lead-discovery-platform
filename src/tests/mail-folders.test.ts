import { describe, expect, it } from 'vitest';
import type { MailMessage } from '@/lib/db/schema/mailing';
import {
  MAIL_FOLDERS,
  deriveFolder,
  type FolderInputs,
} from '@/lib/services/mail-folders';

const ALL_STATUSES: Array<MailMessage['status']> = [
  'queued',
  'sending',
  'sent',
  'delivered',
  'bounced',
  'failed',
  'received',
];

const ALL_DIRECTIONS: Array<MailMessage['direction']> = ['outbound', 'inbound'];

const NOW = new Date('2026-05-19T12:00:00Z');

function build(overrides: Partial<FolderInputs>): FolderInputs {
  return {
    direction: 'outbound',
    status: 'sent',
    trashedAt: null,
    spamAt: null,
    ...overrides,
  };
}

describe('deriveFolder', () => {
  describe('priority order', () => {
    it('trashed wins over everything (even spam + errors)', () => {
      expect(
        deriveFolder(
          build({ trashedAt: NOW, spamAt: NOW, status: 'failed' }),
        ),
      ).toBe('trash');
    });

    it('spam wins over error + status when not trashed', () => {
      expect(
        deriveFolder(build({ spamAt: NOW, status: 'bounced' })),
      ).toBe('spam');
    });

    it('error wins over queued when not trashed/spammed', () => {
      // status alone is one slot — failed > queued because we pick the
      // first matching folder in deriveFolder's priority chain. A message
      // can only have one status, so this is a sanity check on the
      // bucket boundary.
      expect(deriveFolder(build({ status: 'failed' }))).toBe('errors');
      expect(deriveFolder(build({ status: 'bounced' }))).toBe('errors');
    });
  });

  describe('inbound bucketing', () => {
    it('inbound received → inbox', () => {
      expect(
        deriveFolder(build({ direction: 'inbound', status: 'received' })),
      ).toBe('inbox');
    });

    it('inbound failed → errors (rare but possible)', () => {
      expect(
        deriveFolder(build({ direction: 'inbound', status: 'failed' })),
      ).toBe('errors');
    });

    it('inbound trashed → trash regardless of status', () => {
      expect(
        deriveFolder(
          build({ direction: 'inbound', status: 'received', trashedAt: NOW }),
        ),
      ).toBe('trash');
    });
  });

  describe('outbound bucketing', () => {
    it('outbound queued → queued', () => {
      expect(deriveFolder(build({ status: 'queued' }))).toBe('queued');
    });

    it('outbound sending → queued (in-flight is still "queued" from the operator POV)', () => {
      expect(deriveFolder(build({ status: 'sending' }))).toBe('queued');
    });

    it('outbound sent → sent', () => {
      expect(deriveFolder(build({ status: 'sent' }))).toBe('sent');
    });

    it('outbound delivered → sent', () => {
      expect(deriveFolder(build({ status: 'delivered' }))).toBe('sent');
    });

    it('outbound failed → errors', () => {
      expect(deriveFolder(build({ status: 'failed' }))).toBe('errors');
    });

    it('outbound bounced → errors', () => {
      expect(deriveFolder(build({ status: 'bounced' }))).toBe('errors');
    });
  });

  describe('full matrix', () => {
    it('every (direction × status × trashed × spam) cell resolves to a valid folder', () => {
      for (const direction of ALL_DIRECTIONS) {
        for (const status of ALL_STATUSES) {
          for (const trashedAt of [null, NOW]) {
            for (const spamAt of [null, NOW]) {
              const folder = deriveFolder({
                direction,
                status,
                trashedAt,
                spamAt,
              });
              expect(MAIL_FOLDERS).toContain(folder);
              if (trashedAt) expect(folder).toBe('trash');
              else if (spamAt) expect(folder).toBe('spam');
            }
          }
        }
      }
    });
  });
});
