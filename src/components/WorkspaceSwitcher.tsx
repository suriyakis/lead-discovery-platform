'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Building2, Eye } from 'lucide-react';
import { setActiveWorkspaceAction } from '@/lib/workspace-actions';
import { Select } from './ui/Select';

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
 *
 * The icon says which kind of seat the active one is: a building for a
 * membership, an eye for god mode (Lucide, DS-08).
 *
 * With no active row (the bare frame of a super-admin who has no
 * workspace of their own yet, DS-07) the control opens on a "Choose a
 * workspace…" placeholder instead of pretending the first row is active.
 */
export function WorkspaceSwitcher({ workspaces }: Readonly<WorkspaceSwitcherProps>) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  if (workspaces.length === 0) return null;
  const active = workspaces.find((w) => w.isActive) ?? null;

  const memberships = workspaces.filter((w) => !w.isGodMode);
  const godMode = workspaces.filter((w) => w.isGodMode);

  const handleChange = (id: string) => {
    if (!id || id === active?.id) return;
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

  // God-mode rows carry role='super_admin' internally, but that's the
  // viewer's PLATFORM privilege, not a role held in the workspace — the
  // label says "god mode" so it can't be misread as a membership.
  const optionLabel = (w: WorkspaceSwitcherProps['workspaces'][number]) =>
    `${w.name}${w.isArchived ? ' (archived)' : ''}${w.isDefault ? ' • default' : ''} — ${
      w.isGodMode ? 'god mode' : w.role
    }`;

  return (
    <label
      className={
        active?.isGodMode
          ? 'workspace-switcher workspace-switcher-god'
          : 'workspace-switcher'
      }
      title={active?.isGodMode ? 'God-mode: not a member' : 'Switch workspace'}
    >
      <span className="workspace-switcher-icon" aria-hidden="true">
        {active?.isGodMode ? (
          <Eye className="lucide" data-icon="god-mode" />
        ) : (
          <Building2 className="lucide" data-icon="workspace" />
        )}
      </span>
      {/* The pill draws the box; the select is the plain, small control
          inside it (DS-10), named for screen readers (the icon is not). */}
      <Select
        variant="plain"
        size="sm"
        aria-label="Workspace"
        value={active?.id ?? ''}
        onChange={(e) => handleChange(e.target.value)}
        disabled={isPending}
        aria-busy={isPending || undefined}
      >
        {active ? null : (
          <option value="" disabled>
            Choose a workspace…
          </option>
        )}
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
      </Select>
    </label>
  );
}
