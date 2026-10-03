// DS-07: refreshChrome() — after a decision, re-render the workspace frame
// along with the page.
//
// The (app) layout renders the frame once and keeps it across client
// navigation, so the sidebar badges, the bell, the banners and the
// workspace chip only change when the layout renders again. A server
// action that calls refreshChrome() (revalidatePath('/', 'layout')) gets
// the layout re-rendered in its own response: the frame's new attention
// summary reaches the browser with the action's result, whether the
// action redirects or returns a value. withWorkspaceGuard calls it for
// every guarded decision (GUARDED_ACTION_CHROME); other actions that
// change a count call it themselves.
//
// Outside a request (scripts, the test suite calling an action directly)
// there is nothing to revalidate: Next throws its "static generation store
// missing" invariant, which is swallowed here. Any other error (calling it
// during a render) is a programming mistake and is rethrown.

import { revalidatePath } from 'next/cache';

export function refreshChrome(): void {
  try {
    revalidatePath('/', 'layout');
  } catch (err) {
    if (err instanceof Error && err.message.includes('static generation store missing')) return;
    throw err;
  }
}
