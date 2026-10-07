## Findings

### [P1] Suppress task notifications after runtime shutdown

**Location:** `/home/milanglacier/Desktop/personal-projects/pi-extensions/pi-background-tasks/index.ts:1089-1092`

Reloading Pi with a task that ignores SIGTERM schedules the new SIGKILL timer, then Pi invalidates the old extension runtime. When SIGKILL closes the child five seconds later, `finalizeTask` calls the old `pi.sendMessage`, which throws an uncaught stale-runtime error and crashes interactive Pi. This reproduces with Pi's real loader using `trap "" TERM; echo ready; exec sleep 60`. Clearing `activeCtx` prevents widget updates but not notifications; suppress task notifications after shutdown while retaining process cleanup.

### [P2] Distinguish terminated zombies from surviving processes

**Location:** `/home/milanglacier/Desktop/personal-projects/pi-extensions/pi-background-tasks/tests/process-tree.test.ts:21-24`

On Linux, `process.kill(pid, 0)` succeeds for zombies, so a correctly killed grandchild remains classified as alive until its adopting parent reaps it. In containers with a non-reaping PID 1 or under a non-reaping subreaper, all three process-tree tests therefore fail despite successful termination. Running the suite under a Linux subreaper reproduced these failures, with the killed grandchild confirmed in state `Z`. Check process state as well as PID existence, or provide a reaper for the fixtures.

### [P2] Wait for the grandchild's signal handler before stopping

**Location:** `/home/milanglacier/Desktop/personal-projects/pi-extensions/pi-background-tasks/tests/process-tree.test.ts:119-119`

The parent publishes `$!` before the background subshell has necessarily executed `trap '' TERM`. If the test observes the PID file during that window, its SIGTERM kills the grandchild immediately and the pre-grace survival assertion fails even though the implementation is correct. Stopping this exact fixture as soon as its PID file appeared reproduced early termination without the five-second escalation. Publish readiness from the grandchild after installing its signal handler, and wait for that readiness before stopping the task.

## Overall assessment

**Verdict:** Patch is incorrect.

**Explanation:** Reviewed against the merge base with `main`, `b2f7ca8`. Typechecking and the normal test run pass (27 tests), but shutdown escalation can crash Pi after reload, and the real-process tests have reaping and readiness defects.

## P1 clarification

The stale-runtime notification bug predates this branch. A task that exits on SIGTERM can also emit `close` after Pi invalidates its extension runtime during reload or session replacement (`new`, `resume`, or `fork`). The new SIGKILL escalation adds a predictable trigger for tasks that ignore SIGTERM; it did not introduce the underlying unguarded notification callback.

Output arriving after shutdown can also schedule an output-reaction timer that calls the stale `pi.sendMessage`. Clearing `activeCtx` prevents widget updates but does not suppress either output or exit notifications. Not every task necessarily crashes Pi: another asynchronous shutdown handler could let the child close before runtime invalidation.

The fix uses a per-instance shutdown flag to suppress task events, prevent scheduling output reactions, and guard their callbacks. Shutdown clears pending output timers while preserving task finalization, process-group tracking, and termination timers. The two P2 findings remain separate test-fixture issues.

## P1 fix summary

- `index.ts` sets a per-instance shutdown flag before cleanup. Task notifications and output-reaction scheduling stop after shutdown, and output callbacks check the flag before doing notification work.
- Shutdown clears pending output timers for every task, including tasks already stopping. Child callbacks still collect output and finalize task status; SIGTERM, delayed SIGKILL, and process-group registry cleanup remain active.
- `tests/background-tasks.test.ts` adds six regression cases covering all five shutdown reasons, task closure against a simulated stale API, pending output from an already-stopping task, late stdout/stderr, and continued SIGKILL cleanup. All six failed before the fix and pass with it.

### Verification

- `npm run typecheck` passes.
- `npm test` passes: 33 tests across four files.
- `git diff --check` passes.
- A separate check with Pi's real loader/runtime spawned both a SIGTERM-responsive task and a SIGTERM-resistant task producing continuous output, emitted shutdown, and invalidated the runtime. After the grace period there were no uncaught exceptions or messages, both tasks were stopped, and the process-group registry was empty.

P1 is addressed. The original overall assessment above records the reviewed patch before the fixes; the P2 resolutions are recorded below.

## P2 fix summary

- `tests/process-tree.test.ts` checks process state as well as PID existence. On Linux it reads `/proc/<pid>/stat`, parsing the state after the parenthesized process name; on other POSIX platforms it uses `ps`. Zombie (`Z`) and dead (`X`) processes count as terminated, while running, sleeping, and stopped processes still count as alive.
- The leader-exits-first fixture installs the leader's SIGTERM handler before launching the child. A separate `sh` child installs its ignored SIGTERM disposition, publishes its own PID as the readiness signal, and then executes `sleep`. The test waits for that PID before stopping the group.

### Verification

- `npm run typecheck` passes.
- `npm test` passes: 33 tests across four files.
- All three process-tree tests pass under a Linux subreaper that leaves orphaned children unreaped during the tests. Three zombies were confirmed before the wrapper reaped them.
- In 100 rapid-stop checks, the fixture's grandchild survived SIGTERM after readiness publication while its leader exited. No readiness races were observed.
- `git diff --check` passes. The non-Linux `ps` fallback has not been tested on macOS in this environment.

All three review findings are addressed. The original finding locations and overall assessment are retained as the record of the initial review.

# Second review round

## Findings

No findings.

## Overall assessment

**Verdict:** Patch is correct.

**Explanation:** Reviewed the current changes through `1719d89` against the merge base with `main`, `b2f7ca8`, including the plan, implementation, tests, and Pi lifecycle integration. The implementation matches the plan's stated scope, and all three first-round findings are addressed; an independent lifecycle review found no additional actionable defects. `npm run typecheck`, all 33 tests, and `git diff --check b2f7ca8` pass; the three real-process tests also pass under a Linux subreaper that leaves adopted descendants unreaped until the suite completes.
