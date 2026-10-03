// The signal family (DS-09): Badge, StatusBadge, CountBadge, ScoreChip and
// Tag. Server-safe (no hooks), so server pages and client components both
// render them; styles in Badge.module.css, tokens only.
//
//   <StatusBadge set="review_item_state" value={item.state} />
//
// StatusBadge is how a page shows an enum value: the label and tone come
// from src/lib/ui/labels.ts and tone.ts, so no page hand-picks a colour or
// prints a raw code. A bare <Badge> is neutral; pass a tone only for a
// value that has no set (a step counter is neutral, an AI marker is 'ai').

import type { ReactNode } from 'react';
import { signalFor } from '@/lib/ui/labels';
import type { CountTone, SignalSet, SignalValue, Tone } from '@/lib/ui/tone';
import styles from './Badge.module.css';

export interface BadgeProps {
  /** Meaning, never a hue. Defaults to neutral. */
  tone?: Tone;
  /** A 6px dot before the label (a static live state). */
  dot?: boolean;
  /** A process running now: a pulsing dot (stilled by reduced motion). */
  pulse?: boolean;
  /** Mono type for machine values (codes, ids, versions). */
  variant?: 'mono';
  size?: 'sm';
  /** Tooltip, e.g. what the value means. */
  title?: string;
  children: ReactNode;
  /** The set and value a StatusBadge renders, for tests and tooling. */
  'data-signal'?: string;
  'data-value'?: string;
}

export function Badge({
  tone = 'neutral',
  dot = false,
  pulse = false,
  variant,
  size,
  title,
  children,
  ...data
}: Readonly<BadgeProps>) {
  return (
    <span
      className={styles.badge}
      data-tone={tone}
      data-variant={variant}
      data-size={size}
      data-pulse={pulse ? '' : undefined}
      title={title}
      {...data}
    >
      {dot || pulse ? <span className={styles.dot} aria-hidden="true" /> : null}
      <span className={styles.label}>{children}</span>
    </span>
  );
}

/**
 * One value of a known set, as its label in its tone. `value` takes any
 * string so text columns render as read; a value the maps do not know
 * reads neutral with a humanized label (labels.ts signalFor).
 */
export function StatusBadge<S extends SignalSet>({
  set,
  value,
  size,
}: Readonly<{
  set: S;
  value: SignalValue<S> | (string & {});
  size?: 'sm';
}>) {
  const signal = signalFor(set, value);
  return (
    <Badge
      tone={signal.tone}
      pulse={signal.pulse}
      size={size}
      title={signal.description}
      data-signal={set}
      data-value={value}
    >
      {signal.label}
    </Badge>
  );
}

/** Numbers above this print as `99+`; screen readers get the full phrase. */
export const COUNT_CAP = 99;

/**
 * A count: neutral, or attention when a decision waits on this user.
 * `label` is the full phrase for screen readers ("4 records need review");
 * without it the number is read as is. `null` is a number that could not
 * be loaded (MOB-02): it prints "—" in the neutral tone, never 0.
 */
export function CountBadge({
  count,
  tone = 'neutral',
  label,
}: Readonly<{ count: number | null; tone?: CountTone; label?: string }>) {
  const unknown = count === null;
  let text: string;
  let spoken = label;
  if (unknown) {
    text = '—';
    spoken = label ? `${label}: number unavailable` : 'number unavailable';
  } else {
    const n = Math.max(0, Math.floor(count));
    text = n > COUNT_CAP ? `${COUNT_CAP}+` : String(n);
  }
  return (
    <span
      className={styles.count}
      data-tone={unknown ? 'neutral' : tone}
      data-unknown={unknown ? '' : undefined}
    >
      {spoken ? (
        <>
          <span aria-hidden="true">{text}</span>
          <span className="sr-only">{spoken}</span>
        </>
      ) : (
        text
      )}
    </span>
  );
}

/**
 * A 0–100 score in mono: primary (info) by default; a rule such as
 * healthScoreTone() picks another tone. `label` precedes the number
 * ("Score 78/100"), `max` follows it.
 */
export function ScoreChip({
  value,
  max,
  tone = 'info',
  label,
  title,
}: Readonly<{ value: number; max?: number; tone?: Tone; label?: string; title?: string }>) {
  return (
    <span className={styles.score} data-tone={tone} title={title}>
      {label ? <span className={styles.scoreLabel}>{label}</span> : null}
      {value}
      {max !== undefined ? <span className={styles.scoreNote}>/{max}</span> : null}
    </span>
  );
}

/** A wrapping row of badges, chips or tags with the chip gap. */
export function BadgeGroup({ children, label }: Readonly<{ children: ReactNode; label?: string }>) {
  return (
    <span className={styles.group} aria-label={label} role={label ? 'group' : undefined}>
      {children}
    </span>
  );
}

/** The six fixed tag hues (--tag-1 … --tag-6). Never derived from a hash. */
export type TagHue = 1 | 2 | 3 | 4 | 5 | 6;

/** A user's tag: a neutral chip, or one of six fixed hues when the user picked one. */
export function Tag({ children, hue }: Readonly<{ children: ReactNode; hue?: TagHue }>) {
  return (
    <span className={styles.tag} data-hue={hue}>
      {children}
    </span>
  );
}
