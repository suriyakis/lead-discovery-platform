// Phase 58 — outer tab bar for the Communication workspace. Two
// destinations:
//   /communication            — Conversations (thread list with status chips)
//   /communication/follow-ups — Follow-ups (auto-scheduled cadence)
//
// Server component (no client interactivity needed beyond the Links).

import Link from 'next/link';
import { MessagesSquare, Timer } from 'lucide-react';

interface CommunicationTabsProps {
  active: 'conversations' | 'follow-ups';
  conversationsCount?: number;
  followUpsPendingCount?: number;
}

export function CommunicationTabs({
  active,
  conversationsCount,
  followUpsPendingCount,
}: CommunicationTabsProps) {
  return (
    <nav
      className="window-tabs"
      style={{ marginBottom: '1rem', gap: '0.4rem' }}
      aria-label="Communication sections"
    >
      <Link
        href="/communication"
        className={`window-tab${active === 'conversations' ? ' window-tab-active' : ''}`}
        title="Threads currently in flight: sent, replied, scheduled, errored"
      >
        <MessagesSquare className="lucide" /> Conversations
        {conversationsCount !== undefined ? (
          <span className="badge">{conversationsCount}</span>
        ) : null}
      </Link>
      <Link
        href="/communication/follow-ups"
        className={`window-tab${active === 'follow-ups' ? ' window-tab-active' : ''}`}
        title="Auto-scheduled follow-ups (3 polite pings, weekly)"
      >
        <Timer className="lucide" /> Follow-ups
        {followUpsPendingCount !== undefined ? (
          <span className="badge">{followUpsPendingCount}</span>
        ) : null}
      </Link>
    </nav>
  );
}
