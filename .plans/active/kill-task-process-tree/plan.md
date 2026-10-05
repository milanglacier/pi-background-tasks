# Stop the whole process tree of a background task

## Context

Stopping a task, letting it expire, or shutting pi down can leave the task's
processes running. They keep their CPU and memory, and for agent CLIs such as
`claude -p`, their API spend.

### Problem 1: stop signals only the shell

Every task is spawned as `spawn(shell, ["-c", command])` without `detached`
(`index.ts:469`). The task therefore shares pi's process group, so the
extension cannot signal the group. `stopTask` (`index.ts:444`) and the
`session_shutdown` handler (`index.ts:981`) both call
`process.kill(task.pid, "SIGTERM")`, which reaches only the top process.

- If the shell does not `exec` its last command (`a; b`, pipes, `a &`), the
  signal reaches only the shell. The shell exits without passing the signal on,
  and its children are re-parented to init.
- If the shell does `exec` (bash and dash do for a single command or a final
  `&&` command), the signal reaches the command itself. Any process *that*
  command spawned is still not signalled. Most programs do not forward SIGTERM.
  Python's default disposition exits at once.

Reproduced with the `handoff-to-claude-code` skill run as
`python3 handoff.py chat ...`. After SIGTERM to the spawned pid, `python3` was
gone and its `claude` child was still running, for both `sh` and `bash`, with
and without a leading `cd X &&`.

A side effect: `finalizeTask` runs on the child's `close` event, which waits
for stdout/stderr to close. An orphan that inherited the shell's stdout keeps
the pipe open, so a stopped task can stay `running` until the orphan exits.

### Problem 2: expiry does not kill anything

`checkExpiredTasks` (`index.ts:219`) calls `finalizeTask(task, ..., "stopped")`
and never signals the process. When the default 10-minute expiry
(`BG_DEFAULT_TIMEOUT_MS`) fires, the task is reported as stopped while the
process keeps running. Once `task.closed` is set, the real `close` event is
ignored, so nothing tracks the process after that.

It also sends `exit` twice: `finalizeTask` already calls
`sendTaskEvent("exit", task)`, and `checkExpiredTasks` calls it again.

### Problem 3: shutdown is fire-and-forget

`session_shutdown` sends SIGTERM and returns. pi then calls `process.exit`, so a
process that ignores SIGTERM or exits slowly is never followed up with SIGKILL.

pi awaits `session_shutdown` handlers (`runner.js:114` in
`@earendil-works/pi-coding-agent`), and its SIGTERM/SIGHUP handler emits
`session_shutdown` before it touches the terminal (`interactive-mode.js`,
`shutdown({ fromSignal: true })`). An async handler could wait for tasks, but
this plan does not use that (see "Keep it small").

Two pi exit paths skip `session_shutdown` entirely:

- `emergencyTerminalExit`: a write to a dead terminal fails with EIO, for
  example while output is streaming when the tmux window or terminal is closed.
- `uncaughtCrash`.

Both call `killTrackedDetachedChildren()`, but extensions cannot register with
it: `trackDetachedChildPid` and `killProcessTree` are not exported from the
package entry. Both paths end in `process.exit`, so a synchronous
`process.on("exit")` listener in the extension still runs.

### How pi is usually stopped

Closing the terminal window or the tmux window delivers **SIGHUP**, not SIGKILL.
This was checked with tmux 3.7c `kill-window`: a SIGHUP handler that slept 3s
finished, and no SIGKILL followed. pi handles SIGHUP like SIGTERM. Detaching a
tmux client sends nothing. SIGKILL in practice means OOM, `kill -9`, or a
systemd logout with `KillUserProcesses=yes` after its stop timeout.

## Approach

Put each task in its own process group and signal the group.

- **Stop and expiry:** SIGTERM to the group, then an unconditional SIGKILL to
  the group 5s later.
- **pi exit:** `session_shutdown` does the same, and a synchronous
  `process.on("exit")` listener sends SIGKILL to every group still
  registered.

The goal is that no process leaks after a stop, an expiry or pi's exit.
Graceful exit is best effort.

### Keep it small

Drafts of this plan grew one mechanism per edge case. These were considered
and dropped:

- **An async `session_shutdown` that waits for tasks.**
  - It delays pi's exit.
  - When the terminal is gone, pi's render loop and the widget's 1s timer keep
    writing to the dead tty during the wait. The first EIO sends pi into
    `emergencyTerminalExit` → `process.exit`, which cuts the wait short anyway.
- **Probing the group on `close` to decide whether to cancel the SIGKILL
  timer.** An unconditional timer that ignores `ESRCH` covers the same cases.
  This includes a leader that exits first while other members of its group
  live on.
- **Tracking processes left behind by a task that finished on its own** (see
  Out of scope).

### Trade-off of `detached`

With `detached: true`, Node calls `setsid()` in the child. The task gets its own
session and loses its controlling terminal, so it no longer receives
terminal-generated SIGHUP or SIGINT directly. That is acceptable for three
reasons:

- pi runs its TUI in raw mode, so Ctrl-C never produced SIGINT for tasks anyway.
- On SIGHUP/SIGTERM, pi emits `session_shutdown`, which now signals the groups.
- The EIO and crash paths are covered by the `exit` listener (change 5).

The remaining gap is pi itself being SIGKILLed. Today's tasks mostly survive
that too. Document it as a known limitation.

`detached` does not let a task outlive pi by itself. The stdio pipes stay
attached, and the extension never calls `child.unref()`.

## Changes (`index.ts`)

1. **Spawn in a new process group (POSIX only).** Pass `detached: true` when
   `process.platform !== "win32"`. Record `task.pgid = child.pid` only when the
   extension spawned the child itself. A caller-supplied `options.child` gets
   no `pgid` (no caller passes one today, but the option exists).

2. **Add `signalTask(task, signal)`.**
   - With a `pgid`: `process.kill(-pgid, signal)`.
   - Without a `pgid`: `process.kill(task.pid, signal)`, which is the current
     behavior.
   - Windows: keep the current single-pid behavior (see the TODO section).
   - Never throw. `ESRCH` means the group is already gone; swallow it and
     other errors, as the current `try/catch` does.

3. **Add `terminateTask(task)`.** It is synchronous, idempotent, and used by
   stop, expiry and shutdown.
   - If `stopRequested` is already set, return.
   - Set `stopRequested` and send SIGTERM via `signalTask`.
   - `setTimeout(..., 5000).unref()`. When the timer fires, send SIGKILL via
     `signalTask` and drop the pgid from the registry (change 5).
   - Do **not** clear the timer on `close`. `close` only means the pipes the
     extension holds are closed, usually because the leader exited. Other
     members of the group can still be alive. That is exactly what happens
     with `handoff.py` without its forwarding fix: `claude`'s stdio goes to
     Python's pipes, not the task's.
   - The pgid can stay registered for up to 5s after the group empties. The
     risk that the pid is reused by an unrelated group in that window is
     negligible.

   `stopTask` calls it and keeps its current return message. The task becomes
   `stopped` when `close` arrives, as it does today.

4. **Make expiry kill the task.** `checkExpiredTasks` keeps writing the
   `[expired]` line to the log. It then calls `terminateTask`, and stops
   calling `finalizeTask` and `sendTaskEvent` itself. The single `exit` event
   comes from `finalizeTask` on `close`, with status `stopped`. The
   idempotence of `terminateTask` covers repeated calls, since
   `checkExpiredTasks` runs on every `refreshUi`.

5. **Add a process-wide registry and `exit` listener.**
   - A `Set<number>` of pgids on `globalThis` under a `Symbol.for(...)` key.
     The `exit` listener is installed once per process, guarded by the same
     key, so extension reloads never stack listeners.
   - Add the pgid on spawn. Remove it in `finalizeTask` unless the task is
     stopping; a stopping task's pgid is removed when its SIGKILL timer fires.
   - The listener runs synchronously and sends SIGKILL to every registered
     pgid. This covers:
     - normal exit right after `session_shutdown`;
     - `emergencyTerminalExit`;
     - `uncaughtCrash`;
     - tasks of an instance that was shut down on reload and is still in its
       grace period.

6. **Keep `session_shutdown` synchronous.** Clear the widget and its 1s
   render timer **first**, so the extension stops writing to a possibly dead
   terminal. Then call `terminateTask` on every running task, and return.
   - If pi exits next, the `exit` listener sends SIGKILL at once.
   - If pi keeps running (reload, new session, resume), each task's timer
     sends SIGKILL after 5s.

7. **README.** Under the cleanup note (`README.md:53`), state:
   - stop and expiry signal the task's whole process group: SIGTERM, then
     SIGKILL after 5s;
   - when pi exits, tasks get SIGTERM and then SIGKILL almost immediately, so
     a graceful exit is not guaranteed;
   - tasks do not receive terminal hangups directly;
   - processes a task leaves behind after finishing on its own are not
     cleaned up;
   - tasks survive pi being SIGKILLed.

## Tests

### Unit (`tests/background-tasks.test.ts`, mocked `spawn`)

Use `vi.spyOn(process, "kill")` and fake timers.

- `spawn` is called with `detached: true` on POSIX.
- `stop` sends `SIGTERM` to `-pid`. After 5s, `SIGKILL` goes to `-pid`, even
  if the mock child emitted `close` in between. The status is `stopped` once
  `close` arrives, and exactly one `exit` event is sent.
- A second `stop` on a stopping task sends nothing new.
- `ESRCH` from the group kill is handled without throwing.
- Expiry: moving the clock past `expiresAt` sends `SIGTERM` to `-pid`. After
  `close`, the status is `stopped` and exactly one `exit` event was sent.
- `session_shutdown` returns synchronously, after clearing the widget timer
  and sending `SIGTERM` to `-pid` for every running task.
- The `exit` listener sends `SIGKILL` to every registered pgid. A task that
  finished on its own is not registered.
- Loading the extension twice, which simulates a reload, installs only one
  `exit` listener.

### Real processes (new `tests/process-tree.test.ts`, POSIX only)

Run with the real `child_process` and `describe.skipIf(process.platform === "win32")`.

- **No `exec`.** A command that leaves a grandchild, such as `sleep 300; :`.
  Stop the task and check with `process.kill(pid, 0)` that the grandchild is
  gone.
- **Ignores SIGTERM.** A grandchild that runs `trap '' TERM; sleep 300`. Stop
  the task and check that the grandchild is gone only after the grace period.
- **Leader exits first.** The leader starts a child that ignores SIGTERM and
  writes its stdio away from the task's pipes, then traps TERM to exit at once:
  `(trap '' TERM; exec sleep 300) >/dev/null 2>&1 & echo $! > pidfile; trap 'exit 0' TERM; wait`.
  Stop the task and check:
  - the task reports `stopped` before the grace period ends;
  - the `sleep` is gone soon after the grace period.

  This is the shape of `handoff.py` without its forwarding fix.

Read grandchild pids from a pid file the command writes, not from `pgrep`
patterns, which can match the test's own shell.

## Verification

- `npm run typecheck` and `npm test` pass.
- Manual check in a live pi session with a `handoff-to-claude-code` foreground
  run. `/bg stop` and closing the tmux window must both leave no `claude`
  process behind.

## Out of scope

- **Processes a task leaves behind after it finishes on its own**, for
  example `bash -c "server & sleep 1; echo started"`.
  - The leader exits normally, and nobody asked to stop anything. `server`
    stays in the task's group, because non-interactive bash has no job
    control, but it holds no pipe of the task.
  - So `close` fires, the task is `completed`, and its pgid leaves the
    registry. `server` is not killed, not even at pi exit.
  - Today it would usually die with pi's terminal, because it is in pi's
    foreground group and receives the hangup. This plan gives that up to stay
    small.
  - Tasks are already the background mechanism, so this shape is rare.
    Revisit if it leaks in practice.
- Graceful forwarding inside `handoff.py`, which is a separate repo.
- Surviving SIGKILL of pi. That needs an external supervisor, or pi exporting
  `trackDetachedChildPid` so its own emergency paths can kill tasks. Not
  pursued.

## TODO (only if Windows support is wanted; do not implement now)

Windows has no POSIX process groups or signals. Today, `process.kill(pid,
"SIGTERM")` calls `TerminateProcess` on the one `bash.exe` pid. MSYS2/Git Bash
emulates `exec` by starting a new Windows process, so the actual command is
always a child of `bash.exe`. On Windows every stop leaks the command, not just
the no-`exec` cases.

- [ ] Do **not** pass `detached` on Windows. There it means a new console
      window, not a new group. Keep or add `windowsHide: true`.
- [ ] In `signalTask`, kill the tree with
      `${SystemRoot}\System32\taskkill.exe /F /T /PID <pid>`. That mirrors pi's
      internal `killProcessTree`. Alternatively, ask upstream to export
      `killProcessTree` and use it.
- [ ] Accept that stop is always forceful on Windows. There is no SIGTERM
      equivalent for console programs, and `taskkill` without `/F` sends
      `WM_CLOSE`, which they ignore. Skip the grace timer, or make it a no-op.
- [ ] The `exit` listener cannot `await` an async `spawn` of `taskkill`. Use
      `spawnSync` there, or accept best effort.
- [ ] pi listens only for SIGTERM on Windows (not SIGHUP), and Windows rarely
      delivers it. Closing the console window will mostly skip
      `session_shutdown`, so the `exit` listener is the main cleanup path.
      Verify this on a real Windows host.
- [ ] Tests: unit-test the Windows branch by stubbing `process.platform` and
      asserting the `taskkill` arguments. Run the real-process tests on a
      Windows CI runner, or document them as manual.
- [ ] README: list Windows support and its forceful-stop behavior.

## Follow-up: expire tasks on time, with a timeout the caller can set

### Context

Expiry is meant to stop a task a fixed time after it starts (10 minutes by
default, `BG_DEFAULT_TIMEOUT_MS`). In practice it depends on unrelated activity.

- `checkExpiredTasks` has a single caller, `refreshUi` (`index.ts:386`).
  `refreshUi` runs only when a task writes output, a task exits, a task is
  spawned or stopped, or finished tasks are cleared. The widget's and the
  dashboard's 1s timers only call `tui.requestRender()`, and the lifecycle
  events only call `syncWidget`. Neither reaches `checkExpiredTasks`.
- A task that prints nothing, with no other activity in the session, never
  expires. When anything does happen, every overdue task expires at once, so a
  quiet task can be killed long after its deadline because another task
  printed a line.
- The `[expired]` log line is written only when the task has produced output
  (`index.ts:283`). A quiet task, which is exactly the one this fix starts
  expiring, would end up with no record of why it stopped.
- The `bg_task` description says "Pass expiresAt=null to disable the expiry",
  but the tool has no such parameter. `expiresAt` exists only in the internal
  `SpawnTaskOptions`, and `/bg run` cannot set it either. Neither the agent nor
  the user can change the timeout today. Long-running servers survive only
  because of the bug above.

### Approach

A task expires exactly `timeout` after it starts, through a timer, whatever
else happens in the session. The agent and the user get the same default
(10 minutes) and the same way to change it.

### Changes (`index.ts`)

1. **Expiry timer per task.** In `spawnTask`, when `expiresAt` is set, start
   `setTimeout(..., expiresAt - Date.now())` and `unref()` it. Store it on the
   task as `expiryTimer`. When it fires, run the same code as an overdue task
   in `checkExpiredTasks` (write the `[expired]` line, `terminateTask`), then
   `refreshUi()` so the widget shows the new state.
   - Clear `expiryTimer` in `finalizeTask`, so a task that ends early leaves no
     timer behind.
   - Keep the check in `checkExpiredTasks`. It stays correct, and with the
     timer it only ever acts on a task whose timer is about to fire anyway.
   - Node clamps a delay above 2^31 − 1 ms (about 24.8 days) to 1 ms. Change 2
     rejects timeouts that long, so the timer never sees one.

2. **`timeoutSeconds` parameter on `bg_task`.** `Type.Optional(Type.Number())`:
   - omitted: the default, `BG_DEFAULT_TIMEOUT_MS`;
   - `0`: no expiry (`expiresAt: null`);
   - a positive number: expire that many seconds after the start.

   Reject a negative, non-finite, or too-large value (change 1) with an
   `isError` tool result that says to use `0` for no expiry. Use seconds and
   `0` rather than a nullable absolute `expiresAt`: a relative duration is what
   a caller actually means, and some providers handle `null` in tool schemas
   poorly.

   Replace the description's last sentence with one that names
   `timeoutSeconds` and says `0` disables expiry, and that servers and watchers
   meant to outlive the default should pass it.

3. **`/bg run --timeout <seconds> <command>`.** The same values and validation
   as `timeoutSeconds`. `--timeout` is recognised only directly after `run`, so
   a command that itself contains `--timeout` is unaffected. An invalid value
   notifies a warning with the usage. Update the `/bg` description, the unknown
   action hint, and add a `run --timeout` argument completion next to `run`.

4. **Always write the `[expired]` line**, whether or not the task produced
   output.

5. **README.** Document the 10-minute default, `timeoutSeconds` on `bg_task`,
   `/bg run --timeout`, and `0` for no expiry.

### Tests (`tests/background-tasks.test.ts`, mocked `spawn`, fake timers)

- A task with no output and no other activity: advancing the clock by
  `BG_DEFAULT_TIMEOUT_MS` sends `SIGTERM` to `-pid` and writes the `[expired]`
  line to the log. One millisecond earlier, nothing is sent.
- `timeoutSeconds: 30` expires after 30s. `timeoutSeconds: 0` never expires,
  and the spawn result says `Expiry: none`.
- Negative, non-finite, and too-large `timeoutSeconds` return `isError` and
  spawn nothing.
- A task that exits before its deadline is not signalled when the deadline
  passes.
- `/bg run --timeout 30 sleep 100` spawns `sleep 100` and expires after 30s.
  `/bg run sleep --timeout 5` spawns the command verbatim with the default
  timeout. `/bg run --timeout abc sleep 1` warns and spawns nothing.
