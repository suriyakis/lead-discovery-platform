// DS-10: the form primitives (Field, Input, Select, Textarea, SearchInput,
// Checkbox, Switch, EmailPreview) as rendered markup, and the CSS that
// styles bare controls everywhere.
//
// - Field wires its label, error and hint to the one control by id
//   (aria-describedby: error first, then hint, then the control's own).
// - The text controls carry the control-token sizes; Checkbox and Switch
//   are native checkboxes named by their own label (role=switch on Switch).
// - EmailPreview renders email HTML in a sandboxed srcdoc frame, never into
//   the page; no component injects raw HTML any more.
// - base.css styles bare input, select and textarea everywhere (not only
//   inside [data-ds]); the component module restates the same values; the
//   legacy contexts the sweep cleaned resolve to the base metrics (I153).
// The browser half (heights on the acceptance pages, the frame's computed
// style, axe) is e2e/form-controls.spec.ts.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { load, type CheerioAPI } from 'cheerio';
import { describe, expect, it } from 'vitest';
import {
  Checkbox,
  EmailPreview,
  EMAIL_PREVIEW_CSP,
  EMAIL_PREVIEW_SANDBOX,
  emailPreviewDocument,
  Field,
  Input,
  INPUT_TYPES,
  joinIds,
  SearchInput,
  Select,
  Switch,
  Textarea,
} from '@/components/ui';
import { type CssRule, loadAppRules, loadCssFile, styleOf } from './helpers/css-cascade';

const ROOT = path.resolve(__dirname, '..', '..');
const render = (el: ReactElement): CheerioAPI => load(renderToStaticMarkup(el));
/** createElement with the children as arguments (a Field requires its one control). */
const h = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- over components whose props require children
  type: any,
  props?: Record<string, unknown> | null,
  ...children: unknown[]
): ReactElement => createElement(type, props ?? null, ...(children as []));

describe('Field', () => {
  it('points its label at the control and describes it by the error, then the hint', () => {
    const $ = render(
      h(
        Field,
        { label: 'Contact email', hint: 'Replies go here.', error: 'Enter a full address.' },
        h(Input, { type: 'email', name: 'email' }),
      ),
    );
    const input = $('input');
    const id = input.attr('id')!;
    expect(id).toBeTruthy();
    expect($('label').attr('for')).toBe(id);
    expect($('label').text()).toBe('Contact email');
    expect(input.attr('aria-describedby')).toBe(`${id}-error ${id}-hint`);
    expect(input.attr('aria-invalid')).toBe('true');
    expect($(`#${id}-error`).text()).toBe('Enter a full address.');
    expect($(`#${id}-error svg`).attr('aria-hidden')).toBe('true');
    expect($(`#${id}-hint`).text()).toBe('Replies go here.');
  });

  it('keeps the control’s own id and describedby, or takes the Field id', () => {
    let $ = render(
      h(
        Field,
        { label: 'Role', hint: 'Owners only.' },
        h(Select, { id: 'role-1', 'aria-describedby': 'role-note' }),
      ),
    );
    expect($('select').attr('id')).toBe('role-1');
    expect($('label').attr('for')).toBe('role-1');
    expect($('select').attr('aria-describedby')).toBe('role-1-hint role-note');
    expect($('select').attr('aria-invalid')).toBeUndefined();

    $ = render(h(Field, { id: 'g-x', label: 'X' }, h('input')));
    expect($('input').attr('id')).toBe('g-x');
    expect($('input').attr('aria-describedby')).toBeUndefined();
  });

  it('gives two fields on one page different ids', () => {
    const $ = render(
      h(
        'form',
        null,
        h(Field, { label: 'A' }, h(Input, { name: 'a' })),
        h(Field, { label: 'B' }, h(Input, { name: 'b' })),
      ),
    );
    const ids = $('input')
      .toArray()
      .map((el) => $(el).attr('id'));
    expect(new Set(ids).size).toBe(2);
    $('label').each((i, el) => expect($(el).attr('for')).toBe(ids[i]));
  });

  it('marks an optional field, and lays out stack (full width) or inline', () => {
    let $ = render(h(Field, { label: 'Website', optional: true }, h(Input)));
    expect($('label').text()).toBe('Website (optional)');
    expect($('[data-layout]').attr('data-layout')).toBe('stack');
    expect($('[data-layout]').attr('data-width')).toBe('full');
    $ = render(h(Field, { label: 'From', layout: 'inline' }, h(Input)));
    expect($('[data-layout]').attr('data-layout')).toBe('inline');
    expect($('[data-layout]').attr('data-width')).toBe('auto');
    $ = render(h(Field, { label: 'Days', width: 'num' }, h(Input)));
    expect($('[data-layout]').attr('data-width')).toBe('num');
  });

  it('takes exactly one control', () => {
    expect(() =>
      renderToStaticMarkup(
        h(Field, { label: 'Two' }, [
          h('input', { key: 'a' }),
          h('input', { key: 'b' }),
        ] as unknown as ReactElement),
      ),
    ).toThrow();
  });

  it('reaches the input inside a SearchInput and the textarea of a Textarea', () => {
    let $ = render(h(Field, { label: 'Search', hint: 'Name or domain' }, h(SearchInput)));
    const id = $('input').attr('id')!;
    expect($('label').attr('for')).toBe(id);
    expect($('input').attr('type')).toBe('search');
    expect($('input').attr('aria-describedby')).toBe(`${id}-hint`);
    $ = render(h(Field, { label: 'Notes' }, h(Textarea)));
    expect($('label').attr('for')).toBe($('textarea').attr('id'));
  });

  it('joinIds drops empties and repeats', () => {
    expect(joinIds('a', undefined, 'b a', null, false, '')).toBe('a b');
    expect(joinIds(undefined, '')).toBeUndefined();
  });
});

describe('text controls', () => {
  it('Input is a text input at md by default and takes every text-like type', () => {
    let $ = render(h(Input, { name: 'q' }));
    expect($('input').attr('type')).toBe('text');
    expect($('input').attr('data-size')).toBe('md');
    for (const type of INPUT_TYPES) {
      $ = render(h(Input, { type }));
      expect($('input').attr('type')).toBe(type);
    }
    expect(INPUT_TYPES).toContain('date');
    expect(INPUT_TYPES).not.toContain('checkbox');
    $ = render(h(Input, { size: 'sm', align: 'end', className: 'extra' }));
    expect($('input').attr('data-size')).toBe('sm');
    expect($('input').attr('data-align')).toBe('end');
    expect($('input').attr('class')).toContain('extra');
  });

  it('Select keeps its options and takes a size and the plain variant', () => {
    const $ = render(
      h(
        Select,
        { name: 'role', defaultValue: 'b', size: 'sm', variant: 'plain' },
        h('option', { value: 'a' }, 'A'),
        h('option', { value: 'b' }, 'B'),
      ),
    );
    expect($('select').attr('data-size')).toBe('sm');
    expect($('select').attr('data-variant')).toBe('plain');
    expect($('option[selected]').attr('value')).toBe('b');
  });

  it('Textarea defaults to three rows and can turn resizing off', () => {
    let $ = render(h(Textarea, { name: 'body' }));
    expect($('textarea').attr('rows')).toBe('3');
    expect($('textarea').attr('data-resize')).toBe('vertical');
    $ = render(h(Textarea, { rows: 8, resize: 'none' }));
    expect($('textarea').attr('rows')).toBe('8');
    expect($('textarea').attr('data-resize')).toBe('none');
  });

  it('SearchInput is type=search with a hidden glyph, and forwards input props', () => {
    const $ = render(h(SearchInput, { name: 'q', 'aria-label': 'Filter', size: 'sm' }));
    expect($('svg').attr('aria-hidden')).toBe('true');
    expect($('input').attr('type')).toBe('search');
    expect($('input').attr('name')).toBe('q');
    expect($('input').attr('aria-label')).toBe('Filter');
    expect($('input').attr('data-size')).toBe('sm');
  });
});

describe('Checkbox and Switch', () => {
  it('a checkbox inside its own label, named by the label text', () => {
    const $ = render(
      h(Checkbox, { name: 'sig', label: 'Include signature', defaultChecked: true }),
    );
    const input = $('label > input');
    expect(input.attr('type')).toBe('checkbox');
    expect(input.attr('role')).toBeUndefined();
    expect(input.attr('checked')).toBe('checked');
    expect($('label').text()).toBe('Include signature');
  });

  it('a switch is role=switch on a native checkbox that submits "on"', () => {
    const $ = render(h(Switch, { name: 'autoDraftReplies', label: 'Auto-draft replies' }));
    const input = $('input');
    expect(input.attr('type')).toBe('checkbox');
    expect(input.attr('role')).toBe('switch');
    expect($.html()).not.toContain('value='); // the browser submits "on"
    expect(input.attr('name')).toBe('autoDraftReplies');
  });

  it('a description is announced through aria-describedby, after any given ids', () => {
    const $ = render(
      h(Switch, {
        name: 'x',
        label: 'Auto-send',
        description: 'Sends without approval.',
        position: 'end',
        'aria-describedby': 'more-help',
      }),
    );
    const descId = $('input').attr('aria-describedby')!.split(' ')[0]!;
    expect($('input').attr('aria-describedby')).toBe(`${descId} more-help`);
    expect($(`#${descId}`).text()).toBe('Sends without approval.');
    expect($('label').attr('data-position')).toBe('end');
    expect($('label').attr('data-described')).toBe('');
  });

  it('a row checkbox without visible text takes an aria-label; disabled passes through', () => {
    const $ = render(
      h(Checkbox, { name: 'ids', value: '7', 'aria-label': 'Select row 7', disabled: true }),
    );
    expect($('input').attr('aria-label')).toBe('Select row 7');
    expect($('input').attr('disabled')).toBe('disabled');
    expect($('label').text()).toBe('');
  });
});

describe('EmailPreview', () => {
  const html =
    '<p>Kind regards,<br><strong>Jo</strong></p><img src="x" onerror="parent.document.title=1">';

  it('renders the HTML as the srcdoc of a sandboxed, titled frame, never into the page', () => {
    const $ = render(h(EmailPreview, { html, title: 'Signature preview' }));
    const frame = $('iframe');
    expect(frame).toHaveLength(1);
    expect(frame.attr('title')).toBe('Signature preview');
    expect(frame.attr('sandbox')).toBe(EMAIL_PREVIEW_SANDBOX);
    expect(frame.attr('srcdoc')).toBe(emailPreviewDocument(html));
    expect(frame.attr('referrerpolicy')).toBe('no-referrer');
    // Nothing of the email reaches the page's own DOM.
    expect($('strong')).toHaveLength(0);
    expect($('img')).toHaveLength(0);
  });

  it('runs nothing: no allow-scripts (with allow-same-origin it would run as the app)', () => {
    const tokens = EMAIL_PREVIEW_SANDBOX.split(/\s+/);
    expect(tokens).toEqual(['allow-same-origin']);
    for (const t of ['allow-scripts', 'allow-forms', 'allow-popups', 'allow-top-navigation'])
      expect(tokens).not.toContain(t);
  });

  it('is its own document: a light canvas, a policy that loads images only, no app CSS', () => {
    const doc = load(emailPreviewDocument(html));
    expect(doc('meta[http-equiv="Content-Security-Policy"]').attr('content')).toBe(
      EMAIL_PREVIEW_CSP,
    );
    expect(EMAIL_PREVIEW_CSP).toMatch(/default-src 'none'/);
    expect(EMAIL_PREVIEW_CSP).not.toMatch(/script-src/);
    expect(doc('meta[name="color-scheme"]').attr('content')).toBe('light');
    expect(doc('base').attr('target')).toBe('_blank');
    expect(doc('link')).toHaveLength(0);
    expect(doc('script')).toHaveLength(0);
    expect(doc('style')).toHaveLength(1);
    expect(doc('style').text()).not.toMatch(/var\(--/);
    expect(doc('body strong').text()).toBe('Jo');
  });

  it('no component injects raw HTML into the page any more', () => {
    const offenders: string[] = [];
    const src = path.join(ROOT, 'src');
    for (const f of readdirSync(src, { recursive: true, encoding: 'utf8' })) {
      if (!/\.tsx?$/.test(f) || f.split(path.sep).includes('tests')) continue;
      if (readFileSync(path.join(src, f), 'utf8').includes('dangerouslySetInnerHTML'))
        offenders.push(f.split(path.sep).join('/'));
    }
    expect(offenders).toEqual([]);
    for (const f of [
      'src/components/SignaturesWorkspace.tsx',
      'src/components/SignatureForm.tsx',
    ]) {
      expect(readFileSync(path.join(ROOT, f), 'utf8'), f).toMatch(/<EmailPreview\b/);
    }
  });
});

// ---- the CSS ---------------------------------------------------------------

const TEXT_CONTROL = /input:not\(/;
const base = loadCssFile('src/styles/base.css');
const decl = (rules: ReadonlyArray<CssRule>, pick: (r: CssRule) => boolean, prop: string) =>
  rules.filter(pick).flatMap((r) => r.decls.filter((d) => d.prop === prop).map((d) => d.value));

describe('base.css styles bare controls everywhere (DS-10)', () => {
  const textRule = base.find(
    (r) =>
      r.conditions.length === 0 &&
      TEXT_CONTROL.test(r.selectorText) &&
      /textarea/.test(r.selectorText),
  )!;

  it('the text-control rule is global, not scoped to [data-ds]', () => {
    expect(textRule).toBeDefined();
    expect(textRule.selectorText).not.toContain('data-ds');
    expect(textRule.layer).toBe('base');
    const values = Object.fromEntries(textRule.decls.map((d) => [d.prop, d.value]));
    expect(values).toMatchObject({
      'min-height': 'var(--control-md)',
      'background-color': 'var(--surface-input)',
      border: '1px solid var(--border-control)',
      'border-radius': 'var(--radius-sm)',
      'font-size': 'var(--text-sm)',
      padding: '0 var(--space-3)',
    });
    // Nothing control-related stays behind the [data-ds] scope.
    const scoped = base.filter(
      (r) =>
        r.selectorText.includes('data-ds') && /\b(input|select|textarea)\b/.test(r.selectorText),
    );
    expect(scoped.map((r) => r.selectorText)).toEqual([]);
  });

  it('dark scheme, focus ring, invalid and disabled states, the drawn chevron, the date picker', () => {
    expect(
      decl(base, (r) => /:where\(input, select, textarea\)$/.test(r.selectorText), 'color-scheme'),
    ).toEqual(['dark']);
    expect(
      decl(
        base,
        (r) => /:focus-visible$/.test(r.selectorText) && /select/.test(r.selectorText),
        'box-shadow',
      ),
    ).toEqual(['var(--focus-ring-control)']);
    expect(decl(base, (r) => /aria-invalid/.test(r.selectorText), 'border-color')).toEqual([
      'var(--danger)',
    ]);
    expect(
      decl(base, (r) => /select:not\(\[multiple\], \[size\]\)/.test(r.selectorText), 'appearance'),
    ).toEqual(['none']);
    expect(base.some((r) => r.selectorText.includes('::-webkit-calendar-picker-indicator'))).toBe(
      true,
    );
  });

  it('a coarse pointer gets 16px text and 44px controls (the token)', () => {
    const coarse = base.filter((r) => r.conditions.some((c) => /pointer:\s*coarse/.test(c)));
    expect(decl(coarse, (r) => /textarea/.test(r.selectorText), 'font-size')).toEqual([
      'var(--text-md)',
    ]);
    const tokens = loadCssFile('src/styles/tokens.css');
    expect(
      decl(tokens, (r) => r.conditions.some((c) => /pointer:\s*coarse/.test(c)), '--control-md'),
    ).toEqual(['44px']);
  });

  it('the component module restates the same values in @layer components', () => {
    const mod = loadCssFile('src/components/ui/controls.module.css');
    const control = mod.find((r) => r.selectorText === '.control')!;
    expect(control.layer).toBe('components');
    const values = Object.fromEntries(control.decls.map((d) => [d.prop, d.value]));
    for (const prop of [
      'min-height',
      'background-color',
      'border',
      'border-radius',
      'font-size',
      'padding',
      'line-height',
    ]) {
      expect(values[prop], prop).toBe(textRule.decls.find((d) => d.prop === prop)?.value);
    }
    const coarse = mod.filter((r) => r.conditions.some((c) => /pointer:\s*coarse/.test(c)));
    expect(decl(coarse, (r) => r.selectorText === '.control', 'font-size')).toEqual([
      'var(--text-md)',
    ]);
    expect(decl(mod, (r) => r.selectorText === ".control[data-size='sm']", 'min-height')).toEqual([
      'var(--control-sm)',
    ]);
    expect(decl(mod, (r) => r.selectorText === ".control[data-size='lg']", 'min-height')).toEqual([
      'var(--control-lg)',
    ]);
  });
});

describe('legacy contexts resolve to the base control (the I153 sweep)', () => {
  const rules = loadAppRules();
  /** Every form context the acceptance pages and the sweep touched. */
  const CONTEXTS = [
    'form-grid',
    'inline-form',
    'leads-controls',
    'reject-form',
    'approve-form',
    'edit-draft-form',
    'recipe-form',
    'provider-select',
    'provider-select-nested',
    'comment-form',
    'generate-draft-form',
    'translate-inline',
    'mail-filters',
    'mail-rail-mailbox-select',
    'contacts-filters',
    'contacts-quick-create-form',
    'contact-form',
    'crawl-plan-form',
    'research-form',
    'login-form',
    'reply-fields',
    'config-card',
  ];
  const coarse = { conditionMatches: (p: string) => /pointer:\s*coarse/.test(p) };

  it.each(CONTEXTS)(
    '.%s: input, select and textarea get the base metrics, fill and type',
    (ctx) => {
      const $ = load(
        `<form class="${ctx}"><label><input id="i" type="text"></label><select id="s"><option>a</option></select><textarea id="t"></textarea></form>`,
      );
      for (const id of ['#i', '#s', '#t']) {
        const at = `${ctx} ${id}`;
        // A textarea keeps its context's taller floor (a draft body, a note).
        if (id !== '#t') expect(styleOf($, id, rules, 'min-height'), at).toBe('var(--control-md)');
        expect(styleOf($, id, rules, 'height'), at).toBeUndefined();
        expect(styleOf($, id, rules, 'background'), at).toBeUndefined();
        expect(styleOf($, id, rules, 'background-color'), at).toBe('var(--surface-input)');
        expect(styleOf($, id, rules, 'border-color'), at).toBe('var(--border-control)');
        expect(styleOf($, id, rules, 'font-size'), at).toBe('var(--text-sm)');
        expect(styleOf($, id, rules, 'font-size', coarse), at).toBe('var(--text-md)');
        if (id !== '#t') {
          expect(styleOf($, id, rules, 'padding-top'), at).toBe('0');
          expect(styleOf($, id, rules, 'padding-bottom'), at).toBe('0');
        }
      }
      // The select keeps the drawn chevron: no legacy background hides it.
      expect(styleOf($, '#s', rules, 'background-image'), ctx).toMatch(/linear-gradient/);
      expect(styleOf($, '#s', rules, 'appearance'), ctx).toBe('none');
    },
  );

  it('no legacy rule on a bare select sets a background (it would hide the chevron)', () => {
    const offenders = rules
      .filter((r) => r.layer === 'legacy')
      .filter((r) =>
        r.selectors.some((s) => /(^|[\s>+~])select(\[[^\]]*\]|:[\w-]+(\([^)]*\))?)*$/.test(s)),
      )
      .filter((r) => r.decls.some((d) => /^background(-image)?$/.test(d.prop)))
      .map((r) => `${r.selectorText} (${r.file}:${r.line})`);
    expect(offenders).toEqual([]);
  });

  it('the old config-card switch and signature frame rules are gone', () => {
    const selectors = rules.filter((r) => r.layer === 'legacy').flatMap((r) => r.selectors);
    expect(
      selectors.filter((s) =>
        /config-switch|signature-preview-frame|workspace-switcher select/.test(s),
      ),
    ).toEqual(
      // The phone width cap on the header switcher stays (layout, not look).
      ['.workspace-switcher select'],
    );
  });
});

// ---- types -------------------------------------------------------------------
// Checked by `pnpm typecheck` (this file is never called).
export function typeChecks() {
  // @ts-expect-error a checkbox needs a visible label or an aria-label
  createElement(Checkbox, { name: 'x' });
  // @ts-expect-error a switch needs a visible label or an aria-label
  createElement(Switch, { name: 'x', label: undefined });
  // @ts-expect-error Input is for text-like types; checkboxes are Checkbox
  createElement(Input, { type: 'checkbox' });
  // @ts-expect-error the size is a control size, not the HTML character count
  createElement(Input, { size: 20 });
  // @ts-expect-error a Field takes one control element, not text
  createElement(Field, { label: 'x', children: 'text' }); // eslint-disable-line react/no-children-prop
  createElement(Checkbox, { name: 'ok', 'aria-label': 'Select row' });
  createElement(Switch, { name: 'ok', label: 'On' });
}
