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
  }>;
}

/**
 * Header dropdown that lists every workspace the signed-in user can
 * reach. Picking another one calls the server action and refreshes the
 * route so subsequent server components resolve the new context.
 */
export function WorkspaceSwitcher({ workspaces }: Readonly<WorkspaceSwitcherProps>) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const active = workspaces.find((w) => w.isActive) ?? workspaces[0];
  if (!active) return null;

  const handleChange = (id: string) => {
    if (id === active.id) return;
    startTransition(async () => {
      await setActiveWorkspaceAction(id);
      router.refresh();
    });
  };

  return (
    <label className="workspace-switcher" title="Switch workspace">
      <span className="workspace-switcher-icon" aria-hidden="true">
        🏢
      </span>
      <select
        value={active.id}
        onChange={(e) => handleChange(e.target.value)}
        disabled={isPending}
      >
        {workspaces.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
            {w.isArchived ? ' (archived)' : ''}
            {w.isDefault ? ' • default' : ''}
            {' — '}
            {w.role}
          </option>
        ))}
      </select>
    </label>
  );
}
