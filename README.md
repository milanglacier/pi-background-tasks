# pi-background-tasks

Reactive background shell tasks for pi.

A fork, extracted from the `background-tasks` package in the [monopi](https://github.com/ifiokjr/monopi)
monorepo and maintained standalone. Registry keys are namespaced under `milanglacier.background-tasks`,
so this loads alongside the upstream package without clashing with it.

## Install

```bash
pi install npm:@milanglacier/pi-background-tasks
```

## What it provides

This package turns explicit background shell commands into a first-class pi workflow:

- ordinary `bash` commands stay in the foreground and use pi's built-in execution flow
- `bg_status`: compatibility tool for listing, tailing, and stopping tracked background tasks by PID
- `bg_task`: richer LLM-callable tool for spawning, listing, tailing, stopping, and clearing tasks by id or PID
- `/bg`: slash command for launching and managing background tasks manually
- `Ctrl+Alt+B`: richer multi-pane dashboard overlay with a task list, metadata pane, and scrollable log tail
- `/bg watch --follow <id>`: jump straight into the output pane for a task with follow-tail mode enabled
- reactive follow-ups: pi can wake itself up when watched tasks emit new output or exit
- persistent log files for every spawned task

> [!NOTE]
> The dashboard shortcut changed from `Ctrl+Shift+B` to `Ctrl+Alt+B`, because `Ctrl+Shift+B` doesn't work in most terminals.

## Example flows

```text
/bg run gh pr checks 123 --watch
/bg run pnpm test --watch
/bg run --timeout 0 pnpm dev
/bg watch bg-1
/bg watch --follow bg-1
/bg stop bg-1
```

The `bg_task` tool lets the agent start tasks explicitly and optionally gate wakeups with a substring or `/regex/flags` pattern.

A task is stopped 10 minutes after it starts by default. Set a different timeout in seconds with `timeoutSeconds` on
`bg_task` or `--timeout <seconds>` directly after `/bg run`. A timeout of `0` lets the task run until it is stopped,
which suits servers and watchers.

The dashboard supports:

- `Tab` to switch between the task list and output pane
- `↑↓`, `Shift+↑`, `Shift+↓`, `Home`, and `End` for navigation
- `f` to toggle follow-tail mode
- `s` to stop the selected task
- `c` to clear finished tasks

## Notes

- `bg_task` and `/bg run` set `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, and `PI_REASONING_LEVEL`
  from the session that starts the task. Values stay fixed for that task; missing values are omitted, not inherited
  from a parent session. This matches the built-in `bash` defaults, regardless of bash-specific settings or customizations.
- tasks are tracked for the current pi runtime and cleaned up on session shutdown
- on Linux and macOS, every task runs in its own process group. Stopping a task or letting it expire sends
  `SIGTERM` to the whole group, then `SIGKILL` 5 seconds later, so processes the task started are stopped too
- when pi exits, running tasks get `SIGTERM` and then `SIGKILL` almost immediately, so a task may not get to exit
  gracefully
- tasks have no controlling terminal, so they do not receive terminal hangups directly. pi stops them when the
  terminal closes
- processes that a task leaves behind after it finishes on its own keep running
- tasks keep running if pi itself is killed with `SIGKILL`
- every task writes output to a log file so you can inspect recent activity even after the command returns
- use `bg_task` or `/bg` for servers, watchers, PR checks, and other commands you want to keep running after the tool returns
- `reactToOutput` defaults to `true`, so long-lived watchers like `gh ... --watch` can wake the agent when new output arrives

This package ships raw `.ts` sources for pi to load directly.

## Development

```bash
npm install
npm run typecheck   # tsc under strict + exactOptionalPropertyTypes + noUncheckedIndexedAccess
npm test            # vitest
npm run build       # both
```

Tests run the extension against pi's real `ExtensionAPI` and `ExtensionCommandContext` types via
`tests/harness.ts`; the only mocked module in the suite is `node:child_process`.
