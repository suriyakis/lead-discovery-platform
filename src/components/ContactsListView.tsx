'use client';

// P61-26: vibrant contacts list with selection-aware toolbar, bulk
// archive / unarchive / tag, gradient initials avatars, tag pills.
// Mirrors the CommunicationFolderView pattern: server owns the data,
// this component owns the selection state.

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Archive,
  ArchiveRestore,
  Tag as TagIcon,
  TagsIcon,
  Trash2,
} from 'lucide-react';

export interface ContactRow {
  id: string;
  email: string;
  name: string | null;
  role: string | null;
  companyName: string | null;
  companyDomain: string | null;
  tags: string[];
  status: 'active' | 'archived';
  updatedAt: string; // ISO
}

type ServerAction = (formData: FormData) => Promise<void>;

interface Props {
  rows: ContactRow[];
  hiddenInputs: Record<string, string>;
  knownTags: string[];
  actions: {
    archive: ServerAction;
    unarchive: ServerAction;
    addTag: ServerAction;
    removeTag: ServerAction;
  };
}

export function ContactsListView({
  rows,
  hiddenInputs,
  knownTags,
  actions,
}: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pendingTag, setPendingTag] = useState('');

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
    setSelected(allChecked ? new Set() : new Set(allIds));
  }

  return (
    <form>
      {Object.entries(hiddenInputs).map(([k, v]) =>
        v ? <input key={k} type="hidden" name={k} value={v} /> : null,
      )}
      <input type="hidden" name="tag" value={pendingTag} />

      <div className="contacts-toolbar">
        <div className="contacts-toolbar-leading">
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
            <span className="contacts-count">{selectedCount} selected</span>
          ) : (
            <span className="contacts-count muted">
              {rows.length === 0
                ? 'No contacts'
                : `${rows.length} contact${rows.length === 1 ? '' : 's'}`}
            </span>
          )}
        </div>
        <div className="contacts-toolbar-actions">
          <div className="contacts-tag-group">
            <TagsIcon className="lucide" aria-hidden="true" />
            <input
              type="text"
              value={pendingTag}
              onChange={(e) =>
                setPendingTag(
                  e.target.value
                    .toLowerCase()
                    .replace(/\s+/g, '-')
                    .slice(0, 40),
                )
              }
              list="contacts-known-tags"
              placeholder="tag…"
              aria-label="Tag to add or remove"
            />
            <datalist id="contacts-known-tags">
              {knownTags.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
            <button
              type="submit"
              formAction={actions.addTag}
              disabled={selectedCount === 0 || !pendingTag.trim()}
              title="Add tag to selected"
            >
              <TagIcon className="lucide" aria-hidden="true" />
              Add tag
            </button>
            <button
              type="submit"
              formAction={actions.removeTag}
              disabled={selectedCount === 0 || !pendingTag.trim()}
              title="Remove tag from selected"
            >
              Remove
            </button>
          </div>
          <button
            type="submit"
            formAction={actions.archive}
            disabled={selectedCount === 0}
            title="Archive selected"
          >
            <Archive className="lucide" aria-hidden="true" /> Archive
          </button>
          <button
            type="submit"
            formAction={actions.unarchive}
            disabled={selectedCount === 0}
            title="Restore archived to active"
          >
            <ArchiveRestore className="lucide" aria-hidden="true" /> Restore
          </button>
        </div>
      </div>

      {rows.length === 0 ? null : (
        <ul className="contacts-list">
          {rows.map((row) => (
            <ContactRowItem
              key={row.id}
              row={row}
              checked={selected.has(row.id)}
              onToggle={() => toggle(row.id)}
            />
          ))}
        </ul>
      )}
    </form>
  );
}

function ContactRowItem({
  row,
  checked,
  onToggle,
}: {
  row: ContactRow;
  checked: boolean;
  onToggle: () => void;
}) {
  const display = row.name?.trim() || row.email;
  const initials = computeInitials(row.name, row.email);
  const avatarGradient = gradientForKey(row.email);
  return (
    <li
      className={`contact-card${checked ? ' is-checked' : ''}${row.status === 'archived' ? ' is-archived' : ''}`}
    >
      <label className="contact-card-check">
        <input
          type="checkbox"
          name="ids"
          value={row.id}
          checked={checked}
          onChange={onToggle}
          aria-label={`Select ${display}`}
        />
      </label>
      <div className="contact-avatar" style={{ background: avatarGradient }}>
        {initials}
      </div>
      <div className="contact-card-main">
        <div className="contact-card-name-row">
          <Link href={`/contacts/${row.id}`} className="contact-card-name">
            {display}
          </Link>
          {row.role ? (
            <span className="contact-card-role">{row.role}</span>
          ) : null}
          {row.status === 'archived' ? (
            <span className="badge badge-bad">archived</span>
          ) : null}
        </div>
        <div className="contact-card-meta">
          <span className="contact-card-email">{row.email}</span>
          {row.companyName ? (
            <span className="contact-card-company">· {row.companyName}</span>
          ) : row.companyDomain ? (
            <span className="contact-card-company">@{row.companyDomain}</span>
          ) : null}
        </div>
        {row.tags.length > 0 ? (
          <div className="contact-card-tags">
            {row.tags.map((t) => (
              <span
                key={t}
                className="contact-tag"
                style={{ background: tagColor(t) }}
              >
                {t}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <div className="contact-card-aside">
        <Link
          href={`/contacts/${row.id}`}
          className="ghost-btn small"
          title="Open contact"
        >
          Open
        </Link>
      </div>
    </li>
  );
}

function computeInitials(name: string | null, email: string): string {
  const src = (name && name.trim()) || email;
  const parts = src
    .split(/[\s._-]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

const AVATAR_PALETTE = [
  ['oklch(0.72 0.17 240)', 'oklch(0.55 0.18 280)'],
  ['oklch(0.72 0.17 200)', 'oklch(0.55 0.18 160)'],
  ['oklch(0.78 0.16 100)', 'oklch(0.6 0.17 60)'],
  ['oklch(0.75 0.18 25)', 'oklch(0.55 0.18 350)'],
  ['oklch(0.75 0.16 320)', 'oklch(0.55 0.17 260)'],
  ['oklch(0.78 0.15 140)', 'oklch(0.55 0.17 190)'],
  ['oklch(0.78 0.16 75)', 'oklch(0.6 0.17 30)'],
  ['oklch(0.75 0.17 290)', 'oklch(0.55 0.17 250)'],
];

function gradientForKey(key: string): string {
  const idx = hashString(key) % AVATAR_PALETTE.length;
  const [a, b] = AVATAR_PALETTE[idx]!;
  return `linear-gradient(135deg, ${a} 0%, ${b} 100%)`;
}

const TAG_PALETTE = [
  'color-mix(in oklab, oklch(0.72 0.17 240) 28%, var(--brand-input))',
  'color-mix(in oklab, oklch(0.72 0.17 160) 28%, var(--brand-input))',
  'color-mix(in oklab, oklch(0.78 0.16 60) 28%, var(--brand-input))',
  'color-mix(in oklab, oklch(0.75 0.18 25) 28%, var(--brand-input))',
  'color-mix(in oklab, oklch(0.75 0.16 320) 28%, var(--brand-input))',
  'color-mix(in oklab, oklch(0.78 0.15 140) 28%, var(--brand-input))',
];

function tagColor(tag: string): string {
  const idx = hashString(tag) % TAG_PALETTE.length;
  return TAG_PALETTE[idx]!;
}
