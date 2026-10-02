'use client';

// Client-side Suggest button for the per-stage angle fields. Renders
// a vendor picker + button inline next to the textarea label. The
// parent server component passes a server action (suggestAngle) bound
// to a specific productId; this component just bundles stage + vendor
// into a FormData and invokes the action via useTransition so the
// page reloads with the freshly written angle.

import { useTransition, useState } from 'react';

type Vendor = 'anthropic' | 'openai';

export function SuggestAngleButton({
  stage,
  action,
}: {
  stage: 'discovery' | 'engagement' | 'pitch';
  action: (formData: FormData) => Promise<void>;
}) {
  const [vendor, setVendor] = useState<Vendor>('anthropic');
  const [pending, startTransition] = useTransition();
  return (
    <span
      style={{
        display: 'inline-flex',
        gap: '0.35rem',
        alignItems: 'center',
        marginLeft: '0.5rem',
        fontSize: '0.85em',
      }}
    >
      <select
        value={vendor}
        onChange={(e) => setVendor(e.target.value as Vendor)}
        disabled={pending}
        aria-label={`AI vendor for ${stage} angle`}
      >
        <option value="anthropic">Opus 4.7</option>
        <option value="openai">GPT-5</option>
      </select>
      <button
        type="button"
        className="ghost-btn"
        disabled={pending}
        onClick={() => {
          const fd = new FormData();
          fd.set('stage', stage);
          fd.set('vendor', vendor);
          startTransition(() => action(fd));
        }}
      >
        {pending ? 'Suggesting…' : 'Suggest with AI'}
      </button>
    </span>
  );
}
