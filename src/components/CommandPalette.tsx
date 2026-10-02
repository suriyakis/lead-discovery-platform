'use client';

// Keyboard-driven global jump. Cmd-K (Mac) / Ctrl-K (Win/Linux), or the
// visible "Search" button (CommandPaletteTrigger), opens a modal that
// searches the navigation registry — every area, tab, account-menu page
// and action this viewer may use (paletteRoutes) — plus a small entity
// index (products, leads, mailboxes, recent threads — fetched once per
// open). The same component runs in the workspace AppShell and in the
// Platform console (AdminShell), so both list the same pages under the
// same names as the sidebar.
//
// Hand-rolled (no cmdk dep) so the bundle stays lean. Focus-trap +
// arrow-key + Enter/Escape handling done inline.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { paletteRoutes, paletteScore, type NavViewer } from '@/lib/nav/resolve';
import type { WorkspaceRole } from '@/lib/services/context';
import styles from './CommandPalette.module.css';

/** Window event the visible trigger dispatches to open the palette. */
export const OPEN_COMMAND_PALETTE_EVENT = 'leadsonar:open-command-palette';

interface EntityEntry {
  kind: 'product' | 'lead' | 'mailbox' | 'thread';
  label: string;
  href: string;
  sub?: string;
}

export interface PaletteResult {
  id: string;
  label: string;
  group: string;
  sub?: string;
  /** Shown under the label (routes: what the page is for). */
  description?: string;
  keywords?: ReadonlyArray<string>;
  href: string;
}

export interface CommandPaletteProps {
  fetchEntities: () => Promise<EntityEntry[]>;
  isSuperAdmin?: boolean;
  /** The viewer's role in the active workspace; gates admin-only entries. */
  role?: WorkspaceRole | null;
  /** Render open on first paint (tests and the docs gallery). */
  defaultOpen?: boolean;
}

/**
 * Rank everything against the query. Empty query: the registry routes in
 * nav order, then entities. Exported for tests.
 */
export function rankPaletteResults(
  all: ReadonlyArray<PaletteResult>,
  query: string,
  limit = 80,
): PaletteResult[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return all.slice(0, limit);
  const scored: Array<{ r: PaletteResult; score: number }> = [];
  for (const r of all) {
    const score = paletteScore(
      { label: r.label, group: r.group, sub: r.description ?? r.sub, keywords: r.keywords },
      needle,
    );
    if (score > 0) scored.push({ r, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.r);
}

export function CommandPalette({
  fetchEntities,
  isSuperAdmin = false,
  role = null,
  defaultOpen = false,
}: Readonly<CommandPaletteProps>) {
  const router = useRouter();
  const [open, setOpen] = useState(defaultOpen);
  const [query, setQuery] = useState('');
  const [entities, setEntities] = useState<EntityEntry[] | null>(null);
  const [entitiesLoading, setEntitiesLoading] = useState(false);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Global Cmd-K / Ctrl-K + Esc when open, and the visible trigger.
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
    function onOpenRequest() {
      setOpen(true);
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpenRequest);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpenRequest);
    };
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

  const routes: PaletteResult[] = useMemo(
    () =>
      paletteRoutes({ role, isSuperAdmin } satisfies NavViewer).map((r) => ({
        id: r.id,
        label: r.label,
        group: r.group,
        description: r.sub,
        keywords: r.keywords,
        href: r.href,
      })),
    [role, isSuperAdmin],
  );

  const results: PaletteResult[] = useMemo(() => {
    const all: PaletteResult[] = [...routes];
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
    return rankPaletteResults(all, query);
  }, [routes, entities, query]);

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
          placeholder="Jump to a page, an action, a product, lead, mailbox or thread…"
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
                    data-href={r.href}
                    className={active ? 'cmdk-item active' : 'cmdk-item'}
                    role="option"
                    aria-selected={active}
                    onMouseEnter={() => setSelected(idx)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      navigate(r.href);
                    }}
                  >
                    <span className={styles.itemText}>
                      <span className="cmdk-item-label">{r.label}</span>
                      {r.description ? (
                        <span className={styles.itemDesc}>{r.description}</span>
                      ) : null}
                    </span>
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
          <span className={styles.footerEnd}>
            <kbd>⌘K</kbd> / <kbd>Ctrl-K</kbd> toggle
          </span>
        </div>
      </div>
    </div>
  );
}

function kindGroup(kind: EntityEntry['kind']): string {
  switch (kind) {
    // Not 'Products': that heading already groups the Products area.
    case 'product':
      return 'Product profiles';
    case 'lead':
      return 'Leads';
    case 'mailbox':
      return 'Mailboxes';
    case 'thread':
      return 'Threads';
  }
}
