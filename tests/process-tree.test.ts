import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { BG_PGID_REGISTRY_SYMBOL, BG_STOP_GRACE_MS } from "../background-tasks-shared.js";
import backgroundTasksExtension from "../index.js";
import { createExtensionHarness, type ExtensionHarness } from "./harness.js";

// These tests spawn real shells and check which processes survive a stop.
// Grandchild pids come from a pid file the command writes, because a `pgrep`
// pattern can also match the test's own shell.

function toolText(result: AgentToolResult<unknown>): string {
	const first = result.content[0];
	return first?.type === "text" ? first.text : "";
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		// A zombie still has a PID, but it cannot run or respond to signals.
		let state: string | undefined;
		if (process.platform === "linux") {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			// The parenthesized process name can itself contain spaces and parentheses.
			state = stat.slice(stat.lastIndexOf(")") + 2)[0];
		} else {
			state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim()[0];
		}
		return state !== undefined && state !== "Z" && state !== "X";
	} catch {
		return false;
	}
}

describe.skipIf(process.platform === "win32")("stopping a task's process tree", () => {
	let scratch: string;
	let harness: ExtensionHarness;
	let taskCount = 0;
	const grandchildren: number[] = [];

	beforeAll(async () => {
		scratch = mkdtempSync(join(tmpdir(), "pi-bg-tree-"));
		harness = await createExtensionHarness();
		backgroundTasksExtension(harness.pi);
	});

	afterAll(() => {
		// Clean up after a failed assertion so no test process outlives the suite.
		(globalThis as unknown as Record<PropertyKey, { killAll: () => void } | undefined>)[
			BG_PGID_REGISTRY_SYMBOL
		]?.killAll();
		for (const pid of grandchildren) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
		rmSync(scratch, { force: true, recursive: true });
	});

	const runTool = async (params: Record<string, unknown>): Promise<string> => {
		const tool = harness.tools.get("bg_task");
		if (!tool) {
			expect.unreachable("expected the extension to register a bg_task tool");
		}
		return toolText(await tool.execute("tool", params, undefined, undefined, harness.ctx));
	};

	/** Spawns a command that publishes its grandchild PID after signal setup, and returns both IDs. */
	const spawnTask = async (command: (pidFile: string) => string): Promise<{ id: string; grandchild: number }> => {
		const pidFile = join(scratch, `grandchild-${++taskCount}.pid`);
		const started = await runTool({ action: "spawn", command: command(pidFile), reactToOutput: false });
		const id = started.match(/Started (bg-\d+)/)?.[1];
		if (!id) {
			expect.unreachable(`expected a task id in: ${started}`);
		}
		await vi.waitFor(() => expect(existsSync(pidFile) && readFileSync(pidFile, "utf8").trim()).toMatch(/^\d+$/));
		const grandchild = Number(readFileSync(pidFile, "utf8").trim());
		grandchildren.push(grandchild);
		expect(isAlive(grandchild)).toBe(true);
		return { grandchild, id };
	};

	const taskStatus = async (id: string): Promise<string> => {
		const line = (await runTool({ action: "list" })).split("\n").find((entry) => entry.includes(`${id} ·`));
		return line ?? "";
	};

	it("stops a foreground grandchild of a shell that does not exec it", async () => {
		const { id, grandchild } = await spawnTask((pidFile) => `sh -c 'echo $$ > ${pidFile}; exec sleep 300'; :`);

		await runTool({ action: "stop", id });

		await vi.waitFor(() => expect(isAlive(grandchild)).toBe(false), { timeout: BG_STOP_GRACE_MS / 2 });
		await vi.waitFor(async () => expect(await taskStatus(id)).toContain(`${id} · stopped`));
	});

	it(
		"kills a grandchild that ignores SIGTERM only after the grace period",
		async () => {
			const { id, grandchild } = await spawnTask(
				(pidFile) => `sh -c 'trap "" TERM; echo $$ > ${pidFile}; exec sleep 300'; :`,
			);

			const stoppedAt = Date.now();
			await runTool({ action: "stop", id });

			await new Promise((resolve) => setTimeout(resolve, BG_STOP_GRACE_MS / 2));
			expect(isAlive(grandchild)).toBe(true);

			await vi.waitFor(() => expect(isAlive(grandchild)).toBe(false), { timeout: BG_STOP_GRACE_MS * 2 });
			expect(Date.now() - stoppedAt).toBeGreaterThanOrEqual(BG_STOP_GRACE_MS);
			await vi.waitFor(async () => expect(await taskStatus(id)).toContain(`${id} · stopped`));
		},
		BG_STOP_GRACE_MS * 4,
	);

	it(
		"kills a surviving group member after the leader exits on SIGTERM",
		async () => {
			// The leader installs its trap before launch; the child publishes its own PID after ignoring TERM.
			const { id, grandchild } = await spawnTask(
				(pidFile) =>
					`trap 'exit 0' TERM; sh -c 'trap "" TERM; echo $$ > "$1"; exec sleep 300' sh "${pidFile}" >/dev/null 2>&1 & wait`,
			);

			await runTool({ action: "stop", id });

			// The leader exits at once and the grandchild holds none of the task's
			// pipes, so the task is reported stopped well before the grace period ends.
			await vi.waitFor(async () => expect(await taskStatus(id)).toContain(`${id} · stopped`), {
				timeout: BG_STOP_GRACE_MS / 2,
			});
			expect(isAlive(grandchild)).toBe(true);

			await vi.waitFor(() => expect(isAlive(grandchild)).toBe(false), { timeout: BG_STOP_GRACE_MS * 2 });
		},
		BG_STOP_GRACE_MS * 4,
	);
});
