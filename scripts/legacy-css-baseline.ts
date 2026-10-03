/* eslint-disable no-console */
/**
 * scripts/legacy-css-baseline.ts — rewrite src/styles/legacy.baseline.json
 * after legacy.css SHRANK (a page cluster moved to components). The
 * baseline is a ratchet: src/tests/design-foundation-css.test.ts fails
 * when legacy.css grows past it or uses a selector it does not list, and
 * also when the baseline is looser than the file, so every removal is
 * locked in. This script refuses to raise the line count or add selectors.
 *
 *   pnpm css:legacy-baseline
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  currentLegacyBaseline,
  LEGACY_BASELINE,
  type LegacyBaseline,
} from '../src/tests/helpers/css-budget';

const file = path.resolve(process.cwd(), LEGACY_BASELINE);
const next = currentLegacyBaseline();

if (existsSync(file) && !process.argv.includes('--init')) {
  const prev = JSON.parse(readFileSync(file, 'utf8')) as LegacyBaseline;
  const added = next.selectors.filter((s) => !prev.selectors.includes(s));
  if (next.lines > prev.lines || added.length > 0) {
    console.error(
      `legacy.css is frozen: it may only shrink. Lines ${prev.lines} → ${next.lines}; new selectors:\n  ` +
        (added.join('\n  ') || '(none)'),
    );
    process.exit(1);
  }
}

writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
console.log(`${LEGACY_BASELINE}: ${next.lines} lines, ${next.selectors.length} selectors`);
