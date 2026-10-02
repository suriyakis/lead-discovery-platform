// The signal family in the gallery (DS-09): every tone of Badge, the
// variants, StatusBadge over real value sets, CountBadge, ScoreChip, Tag
// and the one-hue FunnelBars. Values come from the registries, so the
// gallery shows exactly what the pages render.

import type { ReactNode } from 'react';
import {
  Badge,
  BadgeGroup,
  CountBadge,
  ScoreChip,
  StatusBadge,
  Tag,
  type TagHue,
} from '@/components/Badge';
import { FunnelBars } from '@/components/FunnelBars';
import { closeReason, pipelineState } from '@/lib/db/schema/pipeline';
import { outreachStage } from '@/lib/db/schema/outreach';
import { reviewItemState } from '@/lib/db/schema/review';
import { NOTIFICATION_KINDS } from '@/lib/kinds/notification';
import { PIPELINE_STATE_LABEL } from '@/lib/ui/labels';
import { healthScoreTone, PIPELINE_PROGRESS, TONE_MEANING, TONES } from '@/lib/ui/tone';
import styles from './gallery.module.css';

const TAG_HUES: ReadonlyArray<TagHue> = [1, 2, 3, 4, 5, 6];

/** Demo counts for the funnel sample: a narrowing pipeline. */
const FUNNEL_SAMPLE = [42, 31, 18, 12, 9, 5, 3];

function Row({
  name,
  use,
  children,
}: Readonly<{ name: string; use: string; children: ReactNode }>) {
  return (
    <figure className={styles.item} data-signal-sample={name}>
      <BadgeGroup>{children}</BadgeGroup>
      <figcaption className={styles.caption}>
        <code className={styles.name}>{name}</code>
        <span className={styles.use}>{use}</span>
      </figcaption>
    </figure>
  );
}

export function SignalSamples() {
  return (
    <div className={styles.stack}>
      <Row name="Badge tone" use="One per meaning; no tone is neutral">
        {TONES.map((tone) => (
          <Badge key={tone} tone={tone} title={TONE_MEANING[tone]}>
            {tone}
          </Badge>
        ))}
      </Row>
      <Row
        name="Badge variants"
        use="Dot (static live), pulse (running), mono (machine values), sm"
      >
        <Badge tone="live" dot>
          Active
        </Badge>
        <Badge tone="live" pulse>
          Running
        </Badge>
        <Badge variant="mono">GB</Badge>
        <Badge size="sm">Small</Badge>
        <Badge tone="ai">AI draft</Badge>
      </Row>
      <Row
        name="StatusBadge review_item_state"
        use="Record states: amber only where a decision waits"
      >
        {reviewItemState.enumValues.map((v) => (
          <StatusBadge key={v} set="review_item_state" value={v} />
        ))}
      </Row>
      <Row name="StatusBadge pipeline_state" use="Progress is info; position carries how far">
        {pipelineState.enumValues.map((v) => (
          <StatusBadge key={v} set="pipeline_state" value={v} />
        ))}
      </Row>
      <Row name="StatusBadge close_reason" use="Only a win is coloured; never red">
        {closeReason.enumValues.map((v) => (
          <StatusBadge key={v} set="close_reason" value={v} />
        ))}
      </Row>
      <Row name="StatusBadge outreach_stage" use="A kind of message, never coloured">
        {outreachStage.enumValues.map((v) => (
          <StatusBadge key={v} set="outreach_stage" value={v} />
        ))}
      </Row>
      <Row name="StatusBadge notification_kind" use="The bell's events">
        {NOTIFICATION_KINDS.map((v) => (
          <StatusBadge key={v} set="notification_kind" value={v} />
        ))}
      </Row>
      <Row
        name="StatusBadge reply_class"
        use="Neutral and marked auto until triage is trusted (I088)"
      >
        <StatusBadge set="reply_class" value="question" />
        <StatusBadge set="reply_class" value="positive" />
      </Row>
      <Row name="CountBadge" use="Neutral; attention when a decision waits; 99+ cap">
        <CountBadge count={4} />
        <CountBadge count={4} tone="attention" label="4 records need review" />
        <CountBadge count={310} />
      </Row>
      <Row
        name="ScoreChip"
        use="Mono, primary; a rule may pick the tone (health ≥80 / 50–79 / <50)"
      >
        <ScoreChip value={78} />
        {[92, 78, 42].map((score) => (
          <ScoreChip
            key={score}
            value={score}
            max={100}
            label="Score"
            tone={healthScoreTone(score)}
          />
        ))}
      </Row>
      <Row name="Tag" use="A user's tag: neutral, or one of six fixed hues the user picked">
        <Tag>cold-store</Tag>
        {TAG_HUES.map((hue) => (
          <Tag key={hue} hue={hue}>
            {`hue ${hue}`}
          </Tag>
        ))}
      </Row>
      <figure className={styles.item} data-signal-sample="FunnelBars">
        <FunnelBars
          label="Pipeline funnel sample"
          rows={PIPELINE_PROGRESS.map((key, i) => ({
            key,
            label: PIPELINE_STATE_LABEL[key],
            count: FUNNEL_SAMPLE[i] ?? 0,
          }))}
        />
        <figcaption className={styles.caption}>
          <code className={styles.name}>FunnelBars</code>
          <span className={styles.use}>One hue: --seq-1 to --seq-7, one step per row</span>
        </figcaption>
      </figure>
    </div>
  );
}
