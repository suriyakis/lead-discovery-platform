'use client';

import Link from 'next/link';
import { useState } from 'react';

export interface UserOption {
  id: string;
  name: string | null;
  email: string;
}

export interface WorkspaceCreateFormProps {
  /** Server action that takes FormData and returns void (redirects on success). */
  action: (formData: FormData) => void | Promise<void>;
  users: ReadonlyArray<UserOption>;
  initialName?: string;
  initialSlug?: string;
  initialOwner?: string;
}

/**
 * Auto-derives the slug from the name as the user types, until they manually
 * edit the slug field — once the slug input is dirty, name changes stop
 * overwriting it. Sanitization mirrors the server: lowercase a-z0-9 with
 * hyphens, hyphens collapsed, leading/trailing hyphens trimmed.
 */
export function WorkspaceCreateForm({
  action,
  users,
  initialName = '',
  initialSlug = '',
  initialOwner = '',
}: Readonly<WorkspaceCreateFormProps>) {
  const [name, setName] = useState(initialName);
  const [slug, setSlug] = useState(initialSlug);
  const [slugDirty, setSlugDirty] = useState(initialSlug.length > 0);

  const handleName = (next: string) => {
    setName(next);
    if (!slugDirty) {
      setSlug(slugify(next));
    }
  };

  return (
    <form action={action} className="edit-draft-form">
      <label>
        <span>Name</span>
        <input
          type="text"
          name="name"
          value={name}
          onChange={(e) => handleName(e.target.value)}
          required
          maxLength={120}
          autoComplete="off"
        />
      </label>
      <label>
        <span>Slug</span>
        <input
          type="text"
          name="slug"
          value={slug}
          onChange={(e) => {
            setSlug(e.target.value);
            setSlugDirty(true);
          }}
          required
          maxLength={64}
          pattern="[a-z0-9][a-z0-9-]{0,62}[a-z0-9]"
          title="lowercase letters, numbers, hyphens"
          placeholder="acme-co"
          autoComplete="off"
        />
        {!slugDirty && slug ? (
          <small className="muted">
            Auto-derived from name — click to edit
          </small>
        ) : null}
      </label>
      <label>
        <span>Owner</span>
        <select name="ownerUserId" defaultValue={initialOwner} required>
          <option value="">— pick a user —</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name ? `${u.name} <${u.email}>` : u.email}
            </option>
          ))}
        </select>
      </label>
      <div className="action-row">
        <button type="submit" className="primary-btn">
          Create
        </button>
        <Link href="/admin/workspaces" className="ghost-btn">
          Cancel
        </Link>
      </div>
    </form>
  );
}

function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}
