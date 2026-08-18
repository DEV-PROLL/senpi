import { describe, expect, it, vi } from "vitest";

/**
 * Submission-channel coverage for pasted images: the `[Image #N]` markers the
 * paste handler inserts must resolve, at submit time, into the images array
 * that rides PromptOptions alongside the text - on EVERY submission surface:
 * the normal onInputCallback/getUserInput channel, the streaming/steer
 * branch, and Alt+Enter (handleFollowUp), whose non-streaming leg cannot
 * widen the public onSubmit(text) API and must hand the images over
 * out-of-band instead.
 *
 * Resolution must read ONLY the submitted text plus the pendingImages map:
 * pi-tui's Editor.submitValue() has already reset the editor and cleared its
 * registries before onSubmit fires, so live editor state is empty by then.
 */

const clipboardImageMock = vi.hoisted(() => ({
	readClipboardImage: vi.fn<() => Promise<{ bytes: Uint8Array; mimeType: string } | null>>(),
}));

const clipboardTextMock = vi.hoisted(() => ({
	readClipboardText: vi.fn<() => Promise<string | null>>(),
}));

vi.mock("../src/utils/clipboard-image.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/utils/clipboard-image.ts")>();
	return { ...original, readClipboardImage: clipboardImageMock.readClipboardImage };
});

vi.mock("../src/utils/clipboard.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/utils/clipboard.ts")>();
	return { ...original, readClipboardText: clipboardTextMock.readClipboardText };
});

vi.mock("../src/utils/version-check.ts", () => ({
	checkForNewPiVersion: vi.fn(async () => undefined),
	getReleaseChangelogUrl: vi.fn((version: string) => `https://example.invalid/releases/${version}`),
}));

import type { ImageContent } from "@earendil-works/pi-ai/compat";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

/** The widened submission-channel payload: text plus images resolved from markers. */
type UserSubmission = { text: string; images?: ImageContent[] };

type MockFn = ReturnType<typeof vi.fn>;

interface FakeEditor {
	getText: MockFn;
	setText: MockFn;
	addToHistory: MockFn;
	insertImageMarker: MockFn;
	insertTextAtCursor: MockFn;
	onSubmit?: (text: string) => void | Promise<void>;
	onImageMarkersChanged?: (order: number[]) => void;
}

interface FakeSession {
	isCompacting: boolean;
	isStreaming: boolean;
	isBashRunning: boolean;
	prompt: MockFn;
	extensionRunner: { getCommand: (name: string) => unknown };
	modelRuntime: { getError: () => string | undefined; refresh: () => Promise<unknown> };
	fallbackValidationWarnings: readonly string[];
}

interface ModeContext {
	defaultEditor: FakeEditor;
	editor: FakeEditor;
	session: FakeSession;
	pendingImages: Map<number, ImageContent>;
	pendingUserInputs: UserSubmission[];
	onInputCallback?: (input: UserSubmission) => void;
	preResolvedSubmissionImages?: ImageContent[];
	settingsManager: { getBlockImages: () => boolean; getImageAutoResize: () => boolean };
	sessionLogger: { warn: MockFn };
	getSessionLogger: () => ModeContext["sessionLogger"];
	ui: { requestRender: () => void };
	showStatus: MockFn;
	showError: (message: string) => void;
	showWarning: (message: string) => void;
	hideShortcutOverlay: () => void;
	flushPendingBashComponents: () => void;
	updatePendingMessagesDisplay: () => void;
	updateEditorBorderColor: () => void;
	handleModelCommand: (searchTerm?: string) => Promise<void>;
	handleBashCommand: (command: string, excluded: boolean) => Promise<void>;
	lastEditorText: string;
	isBashMode: boolean;
	options: Record<string, never>;
	version: string;
	init: () => Promise<void>;
	checkForPackageUpdates: () => Promise<string[]>;
	checkTmuxSetup: () => Promise<string | undefined>;
	maybeWarnAboutAnthropicSubscriptionAuth: () => Promise<void>;
	showNewVersionNotification: (version: unknown) => void;
	showPackageUpdateNotification: (packages: unknown) => void;
	showRiskyMainModelWarning: () => void;
	/**
	 * Real production helpers, bound to the fake receiver (a plain object has
	 * no prototype chain to resolve private methods through). Missing helpers
	 * stay undefined so a tree without the implementation fails on assertions
	 * rather than crashing the harness.
	 */
	takeSubmissionImages?: (submittedText: string) => ImageContent[];
	getUserInput?: () => Promise<UserSubmission>;
	isExtensionCommand?: (text: string) => boolean;
	getExpandedEditorText?: () => string;
}

type ModePrototype = {
	setupEditorSubmitHandler(this: ModeContext): void;
	getUserInput(this: ModeContext): Promise<UserSubmission>;
	run(this: ModeContext): Promise<void>;
	handleFollowUp(this: ModeContext): Promise<void>;
	handleClipboardPaste(this: ModeContext): Promise<void>;
	reconcilePendingImages(this: ModeContext, order: number[]): void;
	takeSubmissionImages(this: ModeContext, submittedText: string): ImageContent[];
	isExtensionCommand(this: ModeContext, text: string): boolean;
	getExpandedEditorText(this: ModeContext): string;
};

const proto = InteractiveMode.prototype as unknown as ModePrototype;

function image(data: string): ImageContent {
	return { type: "image", data, mimeType: "image/png" };
}

/**
 * A real 16x16 RGB PNG so processImage()'s decoder runs the production
 * normalization path (mirrors the clipboard-paste fixture).
 */
const SAMPLE_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAB0klEQVR4nA3LoQ6FIABAURrBjabJ4mjMYtLGZqDRCGw0TBS67QY63c5/vnf6EUIgBUowC1aBFhjBIbgEVuAEXhAESZAFRSDEhJxQE/PEOqEnzMQxcU3YCTfhJ8JEmsgTZfqHBbmgFuaFdUEvmIVj4VqwC27BL4SFtJAXyvIPG3JDbcwb64beMBvHxrVhN9yG3wgbaSNvlO0fduSO2pl31h29Y3aOnWvH7rgdvzN20k7eKfs/nMgTdTKfrCv6xJwcJ9eJPXEn/iScpJN8Us5/uJE36ma+WW/0jbk5bq4be+Nu/E24STf5ptz/4JEe5Zk9q0d7jOfwXB7rcRZ7vCZ7kyZ7i/yEiIyoyR9aIjpjIEbkSNuIiPhIiKZIjJf7Dg3xQD/PD+qAfzMPxcD3YB/fgH8JDesgP5fmHiqyoylxZK7piKkflqtiKq/hKqKRKrpT6Dy/yRb3ML+uLfjEvx8v1Yl/ci38pa+kpS/3uXwyoRpzY23ohmkcjathZG7hG6GRGrlR2j90ZEd15O7a0R3TOTpXx3Zcx3dCJ3Vyp/R/+JA/6l+WD/0h/k4Pq4P++E+/Ef4SB/5o3z/MJADNZgH60APzOAYXAM7cAM/CIM0yIMy+AEIbAcQK3fUWgAAAABJRU5ErkJggg==";

function samplePngBytes(): Uint8Array {
	return new Uint8Array(Buffer.from(SAMPLE_PNG_BASE64, "base64"));
}

function createModeContext(): ModeContext {
	const sessionLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
	const editor: FakeEditor = {
		getText: vi.fn(() => ""),
		setText: vi.fn(() => {}),
		addToHistory: vi.fn(),
		insertImageMarker: vi.fn(() => 1),
		insertTextAtCursor: vi.fn(),
		onImageMarkersChanged: undefined,
	};
	const session: FakeSession = {
		isCompacting: false,
		isStreaming: false,
		isBashRunning: false,
		prompt: vi.fn(async () => {}),
		extensionRunner: { getCommand: vi.fn(() => undefined) },
		modelRuntime: { getError: vi.fn(() => undefined), refresh: vi.fn(async () => undefined) },
		fallbackValidationWarnings: [],
	};
	const context: ModeContext = Object.assign(
		{
			defaultEditor: {} as FakeEditor,
			editor,
			session,
			pendingImages: new Map<number, ImageContent>(),
			pendingUserInputs: [] as UserSubmission[],
			onInputCallback: undefined,
			preResolvedSubmissionImages: undefined,
			settingsManager: {
				getBlockImages: () => false,
				getImageAutoResize: () => true,
			},
			sessionLogger,
			getSessionLogger: () => sessionLogger,
			ui: { requestRender: vi.fn() },
			showStatus: vi.fn(),
			showError: vi.fn(),
			showWarning: vi.fn(),
			hideShortcutOverlay: vi.fn(),
			flushPendingBashComponents: vi.fn(),
			updatePendingMessagesDisplay: vi.fn(),
			updateEditorBorderColor: vi.fn(),
			handleModelCommand: vi.fn(async () => {}),
			handleBashCommand: vi.fn(async () => {}),
			lastEditorText: "",
			isBashMode: false,
			options: {},
			version: "test",
			init: vi.fn(async () => {}),
			checkForPackageUpdates: vi.fn(async (): Promise<string[]> => []),
			checkTmuxSetup: vi.fn(async () => undefined),
			maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(async () => {}),
			showNewVersionNotification: vi.fn(),
			showPackageUpdateNotification: vi.fn(),
			showRiskyMainModelWarning: vi.fn(),
		},
		{} as ModeContext,
	);
	// Bind the REAL production helpers onto the fake receiver (a plain object
	// has no prototype chain to resolve private methods through). Missing
	// helpers stay undefined so a tree without the implementation fails on
	// assertions rather than crashing the harness.
	for (const method of [
		"takeSubmissionImages",
		"isExtensionCommand",
		"getExpandedEditorText",
		"getUserInput",
	] as const) {
		const real = proto[method] as unknown as ((this: ModeContext, ...args: never[]) => unknown) | undefined;
		if (typeof real === "function") {
			context[method] = real.bind(context) as never;
		}
	}

	// Mirror the real editor: clearing the text prunes every marker and fires
	// onImageMarkersChanged([]), which the reconciler answers by DESTROYING
	// pendingImages. Any submission path that resolves images after such a
	// setText loses the attachment.
	editor.setText = vi.fn((text: string) => {
		if (text === "") editor.onImageMarkersChanged?.([]);
	});
	editor.onImageMarkersChanged = (order: number[]) => {
		proto.reconcilePendingImages.call(context, order);
	};
	return context;
}

/** Install the production submit handler; optionally let this.editor BE the default editor. */
function prepareSubmitHandler(context: ModeContext, options: { shareEditor?: boolean } = {}): void {
	if (options.shareEditor) context.defaultEditor = context.editor;
	proto.setupEditorSubmitHandler.call(context);
}

function submit(context: ModeContext, text: string): Promise<void> {
	const handler = context.defaultEditor.onSubmit;
	if (!handler) throw new Error("onSubmit handler not installed");
	return Promise.resolve(handler(text));
}

/** Start the real getUserInput() so the widened channel can be observed end-to-end. */
function beginUserInput(context: ModeContext): Promise<UserSubmission> {
	return proto.getUserInput.call(context);
}

describe("InteractiveMode image submission - normal channel", () => {
	it("delivers a submitted image through the real run() main loop into session.prompt", async () => {
		const pending = image("QUFBQQ==");
		const stop = new Error("stop interactive loop");
		const context = createModeContext();
		context.session.prompt = vi.fn(async () => {
			throw stop;
		});
		context.showError = vi.fn(() => {
			throw stop;
		});
		context.pendingImages.set(1, pending);
		prepareSubmitHandler(context);

		const runPromise = proto.run.call(context);
		await submit(context, "look at [Image #1]");
		await expect(runPromise).rejects.toBe(stop);

		expect(context.session.prompt).toHaveBeenCalledTimes(1);
		const [promptText, promptOptions] = context.session.prompt.mock.calls[0] as [
			string,
			{ streamingBehavior?: string; images?: ImageContent[] },
		];
		expect(promptText).toBe("look at [Image #1]");
		expect(promptOptions?.streamingBehavior).toBe("steer");
		expect(promptOptions?.images).toHaveLength(1);
		expect(promptOptions?.images?.[0]).toMatchObject({
			type: "image",
			data: pending.data,
			mimeType: pending.mimeType,
		});
	});

	it("passes NO images key when the main loop drains plain text", async () => {
		const stop = new Error("stop interactive loop");
		const context = createModeContext();
		context.session.prompt = vi.fn(async () => {
			throw stop;
		});
		context.showError = vi.fn(() => {
			throw stop;
		});
		prepareSubmitHandler(context);

		const runPromise = proto.run.call(context);
		await submit(context, "just text");
		await expect(runPromise).rejects.toBe(stop);

		expect(context.session.prompt).toHaveBeenCalledTimes(1);
		const [promptText, promptOptions] = context.session.prompt.mock.calls[0] as [string, Record<string, unknown>];
		expect(promptText).toBe("just text");
		expect(promptOptions).toEqual({ streamingBehavior: "steer" });
	});

	it("resolves markers into the widened getUserInput payload and clears pendingImages", async () => {
		const pending = image("QUJDRA==");
		const context = createModeContext();
		context.pendingImages.set(1, pending);
		prepareSubmitHandler(context);

		const userInput = beginUserInput(context);
		await submit(context, "look at [Image #1]");

		await expect(userInput).resolves.toEqual({
			text: "look at [Image #1]",
			images: [pending],
		});
		expect(context.pendingImages.size).toBe(0);
	});

	it("returns queued submissions (with images) from getUserInput before installing a callback", async () => {
		const queued = image("cXVldWVk");
		const context = createModeContext();
		context.pendingUserInputs.push({ text: "queued [Image #1]", images: [queued] });

		await expect(proto.getUserInput.call(context)).resolves.toEqual({
			text: "queued [Image #1]",
			images: [queued],
		});
		expect(context.onInputCallback).toBeUndefined();
	});

	it("submits two markers in reading order with final text [Image #1] then [Image #2]", async () => {
		const first = image("RklSU1Q=");
		const second = image("U0VDT05E");
		const context = createModeContext();
		context.pendingImages.set(1, first);
		context.pendingImages.set(2, second);
		prepareSubmitHandler(context);

		const userInput = beginUserInput(context);
		await submit(context, "shot [Image #1] then [Image #2]");

		const resolved = await userInput;
		expect(resolved.text).toBe("shot [Image #1] then [Image #2]");
		expect(resolved.images).toEqual([first, second]);
		expect(context.pendingImages.size).toBe(0);
	});

	it("orders the array by READING ORDER, not marker number", async () => {
		const a = image("QUFBQQ==");
		const b = image("QkJCQg==");
		const context = createModeContext();
		context.pendingImages.set(1, a);
		context.pendingImages.set(2, b);
		prepareSubmitHandler(context);

		const userInput = beginUserInput(context);
		await submit(context, "late [Image #2] early [Image #1]");

		// The first marker in the text must be images[0] so look_at's
		// [Image #1] resolves to what the user sees first.
		await expect(userInput).resolves.toEqual({
			text: "late [Image #2] early [Image #1]",
			images: [b, a],
		});
	});

	it("passes no images key when every marker was deleted before submit", async () => {
		const context = createModeContext();
		prepareSubmitHandler(context);

		const userInput = beginUserInput(context);
		await submit(context, "all markers deleted");

		await expect(userInput).resolves.toEqual({ text: "all markers deleted" });
	});

	it("passes plain text through with no images key", async () => {
		const context = createModeContext();
		prepareSubmitHandler(context);

		const userInput = beginUserInput(context);
		await submit(context, "hello without attachments");

		await expect(userInput).resolves.toEqual({ text: "hello without attachments" });
	});

	it("lets a hand-typed [Image #1] with no pending entry pass through untouched", async () => {
		const context = createModeContext();
		prepareSubmitHandler(context);

		const userInput = beginUserInput(context);
		await submit(context, "look at [Image #1]");

		await expect(userInput).resolves.toEqual({ text: "look at [Image #1]" });
	});

	it("lets a hand-typed marker consume no slot in front of a real one", async () => {
		const pasted = image("UEFTVEVE");
		const context = createModeContext();
		context.pendingImages.set(2, pasted);
		prepareSubmitHandler(context);

		const userInput = beginUserInput(context);
		await submit(context, "typed [Image #1] pasted [Image #2]");

		await expect(userInput).resolves.toEqual({
			text: "typed [Image #1] pasted [Image #2]",
			images: [pasted],
		});
	});

	it("attaches the image once when a marker is duplicated by kill/yank", async () => {
		const pending = image("RFVQTElDQVRF");
		const context = createModeContext();
		context.pendingImages.set(1, pending);
		prepareSubmitHandler(context);

		const userInput = beginUserInput(context);
		await submit(context, "dup [Image #1] and [Image #1] again");

		const resolved = await userInput;
		expect(resolved.text).toBe("dup [Image #1] and [Image #1] again");
		expect(resolved.images).toEqual([pending]);
	});
});

describe("InteractiveMode image submission - steer path", () => {
	it("carries images on the streaming/steer branch and resolves before setText clears the map", async () => {
		const pending = image("U1RFRVI=");
		const context = createModeContext();
		context.session.isStreaming = true;
		context.pendingImages.set(1, pending);
		prepareSubmitHandler(context);

		await submit(context, "steer this [Image #1]");

		expect(context.session.prompt).toHaveBeenCalledTimes(1);
		const [text, options] = context.session.prompt.mock.calls[0] as [
			string,
			{ streamingBehavior?: string; images?: ImageContent[] },
		];
		expect(text).toBe("steer this [Image #1]");
		expect(options?.streamingBehavior).toBe("steer");
		expect(options?.images).toEqual([pending]);
		expect(context.pendingImages.size).toBe(0);
	});
});

describe("InteractiveMode image submission - Alt+Enter followUp", () => {
	it("resolves images BEFORE setText on the streaming followUp branch", async () => {
		const pending = image("Rk9MTG9X");
		const context = createModeContext();
		context.session.isStreaming = true;
		context.pendingImages.set(1, pending);
		context.editor.getText.mockReturnValue("describe [Image #1]");
		prepareSubmitHandler(context);

		await proto.handleFollowUp.call(context);

		// The setText("") in this branch fires onImageMarkersChanged([]), which
		// destroys pendingImages - so these assertions only pass if resolution
		// happened before the clear.
		expect(context.session.prompt).toHaveBeenCalledTimes(1);
		const [text, options] = context.session.prompt.mock.calls[0] as [
			string,
			{ streamingBehavior?: string; images?: ImageContent[] },
		];
		expect(text).toBe("describe [Image #1]");
		expect(options?.streamingBehavior).toBe("followUp");
		expect(options?.images).toEqual([pending]);
		expect(context.editor.setText).toHaveBeenCalledWith("");
		expect(context.pendingImages.size).toBe(0);
	});

	it("routes non-streaming followUp through preResolvedSubmissionImages into the widened channel", async () => {
		const pending = image("Rk9MTE5PTg==");
		const context = createModeContext();
		context.pendingImages.set(1, pending);
		context.editor.getText.mockReturnValue("describe [Image #1]");
		prepareSubmitHandler(context, { shareEditor: true });

		const userInput = beginUserInput(context);
		await proto.handleFollowUp.call(context);

		// onSubmit(text) stayed a string-only public API; the images traveled
		// through the pre-resolved field and out the normal channel.
		await expect(userInput).resolves.toEqual({
			text: "describe [Image #1]",
			images: [pending],
		});
		expect(context.editor.setText).toHaveBeenCalledWith("");
		expect(context.pendingImages.size).toBe(0);
		expect(context.preResolvedSubmissionImages).toBeUndefined();
		expect(context.session.prompt).not.toHaveBeenCalled();
	});

	it("leaves no stale images on the next ordinary submission after Alt+Enter on a slash command", async () => {
		const stale = image("U1RBTEU=");
		const context = createModeContext();
		context.preResolvedSubmissionImages = [stale];
		prepareSubmitHandler(context);

		// The /model branch returns before the image-consuming branch; the
		// pre-resolved array must not survive it.
		await submit(context, "/model");
		expect(context.preResolvedSubmissionImages).toBeUndefined();

		const userInput = beginUserInput(context);
		await submit(context, "next ordinary message");
		await expect(userInput).resolves.toEqual({ text: "next ordinary message" });
	});

	it("leaves no stale images on the next ordinary submission after Alt+Enter on a bash command", async () => {
		const stale = image("U1RBTEUy");
		const context = createModeContext();
		context.preResolvedSubmissionImages = [stale];
		prepareSubmitHandler(context);

		await submit(context, "!ls");
		expect(context.preResolvedSubmissionImages).toBeUndefined();

		const userInput = beginUserInput(context);
		await submit(context, "next ordinary message");
		await expect(userInput).resolves.toEqual({ text: "next ordinary message" });
	});
});

describe("InteractiveMode image submission - compaction boundary", () => {
	it("drops a pasted attachment with a visible status while the session is compacting", async () => {
		clipboardImageMock.readClipboardImage.mockResolvedValueOnce({
			bytes: samplePngBytes(),
			mimeType: "image/png",
		});
		clipboardTextMock.readClipboardText.mockResolvedValueOnce(null);
		const context = createModeContext();
		context.session.isCompacting = true;

		await proto.handleClipboardPaste.call(context);

		// Pinned scope boundary: the compaction queue carries text only, so the
		// attachment is dropped here - visibly, never silently.
		expect(context.editor.insertImageMarker).not.toHaveBeenCalled();
		expect(context.editor.insertTextAtCursor).not.toHaveBeenCalled();
		expect(context.pendingImages.size).toBe(0);
		expect(context.showStatus).toHaveBeenCalledTimes(1);
		expect(String(context.showStatus.mock.calls[0]?.[0])).toMatch(/compact/i);
	});
});
