## What and why

<!-- What changes, and the problem it solves. Link the issue / audit id (I…, X…). -->

## Tests

<!-- What you added or changed, and the result of `pnpm test`, `pnpm typecheck`, `pnpm lint`. -->

## Checklist

- [ ] Every tenant query is scoped by `ctx.workspaceId`; significant actions write `audit_log`, AI/search/job work writes `usage_log`.
- [ ] Tests cover everything this PR touches.
- [ ] If this changes what an operator sees or how a flow behaves, `src/lib/assistant/handbook.ts` is updated in this PR: the affected claim and its `[handbook H-xx]` test, and the "Known limitations right now" line of any issue this PR fixes is removed. The in-app assistant quotes the handbook to operators.
- [ ] Migrations (if any) were generated with `pnpm db:generate` and are safe on production data.
