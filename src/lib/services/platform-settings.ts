// Platform-wide provider/model defaults, managed by super-admins from
// /admin/providers. Non-secret twin of platform_secrets: WHICH vendor and
// model each capability runs on when a workspace hasn't picked its own.
//
// Resolution everywhere: workspace setting → platform setting (this
// service) → env var → auto-detected system default.

import { eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { platformSettings } from '@/lib/db/schema/platform-settings';
import { recordPlatformAuditEvent } from './audit';
import { isSuperAdmin, type WorkspaceContext } from './context';
import {
  ALLOWED_AI_PROVIDERS,
  ALLOWED_EMBEDDING_PROVIDERS,
  ALLOWED_RESEARCH_PROVIDERS,
  ALLOWED_SEARCH_PROVIDERS,
  ALLOWED_VECTOR_STORAGE_PROVIDERS,
  isValidAiModel,
} from './provider-settings';

export class PlatformSettingsError extends Error {
  public readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'PlatformSettingsError';
    this.code = code;
  }
}

const denied = (op: string) =>
  new PlatformSettingsError(`Permission denied: ${op}`, 'permission_denied');
const invalid = (msg: string) => new PlatformSettingsError(msg, 'invalid_input');

/** Every key the console may write, with its validator. */
const KEY_VALIDATORS: Record<string, (v: string) => boolean> = {
  'ai.provider': (v) =>
    (ALLOWED_AI_PROVIDERS as readonly string[]).includes(v) && v !== 'mock',
  'ai.model': (v) => isValidAiModel('any', v),
  'embedding.provider': (v) =>
    (ALLOWED_EMBEDDING_PROVIDERS as readonly string[]).includes(v) && v !== 'mock',
  'research.provider': (v) =>
    (ALLOWED_RESEARCH_PROVIDERS as readonly string[]).includes(v) && v !== 'mock',
  'research.model': (v) => isValidAiModel('any', v),
  'search.provider': (v) =>
    (ALLOWED_SEARCH_PROVIDERS as readonly string[]).includes(v) && v !== 'mock',
  'vector_storage.provider': (v) =>
    (ALLOWED_VECTOR_STORAGE_PROVIDERS as readonly string[]).includes(v) &&
    v !== 'mock',
};

export const PLATFORM_SETTING_KEYS = Object.keys(KEY_VALIDATORS);

export type PlatformSettingsMap = Partial<Record<string, string>>;

/** All platform settings in one query. Values are trimmed, never empty. */
export async function getPlatformSettings(): Promise<PlatformSettingsMap> {
  const rows = await db
    .select({ key: platformSettings.key, value: platformSettings.value })
    .from(platformSettings)
    .where(inArray(platformSettings.key, PLATFORM_SETTING_KEYS));
  const map: PlatformSettingsMap = {};
  for (const r of rows) {
    const v = r.value.trim();
    if (v) map[r.key] = v;
  }
  return map;
}

/** Single-key convenience for the provider factories. */
export async function getPlatformSetting(key: string): Promise<string | null> {
  const rows = await db
    .select({ value: platformSettings.value })
    .from(platformSettings)
    .where(eq(platformSettings.key, key))
    .limit(1);
  const v = rows[0]?.value.trim();
  return v || null;
}

/**
 * Super-admin write. `null` deletes the key (resolution falls through to
 * env / auto-detect); omitted keys are untouched. Values validated per key.
 */
export async function setPlatformSettings(
  ctx: WorkspaceContext,
  patch: Record<string, string | null>,
): Promise<void> {
  if (!isSuperAdmin(ctx)) throw denied('platform_settings.update');

  const applied: Record<string, string | null> = {};
  for (const [key, raw] of Object.entries(patch)) {
    const validator = KEY_VALIDATORS[key];
    if (!validator) throw invalid(`unknown platform setting: ${key}`);
    if (raw === null || raw.trim() === '') {
      await db.delete(platformSettings).where(eq(platformSettings.key, key));
      applied[key] = null;
      continue;
    }
    const value = raw.trim();
    if (!validator(value)) throw invalid(`invalid value for ${key}: ${value}`);
    await db
      .insert(platformSettings)
      .values({ key, value, updatedByUserId: ctx.userId })
      .onConflictDoUpdate({
        target: platformSettings.key,
        set: { value, updatedByUserId: ctx.userId, updatedAt: new Date() },
      });
    applied[key] = value;
  }

  if (Object.keys(applied).length > 0) {
    await recordPlatformAuditEvent(ctx.userId, {
      kind: 'platform_settings.update',
      entityType: 'platform_settings',
      entityId: null,
      payload: applied,
    });
  }
}
