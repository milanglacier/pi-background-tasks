# Keep the subcommand when accepting a `/bg` argument completion

## Context

Typing `/bg watch bg-1` and pressing Enter turns the input into `/bg bg-1`,
which drops `watch`. The command is not run either.

Pi's slash command autocomplete (`@earendil-works/pi-tui`,
`dist/autocomplete.js`) works like this:

- `getSuggestions` passes everything after `/bg ` to `getArgumentCompletions`
  as `prefix` (for example `"watch bg-1"`). It records that whole string as the
  replacement prefix.
- `applyCompletion` replaces **the whole argument string** with `item.value`.
- The editor (`dist/components/editor.js`, `tui.select.confirm`) applies the
  selected item when Enter is pressed while the popup is open. For argument
  completions (prefix not starting with `/`), it does not also submit.
- `getBestAutocompleteMatchIndex` compares `item.value === prefix` against the
  full argument string. This confirms that `value` must hold the full argument
  text.

The `/bg` completions return `value: task.id`, so accepting one replaces
`watch bg-1` with `bg-1`. The popup also stays open after the id is fully typed,
so Enter applies a completion instead of submitting.

This is a bug in the extension's use of the API, not in Pi.

## Changes (`index.ts`, `getArgumentCompletions` of the `/bg` command)

1. **Return the full argument text as `value`.** Keep the task id as `label`
   so the popup looks the same:
   - `{ label: "bg-1", value: "watch bg-1" }`
   - `{ label: "bg-1", value: "watch --follow bg-1" }`
   - `{ label: "bg-1", value: "stop bg-1" }` (and `log` the same way)
2. **Filter task ids by the partially typed id.** Today every task is listed no
   matter what was typed.
3. **Let Enter submit once the argument is complete.** When the typed id exactly
   matches a task id, return `null` so no popup opens and Enter runs the
   command. Apply the same rule to the complete subcommands `dashboard`, `list`
   and `clear`, which have the same double-Enter problem. Trade-off: with
   `bg-1` and `bg-10`, typing `bg-1` hides `bg-10`. That is acceptable because
   `bg-1` is already a valid id.
4. **Handle trailing whitespace and the flag:**
   - `watch ` (trailing space) suggests task ids, not the subcommand list.
   - `watch --f` suggests `watch --follow `.
   - Once the id is followed by a space, or extra words follow it, return
     `null`.

The handler's parsing is unchanged.

## Tests (`tests/background-tasks.test.ts`)

Spawn tasks through the mocked `spawn`, then call the registered command's
`getArgumentCompletions` and check that:

- Subcommand completion still works, and `list` typed exactly returns `null`.
- `watch `, `watch --follow `, and `stop ` return items whose `value` holds the
  full argument text and whose `label` is the id.
- A partial id filters the list.
- An exact id returns `null`.
- `watch --f` suggests `watch --follow `.
- Unknown subcommands and extra trailing words return `null`.

## Verification

- `npm run typecheck` and `npm test` pass in `pi-background-tasks/`.
- Simulate `applyCompletion` from pi-tui on a few inputs and check that the
  result keeps the subcommand, e.g. `/bg watch bg-` + item gives
  `/bg watch bg-1`.
