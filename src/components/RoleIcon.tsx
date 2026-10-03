// One Lucide icon per workspace role (DS-08: the chrome's role emoji
// become icons). Decorative: the role's name always sits beside it.
// Typed as a full Record over the enum, so a new role without an icon
// fails the typecheck.

import { Crown, Eye, type LucideIcon, Shield, Star, User } from 'lucide-react';
import type { WorkspaceMemberRole } from '@/lib/db/schema/workspaces';

export const ROLE_ICONS: Readonly<Record<WorkspaceMemberRole, LucideIcon>> = {
  owner: Crown,
  admin: Shield,
  manager: Star,
  member: User,
  viewer: Eye,
};

export function RoleIcon({ role, className }: Readonly<{ role: string; className?: string }>) {
  if (!Object.hasOwn(ROLE_ICONS, role)) return null;
  const Icon = ROLE_ICONS[role as WorkspaceMemberRole];
  return (
    <Icon
      className={className ? `lucide ${className}` : 'lucide'}
      aria-hidden="true"
      data-role-icon={role}
    />
  );
}
