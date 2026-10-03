'use client';

// The indeterminate state exists only as a DOM property, so the gallery
// sets it after mount to show the "some selected" checkbox.

import { useEffect, useRef } from 'react';

export function IndeterminateCheckbox({
  label,
  className,
}: Readonly<{ label: string; className?: string }>) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = true;
  }, []);
  return (
    <label className={className}>
      <input ref={ref} type="checkbox" />
      {label}
    </label>
  );
}
