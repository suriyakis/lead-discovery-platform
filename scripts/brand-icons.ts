// pnpm brand:icons — writes every brand file from src/lib/brand-mark.ts
// (DS-08): src/app/icon.svg, favicon.ico, apple-icon.png,
// opengraph-image.png (+ .alt.txt) and the manifest icons in
// public/icons/. Run it after changing the mark's geometry, the brand
// colours (src/lib/brand.ts follows tokens.css) or the link-preview card,
// and commit the results together with scripts/brand-icons.lock.json.
//
// PNGs are rasterised by Playwright's Chromium (already a dev dependency
// for the e2e suite: `pnpm exec playwright install chromium` once per
// machine). The link-preview card loads Inter and JetBrains Mono from
// Google Fonts while it renders, so run this online.
//
// The lock file records, per file, the hash of the source it was rendered
// from and of the bytes written; src/tests/brand.test.ts fails when the
// geometry or colours changed without a re-run, or a file was edited by hand.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from '@playwright/test';
import {
  BRAND_ICON_FILES,
  BRAND_ICON_LOCK_FILE,
  OG_IMAGE_ALT,
  OG_IMAGE_ALT_FILE,
  type BrandIconFile,
  type BrandIconLock,
} from '../src/lib/brand-mark';

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

function write(file: string, data: string | Buffer) {
  const abs = path.resolve(process.cwd(), file);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, data);
}

/** Rasterise one SVG or HTML source at width × height, transparent where it is. */
async function render(page: Page, source: string, width: number, height: number): Promise<Buffer> {
  await page.setViewportSize({ width, height });
  const html = source.trimStart().startsWith('<svg')
    ? `<!doctype html><html><head><style>html,body{margin:0;background:transparent}svg{display:block;width:${width}px;height:${height}px}</style></head><body>${source}</body></html>`
    : source;
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  return page.screenshot({
    type: 'png',
    omitBackground: true,
    clip: { x: 0, y: 0, width, height },
  });
}

/**
 * An .ico holding PNG frames (Vista+ and every current browser read
 * PNG-in-ICO): ICONDIR, one ICONDIRENTRY per frame, then the PNGs.
 */
function encodeIco(frames: ReadonlyArray<{ size: number; png: Buffer }>): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(frames.length, 4);
  const entries: Buffer[] = [];
  let offset = 6 + 16 * frames.length;
  for (const { size, png } of frames) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 = 256)
    e.writeUInt8(size >= 256 ? 0 : size, 1); // height
    e.writeUInt8(0, 2); // palette colours
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...frames.map((f) => f.png)]);
}

async function build(page: Page, spec: BrandIconFile): Promise<Buffer> {
  switch (spec.kind) {
    case 'svg':
      return Buffer.from(spec.source, 'utf8');
    case 'png': {
      const { width, height } = spec.sizes[0]!;
      return render(page, spec.source, width, height);
    }
    case 'ico': {
      const frames = [];
      for (const { width } of spec.sizes) {
        frames.push({ size: width, png: await render(page, spec.source, width, width) });
      }
      return encodeIco(frames);
    }
  }
}

async function main() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    const lock: BrandIconLock = { files: {} };
    for (const spec of BRAND_ICON_FILES) {
      const bytes = await build(page, spec);
      write(spec.file, bytes);
      lock.files[spec.file] = { source: sha256(spec.source), output: sha256(bytes) };
      console.log(`wrote ${spec.file} (${bytes.length} bytes)`);
    }
    write(OG_IMAGE_ALT_FILE, OG_IMAGE_ALT);
    console.log(`wrote ${OG_IMAGE_ALT_FILE}`);
    write(BRAND_ICON_LOCK_FILE, `${JSON.stringify(lock, null, 2)}\n`);
    console.log(`wrote ${BRAND_ICON_LOCK_FILE}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
