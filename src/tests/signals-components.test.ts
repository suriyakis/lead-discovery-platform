// DS-09: the Badge family, HintBadge and FunnelBars as rendered markup,
// and their stylesheet. The default badge is neutral, a StatusBadge takes
// its label and tone from the maps, counts cap at 99+, tags never carry a
// hashed hue, and the funnel steps one hue down the --seq ramp.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { load } from 'cheerio';
import { describe, expect, it } from 'vitest';
import { Badge, BadgeGroup, CountBadge, ScoreChip, StatusBadge, Tag } from '@/components/Badge';
import { FunnelBars, funnelPercent } from '@/components/FunnelBars';
import { HintBadge, HintBadgeList } from '@/components/HintBadge';
import { HINT_SEVERITIES, type Hint } from '@/lib/services/hints';
import { HINT_SEVERITY_TONE, TONES } from '@/lib/ui/tone';

const ROOT = path.resolve(__dirname, '..', '..');

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- createElement over generic components
const html = (type: any, props: Record<string, unknown>, ...children: unknown[]) =>
  load(renderToStaticMarkup(createElement(type, props, ...(children as []))));

describe('Badge', () => {
  it('is neutral by default (I151: the bare badge used to be amber)', () => {
    const $ = html(Badge, {}, 'Step 1 of 3');
    const badge = $('[data-tone]');
    expect(badge.attr('data-tone')).toBe('neutral');
    expect(badge.text()).toBe('Step 1 of 3');
    expect(badge.attr('data-pulse')).toBeUndefined();
  });

  it('renders every tone, a dot, a pulse and the variants', () => {
    for (const tone of TONES) {
      expect(html(Badge, { tone }, 'x')('[data-tone]').attr('data-tone')).toBe(tone);
    }
    const $ = html(Badge, { tone: 'live', pulse: true, variant: 'mono', size: 'sm' }, 'Running');
    const badge = $('[data-tone]');
    expect(badge.attr('data-pulse')).toBe('');
    expect(badge.attr('data-variant')).toBe('mono');
    expect(badge.attr('data-size')).toBe('sm');
    expect(badge.find('[aria-hidden="true"]')).toHaveLength(1); // the dot
  });
});

describe('StatusBadge', () => {
  it('shows the label in the tone of the value, never the raw code', () => {
    const $ = html(StatusBadge, { set: 'review_item_state', value: 'needs_review' });
    const badge = $('[data-signal="review_item_state"]');
    expect(badge.attr('data-value')).toBe('needs_review');
    expect(badge.attr('data-tone')).toBe('attention');
    expect(badge.text()).toBe('Needs review');
  });

  it("'closing' and every close reason but won are neutral; won is success", () => {
    expect(
      html(StatusBadge, { set: 'outreach_stage', value: 'closing' })('[data-tone]').attr(
        'data-tone',
      ),
    ).toBe('neutral');
    for (const reason of [
      'won',
      'lost',
      'no_response',
      'wrong_fit',
      'duplicate',
      'spam',
      'other',
    ]) {
      const tone = html(StatusBadge, { set: 'close_reason', value: reason })('[data-tone]').attr(
        'data-tone',
      );
      expect(tone, reason).toBe(reason === 'won' ? 'success' : 'neutral');
    }
  });

  it('pulses a running process and titles a described value', () => {
    expect(
      html(StatusBadge, { set: 'outreach_queue_status', value: 'sending' })('[data-tone]').attr(
        'data-pulse',
      ),
    ).toBe('');
    expect(
      html(StatusBadge, { set: 'workspace_member_role', value: 'owner' })('[title]').attr('title'),
    ).toMatch(/ownership/);
  });

  it('renders an unknown value (an older row) neutral and in words', () => {
    const badge = html(StatusBadge, { set: 'notification_kind', value: 'legacy.kind_x' })(
      '[data-tone]',
    );
    expect(badge.attr('data-tone')).toBe('neutral');
    expect(badge.text()).toBe('Legacy kind x');
  });
});

describe('CountBadge, ScoreChip, Tag, BadgeGroup', () => {
  it('counts are neutral unless told, cap at 99+ and read in full to screen readers', () => {
    expect(html(CountBadge, { count: 4 })('[data-tone]').attr('data-tone')).toBe('neutral');
    const $ = html(CountBadge, { count: 310, tone: 'attention', label: '310 records need review' });
    expect($('[data-tone]').attr('data-tone')).toBe('attention');
    expect($('[aria-hidden="true"]').text()).toBe('99+');
    expect($('.sr-only').text()).toBe('310 records need review');
    expect(html(CountBadge, { count: -2 })('[data-tone]').text()).toBe('0');
  });

  it('a score is primary unless a rule picks the tone', () => {
    const plain = html(ScoreChip, { value: 78 })('[data-tone]');
    expect(plain.attr('data-tone')).toBe('info');
    expect(plain.text()).toBe('78');
    const health = html(ScoreChip, { value: 78, max: 100, label: 'Score', tone: 'attention' })(
      '[data-tone]',
    );
    expect(health.attr('data-tone')).toBe('attention');
    expect(health.text()).toBe('Score78/100');
  });

  it('a tag is neutral unless a fixed hue is given (no hashing)', () => {
    expect(html(Tag, {}, 'cold-store')('span').attr('data-hue')).toBeUndefined();
    expect(html(Tag, { hue: 3 }, 'priority')('span').attr('data-hue')).toBe('3');
  });

  it('a labelled group is a group', () => {
    const $ = html(BadgeGroup, { label: 'Status' }, 'x');
    expect($('[role="group"]').attr('aria-label')).toBe('Status');
  });
});

describe('HintBadge (I151)', () => {
  it.each(HINT_SEVERITIES)('a %s hint takes its tone from the meaning map', (severity) => {
    const hint: Hint = { type: 'next_action', severity, text: 'send first outreach' } as Hint;
    const tone = html(HintBadge, { hint })('[data-tone]').attr('data-tone');
    expect(tone).toBe(HINT_SEVERITY_TONE[severity]);
  });

  it('info is not amber, action and warning are, only critical is red', () => {
    expect(HINT_SEVERITY_TONE).toEqual({
      info: 'info',
      action: 'attention',
      warning: 'attention',
      critical: 'danger',
      success: 'success',
      note: 'neutral',
    });
  });

  it('caps the list and counts the rest in a neutral badge', () => {
    const hints = Array.from({ length: 5 }, (_, i) => ({
      type: 'next_action',
      severity: 'action',
      text: `hint ${i}`,
    })) as Hint[];
    const $ = html(HintBadgeList, { hints, maxVisible: 3 });
    const tones = $('[data-tone]')
      .toArray()
      .map((el) => $(el).attr('data-tone'));
    expect(tones).toEqual(['attention', 'attention', 'attention', 'neutral']);
    expect($('[data-tone]').last().text()).toBe('+2');
  });
});

describe('FunnelBars', () => {
  const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((key, i) => ({
    key,
    label: key.toUpperCase(),
    count: 70 - i * 10,
    href: `/pipeline?state=${key}`,
  }));

  it('steps each row one hue down the ramp, with the length as data only', () => {
    const $ = html(FunnelBars, { rows, label: 'Funnel' });
    const fills = $('[data-step]').toArray();
    expect(fills.map((el) => $(el).attr('data-step'))).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    expect($(fills[0]).attr('style')).toBe('--v:100');
    expect($(fills[6]).attr('style')).toBe('--v:14');
    expect($('ol').attr('aria-label')).toBe('Funnel');
    expect($('a').first().attr('href')).toBe('/pipeline?state=a');
  });

  it('renders rows without links inside a linked card', () => {
    const $ = html(FunnelBars, { rows: rows.map(({ href: _href, ...r }) => r), label: 'Funnel' });
    expect($('a')).toHaveLength(0);
    expect($('[data-funnel-row]')).toHaveLength(7);
  });

  it('computes bar lengths safely', () => {
    expect(funnelPercent(0, 0)).toBe(0);
    expect(funnelPercent(5, 10)).toBe(50);
    expect(funnelPercent(20, 10)).toBe(100);
  });
});

describe('Badge.module.css and FunnelBars.module.css', () => {
  const badgeCss = readFileSync(path.join(ROOT, 'src/components/Badge.module.css'), 'utf8');
  const funnelCss = readFileSync(path.join(ROOT, 'src/components/FunnelBars.module.css'), 'utf8');

  it('styles every tone for badges, scores and counts, and only tones from tone.ts', () => {
    for (const tone of TONES.filter((t) => t !== 'neutral')) {
      for (const cls of ['badge', 'score', 'count']) {
        expect(badgeCss, `.${cls}[data-tone='${tone}']`).toContain(`.${cls}[data-tone='${tone}']`);
      }
    }
    const used = [...badgeCss.matchAll(/data-tone='([a-z]+)'/g)].map((m) => m[1]);
    for (const t of used) expect(TONES).toContain(t);
  });

  it('gives each of the six tag hues its token, and nothing more', () => {
    for (let n = 1; n <= 6; n++)
      expect(badgeCss).toContain(`.tag[data-hue='${n}'] {\n    --t: var(--tag-${n});`);
    expect(badgeCss).not.toContain("data-hue='7'");
  });

  it('fills every funnel step from the --seq ramp and nothing else', () => {
    for (let n = 2; n <= 7; n++) {
      expect(funnelCss).toContain(`.fill[data-step='${n}'] {\n    --step-colour: var(--seq-${n});`);
    }
    expect(funnelCss).toContain('--step-colour: var(--seq-1);');
    expect(funnelCss).not.toMatch(/oklch\(|#[0-9a-f]{3,8}\b/i);
  });
});
