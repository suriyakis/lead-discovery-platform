// Horizontal-scroll container for data tables (DS-03, I145/I146).
//
// A wide table must scroll inside its own box on a phone instead of
// pushing the whole page sideways. `.table-scroll` (globals.css) gives the
// box `overflow-x: auto` and caps it at the column width; the AppShell
// grid column is `minmax(0, 1fr)`, so the cap actually holds.
//
// With a `label` the box becomes a named region, so a screen-reader user
// who lands in the scrolled area knows which table it is. Server
// component: no state, no client JS.

export function TableScroll({
  children,
  label,
  className,
}: Readonly<
  React.PropsWithChildren<{
    /** Accessible name for the scroll region, e.g. "Token usage by month". */
    label?: string;
    /** Extra classes, e.g. `data-table-wrap` for the boxed card variant. */
    className?: string;
  }>
>) {
  return (
    <div
      className={className ? `table-scroll ${className}` : 'table-scroll'}
      {...(label ? { role: 'region', 'aria-label': label } : {})}
    >
      {children}
    </div>
  );
}
