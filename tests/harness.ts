import type {
	ContextUsage,
	EntryRenderer,
	EventBus,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionUIContext,
	MarkdownTransformer,
	MessageRenderer,
	ScopedModel,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { ModelRegistry, ModelRuntime, Theme } from "@earendil-works/pi-coding-agent";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Types the harness reuses from pi rather than redeclaring. Indexed access keeps
 * them tied to the real `ExtensionAPI` / `ExtensionContext` even when pi does not
 * re-export the named type from its package root.
 */
type ShortcutOptions = Parameters<ExtensionAPI["registerShortcut"]>[1];
type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
type SessionManager = ExtensionCommandContext["sessionManager"];
type ThinkingLevel = NonNullable<ExtensionCommandContext["thinkingLevel"]>;
type CustomMessage = Parameters<ExtensionAPI["sendMessage"]>[0];
type SendMessageOptions = Parameters<ExtensionAPI["sendMessage"]>[1];
type WidgetContent = Parameters<ExtensionUIContext["setWidget"]>[1];
type StringWidgetContent = string[] | undefined;
type RegisteredTool = ToolDefinition;

export interface RecordedMessage {
	message: CustomMessage;
	options: SendMessageOptions;
}

export interface RecordedNotification {
	msg: string;
	type: "info" | "warning" | "error" | undefined;
}

export interface ExtensionHarness {
	/** The real `ExtensionAPI` handed to the extension under test. */
	pi: ExtensionAPI;
	/** The real `ExtensionCommandContext` handed to command and shortcut handlers. */
	ctx: ExtensionCommandContext;
	tools: Map<string, RegisteredTool>;
	commands: Map<string, CommandOptions>;
	shortcuts: Map<string, ShortcutOptions>;
	messageRenderers: Map<string, MessageRenderer>;
	entryRenderers: Map<string, EntryRenderer>;
	messages: RecordedMessage[];
	notifications: RecordedNotification[];
	widgets: Map<string, WidgetContent | StringWidgetContent>;
	statuses: Map<string, string | undefined>;
	/** Dispatch a pi lifecycle event to every handler the extension registered for it. */
	emit(event: string, payload: unknown): void;
}

function notImplemented(name: string): never {
	throw new Error(`ExtensionHarness: ${name}() is not implemented by this test harness.`);
}

/**
 * Builds a harness whose `pi` and `ctx` satisfy pi's real `ExtensionAPI` and
 * `ExtensionCommandContext` interfaces. Nothing here is a hand-written stand-in
 * for a pi type, so the extension entry point is type checked against the same
 * contract it gets at runtime, with no casts at the call site.
 *
 * `ModelRegistry` is a class with private state and therefore cannot be
 * satisfied structurally. The harness constructs a genuine instance over a
 * throwaway directory with model network access disabled.
 */
export async function createExtensionHarness(): Promise<ExtensionHarness> {
	const scratch = mkdtempSync(join(tmpdir(), "pi-bg-harness-"));
	const modelRuntime = await ModelRuntime.create({
		allowModelNetwork: false,
		authPath: join(scratch, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(scratch, "models.json"),
		refreshOnCreate: false,
	});
	const modelRegistry = new ModelRegistry(modelRuntime);

	const handlers = new Map<string, Array<(event: never, ctx: never) => unknown>>();
	const tools = new Map<string, RegisteredTool>();
	const commands = new Map<string, CommandOptions>();
	const shortcuts = new Map<string, ShortcutOptions>();
	const messageRenderers = new Map<string, MessageRenderer>();
	const entryRenderers = new Map<string, EntryRenderer>();
	const messages: RecordedMessage[] = [];
	const notifications: RecordedNotification[] = [];
	const widgets = new Map<string, WidgetContent | StringWidgetContent>();
	const statuses = new Map<string, string | undefined>();
	const flags = new Map<string, boolean | string | undefined>();

	let editorText = "";
	let sessionName: string | undefined;
	let thinkingLevel: ThinkingLevel = "off";
	let toolsExpanded = false;

	const busListeners = new Map<string, Array<(data: unknown) => void>>();
	const events: EventBus = {
		emit(channel, data) {
			for (const listener of busListeners.get(channel) ?? []) {
				listener(data);
			}
		},
		on(channel, handler) {
			const listeners = busListeners.get(channel) ?? [];
			listeners.push(handler);
			busListeners.set(channel, listeners);
			return () => {
				const current = busListeners.get(channel) ?? [];
				const index = current.indexOf(handler);
				if (index >= 0) {
					current.splice(index, 1);
				}
			};
		},
	};

	// A genuine Theme instance. Theme is a class with private state, so a plain
	// object could never satisfy it -- constructing the real one keeps the harness
	// free of stand-in types.
	const theme = new Theme(
		{
			accent: 7,
			border: 7,
			borderAccent: 7,
			borderMuted: 7,
			success: 7,
			error: 7,
			warning: 7,
			muted: 7,
			dim: 7,
			text: 7,
			thinkingText: 7,
			searchMatchText: 7,
			userMessageText: 7,
			customMessageText: 7,
			customMessageLabel: 7,
			toolTitle: 7,
			toolOutput: 7,
			mdHeading: 7,
			mdLink: 7,
			mdLinkUrl: 7,
			mdCode: 7,
			mdCodeBlock: 7,
			mdCodeBlockBorder: 7,
			mdQuote: 7,
			mdQuoteBorder: 7,
			mdHr: 7,
			mdListBullet: 7,
			toolDiffAdded: 7,
			toolDiffRemoved: 7,
			toolDiffContext: 7,
			syntaxComment: 7,
			syntaxKeyword: 7,
			syntaxFunction: 7,
			syntaxVariable: 7,
			syntaxString: 7,
			syntaxNumber: 7,
			syntaxType: 7,
			syntaxOperator: 7,
			syntaxPunctuation: 7,
			thinkingOff: 7,
			thinkingMinimal: 7,
			thinkingLow: 7,
			thinkingMedium: 7,
			thinkingHigh: 7,
			thinkingXhigh: 7,
			thinkingMax: 7,
			bashMode: 7,
		},
		{
			selectedBg: 7,
			scrollbarThumb: 7,
			searchMatchBg: 7,
			userMessageBg: 7,
			customMessageBg: 7,
			toolPendingBg: 7,
			toolSuccessBg: 7,
			toolErrorBg: 7,
		},
		"256color",
		{ name: "harness" },
	);

	const sessionManager: SessionManager = {
		buildContextEntries: () => [],
		getBranch: () => [],
		getCwd: () => process.cwd(),
		getEntries: () => [],
		getEntry: () => undefined,
		getHeader: () => null,
		getLabel: () => undefined,
		getLeafEntry: () => undefined,
		getLeafId: () => null,
		getSessionDir: () => scratch,
		getSessionFile: () => undefined,
		getSessionId: () => "harness-session",
		getSessionName: () => sessionName ?? "",
		getTree: () => [],
	};

	const ui: ExtensionUIContext = {
		addAutocompleteProvider() {},
		confirm: async () => true,
		custom: async () => notImplemented("ui.custom"),
		editor: async () => undefined,
		getAllThemes: () => [],
		getEditorComponent: () => undefined,
		getEditorText: () => editorText,
		getTheme: () => theme,
		getToolsExpanded: () => toolsExpanded,
		input: async () => undefined,
		notify(message, type) {
			notifications.push({ msg: message, type });
		},
		onTerminalInput: () => () => {},
		pasteToEditor(text) {
			editorText += text;
		},
		select: async () => undefined,
		setEditorComponent() {},
		setEditorText(text) {
			editorText = text;
		},
		setFooter() {},
		setHeader() {},
		setHiddenThinkingLabel() {},
		setStatus(key, text) {
			statuses.set(key, text);
		},
		setTheme: () => ({ success: true }),
		setTitle() {},
		setToolsExpanded(expanded) {
			toolsExpanded = expanded;
		},
		setWidget(key: string, content: WidgetContent | StringWidgetContent) {
			widgets.set(key, content);
		},
		setWorkingIndicator() {},
		setWorkingMessage() {},
		setWorkingVisible() {},
		theme,
	};

	const ctx: ExtensionCommandContext = {
		abort() {},
		compact() {},
		cwd: process.cwd(),
		fork: async () => ({ cancelled: false }),
		getContextUsage: (): ContextUsage | undefined => undefined,
		getSystemPrompt: () => "",
		getSystemPromptOptions: () => ({ cwd: process.cwd() }),
		hasPendingMessages: () => false,
		hasUI: true,
		isIdle: () => true,
		isProjectTrusted: () => true,
		mode: "tui",
		model: undefined,
		modelRegistry,
		navigateTree: async () => ({ cancelled: false }),
		newSession: async () => ({ cancelled: false }),
		reload: async () => {},
		scopedModels: [] as readonly ScopedModel[],
		sessionManager,
		shutdown() {},
		signal: undefined,
		switchSession: async () => ({ cancelled: false }),
		thinkingLevel,
		ui,
		waitForIdle: async () => {},
	};

	const pi: ExtensionAPI = {
		appendEntry() {},
		events,
		exec: async () => ({ stdout: "", stderr: "", exitCode: 0, code: 0, killed: false }),
		getActiveTools: () => [...tools.keys()],
		getAllTools: () => [],
		getCommands: () => [],
		getFlag: (name) => flags.get(name),
		getSessionName: () => sessionName,
		getThinkingLevel: () => thinkingLevel,
		on(event: string, handler: (event: never, ctx: never) => unknown) {
			const existing = handlers.get(event) ?? [];
			existing.push(handler);
			handlers.set(event, existing);
		},
		registerCommand(name, options) {
			commands.set(name, options);
		},
		registerEntryRenderer(customType, renderer) {
			entryRenderers.set(customType, renderer as EntryRenderer);
		},
		registerFlag(name, options) {
			flags.set(name, options.default);
		},
		registerMarkdownTransformer(_transformer: MarkdownTransformer) {},
		registerMessageRenderer(customType, renderer) {
			messageRenderers.set(customType, renderer as MessageRenderer);
		},
		registerProvider() {},
		registerShortcut(shortcut, options) {
			shortcuts.set(shortcut, options);
		},
		registerTool(tool) {
			// `registerTool` is generic over the tool's TypeBox schema. Erasing those
			// generics to store heterogeneous tools in one registry is what the cast
			// covers; the stored value is a real ToolDefinition, not a stand-in.
			tools.set(tool.name, tool as unknown as RegisteredTool);
		},
		sendMessage(message, options) {
			messages.push({ message, options });
		},
		sendUserMessage() {},
		setActiveTools() {},
		setLabel() {},
		setModel: async () => true,
		setSessionName(name) {
			sessionName = name;
		},
		setThinkingLevel(level) {
			thinkingLevel = level;
		},
		unregisterProvider() {},
	};

	return {
		commands,
		ctx,
		emit(event, payload) {
			// `ExtensionAPI.on` is overloaded with a distinct payload type per event
			// name. Dispatching by a runtime string cannot be resolved against those
			// overloads, so the payload is widened here at the dispatch boundary only.
			for (const handler of handlers.get(event) ?? []) {
				handler(payload as never, ctx as never);
			}
		},
		entryRenderers,
		messageRenderers,
		messages,
		notifications,
		pi,
		shortcuts,
		statuses,
		tools,
		widgets,
	};
}
