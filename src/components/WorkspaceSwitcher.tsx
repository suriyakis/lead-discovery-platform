'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { setActiveWorkspaceAction } from '@/lib/workspace-actions';

export interface WorkspaceSwitcherProps {
  workspaces: ReadonlyArray<{
    id: string;
    name: string;
    slug: string;
    role: string;
    isActive: boolean;
    isArchived: boolean;
    isDefault: boolean;
    /** Phase 29: row exists because viewer is super-admin, not because they're a member. */
    isGodMode: boolean;
  }>;
}

/**
 * Header dropdown listing every workspace the signed-in user can reach.
 *
 * For super-admins the list is split:
 *   - "Member of"        — workspaces they're an actual member of
 *   - "God mode (other)" — every other workspace; entering audit-logs
 *
 * Picking another workspace calls the server action and refreshes the
 * route so subsequent server components resolve the new context.
 */
export function WorkspaceSwitcher({ workspaces }: Readonly<WorkspaceSwitcherProps>) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const active = workspaces.find((w) => w.isActive) ?? workspaces[0];
  if (!active) return null;

  const memberships = workspaces.filter((w) => !w.isGodMode);
  const godMode = workspaces.filter((w) => w.isGodMode);

  const handleChange = (id: string) => {
    if (id === active.id) return;
    const target = workspaces.find((w) => w.id === id);
    if (
      target?.isGodMode &&
      !confirm(
        `Switch into ${target.name} as super-admin? The switch is audit-logged in that workspace.`,
      )
    ) {
      return;
    }
    startTransition(async () => {
      await setActiveWorkspaceAction(id);
      router.refresh();
    });
  };

  const optionLabel = (w: WorkspaceSwitcherProps['workspaces'][number]) =>
    `${w.name}${w.isArchived ? ' (archived)' : ''}${w.isDefault ? ' • default' : ''} — ${w.role}`;

  return (
    <label
      className={
        active.isGodMode
          ? 'workspace-switcher workspace-switcher-god'
          : 'workspace-switcher'
      }
      title={active.isGodMode ? 'God-mode: not a member' : 'Switch workspace'}
    >
      <span className="workspace-switcher-icon" aria-hidden="true">
        {active.isGodMode ? '👁' : '🏢'}
      </span>
      <select
        value={active.id}
        onChange={(e) => handleChange(e.target.value)}
        disabled={isPending}
      >
        {memberships.length > 0 ? (
          <optgroup label="Member of">
            {memberships.map((w) => (
              <option key={w.id} value={w.id}>
                {optionLabel(w)}
              </option>
            ))}
          </optgroup>
        ) : null}
        {godMode.length > 0 ? (
          <optgroup label="God mode (other workspaces)">
            {godMode.map((w) => (
              <option key={w.id} value={w.id}>
                {optionLabel(w)}
              </option>
            ))}
          </optgroup>
        ) : null}
      </select>
    </label>
  );
}
