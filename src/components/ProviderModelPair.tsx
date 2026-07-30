'use client';

// P62-14: reactive Provider + Model dropdown pair. Renders the same
// shape as ProviderSelect + ModelSelect (so the server action gets the
// same form field names), but watches the provider select client-side
// and refilters the model options on change instead of waiting for a
// page reload. Used by the Internet Data Extraction card on
// /settings/integrations.

import { useEffect, useState } from 'react';

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
  resolved: { id: string; source: 'workspace' | 'platform' | 'env' | 'default' };
  /** Override the inherit-option text (default: "platform default (…)").
   *  The admin console uses "automatic — currently X". */
  inheritLabel?: string;
}

const ENV_TOKEN = '__env__';
const DEFAULT_TOKEN = '__default__';
const CUSTOM_TOKEN = '__custom__';

/** Hybrid combobox. Native <select> for the catalog plus a "Custom
 *  model..." entry that flips to a free-text input — so the operator
 *  can pick a known model OR type any vendor id without a deploy. */
function ModelPicker({
  name,
  value,
  onChange,
  models,
}: {
  name: string;
  value: string;
  onChange: (v: string) => void;
  models: ReadonlyArray<string>;
}) {
  // Whether the operator is currently in custom-text mode. We treat
  // any saved value not in `models` (and not DEFAULT_TOKEN) as custom.
  const valueIsCustom =
    value !== DEFAULT_TOKEN && !models.includes(value);
  const [customMode, setCustomMode] = useState(valueIsCustom);

  // Keep custom-mode in sync if the model list changes underneath
  // (e.g. provider switched). When the new catalog includes the
  // current value, drop out of custom mode.
  useEffect(() => {
    if (value === DEFAULT_TOKEN) {
      setCustomMode(false);
      return;
    }
    setCustomMode(!models.includes(value));
  }, [value, models]);

  if (models.length === 0) {
    return (
      <input
        type="text"
        name={name}
        disabled
        placeholder="— not applicable —"
      />
    );
  }

  if (customMode) {
    return (
      <div className="provider-select-nested-row">
        <input
          type="text"
          name={name}
          value={value === DEFAULT_TOKEN ? '' : value}
          onChange={(e) => {
            const next = e.target.value.trim();
            onChange(next === '' ? DEFAULT_TOKEN : next);
          }}
          placeholder="e.g. gemini-3.5-flash-preview"
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          className="ghost-btn small"
          onClick={() => {
            onChange(DEFAULT_TOKEN);
            setCustomMode(false);
          }}
          title="Use a model from the suggestion list instead"
        >
          Pick
        </button>
      </div>
    );
  }

  return (
    <select
      name={name}
      value={value}
      onChange={(e) => {
        if (e.target.value === CUSTOM_TOKEN) {
          setCustomMode(true);
          onChange(DEFAULT_TOKEN);
        } else {
          onChange(e.target.value);
        }
      }}
    >
      <option value={DEFAULT_TOKEN}>— provider default —</option>
      {models.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
      <option value={CUSTOM_TOKEN}>Custom model… (type any id)</option>
    </select>
  );
}

export function ProviderModelPair({
  providers,
  catalog,
  providerName,
  modelName,
  initialProvider,
  initialModel,
  envFallbackLabel,
  resolved,
  inheritLabel,
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
            {inheritLabel ?? `platform default (${envFallbackLabel})`}
          </option>
          {providers.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>

      <label className="provider-select-nested">
        <span>Model</span>
        <ModelPicker
          name={modelName}
          value={modelValue}
          onChange={setModelValue}
          models={models}
        />
      </label>
    </>
  );
}
