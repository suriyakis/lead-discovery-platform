'use client';

// P62-14: reactive Provider + Model dropdown pair. Renders the same
// shape as ProviderSelect + ModelSelect (so the server action gets the
// same form field names), but watches the provider select client-side
// and refilters the model options on change instead of waiting for a
// page reload. Used by the Internet Data Extraction card on
// /settings/integrations.

import { useState } from 'react';

interface Props {
  providers: ReadonlyArray<string>;
  /** Per-provider model catalog. Keyed by provider id. */
  catalog: Record<string, readonly string[]>;
  /** Form field name for the provider <select>. */
  providerName: string;
  /** Form field name for the model <select>. */
  modelName: string;
  /** workspaceValue currently saved for the provider (null = inherit). */
  initialProvider: string | null;
  /** workspaceValue currently saved for the model (null = default). */
  initialModel: string | null;
  /** Resolved active provider when initialProvider is null — shown in
   *  the inherit option label. */
  envFallbackLabel: string;
  /** Resolved active provider — shown as the (active: X via Y) caption. */
  resolved: { id: string; source: 'workspace' | 'env' | 'default' };
}

const ENV_TOKEN = '__env__';
const DEFAULT_TOKEN = '__default__';

export function ProviderModelPair({
  providers,
  catalog,
  providerName,
  modelName,
  initialProvider,
  initialModel,
  envFallbackLabel,
  resolved,
}: Props) {
  const [providerValue, setProviderValue] = useState<string>(
    initialProvider ?? ENV_TOKEN,
  );
  const [modelValue, setModelValue] = useState<string>(
    initialModel ?? DEFAULT_TOKEN,
  );

  // The provider whose model catalog drives the Model dropdown:
  //   - explicit workspace pick → that provider
  //   - ENV_TOKEN ("inherit") → use the resolved active id
  const effectiveProvider =
    providerValue === ENV_TOKEN ? resolved.id : providerValue;
  const models = catalog[effectiveProvider] ?? [];

  function onProviderChange(next: string) {
    setProviderValue(next);
    // When the chosen provider's catalog doesn't contain the current
    // model, reset to the provider default. (E.g. switching from
    // openai → gemini, gpt-5-nano stops being valid.)
    const nextCatalog =
      catalog[next === ENV_TOKEN ? resolved.id : next] ?? [];
    if (modelValue !== DEFAULT_TOKEN && !nextCatalog.includes(modelValue)) {
      setModelValue(DEFAULT_TOKEN);
    }
  }

  return (
    <>
      <label className="provider-select-nested">
        <span>
          Provider{' '}
          <span className="muted small">
            (active: <code>{resolved.id}</code> via {resolved.source})
          </span>
        </span>
        <select
          name={providerName}
          value={providerValue}
          onChange={(e) => onProviderChange(e.target.value)}
        >
          <option value={ENV_TOKEN}>
            inherit env default ({envFallbackLabel})
          </option>
          {providers.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>

      <label className="provider-select-nested">
        <span>
          Model{' '}
          <span className="muted small">
            (for <code>{effectiveProvider}</code>)
          </span>
        </span>
        {models.length === 0 ? (
          <select name={modelName} disabled defaultValue={DEFAULT_TOKEN}>
            <option value={DEFAULT_TOKEN}>— not applicable —</option>
          </select>
        ) : (
          <select
            name={modelName}
            value={modelValue}
            onChange={(e) => setModelValue(e.target.value)}
          >
            <option value={DEFAULT_TOKEN}>— provider default —</option>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        )}
      </label>
    </>
  );
}
