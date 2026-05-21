'use client';

// P61-14: Gmail-style folder view. Receives a serialised messages list +
// folder context + a bag of server-action references from the page. Owns
// the selection state so we can show "N selected" reactively and gate
// the toolbar buttons on having something checked.

import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  Inbox,
  RotateCw,
  Send,
  ShieldAlert,
  Timer,
  Trash2,
} from 'lucide-react';
import type { MailFolder } from '@/lib/services/mail-folders';
import { ConfirmFormButton } from './ConfirmFormButton';

export interface FolderViewRow {
  id: string;
  threadId: string | null;
  subject: string;
  snippet: string;
  direction: 'inbound' | 'outbound';
  peer: string;
  whenIso: string;
  status: string;
  failureReason: string | null;
  spamReason: string | null;
  mailboxName: string | null;
  isHardBounce: boolean;
}

type ServerAction = (formData: FormData) => Promise<void>;

interface Props {
  folder: MailFolder;
  hiddenInputs: { folder: string; q: string; mailboxId: string };
  rows: FolderViewRow[];
  actions: {
    trash: ServerAction;
    spam: ServerAction;
    unspam: ServerAction;
    restore: ServerAction;
    delete: ServerAction;
    retry: ServerAction;
  };
}

export function CommunicationFolderView({
  folder,
  hiddenInputs,
  rows,
  actions,
}: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const allIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const allChecked =
    allIds.length > 0 && allIds.every((id) => selected.has(id));
  const someChecked = !allChecked && selected.size > 0;
  const selectedCount = selected.size;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    if (allChecked) {
      setSelected(new Set());
    } else {
      setSelected(new Set(allIds));
    }
  }

  return (
    <form>
      <input type="hidden" name="folder" value={hiddenInputs.folder} />
      <input type="hidden" name="q" value={hiddenInputs.q} />
      <input
        type="hidden"
        name="mailboxId"
        value={hiddenInputs.mailboxId}
      />

      {/* Sticky toolbar — fades in when selection is non-empty.
          Master checkbox always present so user can select-all in one click. */}
      <div className="mail-toolbar">
        <div className="mail-toolbar-leading">
          <input
            type="checkbox"
            aria-label={allChecked ? 'Deselect all' : 'Select all'}
            checked={allChecked}
            ref={(el) => {
              if (el) el.indeterminate = someChecked;
            }}
            onChange={toggleAll}
          />
          {selectedCount > 0 ? (
            <span className="mail-toolbar-count">
              {selectedCount} selected
            </span>
          ) : (
            <span className="mail-toolbar-count muted">
              {rows.length === 0
                ? 'No messages'
                : `${rows.length} message${rows.length === 1 ? '' : 's'}`}
            </span>
          )}
        </div>
        <div
          className="mail-toolbar-actions"
          data-empty={selectedCount === 0 ? 'true' : 'false'}
        >
          {folder === 'errors' ? (
            <button
              type="submit"
              formAction={actions.retry}
              className="primary-btn"
              disabled={selectedCount === 0}
              title="Re-enqueue the original send for each retryable message"
            >
              <RotateCw className="lucide" /> Retry
            </button>
          ) : null}
          {folder !== 'trash' ? (
            <button
              type="submit"
              formAction={actions.trash}
              disabled={selectedCount === 0}
              title="Move to trash"
            >
              <Trash2 className="lucide" /> Trash
            </button>
          ) : null}
          {folder !== 'spam' && folder !== 'trash' ? (
            <button
              type="submit"
              formAction={actions.spam}
              disabled={selectedCount === 0}
              title="Flag as spam"
            >
              <ShieldAlert className="lucide" /> Spam
            </button>
          ) : null}
          {folder === 'spam' ? (
            <button
              type="submit"
              formAction={actions.unspam}
              disabled={selectedCount === 0}
            >
              Not spam
            </button>
          ) : null}
          {folder === 'trash' ? (
            <button
              type="submit"
              formAction={actions.restore}
              disabled={selectedCount === 0}
            >
              Restore
            </button>
          ) : null}
          {folder === 'trash' ? (
            <ConfirmFormButton
              formAction={actions.delete}
              message="Permanently delete the selected message(s)? This cannot be undone."
              className="ghost-btn danger"
              disabled={selectedCount === 0}
            >
              Delete permanently
            </ConfirmFormButton>
          ) : null}
        </div>
      </div>

      {rows.length === 0 ? null : (
        <ul className="mail-list">
          {rows.map((row) => (
            <MailRow
              key={row.id}
              row={row}
              folder={folder}
              checked={selected.has(row.id)}
              onToggle={() => toggle(row.id)}
            />
          ))}
        </ul>
      )}
    </form>
  );
}

function MailRow({
  row,
  folder,
  checked,
  onToggle,
}: {
  row: FolderViewRow;
  folder: MailFolder;
  checked: boolean;
  onToggle: () => void;
}) {
  const when = new Date(row.whenIso);
  return (
    <li className={`mail-row${checked ? ' is-checked' : ''}`}>
      <label className="mail-row-check" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          name="ids"
          value={row.id}
          checked={checked}
          onChange={onToggle}
          aria-label={`Select ${row.subject || '(no subject)'}`}
        />
      </label>
      <div className="mail-row-peer">
        <span className="mail-row-direction" aria-hidden="true">
          {row.direction === 'outbound' ? '↗' : '↘'}
        </span>
        <span className="mail-row-peer-name">{row.peer || '(unknown)'}</span>
        {row.mailboxName ? (
          <span className="mail-row-mailbox">{row.mailboxName}</span>
        ) : null}
      </div>
      <div className="mail-row-body">
        {row.threadId ? (
          <Link
            href={`/communication/${row.threadId}`}
            className="mail-row-subject"
          >
            {row.subject || '(no subject)'}
          </Link>
        ) : (
          <span className="mail-row-subject">
            {row.subject || '(no subject)'}
          </span>
        )}
        {row.snippet ? (
          <span className="mail-row-snippet"> — {row.snippet}</span>
        ) : null}
        <FolderHints row={row} folder={folder} />
      </div>
      <div className="mail-row-meta">
        <FormattedDate date={when} />
      </div>
    </li>
  );
}

function FolderHints({ row, folder }: { row: FolderViewRow; folder: MailFolder }) {
  const hints: ReactNode[] = [];
  if (folder === 'errors') {
    if (row.isHardBounce)
      hints.push(
        <span key="hb" className="mail-row-hint mail-row-hint-bad">
          <AlertTriangle className="lucide" /> Hard bounce
        </span>,
      );
    if (row.failureReason)
      hints.push(
        <span key="reason" className="mail-row-hint">
          {row.failureReason}
        </span>,
      );
  }
  if (folder === 'spam' && row.spamReason) {
    hints.push(
      <span key="sr" className="mail-row-hint">
        flag: {row.spamReason}
      </span>,
    );
  }
  if (folder === 'queued') {
    hints.push(
      <span key="q" className="mail-row-hint">
        <Timer className="lucide" /> {row.status}
      </span>,
    );
  }
  if (hints.length === 0) return null;
  return <div className="mail-row-hints">{hints}</div>;
}

function FormattedDate({ date }: { date: Date }) {
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const sameYear = date.getFullYear() === now.getFullYear();
  let label: string;
  if (sameDay) {
    label = date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  } else if (sameYear) {
    label = date.toLocaleDateString([], {
      month: 'short',
      day: 'numeric',
    });
  } else {
    label = date.toLocaleDateString([], {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }
  return <time dateTime={date.toISOString()}>{label}</time>;
}

// ---- folder icon helper used by the parent server component ----

export function FolderIcon({ folder }: { folder: MailFolder }) {
  switch (folder) {
    case 'inbox':
      return <Inbox className="lucide" />;
    case 'sent':
      return <Send className="lucide" />;
    case 'queued':
      return <Timer className="lucide" />;
    case 'errors':
      return <AlertTriangle className="lucide" />;
    case 'spam':
      return <ShieldAlert className="lucide" />;
    case 'trash':
      return <Trash2 className="lucide" />;
  }
}
