// Renderers for the gallery's token samples (DS-06). Each sample reads its
// token through a custom property set inline (cssVars), so the module CSS
// never hard-codes a value and the gallery shows exactly what tokens.css
// says.

import type { ReactNode } from 'react';
import { cssVars, type CssVarName } from '@/lib/ui/css-vars';
import { SURFACES, TONES, type TokenEntry, type TokenGroup, toneTokens } from './_catalog';
import styles from './gallery.module.css';

const v = (name: CssVarName) => `var(${name})`;

export function GallerySection({
  id,
  title,
  description,
  children,
}: Readonly<{ id: string; title: string; description?: ReactNode; children: ReactNode }>) {
  return (
    <section id={id} className={styles.section} aria-labelledby={`${id}-title`}>
      <div className={styles.sectionHead}>
        <h2 id={`${id}-title`} className={styles.sectionTitle}>
          {title}
        </h2>
        {description ? <p className={styles.sectionDesc}>{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Caption({ token }: Readonly<{ token: TokenEntry }>) {
  return (
    <figcaption className={styles.caption}>
      <code className={styles.name}>{token.name}</code>
      <span className={styles.use}>{token.use}</span>
    </figcaption>
  );
}

/** One surface tile; a translucent surface is drawn over the one it lives on. */
function SurfaceTile({
  surface,
  sample,
  children,
}: Readonly<{ surface: (typeof SURFACES)[number]; sample?: string; children: ReactNode }>) {
  const base = surface.over ?? surface.name;
  return (
    <span className={styles.tile} style={cssVars({ '--tile-base': v(base) })}>
      <span
        className={styles.tileTop}
        style={cssVars({
          ...(surface.over ? { '--tile-top': v(surface.name) } : {}),
          ...(sample ? { '--sample': sample } : {}),
        })}
      >
        {children}
        <span className={styles.tileLabel}>{surface.label}</span>
      </span>
    </span>
  );
}

function TokenSample({
  group,
  token,
  index,
}: Readonly<{ group: TokenGroup; token: TokenEntry; index: number }>) {
  const sample = cssVars({ '--sample': v(token.name) });
  switch (group.kind) {
    case 'fill':
      return (
        <span
          className={
            token.name.startsWith('--glyph') ? `${styles.fill} ${styles.glyph}` : styles.fill
          }
          style={sample}
        />
      );
    case 'line':
      return <span className={styles.line} style={sample} />;
    case 'bar':
      return (
        <span className={styles.barTrack}>
          <span className={styles.bar} style={sample} />
        </span>
      );
    case 'ramp':
      return (
        <span
          className={styles.rampBar}
          style={cssVars({ '--sample': v(token.name), '--w': `${100 - index * 15}%` })}
        />
      );
    case 'height':
      return <span className={styles.height} style={sample} />;
    case 'radius':
      return <span className={styles.radius} style={sample} />;
    case 'shadow':
      return <span className={styles.shadow} style={sample} />;
    case 'type':
      return (
        <p
          className={
            token.name === '--text-label'
              ? `${styles.typeSample} ${styles.labelSample}`
              : styles.typeSample
          }
          style={sample}
        >
          Ping the market
        </p>
      );
    case 'text':
    case 'value':
      return null;
  }
}

/** A token group: swatches in a grid, text samples on every surface, or a value list. */
export function TokenGroupSamples({ group }: Readonly<{ group: TokenGroup }>) {
  if (group.kind === 'value') {
    return (
      <ul className={styles.values}>
        {group.tokens.map((token) => (
          <li key={token.name} className={styles.valueRow}>
            <code className={styles.name}>{token.name}</code>
            <span className={styles.use}>{token.use}</span>
          </li>
        ))}
      </ul>
    );
  }
  if (group.kind === 'text') {
    return (
      <div className={styles.stack}>
        {group.tokens.map((token) => (
          <figure key={token.name} className={`${styles.item} ${styles.surfaceRow}`}>
            <Caption token={token} />
            <div className={styles.surfaces}>
              {SURFACES.map((surface) => (
                <SurfaceTile key={surface.name} surface={surface} sample={v(token.name)}>
                  Aa 12 · sample
                </SurfaceTile>
              ))}
            </div>
          </figure>
        ))}
      </div>
    );
  }
  return (
    <div className={group.kind === 'type' ? `${styles.grid} ${styles.gridWide}` : styles.grid}>
      {group.tokens.map((token, index) => (
        <figure key={token.name} className={styles.item}>
          <TokenSample group={group} token={token} index={index} />
          <Caption token={token} />
        </figure>
      ))}
    </div>
  );
}

/** Every tone as a chip on every surface: the visual twin of tokens.ui.test.ts. */
export function ToneSamples() {
  return (
    <div className={styles.stack}>
      {TONES.map(({ tone, use }) => {
        const [color, soft, line] = toneTokens(tone);
        const vars = cssVars({
          '--t': v(color!),
          ...(soft ? { '--t-soft': v(soft) } : {}),
          ...(line ? { '--t-line': v(line) } : {}),
        });
        return (
          <figure
            key={tone}
            className={`${styles.item} ${styles.surfaceRow}`}
            data-tone-sample={tone}
          >
            <figcaption className={styles.caption}>
              <code className={styles.name}>{toneTokens(tone).join(' ')}</code>
              <span className={styles.use}>
                {tone}: {use}
              </span>
            </figcaption>
            <div className={styles.surfaces}>
              {SURFACES.map((surface) => (
                <SurfaceTile key={surface.name} surface={surface}>
                  <span className={styles.chip} style={vars}>
                    <span className={styles.dot} />
                    {tone}
                  </span>
                </SurfaceTile>
              ))}
            </div>
          </figure>
        );
      })}
    </div>
  );
}
