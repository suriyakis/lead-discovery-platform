/** Joins class names, dropping empties (a module class plus a stable hook, a state class…). */
export const cx = (...names: ReadonlyArray<string | undefined | null | false>) =>
  names.filter(Boolean).join(' ');
