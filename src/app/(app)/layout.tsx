// DS-07 (absorbs MOB-03, AP-05a, ia:F-09): the layout of every workspace
// page. The (app) folder is a route group — it adds nothing to the URL —
// so /review, /drafts, /settings/members … keep their addresses, but they
// now share this layout, and Next keeps a layout mounted across client
// navigation. The workspace frame (sidebar, header, banners, Cmd-K, the
// "Ask the platform" assistant) is therefore rendered once per full load
// instead of once per page, and the assistant's conversation survives
// moving between pages (I053).
//
// AppShell decides the frame's state (signed out, waiting for approval, no
// workspace, a workspace) and keeps its numbers live; see
// src/components/AppShell.tsx and src/lib/shell/. Pages are moved here by
// scripts/codemods/app-route-group.mjs, which a branch opened before the
// move re-runs instead of hand-rebasing. /admin keeps its own layout and
// AdminShell; the landing page, /pending and the /dashboard and /inbox
// redirect stubs stay outside the group.

import { AppShell } from '@/components/AppShell';

export default function AppLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <AppShell>{children}</AppShell>;
}
