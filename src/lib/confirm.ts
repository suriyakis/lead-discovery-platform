// Confirmation mechanics for one-click high-impact form buttons (DS-04).
//
// Pure and browser-safe: the client buttons in src/components call these
// with the real window dialogs, tests call them with stubs. The copy for
// each action lives in ./confirm-copy.ts.
//
// Today the dialogs are the browser's own confirm()/prompt(). DS-11 swaps
// them for an in-app dialog; only browserConfirmUi changes then.

/** The three dialogs a confirmation may use. */
export interface ConfirmUi {
  confirm(message: string): boolean;
  prompt(message: string): string | null;
  alert(message: string): void;
}

export interface ConfirmSpec {
  message: string;
  /**
   * Type-to-confirm. When set, the operator must type exactly this text
   * (surrounding whitespace ignored) instead of clicking OK. Used for the
   * actions that are hardest to notice afterwards: granting platform
   * super-admin and making a workspace billing exempt.
   */
  confirmPhrase?: string;
}

/**
 * Ask the operator to confirm. Returns true when the action may go
 * ahead; false means the caller must cancel the submission.
 */
export function confirmAction(spec: ConfirmSpec, ui: ConfirmUi): boolean {
  const phrase = spec.confirmPhrase?.trim();
  if (!phrase) return ui.confirm(spec.message);
  const typed = ui.prompt(`${spec.message}\n\nType ${phrase} to confirm.`);
  if (typed === null) return false;
  if (typed.trim() === phrase) return true;
  ui.alert(`That did not match "${phrase}". Nothing was changed.`);
  return false;
}

/** The browser's native dialogs, looked up at call time. */
export const browserConfirmUi: ConfirmUi = {
  confirm: (message) => globalThis.confirm(message),
  prompt: (message) => globalThis.prompt(message),
  alert: (message) => globalThis.alert(message),
};

/** The slice of HTMLFormElement the buttons read. */
export interface FormLike {
  elements: { namedItem(name: string): unknown };
}

/**
 * Current value of a named control in the button's form, or '' when the
 * form or the control is missing. Works for input, select and radio
 * groups (RadioNodeList has a value too).
 */
export function readFieldValue(form: FormLike | null | undefined, name: string): string {
  const el = form?.elements.namedItem(name);
  if (el && typeof el === 'object' && 'value' in el) {
    const value = (el as { value: unknown }).value;
    return typeof value === 'string' ? value : '';
  }
  return '';
}

/** Confirm text chosen by the current value of one form control. */
export interface MessageByValue {
  /** Name of the input or select whose value picks the message. */
  field: string;
  /** Value → message. A value with no entry needs no confirmation. */
  messages: Readonly<Record<string, string>>;
}

/** The message for the control's current value, or undefined. */
export function pickMessageForValue(
  spec: MessageByValue,
  form: FormLike | null | undefined,
): string | undefined {
  const value = readFieldValue(form, spec.field);
  return Object.prototype.hasOwnProperty.call(spec.messages, value)
    ? spec.messages[value]
    : undefined;
}
