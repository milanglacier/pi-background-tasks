# Progress

Status: done. Implemented, verified, and checked manually in a live Pi session.

## Done

- `index.ts`: `taskPromptOptions(argumentHead)` now returns
  `value: "<head> <id>"` (for example `watch bg-1`, `watch --follow bg-1`,
  `stop bg-1`). The `label` is still the bare id.
- `index.ts`, `/bg` `getArgumentCompletions`:
  - Task ids are filtered by the partially typed id.
  - An exact task id returns `null`, so Enter submits the command. So does an
    exact `dashboard`, `list` or `clear`.
  - `watch ` with a trailing space (any number of spaces) suggests
    `--follow` first, then the task ids, instead of the subcommand list. The
    same applies to `log `. `stop ` suggests only task ids.
  - `watch --f` (and `log --f`) suggests `<subcommand> --follow `.
  - An id followed by a space or by extra words returns `null`. So do unknown
    flags and subcommands without argument completion (`run`, ...).
- `tests/background-tasks.test.ts`: added
  "completes /bg arguments with the full argument text so the subcommand is
  kept". It covers the cases above.

## Verification

- Manual check in a live Pi session by the user: passes.
- `npm run typecheck`: passes.
- `npm test`: 12/12 pass.
- Ran pi-tui's real `CombinedAutocompleteProvider` against the real extension
  (temporary test, since removed), with tasks `bg-1` and `bg-2`. The first
  item is `bg-2` because tasks are sorted newest first:
  - `/bg watch bg-` -> `/bg watch bg-2`
  - `/bg watch --follow bg-` -> `/bg watch --follow bg-2`
  - `/bg stop b` -> `/bg stop bg-2`
  - `/bg watch ` -> `/bg watch --follow ` (first item; the ids follow)
  - `/bg wa` -> `/bg watch `
  - `/bg watch bg-1` -> no popup, so Enter submits
  - `/bg list` -> no popup, so Enter submits

## Known trade-offs

- With `bg-1` and `bg-10`, typing `bg-1` hides `bg-10`, because the exact
  match closes the popup.
- Completion matches the subcommand case-insensitively (`LIST` returns
  `null`), but the handler matches case-sensitively. This was already the
  case before this change and is left as is.
