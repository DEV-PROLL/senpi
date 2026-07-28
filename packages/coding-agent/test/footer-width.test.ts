import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { FooterComponent, formatCwdForFooter } from "../src/modes/interactive/components/footer.ts";
import { type FooterSegment, planFooterLayout } from "../src/modes/interactive/components/footer-layout.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

type FooterUsageEntry =
	| { type: "message"; message: { role: "assistant" | "toolResult"; usage: AssistantUsage } }
	| { type: "branch_summary"; usage: AssistantUsage }
	| { type: "compaction"; usage: AssistantUsage };

function createSession(options: {
	sessionName: string;
	modelId?: string;
	provider?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
	usage?: AssistantUsage;
	branchUsage?: AssistantUsage;
	compactionUsage?: AssistantUsage;
	toolUsage?: AssistantUsage;
}): AgentSession {
	const usage = options.usage;
	const entries: FooterUsageEntry[] = [];

	if (usage !== undefined) {
		entries.push({
			type: "message",
			message: {
				role: "assistant",
				usage,
			},
		});
	}

	if (options.branchUsage !== undefined) {
		entries.push({
			type: "branch_summary",
			usage: options.branchUsage,
		});
	}

	if (options.compactionUsage !== undefined) {
		entries.push({
			type: "compaction",
			usage: options.compactionUsage,
		});
	}

	if (options.toolUsage !== undefined) {
		entries.push({
			type: "message",
			message: {
				role: "toolResult",
				usage: options.toolUsage,
			},
		});
	}

	const session = {
		state: {
			model: {
				id: options.modelId ?? "test-model",
				provider: options.provider ?? "test",
				contextWindow: 200_000,
				reasoning: options.reasoning ?? false,
			},
			thinkingLevel: options.thinkingLevel ?? "off",
		},
		sessionManager: {
			getEntries: () => entries,
			getUsageTotals: () => {
				const totals = {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0,
					latestCacheHitRate: undefined as number | undefined,
				};
				for (const entry of entries) {
					const usage = entry.type === "message" ? entry.message.usage : entry.usage;
					totals.input += usage.input;
					totals.output += usage.output;
					totals.cacheRead += usage.cacheRead;
					totals.cacheWrite += usage.cacheWrite;
					totals.cost += usage.cost.total;

					if (entry.type === "message" && entry.message.role === "assistant") {
						const latestPromptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
						totals.latestCacheHitRate =
							latestPromptTokens > 0 ? (usage.cacheRead / latestPromptTokens) * 100 : undefined;
					}
				}
				return totals;
			},
			getSessionName: () => options.sessionName,
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: 12.3 }),
		modelRuntime: {
			isUsingOAuth: () => false,
		},
	};

	return session as unknown as AgentSession;
}

function createFooterData(providerCount: number): ReadonlyFooterDataProvider {
	const provider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => providerCount,
		onBranchChange: (callback: () => void) => {
			void callback;
			return () => {};
		},
	};

	return provider;
}

describe("formatCwdForFooter", () => {
	it("does not abbreviate sibling paths that share the home prefix", () => {
		expect(formatCwdForFooter("/home/user2", "/home/user")).toBe("/home/user2");
	});

	it("abbreviates the home directory and descendants", () => {
		expect(formatCwdForFooter("/home/user", "/home/user")).toBe("~");
		expect(formatCwdForFooter("/home/user/project", "/home/user")).toBe("~/project");
	});
});

describe("FooterComponent width handling", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("keeps all lines within width for wide session names", () => {
		const width = 93;
		const session = createSession({ sessionName: "한글".repeat(30) });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps stats line within width for wide model and provider names", () => {
		const width = 60;
		const session = createSession({
			sessionName: "",
			modelId: "模".repeat(30),
			provider: "공급자",
			reasoning: true,
			thinkingLevel: "high",
			usage: {
				input: 12_345,
				output: 6_789,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(2));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("includes summary and tool result usage in the total cost", () => {
		const session = createSession({
			sessionName: "",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.5 },
			},
			branchUsage: {
				input: 20,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.25 },
			},
			compactionUsage: {
				input: 5,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.125 },
			},
			toolUsage: {
				input: 15,
				output: 3,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.375 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const renderedFooter = footer
			.render(120)
			.map((line) => stripAnsi(line))
			.join("\n");
		expect(renderedFooter).toContain("$1.250");
	});

	it("shows the latest cache hit rate when cache usage is present", () => {
		const session = createSession({
			sessionName: "",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 50,
				cacheWrite: 50,
				cost: { total: 0.001 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const renderedFooter = footer
			.render(120)
			.map((line) => stripAnsi(line))
			.join("\n");
		expect(renderedFooter).toContain("CH25.0%");
		// The cache read/write totals segment was removed; only the hit rate remains.
		expect(renderedFooter).not.toContain("cache 50/50");
		expect(renderedFooter).not.toContain("cache ");
	});

	it("marks Kimi Coding costs as subscription estimates", () => {
		const session = createSession({
			sessionName: "",
			provider: "kimi-coding",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		// Fork footer renders one combined stats line; assert against the full render
		// instead of upstream's two-line layout index.
		const renderedFooter = footer
			.render(120)
			.map((line) => stripAnsi(line))
			.join("\n");
		expect(renderedFooter).toContain("$1.234 (sub)");
	});

	it("keeps the model label and context block visible at narrow widths", () => {
		const width = 60;
		const session = createSession({
			sessionName: "deep-work-on-footer-layout",
			modelId: "test-model",
			reasoning: true,
			thinkingLevel: "high",
			usage: {
				input: 12_345,
				output: 6_789,
				cacheRead: 50,
				cacheWrite: 50,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(2));

		const lines = footer.render(width);
		const plain = lines.map((line) => stripAnsi(line)).join("\n");
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		expect(plain).toContain("test-model:high");
		expect(plain).toContain("main");
		expect(plain).toContain("(auto)");
		expect(plain).toContain("…");
	});

	it("still renders the model label at very narrow widths", () => {
		const width = 30;
		const session = createSession({
			sessionName: "deep-work-on-footer-layout",
			modelId: "test-model",
			reasoning: true,
			thinkingLevel: "high",
			usage: {
				input: 12_345,
				output: 6_789,
				cacheRead: 50,
				cacheWrite: 50,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(2));

		const lines = footer.render(width);
		const plain = lines.map((line) => stripAnsi(line)).join("\n");
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		expect(plain).toContain("test-model");
	});

	it("renders the provider prefix when more than one provider is available", () => {
		const width = 200;
		const session = createSession({
			sessionName: "session-name",
			modelId: "test-model",
			provider: "test",
			reasoning: true,
			thinkingLevel: "high",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(2));

		const lines = footer.render(width);
		const plain = lines.map((line) => stripAnsi(line)).join("\n");
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		expect(plain).toContain("(test) test-model:high");
	});
});

function seg(plain: string): FooterSegment {
	return { plain, colored: plain };
}

describe("planFooterLayout provider priority", () => {
	const anchor: [FooterSegment, ...FooterSegment[]] = [seg("~/local-workspaces/senpi"), seg("main")];
	const middle = [seg("session-name"), seg("↑1.2M"), seg("↓45K"), seg("CH92.3%"), seg("$12.345")];
	const tail = seg("120K/1M (12.0%) (auto)");
	const right = {
		minimal: seg("claude-opus-5:low"),
		full: seg("(anthropic) claude-opus-5:low"),
	};
	const separator = " • ";
	const ellipsisMarker = seg("…");
	const baseInput = {
		anchor,
		middle,
		tail,
		right,
		separator,
		minPadding: 2,
		ellipsisMarker,
	};

	it("keeps the provider prefix once a middle stat has to elide", () => {
		const plan = planFooterLayout({ ...baseInput, width: 124 });
		expect(plan.kind).toBe("middle-elided");
		if (plan.kind !== "middle-elided") throw new Error("unexpected plan");
		expect(plan.keptMiddleCount).toBe(3);
		expect(plan.showMarker).toBe(true);
		expect(plan.useFullRight).toBe(true);
	});

	it("falls back to the bare model label when even empty middle cannot fit the full label", () => {
		const plan = planFooterLayout({ ...baseInput, width: 75 });
		expect(plan.kind).toBe("middle-elided");
		if (plan.kind !== "middle-elided") throw new Error("unexpected plan");
		expect(plan.keptMiddleCount).toBe(0);
		expect(plan.showMarker).toBe(false);
		expect(plan.useFullRight).toBe(false);
	});

	it("keeps the existing pwd-elided and anchor/tail guarantees untouched", () => {
		const plan = planFooterLayout({ ...baseInput, width: 60 });
		expect(plan.kind).toBe("pwd-elided");
		if (plan.kind !== "pwd-elided") throw new Error("unexpected plan");
		expect(plan.pwdPlain.length).toBeGreaterThan(0);
	});
});
