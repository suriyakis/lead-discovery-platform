// `pnpm handbook:export` — writes docs/USER_GUIDE.md from the assistant
// handbook and the navigation registry (AP-03). Needs no database and no
// environment: the output is the same on every machine, and
// src/tests/assistant-handbook.test.ts fails while the committed file
// differs from it. Run it after changing the handbook or the registry.

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { renderUserGuide, USER_GUIDE_PATH } from '../src/lib/assistant/handbook/user-guide';

const target = path.resolve(process.cwd(), USER_GUIDE_PATH);
writeFileSync(target, renderUserGuide());
console.log(`handbook:export wrote ${USER_GUIDE_PATH}`);
