'use client';

// Step D: keyboard-driven global jump. Cmd-K (Mac) / Ctrl-K (Win/Linux)
// opens a modal that searches routes + a small entity index (products,
// leads, mailboxes, recent threads — fetched once per open).
//
// Hand-rolled (no cmdk dep) so the bundle stays lean. Focus-trap +
// arrow-key + Enter/Escape handling done inline.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { NAV_ROUTES } from './nav-routes';

interface EntityEntry {
  kind: 'product' | 'lead' | 'mailbox' | 'thread';
  label: string;
  href: string;
  sub?: string;
}

interface PaletteResult {
  id: string;
  label: string;
  group: string;
  sub?: string;
  href: string;
}

export interface CommandPaletteProps {
  fetchEntities: () => Promise<EntityEntry[]>;
  isSuperAdmin?: boolean;
}

export function CommandPalette({
  fetchEntities,
  isSuperAdmin = false,
}: Readonly<CommandPaletteProps>) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [entities, setEntities] = useState<EntityEntry[] | null>(null);
  const [entitiesLoading, setEntitiesLoading] = useState(false);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Global Cmd-K / Ctrl-K + Esc when open.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const isJumpKey =
        (e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey);
      if (isJumpKey) {
        e.preventDefault();
        setOpen((o) => !o);
        return;
      }
      if (e.key === 'Escape' && open) {
        e.preventDefault();
        setOpen(false);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  // Lazy-load entity index on first open. Cached on the component after
  // that — re-opens within the same session reuse the cached list.
  useEffect(() => {
    if (!open) return;
    if (entities !== null) return;
    if (entitiesLoading) return;
    setEntitiesLoading(true);
    fetchEntities()
      .then((rows) => setEntities(rows))
      .catch(() => setEntities([])) // fail silent — routes still work
      .finally(() => setEntitiesLoading(false));
  }, [open, entities, entitiesLoading, fetchEntities]);

  // Reset transient state on open.
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelected(0);
      // Focus the input after the modal mounts.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const visibleRoutes = useMemo(
    () => NAV_ROUTES.filter((r) => !r.superAdminOnly || isSuperAdmin),
    [isSuperAdmin],
  );

  const results: PaletteResult[] = useMemo(() => {
    const all: PaletteResult[] = [];
    for (const r of visibleRoutes) {
      all.push({
        id: `route:${r.href}`,
        label: r.label,
        group: r.group,
        href: r.href,
      });
    }
    if (entities) {
      for (const e of entities) {
        all.push({
          id: `${e.kind}:${e.href}`,
          label: e.label,
          group: kindGroup(e.kind),
          sub: e.sub,
          href: e.href,
        });
      }
    }
    const needle = query.trim().toLowerCase();
    if (!needle) return all.slice(0, 80);
    const scored: Array<{ r: PaletteResult; score: number }> = [];
    for (const r of all) {
      const score = matchScore(r, needle);
      if (score > 0) scored.push({ r, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 80).map((s) => s.r);
  }, [visibleRoutes, entities, query]);

  // Keep the selected index in bounds whenever results change.
  useEffect(() => {
    setSelected((s) => Math.max(0, Math.min(s, results.length - 1)));
  }, [results.length]);

  const navigate = useCallback(
    (href: string) => {
      setOpen(false);
      router.push(href);
    },
    [router],
  );

  const onInputKey = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelected((s) => Math.min(s + 1, results.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelected((s) => Math.max(s - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const r = results[selected];
        if (r) navigate(r.href);
      }
    },
    [results, selected, navigate],
  );

  // Auto-scroll the selected item into view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-idx="${selected}"]`,
    );
    el?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  if (!open) return null;

  // Group results by .group preserving order.
  const grouped = new Map<string, PaletteResult[]>();
  for (const r of results) {
    const list = grouped.get(r.group) ?? [];
    list.push(r);
    grouped.set(r.group, list);
  }
  let runningIndex = 0;

  return (
    <div
      className="cmdk-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div className="cmdk-modal">
        <input
          ref={inputRef}
          className="cmdk-input"
          type="text"
          placeholder="Jump to anywhere — routes, products, leads, mailboxes, threads…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onInputKey}
          aria-controls="cmdk-results"
        />
        <ul
          id="cmdk-results"
          ref={listRef}
          className="cmdk-list"
          role="listbox"
        >
          {results.length === 0 ? (
            <li className="cmdk-empty">
              {entitiesLoading
                ? 'Loading entities…'
                : `No matches for "${query}"`}
            </li>
          ) : (
            Array.from(grouped.entries()).flatMap(([group, items]) => [
              <li key={`group-${group}`} className="cmdk-group">
                {group}
              </li>,
              ...items.map((r) => {
                const idx = runningIndex++;
                const active = idx === selected;
                return (
                  <li
                    key={r.id}
                    data-idx={idx}
                    className={active ? 'cmdk-item active' : 'cmdk-item'}
                    role="option"
                    aria-selected={active}
                    onMouseEnter={() => setSelected(idx)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      navigate(r.href);
                    }}
                  >
                    <span className="cmdk-item-label">{r.label}</span>
                    {r.sub ? (
                      <span className="cmdk-item-sub">{r.sub}</span>
                    ) : null}
                  </li>
                );
              }),
            ])
          )}
        </ul>
        <div className="cmdk-footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>Enter</kbd> open
          </span>
          <span>
            <kbd>Esc</kbd> close
          </span>
          <span style={{ marginLeft: 'auto' }}>
            <kbd>⌘K</kbd> / <kbd>Ctrl-K</kbd> toggle
          </span>
        </div>
      </div>
    </div>
  );
}

function kindGroup(kind: EntityEntry['kind']): string {
  switch (kind) {
    case 'product':
      return 'Products';
    case 'lead':
      return 'Leads';
    case 'mailbox':
      return 'Mailboxes';
    case 'thread':
      return 'Threads';
  }
}

function matchScore(r: PaletteResult, needle: string): number {
  const label = r.label.toLowerCase();
  if (label === needle) return 100;
  if (label.startsWith(needle)) return 80;
  if (label.includes(needle)) return 60;
  if (r.sub && r.sub.toLowerCase().includes(needle)) return 40;
  if (r.group.toLowerCase().includes(needle)) return 20;
  // Fuzzy: every char of needle appears in order somewhere in label.
  let li = 0;
  for (const ch of needle) {
    const found = label.indexOf(ch, li);
    if (found < 0) return 0;
    li = found + 1;
  }
  return 10;
}

