import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { getShellConfig } from "@earendil-works/pi-coding-agent";
import type { SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import {
	BG_DEFAULT_TIMEOUT_MS,
	BG_MAX_TIMEOUT_SECONDS,
	BG_PGID_REGISTRY_SYMBOL,
	BG_STOP_GRACE_MS,
	isBackgroundTaskEventDetails,
} from "../background-tasks-shared.js";
import { createExtensionHarness, type ExtensionHarness } from "./harness.js";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

// Only the process spawn is mocked. Everything else -- the pi extension API, the
// TypeBox schema builders, StringEnum, getShellConfig, getAgentDir -- is the real
// implementation, so these tests exercise the same contract pi enforces at runtime.
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const backgroundTasksExtension = (await import("../index.js")).default;

type MockChild = EventEmitter & {
	pid: number;
	stdout: EventEmitter;
	stderr: EventEmitter;
	kill: ReturnType<typeof vi.fn>;
};

function createMockChild(pid = 4321): MockChild {
	const child = new EventEmitter() as MockChild;
	child.pid = pid;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.kill = vi.fn();
	return child;
}

/** Reads the first text part of a tool result, failing the test if there is none. */
function toolText(result: AgentToolResult<unknown>): string {
	const first = result.content[0];
	if (first?.type !== "text") {
		expect.unreachable("expected the tool result to start with a text part");
	}
	return first.text;
}

/** Invokes a tool the way pi does, with the full five-argument signature. */
async function runTool(
	tool: ToolDefinition,
	toolCallId: string,
	params: Record<string, unknown>,
	ctx: Parameters<ToolDefinition["execute"]>[4],
): Promise<AgentToolResult<unknown>> {
	return await tool.execute(toolCallId, params, undefined, undefined, ctx);
}

interface PgidRegistry {
	pgids: Set<number>;
	killAll: () => void;
}

/** The process-wide registry of task process groups, created when the extension loads. */
function pgidRegistry(): PgidRegistry {
	const registry = (globalThis as unknown as Record<PropertyKey, PgidRegistry | undefined>)[BG_PGID_REGISTRY_SYMBOL];
	if (!registry) {
		expect.unreachable("expected the extension to create the process group registry");
	}
	return registry;
}

function exitEventCount(messages: { message: { details?: unknown } }[]): number {
	return messages.filter(
		({ message }) => isBackgroundTaskEventDetails(message.details) && message.details.eventType === "exit",
	).length;
}

function requireTool(tools: Map<string, ToolDefinition>, name: string): ToolDefinition {
	const tool = tools.get(name);
	if (!tool) {
		expect.unreachable(`expected the extension to register a ${name} tool`);
	}
	return tool;
}

const inheritedSessionEnv = {
	PI_SESSION_ID: "parent-session",
	PI_SESSION_FILE: "/parent/session.jsonl",
	PI_PROVIDER: "parent-provider",
	PI_MODEL: "parent-model",
	PI_REASONING_LEVEL: "high",
};

function stubSessionEnv(inherited: boolean): void {
	for (const [key, value] of Object.entries(inheritedSessionEnv)) {
		vi.stubEnv(key, inherited ? value : undefined);
	}
}

function spawnedEnv(callIndex = 0): NodeJS.ProcessEnv {
	const options = spawnMock.mock.calls[callIndex]?.[2] as SpawnOptions | undefined;
	if (!options?.env) {
		expect.unreachable("expected spawn to receive an environment");
	}
	return options.env;
}

describe("background tasks extension", () => {
	// The mock children have made-up pids, so no signal may reach a real process.
	let killSpy: MockInstance<typeof process.kill>;

	beforeEach(() => {
		vi.useFakeTimers();
		killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
	});

	afterEach(() => {
		// Forget the made-up groups so the exit listener never signals them.
		(globalThis as unknown as Record<PropertyKey, PgidRegistry | undefined>)[BG_PGID_REGISTRY_SYMBOL]?.pgids.clear();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	describe.each(["bg_task", "/bg run"] as const)("%s session environment", (path) => {
		async function startTask(harness: ExtensionHarness, ctx: ExtensionHarness["ctx"]): Promise<void> {
			spawnMock.mockReturnValueOnce(createMockChild());
			if (path === "bg_task") {
				await runTool(requireTool(harness.tools, "bg_task"), "spawn", { action: "spawn", command: "env" }, ctx);
			} else {
				const bg = harness.commands.get("bg");
				if (!bg) expect.unreachable("expected a /bg command");
				await bg.handler("run env", ctx);
			}
		}

		it.each([false, true])("resolves each spawn from its initiating context (inherited values: %s)", async (inherited) => {
			stubSessionEnv(inherited);
			const harness = await createExtensionHarness();
			backgroundTasksExtension(harness.pi);
			// The lifecycle context differs from the context initiating each task.
			harness.emit("session_start", { type: "session_start" });

			for (const [index, thinkingLevel] of (["off", "medium"] as const).entries()) {
				const ctx: ExtensionHarness["ctx"] = {
					...harness.ctx,
					sessionManager: {
						...harness.ctx.sessionManager,
						getSessionId: () => `session-${index}`,
						getSessionFile: () => `/sessions/${index}.jsonl`,
					},
					model: {
						id: `model-${index}`,
						provider: `provider-${index}`,
						name: "Test model",
						api: "anthropic-messages",
						baseUrl: "https://example.com",
						input: ["text"],
						reasoning: true,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 1000,
						maxTokens: 100,
					},
					thinkingLevel,
				};
				await startTask(harness, ctx);
				expect(spawnedEnv(index)).toMatchObject({
					PI_SESSION_ID: `session-${index}`,
					PI_SESSION_FILE: `/sessions/${index}.jsonl`,
					PI_PROVIDER: `provider-${index}`,
					PI_MODEL: `model-${index}`,
					PI_REASONING_LEVEL: thinkingLevel,
				});
			}
			// Starting the second task does not change the first task's environment.
			expect(spawnedEnv(0)).toMatchObject({ PI_MODEL: "model-0", PI_REASONING_LEVEL: "off" });
		});

		it("removes inherited optional values when the context has no sources for them", async () => {
			stubSessionEnv(true);
			const harness = await createExtensionHarness();
			backgroundTasksExtension(harness.pi);
			delete harness.ctx.thinkingLevel;
			await startTask(harness, harness.ctx);

			const env = spawnedEnv();
			expect(env["PI_SESSION_ID"]).toBe("harness-session");
			for (const key of ["PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) {
				expect(env).not.toHaveProperty(key);
			}
		});
	});

	it("removes inherited session values when a tool call has no context, even with an active lifecycle context", async () => {
		stubSessionEnv(true);
		spawnMock.mockReturnValueOnce(createMockChild());
		const harness = await createExtensionHarness();
		backgroundTasksExtension(harness.pi);
		harness.emit("session_start", { type: "session_start" });
		const tool = requireTool(harness.tools, "bg_task");
		// Pi supplies a context; omit it here to exercise the runtime fallback.
		await tool.execute(
			"spawn",
			{ action: "spawn", command: "env" },
			undefined,
			undefined,
			undefined as unknown as Parameters<ToolDefinition["execute"]>[4],
		);

		for (const key of Object.keys(inheritedSessionEnv)) {
			expect(spawnedEnv()).not.toHaveProperty(key);
		}
	});

	it("spawns tasks, tails logs, reacts to output, and reports completion", async () => {
		const child = createMockChild();
		spawnMock.mockReturnValueOnce(child);

		const harness = await createExtensionHarness();
		backgroundTasksExtension(harness.pi);
		const tool = requireTool(harness.tools, "bg_task");

		const spawnResult = await runTool(tool, "tool-1", { action: "spawn", command: "echo hello" }, harness.ctx);
		expect(toolText(spawnResult)).toContain("Started bg-1");

		const { shell, args } = getShellConfig();
		expect(spawnMock).toHaveBeenCalledWith(
			shell,
			[...args, "echo hello"],
			expect.objectContaining({
				cwd: process.cwd(),
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", "pipe"],
			}),
		);

		child.stdout.emit("data", Buffer.from("watching\n"));
		await vi.advanceTimersByTimeAsync(1_500);
		expect(harness.messages).toHaveLength(1);

		const outputDetails = harness.messages[0]?.message.details;
		expect(isBackgroundTaskEventDetails(outputDetails)).toBe(true);
		if (!isBackgroundTaskEventDetails(outputDetails)) {
			expect.unreachable("expected a background task event payload");
		}
		expect(outputDetails.eventType).toBe("output");

		const listResult = await runTool(tool, "tool-2", { action: "list" }, harness.ctx);
		expect(toolText(listResult)).toContain("bg-1 · running");

		const logResult = await runTool(tool, "tool-3", { action: "log", id: "bg-1" }, harness.ctx);
		expect(toolText(logResult)).toContain("watching");

		child.emit("close", 0);
		expect(harness.messages).toHaveLength(2);

		const exitDetails = harness.messages[1]?.message.details;
		if (!isBackgroundTaskEventDetails(exitDetails)) {
			expect.unreachable("expected a background task event payload");
		}
		expect(exitDetails.eventType).toBe("exit");
		expect(exitDetails.task.status).toBe("completed");
	});

	it("opens the dashboard from the slash command and shortcut, and supports /bg watch --follow", async () => {
		const child = createMockChild();
		spawnMock.mockReturnValueOnce(child);

		const harness = await createExtensionHarness();
		const custom = vi.fn().mockResolvedValue(undefined);
		harness.ctx.ui.custom = custom;
		backgroundTasksExtension(harness.pi);

		const bg = harness.commands.get("bg");
		if (!bg) {
			expect.unreachable("expected the extension to register a /bg command");
		}

		await bg.handler("", harness.ctx);
		expect(custom).toHaveBeenCalledWith(expect.any(Function), {
			overlay: true,
			overlayOptions: { anchor: "center", width: 96, maxHeight: "80%" },
		});

		await bg.handler("run gh pr checks 123 --watch", harness.ctx);
		expect(harness.notifications.at(-1)?.msg).toContain("Started bg-1");

		await bg.handler("watch --follow bg-1", harness.ctx);
		expect(custom).toHaveBeenCalledTimes(2);

		const shortcut = harness.shortcuts.get("ctrl+alt+b");
		if (!shortcut) {
			expect.unreachable("expected the extension to register the ctrl+alt+b shortcut");
		}
		await shortcut.handler(harness.ctx);
		expect(custom).toHaveBeenCalledTimes(3);
	});

	it("completes /bg arguments with the full argument text so the subcommand is kept", async () => {
		spawnMock.mockReturnValueOnce(createMockChild()).mockReturnValueOnce(createMockChild());

		const harness = await createExtensionHarness();
		backgroundTasksExtension(harness.pi);
		const tool = requireTool(harness.tools, "bg_task");
		await runTool(tool, "tool-1", { action: "spawn", command: "sleep 100" }, harness.ctx);
		await runTool(tool, "tool-2", { action: "spawn", command: "sleep 200" }, harness.ctx);

		const complete = harness.commands.get("bg")?.getArgumentCompletions;
		if (!complete) {
			expect.unreachable("expected the /bg command to provide argument completions");
		}
		const values = async (prefix: string) => (await complete(prefix))?.map((item) => item.value) ?? null;

		expect(await values("wa")).toEqual(["watch ", "watch --follow "]);
		expect(await values("ru")).toEqual(["run ", "run --timeout "]);
		expect(await values("list")).toBeNull();

		expect((await values("watch "))?.sort()).toEqual(["watch --follow ", "watch bg-1", "watch bg-2"]);
		expect((await values("watch   "))?.[0]).toBe("watch --follow ");
		expect((await values("watch --follow "))?.sort()).toEqual(["watch --follow bg-1", "watch --follow bg-2"]);
		expect((await values("stop "))?.sort()).toEqual(["stop bg-1", "stop bg-2"]);
		expect((await complete("stop "))?.map((item) => item.label).sort()).toEqual(["bg-1", "bg-2"]);

		expect((await values("watch b"))?.sort()).toEqual(["watch bg-1", "watch bg-2"]);
		expect(await values("watch x")).toBeNull();
		expect(await values("watch bg-2")).toBeNull();
		expect(await values("watch --follow bg-1")).toBeNull();
		expect(await values("watch bg-3")).toBeNull();
		expect(await values("watch --f")).toEqual(["watch --follow "]);
		expect(await values("watch bg- extra")).toBeNull();
		expect(await values("watch bg-1 ")).toBeNull();
		expect(await values("run ")).toBeNull();
	});

	it("stops tracked tasks and clears finished ones", async () => {
		const child = createMockChild();
		spawnMock.mockReturnValueOnce(child);

		const harness = await createExtensionHarness();
		backgroundTasksExtension(harness.pi);
		const tool = requireTool(harness.tools, "bg_task");

		await runTool(tool, "tool-1", { action: "spawn", command: "pnpm test --watch" }, harness.ctx);

		const stopResult = await runTool(tool, "tool-2", { action: "stop", id: "bg-1" }, harness.ctx);
		expect(toolText(stopResult)).toContain("Stopping bg-1");

		child.emit("close", null);

		const clearResult = await runTool(tool, "tool-3", { action: "clear" }, harness.ctx);
		expect(toolText(clearResult)).toContain("Removed 1 finished");
	});

	it.each(["quit", "reload", "new", "resume", "fork"])(
		"finalizes a task without notifying the old runtime after %s shutdown",
		async (reason) => {
			const child = createMockChild();
			spawnMock.mockReturnValueOnce(child);
			const harness = await createExtensionHarness();
			backgroundTasksExtension(harness.pi);
			const tool = requireTool(harness.tools, "bg_task");
			await runTool(tool, "spawn", { action: "spawn", command: "sleep 300", timeoutSeconds: 0 }, harness.ctx);

			harness.emit("session_shutdown", { type: "session_shutdown", reason });
			const sendMessage = vi.spyOn(harness.pi, "sendMessage").mockImplementation(() => {
				throw new Error("This extension ctx is stale after session replacement or reload.");
			});

			expect(() => child.emit("close", null)).not.toThrow();
			expect(sendMessage).not.toHaveBeenCalled();
			expect(toolText(await runTool(tool, "list", { action: "list" }, harness.ctx))).toContain("bg-1 · stopped");

			await vi.advanceTimersByTimeAsync(BG_STOP_GRACE_MS);
			const target = process.platform === "win32" ? child.pid : -child.pid;
			expect(killSpy.mock.calls).toEqual([
				[target, "SIGTERM"],
				[target, "SIGKILL"],
			]);
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it("clears queued output reactions and ignores late output while shutdown cleanup continues", async () => {
		const child = createMockChild();
		spawnMock.mockReturnValueOnce(child);
		const harness = await createExtensionHarness();
		backgroundTasksExtension(harness.pi);
		const tool = requireTool(harness.tools, "bg_task");
		await runTool(tool, "spawn", { action: "spawn", command: "sleep 300", timeoutSeconds: 0 }, harness.ctx);
		await runTool(tool, "stop", { action: "stop", id: "bg-1" }, harness.ctx);
		// A stopping task can still produce output before session shutdown.
		child.stdout.emit("data", Buffer.from("still stopping\n"));
		expect(vi.getTimerCount()).toBe(2);

		harness.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
		const sendMessage = vi.spyOn(harness.pi, "sendMessage").mockImplementation(() => {
			throw new Error("This extension ctx is stale after session replacement or reload.");
		});
		expect(vi.getTimerCount()).toBe(1);
		child.stdout.emit("data", Buffer.from("late stdout\n"));
		child.stderr.emit("data", Buffer.from("late stderr\n"));
		expect(vi.getTimerCount()).toBe(1);
		expect(toolText(await runTool(tool, "log", { action: "log", id: "bg-1" }, harness.ctx))).toContain("late stderr");

		await vi.advanceTimersByTimeAsync(BG_STOP_GRACE_MS - 1);
		expect(killSpy).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		const target = process.platform === "win32" ? child.pid : -child.pid;
		expect(killSpy).toHaveBeenLastCalledWith(target, "SIGKILL");
		expect(() => child.emit("close", null)).not.toThrow();
		expect(sendMessage).not.toHaveBeenCalled();
		expect(toolText(await runTool(tool, "list", { action: "list" }, harness.ctx))).toContain("bg-1 · stopped");
		expect(pgidRegistry().pgids.has(child.pid)).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	describe.skipIf(process.platform === "win32")("process groups", () => {
		it("sends SIGTERM to the group on stop and SIGKILL after the grace period, even after close", async () => {
			const child = createMockChild();
			spawnMock.mockReturnValueOnce(child);

			const harness = await createExtensionHarness();
			backgroundTasksExtension(harness.pi);
			const tool = requireTool(harness.tools, "bg_task");
			await runTool(tool, "tool-1", { action: "spawn", command: "python3 handoff.py" }, harness.ctx);

			const stopResult = await runTool(tool, "tool-2", { action: "stop", id: "bg-1" }, harness.ctx);
			expect(toolText(stopResult)).toContain("Stopping bg-1");
			expect(killSpy.mock.calls).toEqual([[-4321, "SIGTERM"]]);

			child.emit("close", null);
			expect(exitEventCount(harness.messages)).toBe(1);
			const listResult = await runTool(tool, "tool-3", { action: "list" }, harness.ctx);
			expect(toolText(listResult)).toContain("bg-1 · stopped");

			// Other members of the group can outlive the leader, so the SIGKILL still goes out.
			await vi.advanceTimersByTimeAsync(BG_STOP_GRACE_MS - 1);
			expect(killSpy).not.toHaveBeenCalledWith(-4321, "SIGKILL");
			await vi.advanceTimersByTimeAsync(1);
			expect(killSpy.mock.calls).toEqual([
				[-4321, "SIGTERM"],
				[-4321, "SIGKILL"],
			]);
			expect(pgidRegistry().pgids.has(4321)).toBe(false);
			expect(exitEventCount(harness.messages)).toBe(1);
		});

		it("ignores a second stop of a stopping task", async () => {
			spawnMock.mockReturnValueOnce(createMockChild());

			const harness = await createExtensionHarness();
			backgroundTasksExtension(harness.pi);
			const tool = requireTool(harness.tools, "bg_task");
			await runTool(tool, "tool-1", { action: "spawn", command: "sleep 300" }, harness.ctx);

			await runTool(tool, "tool-2", { action: "stop", id: "bg-1" }, harness.ctx);
			await runTool(tool, "tool-3", { action: "stop", id: "bg-1" }, harness.ctx);
			expect(killSpy.mock.calls).toEqual([[-4321, "SIGTERM"]]);

			await vi.advanceTimersByTimeAsync(BG_STOP_GRACE_MS);
			expect(killSpy.mock.calls).toEqual([
				[-4321, "SIGTERM"],
				[-4321, "SIGKILL"],
			]);
		});

		it("marks the task stopped without throwing when its group is already gone", async () => {
			spawnMock.mockReturnValueOnce(createMockChild());
			killSpy.mockImplementation(() => {
				throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
			});

			const harness = await createExtensionHarness();
			backgroundTasksExtension(harness.pi);
			const tool = requireTool(harness.tools, "bg_task");
			await runTool(tool, "tool-1", { action: "spawn", command: "sleep 300" }, harness.ctx);

			const stopResult = await runTool(tool, "tool-2", { action: "stop", id: "bg-1" }, harness.ctx);
			expect(toolText(stopResult)).toContain("Stopping bg-1");
			expect(toolText(await runTool(tool, "tool-3", { action: "list" }, harness.ctx))).toContain("bg-1 · stopped");
			expect(exitEventCount(harness.messages)).toBe(1);

			await vi.advanceTimersByTimeAsync(BG_STOP_GRACE_MS);
			expect(killSpy).toHaveBeenLastCalledWith(-4321, "SIGKILL");
		});

		it("expires a quiet task on time and reports a single exit", async () => {
			const child = createMockChild();
			spawnMock.mockReturnValueOnce(child);

			const harness = await createExtensionHarness();
			backgroundTasksExtension(harness.pi);
			const tool = requireTool(harness.tools, "bg_task");
			await runTool(tool, "tool-1", { action: "spawn", command: "sleep 3600" }, harness.ctx);

			// Nothing else happens in the session, so only the task's own timer can expire it.
			await vi.advanceTimersByTimeAsync(BG_DEFAULT_TIMEOUT_MS - 1);
			expect(killSpy).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(killSpy.mock.calls).toEqual([[-4321, "SIGTERM"]]);
			expect(toolText(await runTool(tool, "tool-2", { action: "log", id: "bg-1" }, harness.ctx))).toContain(
				"[expired] Background task timed out after 10m",
			);

			// Expiry is also checked on every UI refresh; it must not signal the task again.
			child.stdout.emit("data", Buffer.from("shutting down\n"));
			expect(killSpy.mock.calls).toEqual([[-4321, "SIGTERM"]]);
			expect(exitEventCount(harness.messages)).toBe(0);

			child.emit("close", null);
			expect(exitEventCount(harness.messages)).toBe(1);
			const exitDetails = harness.messages.at(-1)?.message.details;
			if (!isBackgroundTaskEventDetails(exitDetails)) {
				expect.unreachable("expected a background task event payload");
			}
			expect(exitDetails.task.status).toBe("stopped");
		});

		it("expires a task after timeoutSeconds, or never when it is 0", async () => {
			spawnMock.mockReturnValueOnce(createMockChild(1111)).mockReturnValueOnce(createMockChild(2222));

			const harness = await createExtensionHarness();
			backgroundTasksExtension(harness.pi);
			const tool = requireTool(harness.tools, "bg_task");
			await runTool(tool, "tool-1", { action: "spawn", command: "make", timeoutSeconds: 30 }, harness.ctx);
			const forever = await runTool(
				tool,
				"tool-2",
				{ action: "spawn", command: "npm run dev", timeoutSeconds: 0 },
				harness.ctx,
			);
			expect(toolText(forever)).toContain("Expiry: none");

			await vi.advanceTimersByTimeAsync(30_000 - 1);
			expect(killSpy).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(killSpy.mock.calls).toEqual([[-1111, "SIGTERM"]]);

			await vi.advanceTimersByTimeAsync(BG_DEFAULT_TIMEOUT_MS * 10);
			expect(killSpy).not.toHaveBeenCalledWith(-2222, expect.anything());
		});

		it("rejects an invalid timeoutSeconds without spawning", async () => {
			const harness = await createExtensionHarness();
			backgroundTasksExtension(harness.pi);
			const tool = requireTool(harness.tools, "bg_task");

			for (const timeoutSeconds of [-1, Number.NaN, Number.POSITIVE_INFINITY, BG_MAX_TIMEOUT_SECONDS + 1]) {
				const result = await runTool(tool, "tool-1", { action: "spawn", command: "sleep 1", timeoutSeconds }, harness.ctx);
				expect((result as { isError?: boolean }).isError).toBe(true);
				expect(toolText(result)).toContain("invalid timeoutSeconds");
			}
			expect(spawnMock).not.toHaveBeenCalled();
		});

		it("does not signal a task that exits before its deadline", async () => {
			const child = createMockChild();
			spawnMock.mockReturnValueOnce(child);

			const harness = await createExtensionHarness();
			backgroundTasksExtension(harness.pi);
			const tool = requireTool(harness.tools, "bg_task");
			await runTool(tool, "tool-1", { action: "spawn", command: "make", timeoutSeconds: 30 }, harness.ctx);

			child.emit("close", 0);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(killSpy).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		});

		it("accepts --timeout directly after /bg run", async () => {
			spawnMock.mockReturnValueOnce(createMockChild(1111)).mockReturnValueOnce(createMockChild(2222));

			const harness = await createExtensionHarness();
			backgroundTasksExtension(harness.pi);
			const bg = harness.commands.get("bg");
			if (!bg) {
				expect.unreachable("expected the extension to register a /bg command");
			}
			const { shell, args } = getShellConfig();

			await bg.handler("run --timeout 30 sleep 100", harness.ctx);
			expect(spawnMock).toHaveBeenLastCalledWith(shell, [...args, "sleep 100"], expect.anything());

			// A `--timeout` after the command name belongs to the command.
			await bg.handler("run sleep --timeout 5", harness.ctx);
			expect(spawnMock).toHaveBeenLastCalledWith(shell, [...args, "sleep --timeout 5"], expect.anything());

			for (const invalid of ["run --timeout abc sleep 1", "run --timeout 30", "run --timeout=30 sleep 1"]) {
				await bg.handler(invalid, harness.ctx);
				expect(harness.notifications.at(-1)).toEqual({
					msg: expect.stringContaining("Usage: /bg run [--timeout <seconds>] <command>"),
					type: "warning",
				});
			}
			expect(spawnMock).toHaveBeenCalledTimes(2);

			await vi.advanceTimersByTimeAsync(30_000);
			expect(killSpy.mock.calls).toEqual([[-1111, "SIGTERM"]]);
			await vi.advanceTimersByTimeAsync(BG_DEFAULT_TIMEOUT_MS - 30_000);
			expect(killSpy).toHaveBeenCalledWith(-2222, "SIGTERM");
		});

		it("clears the widget and signals every running task synchronously on session_shutdown", async () => {
			spawnMock
				.mockReturnValueOnce(createMockChild(1111))
				.mockReturnValueOnce(createMockChild(2222))
				.mockReturnValueOnce(createMockChild(3333));

			const harness = await createExtensionHarness();
			backgroundTasksExtension(harness.pi);
			const bg = harness.commands.get("bg");
			if (!bg) {
				expect.unreachable("expected the extension to register a /bg command");
			}
			await bg.handler("run sleep 100", harness.ctx);
			await bg.handler("run sleep 200", harness.ctx);
			await bg.handler("run true", harness.ctx);
			const finished = spawnMock.mock.results[2]?.value as MockChild;
			finished.emit("close", 0);
			expect(harness.widgets.get("milanglacier.background-tasks")).toBeTypeOf("function");

			expect(harness.emit("session_shutdown", { reason: "quit" })).toEqual([undefined]);
			expect(harness.widgets.get("milanglacier.background-tasks")).toBeUndefined();
			expect(killSpy.mock.calls).toEqual([
				[-1111, "SIGTERM"],
				[-2222, "SIGTERM"],
			]);

			// A task that closes after shutdown does not bring the widget back.
			(spawnMock.mock.results[0]?.value as MockChild).emit("close", null);
			expect(harness.widgets.get("milanglacier.background-tasks")).toBeUndefined();
		});

		it("sends SIGKILL to every registered group on process exit, skipping tasks that finished", async () => {
			const finished = createMockChild(1111);
			spawnMock.mockReturnValueOnce(finished).mockReturnValueOnce(createMockChild(2222));

			const harness = await createExtensionHarness();
			backgroundTasksExtension(harness.pi);
			const tool = requireTool(harness.tools, "bg_task");
			await runTool(tool, "tool-1", { action: "spawn", command: "make" }, harness.ctx);
			await runTool(tool, "tool-2", { action: "spawn", command: "npm run dev" }, harness.ctx);
			finished.emit("close", 0);

			const registry = pgidRegistry();
			expect([...registry.pgids]).toEqual([2222]);
			expect(process.listeners("exit")).toContain(registry.killAll);

			registry.killAll();
			expect(killSpy.mock.calls).toEqual([[-2222, "SIGKILL"]]);
			expect(registry.pgids.size).toBe(0);
		});

		it("installs a single exit listener across extension reloads", async () => {
			const first = await createExtensionHarness();
			backgroundTasksExtension(first.pi);
			const registry = pgidRegistry();
			const listenerCount = process.listenerCount("exit");

			// A reload evaluates the extension module again and loads it into a new pi.
			vi.resetModules();
			const reloaded = (await import("../index.js")).default;
			expect(reloaded).not.toBe(backgroundTasksExtension);
			const second = await createExtensionHarness();
			reloaded(second.pi);

			expect(pgidRegistry()).toBe(registry);
			expect(process.listenerCount("exit")).toBe(listenerCount);
			expect(process.listeners("exit").filter((listener) => listener === registry.killAll)).toHaveLength(1);
		});
	});
});
