import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isBackgroundTaskEventDetails } from "../background-tasks-shared.js";
import { createExtensionHarness } from "./harness.js";

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

function createMockChild(): MockChild {
	const child = new EventEmitter() as MockChild;
	child.pid = 4321;
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

function requireTool(tools: Map<string, ToolDefinition>, name: string): ToolDefinition {
	const tool = tools.get(name);
	if (!tool) {
		expect.unreachable(`expected the extension to register a ${name} tool`);
	}
	return tool;
}

describe("background tasks extension", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
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

		const shortcut = harness.shortcuts.get("ctrl+shift+b");
		if (!shortcut) {
			expect.unreachable("expected the extension to register the ctrl+shift+b shortcut");
		}
		await shortcut.handler(harness.ctx);
		expect(custom).toHaveBeenCalledTimes(3);
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
});
