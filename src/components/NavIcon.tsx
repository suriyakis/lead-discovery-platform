// Lucide components for the registry's icon names (src/lib/nav/registry.ts
// keeps names, not components, so it stays importable without React).
// Typed as a full Record: a name added to NavIconName without a component
// here fails the typecheck.

import {
  BookOpen,
  CirclePlus,
  Crown,
  House,
  KanbanSquare,
  LifeBuoy,
  ListChecks,
  type LucideIcon,
  MessagesSquare,
  OctagonAlert,
  PackagePlus,
  Radar,
  Send,
  Settings,
  UserPlus,
} from 'lucide-react';
import type { NavIconName } from '@/lib/nav/registry';

export const NAV_ICONS: Readonly<Record<NavIconName, LucideIcon>> = {
  House,
  ListChecks,
  KanbanSquare,
  Send,
  MessagesSquare,
  Radar,
  BookOpen,
  Settings,
  Crown,
  LifeBuoy,
  OctagonAlert,
  UserPlus,
  PackagePlus,
  CirclePlus,
};

export function NavIcon({ name, className }: Readonly<{ name: NavIconName; className?: string }>) {
  const Icon = NAV_ICONS[name];
  return <Icon className={className} aria-hidden="true" />;
}
