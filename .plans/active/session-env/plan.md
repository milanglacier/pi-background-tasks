# Give background tasks the session variables that pi's bash tool sets

## Goal

Commands started with `bg_task` or `/bg run` see the same `PI_SESSION_ID`,
`PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL` and `PI_REASONING_LEVEL` values
that the same command would see under pi's `bash` tool.

The motivating case is the subagent runner in `pi-subagent-skill`. It reads
`PI_PROVIDER`, `PI_MODEL` and `PI_REASONING_LEVEL` to start a subagent with
the caller's model and thinking level, and `PI_SESSION_FILE` for `--fork`.
Started through `bg_task`, it gets none of them in a top-level pi, and the
values of the wrong session inside a subagent.

Draft plan; not yet approved.

## Confirmed scope

- Match pi's `bash` tool behavior, not more: the same five variables, the
  same sources, resolved when the task starts.
- Applies to both spawn paths: the `bg_task` tool and the `/bg run` command.
- No new tool parameters, settings or flags.
- No change to `createBgProcessShellEnv`'s existing behavior. It is exported
  from the package, and its tests cover only the `PATH` update.

## Current implementation

- `spawnTask` in `index.ts` starts the shell with
  `env: createBgProcessShellEnv()`, which copies `process.env` and puts the
  agent `bin` directory on `PATH`.
- pi sets the five variables only in the environment of its own `bash` tool
  commands. They are not in pi's `process.env`, so a top-level pi gives
  background tasks none of them.
- A pi started from another pi's `bash` tool, such as a subagent, has the
  parent's five variables in its `process.env`. Background tasks of that pi
  inherit the parent's session ID, session file and model.
- pi 1.0.4's `bash` tool (`dist/core/tools/bash.js`, `resolveSpawnContext`)
  first deletes all five variables from the inherited environment, then sets
  them from the tool call's context:
  - `PI_SESSION_ID` from `ctx.sessionManager.getSessionId()`.
  - `PI_SESSION_FILE` from `ctx.sessionManager.getSessionFile()`, only when
    the session has a file.
  - `PI_PROVIDER` and `PI_MODEL` from `ctx.model.provider` and `ctx.model.id`,
    only when a model is selected.
  - `PI_REASONING_LEVEL` from `ctx.thinkingLevel`, only when it is set.
- The `bg_task` tool's `execute` receives that context as its fifth argument
  (named `_ctx` and unused today). The `/bg run` handler receives the command
  context, which has the same fields.

## Behavioral contract

- Every spawned task's environment starts from `createBgProcessShellEnv()`,
  then has the five variables removed, then has them set from the context of
  the tool call or command that started the task, by the rules above.
- Values are taken at spawn time. A later `/model` or thinking change does not
  reach a running task, as with `bash`.
- When no context is available, the five variables are removed and none is
  set. A task never inherits stale values from `process.env`.
- Nothing else in the environment changes.

## Implementation steps

### 1. Shared helper

File: `background-tasks-shared.ts`.

- Add a plain data type for the session values (session ID, optional session
  file, optional provider and model, optional thinking level).
- Add a function that takes an environment and those values and returns a new
  environment: delete the five variables, then set the ones that have values.
  Keeping it free of Pi types makes it testable without a context.

### 2. Spawn paths

File: `index.ts`.

- Add a small function that reads the session values from an
  `ExtensionContext`.
- Add an optional session-values field to `SpawnTaskOptions` and build the
  task environment with the new helper in `spawnTask`.
- Pass the values from the `bg_task` tool's context and from the `/bg run`
  handler's context.

### 3. Tests

- `tests/background-tasks-shared.test.ts`: the helper removes stale values,
  sets each variable from its source, omits `PI_SESSION_FILE`, the model
  pair and `PI_REASONING_LEVEL` when their sources are missing, and leaves
  other variables and the `PATH` update alone.
- `tests/background-tasks.test.ts`, with the existing harness: a task started
  by `bg_task` with a mock context prints the five variables, and the output
  matches the context, also when `process.env` holds different values.
  Repeat for `/bg run`.

### 4. Documentation

File: `README.md`.

- State that background tasks get the same `PI_*` session variables as pi's
  `bash` tool, resolved when the task starts.

### 5. Verification

- `npm run build` (typecheck and tests) from this submodule.
- Do not commit, release or bump the parent gitlink as part of this plan.

## Acceptance criteria

- A command run with `bg_task` and the same command run with `bash` in the
  same session see the same five values.
- Inside a pi whose `process.env` holds another session's values, background
  tasks see their own session's values.
- Other environment variables and the `PATH` update are unchanged.
- All checks pass.

## Review addendum

The following clarifications amend the implementation and test instructions
above without changing the original plan text.

### Test the environment passed to spawn

`tests/background-tasks.test.ts` mocks `spawn`, so commands in that suite
cannot actually print environment variables. For both `bg_task` and `/bg run`,
assert the `env` passed to `spawnMock` against the initiating context,
including when `process.env` contains different values. This replaces the
printed-output test described in step 3. A real subprocess test would require
a separate setup without the spawn mock.

### Cover missing values and successive spawns

- Test that missing context removes all five inherited session variables.
- Test that missing optional context fields remove their corresponding
  inherited variables rather than retaining stale values.
- Test that `thinkingLevel: "off"` sets `PI_REASONING_LEVEL` to `off`; it is a
  value, not an absent thinking level.
- For both spawn paths, start two tasks with different context values and
  assert that each receives its own values. This guards against caching
  session values between spawns.

### Limit bash parity to default session-variable injection

References to matching pi's `bash` tool mean its default injection of these
five session variables. They do not include environment changes made by a
bash `spawnHook`, disabling session-environment exposure, or a replacement
bash tool. Apply this qualification to the README wording and acceptance
criteria.
