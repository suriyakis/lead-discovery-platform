'use client';

// P61-20: auto-submitting filter form for /communication. Selecting a
// product, dragging a date, or toggling a value submits the form
// immediately so the operator never hunts for an Apply button. The
// free-text search still needs Enter (debouncing keystrokes server-side
// would be wasteful) and we keep an Apply button for accessibility.

import { Search } from 'lucide-react';
import Link from 'next/link';
import { useRef, type FormEvent } from 'react';
import type { MailFolder } from '@/lib/services/mail-folders';
import type { MailSourceFilter } from '@/lib/services/mail';

interface ProductOpt {
  id: string;
  name: string;
}

interface Props {
  activeFolder: MailFolder;
  source: MailSourceFilter;
  productId: string;
  dateFrom: string;
  dateTo: string;
  search: string;
  mailboxId: string;
  products: ProductOpt[];
  folderLabel: string;
  hasActiveFilters: boolean;
  resetHref: string;
  segmentLinks: { all: string; outreach: string; external: string };
}

export function MailFilterForm({
  activeFolder,
  source,
  productId,
  dateFrom,
  dateTo,
  search,
  mailboxId,
  products,
  folderLabel,
  hasActiveFilters,
  resetHref,
  segmentLinks,
}: Props) {
  const formRef = useRef<HTMLFormElement>(null);

  function submitNow() {
    formRef.current?.requestSubmit();
  }

  // When the user clears the search box (e.g. via the native X button)
  // we want the list to refresh immediately too. <input type="search">
  // fires a 'search' event on clear in some browsers — fall back to
  // 'input' with an empty value.
  function onSearchInput(e: FormEvent<HTMLInputElement>) {
    if (e.currentTarget.value === '' && search !== '') submitNow();
  }

  return (
    <form
      ref={formRef}
      method="get"
      action="/communication"
      className="mail-filters"
      role="search"
    >
      <input type="hidden" name="folder" value={activeFolder} />
      {mailboxId ? <input type="hidden" name="mailboxId" value={mailboxId} /> : null}

      {/* Segment toggle: All / App / External (already Link-based, instant) */}
      <div
        className="mail-segment"
        role="tablist"
        aria-label="Conversation source"
      >
        <Link
          href={segmentLinks.all}
          className={source === 'all' ? 'is-active' : ''}
        >
          All
        </Link>
        <Link
          href={segmentLinks.outreach}
          className={source === 'outreach' ? 'is-active' : ''}
        >
          App conversations
        </Link>
        <Link
          href={segmentLinks.external}
          className={source === 'external' ? 'is-active' : ''}
        >
          External email
        </Link>
      </div>

      <input
        type="hidden"
        name="source"
        value={source !== 'all' ? source : ''}
      />

      <label>
        <span>Product</span>
        <select
          name="productId"
          defaultValue={productId}
          onChange={submitNow}
        >
          <option value="">All</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>

      <label>
        <span>From</span>
        <input
          type="date"
          name="from"
          defaultValue={dateFrom}
          onChange={submitNow}
        />
      </label>
      <label>
        <span>To</span>
        <input
          type="date"
          name="to"
          defaultValue={dateTo}
          onChange={submitNow}
        />
      </label>

      <div className="mail-filters-search">
        <Search className="lucide" />
        <input
          type="search"
          name="q"
          defaultValue={search}
          placeholder={`Search ${folderLabel}…`}
          onInput={onSearchInput}
        />
      </div>

      <div className="mail-filters-buttons">
        <button type="submit" className="primary-btn">
          Search
        </button>
        {hasActiveFilters ? (
          <Link href={resetHref} className="ghost-btn">
            Reset
          </Link>
        ) : null}
      </div>
    </form>
  );
}
