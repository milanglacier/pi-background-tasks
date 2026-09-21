import { describe, expect, it } from "vitest";

import { createExtensionHarness } from "./harness.js";
import backgroundTasksExtension from "../index.js";

describe("background tasks runtime smoke tests", () => {
	it("registers tools, commands, shortcuts, and message renderers", async () => {
		const harness = await createExtensionHarness();
		backgroundTasksExtension(harness.pi);

		expect(harness.tools.has("bg_task")).toBe(true);
		expect(harness.tools.has("bg_status")).toBe(true);
		expect(harness.tools.has("bash")).toBe(false);
		expect(harness.commands.has("bg")).toBe(true);
		expect(harness.shortcuts.has("ctrl+shift+b")).toBe(true);
		expect(harness.messageRenderers.has("milanglacier.background-tasks:event")).toBe(true);
	});
});
