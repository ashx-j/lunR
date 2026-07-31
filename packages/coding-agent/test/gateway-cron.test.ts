import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import lunrCron from "../src/builtin-extensions/lunr-cron.ts";
import { beginCronFire, endCronFire, isCronFire } from "../src/core/cron/fire-guard.ts";
import { type CronJob, createJob, getJob, setCronBaseDir } from "../src/core/cron/jobs.ts";
import { currentOrigin, runWithOrigin } from "../src/core/cron/origin-context.ts";
import { defaultGatewayConfig, type GatewayConfig } from "../src/gateway/config.ts";
import { createPlatformDeliverer, startGatewayCron, wrapCronContent } from "../src/gateway/cron.ts";
import type { ButtonSpec, CallbackEvent, PlatformAdapter, SendOptions, SendResult } from "../src/gateway/types.ts";

// ---------------------------------------------------------------------------
// Fakes + setup
// ---------------------------------------------------------------------------

class FakeAdapter implements PlatformAdapter {
	readonly platform: string;
	maxMessageLength = 100;
	sent: Array<{ chatId: string; text: string; opts?: SendOptions; buttons?: ButtonSpec[][] }> = [];
	failNext = false;
	private callbackHandler?: (event: CallbackEvent) => void;

	constructor(platform: string, maxMessageLength = 100) {
		this.platform = platform;
		this.maxMessageLength = maxMessageLength;
	}

	async connect(): Promise<boolean> {
		return true;
	}
	async disconnect(): Promise<void> {}
	async send(chatId: string, text: string, opts?: SendOptions): Promise<SendResult> {
		if (this.failNext) {
			this.failNext = false;
			return { success: false, error: "boom" };
		}
		this.sent.push({ chatId, text, opts });
		return { success: true, messageId: `m${this.sent.length}` };
	}
	async sendButtons(chatId: string, text: string, buttons: ButtonSpec[][], opts?: SendOptions): Promise<SendResult> {
		this.sent.push({ chatId, text, opts, buttons });
		return { success: true, messageId: `m${this.sent.length}` };
	}
	async editMessage(): Promise<SendResult> {
		return { success: true };
	}
	async sendTyping(): Promise<void> {}
	onMessage(): void {}
	onCallback(handler: (event: CallbackEvent) => void): void {
		this.callbackHandler = handler;
	}
	async answerCallback(): Promise<void> {}
	simulateCallback(event: CallbackEvent): void {
		this.callbackHandler?.(event);
	}
}

let dir: string;
const stoppers: Array<() => void> = [];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "lunr-gw-cron-"));
	setCronBaseDir(dir);
});

afterEach(() => {
	for (const stop of stoppers.splice(0)) stop();
	setCronBaseDir(undefined);
	rmSync(dir, { recursive: true, force: true });
});

function makeConfig(mutate?: (cfg: GatewayConfig) => void): GatewayConfig {
	const cfg = defaultGatewayConfig();
	mutate?.(cfg);
	return cfg;
}

function fakeJob(overrides: Partial<CronJob> = {}): CronJob {
	return {
		id: "job1",
		name: "testjob",
		prompt: "p",
		schedule: { kind: "interval", minutes: 30 },
		scheduleDisplay: "every 30m",
		repeat: { times: null, completed: 0 },
		enabled: true,
		state: "scheduled",
		createdAt: new Date().toISOString(),
		nextRunAt: null,
		lastRunAt: null,
		lastStatus: null,
		lastError: null,
		lastDeliveryError: null,
		deliver: "local",
		origin: null,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// fire-guard
// ---------------------------------------------------------------------------

describe("fire-guard", () => {
	it("is a depth counter: nested begins need matching ends", () => {
		expect(isCronFire()).toBe(false);
		beginCronFire();
		expect(isCronFire()).toBe(true);
		beginCronFire();
		endCronFire();
		expect(isCronFire()).toBe(true); // still one level deep
		endCronFire();
		expect(isCronFire()).toBe(false);
	});

	it("ignores an unbalanced endCronFire", () => {
		endCronFire();
		expect(isCronFire()).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// origin-context
// ---------------------------------------------------------------------------

describe("origin-context", () => {
	it("propagates through an awaited async chain", async () => {
		const origin = { platform: "telegram", chatId: "c1", threadId: "t1", chatType: "dm" };
		const seen = await runWithOrigin(origin, async () => {
			await new Promise((resolve) => setTimeout(resolve, 1));
			const inner = async () => {
				await Promise.resolve();
				return currentOrigin();
			};
			return inner();
		});
		expect(seen).toEqual(origin);
	});

	it("is undefined outside runWithOrigin and after it returns", async () => {
		expect(currentOrigin()).toBeUndefined();
		await runWithOrigin({ platform: "telegram", chatId: "c1" }, async () => {});
		expect(currentOrigin()).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// lunr-cron tool: fire-guard refusal + origin stamping
// ---------------------------------------------------------------------------

type CronToolDef = {
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: unknown,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<{ content: Array<{ type: string; text: string }> }>;
};

function loadCronTool(): CronToolDef {
	let tool: CronToolDef | undefined;
	const piStub = {
		on: () => {},
		registerCommand: () => {},
		registerTool: (def: CronToolDef) => {
			tool = def;
		},
		sendUserMessage: () => {},
	};
	lunrCron(piStub as never);
	if (!tool) throw new Error("lunr-cron did not register a tool");
	return tool;
}

const idleCtx = { isIdle: () => true, ui: { notify: () => {} } };

describe("lunr-cron tool", () => {
	it("refuses while a cron-fired turn is in flight", async () => {
		const tool = loadCronTool();
		beginCronFire();
		try {
			const result = await tool.execute("t1", { action: "list" }, null, null, idleCtx);
			expect(result.content[0].text).toContain("cron jobs cannot schedule cron jobs");
		} finally {
			endCronFire();
		}
	});

	it("stamps origin + deliver='origin' when created inside a gateway origin context", async () => {
		const tool = loadCronTool();
		const origin = { platform: "telegram", chatId: "chat9", threadId: "77", chatType: "dm" };
		const result = await runWithOrigin(origin, () =>
			tool.execute("t2", { action: "create", prompt: "check deploy", schedule: "every 30m" }, null, null, idleCtx),
		);
		expect(result.content[0].text).toContain("Created cron job");
		const id = /Created cron job '[^']+' \(([a-z0-9]+)\)/.exec(result.content[0].text)?.[1];
		const job = getJob(id!);
		expect(job.deliver).toBe("origin");
		expect(job.origin).toEqual(origin);
	});

	it("defaults to deliver='local' with no origin outside a gateway context", async () => {
		const tool = loadCronTool();
		const result = await tool.execute(
			"t3",
			{ action: "create", prompt: "check deploy", schedule: "every 30m" },
			null,
			null,
			idleCtx,
		);
		const id = /Created cron job '[^']+' \(([a-z0-9]+)\)/.exec(result.content[0].text)?.[1];
		const job = getJob(id!);
		expect(job.deliver).toBe("local");
		expect(job.origin).toBeNull();
	});

	it("an explicit deliver param beats the origin default", async () => {
		const tool = loadCronTool();
		const origin = { platform: "telegram", chatId: "chat9" };
		const result = await runWithOrigin(origin, () =>
			tool.execute(
				"t4",
				{ action: "create", prompt: "check deploy", schedule: "every 30m", deliver: "local" },
				null,
				null,
				idleCtx,
			),
		);
		const id = /Created cron job '[^']+' \(([a-z0-9]+)\)/.exec(result.content[0].text)?.[1];
		const job = getJob(id!);
		expect(job.deliver).toBe("local");
		expect(job.origin).toEqual(origin); // origin still stamped for reference
	});
});

// ---------------------------------------------------------------------------
// Platform deliverer routing
// ---------------------------------------------------------------------------

describe("createPlatformDeliverer", () => {
	it("'local' is a no-op success", async () => {
		const adapter = new FakeAdapter("telegram");
		const deliver = createPlatformDeliverer(new Map([["telegram", adapter]]), makeConfig());
		const err = await deliver(fakeJob({ deliver: "local" }), "hello");
		expect(err).toBeNull();
		expect(adapter.sent).toEqual([]);
	});

	it("'origin' delivers to the job's origin chat, threadId passed through", async () => {
		const adapter = new FakeAdapter("telegram");
		const deliver = createPlatformDeliverer(new Map([["telegram", adapter]]), makeConfig());
		const job = fakeJob({
			deliver: "origin",
			origin: { platform: "telegram", chatId: "chat1", threadId: "th9" },
		});
		const err = await deliver(job, "result text");
		expect(err).toBeNull();
		expect(adapter.sent).toHaveLength(1);
		expect(adapter.sent[0].chatId).toBe("chat1");
		expect(adapter.sent[0].opts?.threadId).toBe("th9");
		expect(adapter.sent[0].text).toBe("☾ Cron: testjob\n———\nresult text");
	});

	it("'origin' with a missing origin falls back to the platform homeChannel", async () => {
		const adapter = new FakeAdapter("telegram");
		const cfg = makeConfig((c) => {
			c.telegram.homeChannel = "homeChat";
		});
		const deliver = createPlatformDeliverer(new Map([["telegram", adapter]]), cfg);
		const err = await deliver(fakeJob({ deliver: "origin", origin: null }), "hi");
		expect(err).toBeNull();
		expect(adapter.sent[0].chatId).toBe("homeChat");
	});

	it("'origin' with no origin and no homeChannel returns an error string", async () => {
		const adapter = new FakeAdapter("telegram");
		const deliver = createPlatformDeliverer(new Map([["telegram", adapter]]), makeConfig());
		const err = await deliver(fakeJob({ deliver: "origin", origin: null }), "hi");
		expect(err).toContain("no origin");
		expect(adapter.sent).toEqual([]);
	});

	it("bare platform name delivers to that platform's homeChannel", async () => {
		const adapter = new FakeAdapter("discord");
		const cfg = makeConfig((c) => {
			c.discord.homeChannel = "chan42";
		});
		const deliver = createPlatformDeliverer(new Map([["discord", adapter]]), cfg);
		const err = await deliver(fakeJob({ deliver: "discord" }), "hi");
		expect(err).toBeNull();
		expect(adapter.sent[0].chatId).toBe("chan42");
	});

	it("bare platform name without a homeChannel returns an error string", async () => {
		const adapter = new FakeAdapter("telegram");
		const deliver = createPlatformDeliverer(new Map([["telegram", adapter]]), makeConfig());
		const err = await deliver(fakeJob({ deliver: "telegram" }), "hi");
		expect(err).toContain("no homeChannel configured for telegram");
	});

	it("explicit 'telegram:123:456' targets chat 123 with thread 456", async () => {
		const adapter = new FakeAdapter("telegram");
		const deliver = createPlatformDeliverer(new Map([["telegram", adapter]]), makeConfig());
		const err = await deliver(fakeJob({ deliver: "telegram:123:456" }), "hi");
		expect(err).toBeNull();
		expect(adapter.sent[0]).toMatchObject({ chatId: "123" });
		expect(adapter.sent[0].opts?.threadId).toBe("456");
	});

	it("comma targets: local is skipped, explicit target still delivered", async () => {
		const adapter = new FakeAdapter("telegram");
		const deliver = createPlatformDeliverer(new Map([["telegram", adapter]]), makeConfig());
		const err = await deliver(fakeJob({ deliver: "local, telegram:123" }), "hi");
		expect(err).toBeNull();
		expect(adapter.sent).toHaveLength(1);
		expect(adapter.sent[0].chatId).toBe("123");
		expect(adapter.sent[0].opts?.threadId).toBeUndefined();
	});

	it("unknown platform returns an error string", async () => {
		const adapter = new FakeAdapter("telegram");
		const deliver = createPlatformDeliverer(new Map([["telegram", adapter]]), makeConfig());
		const err = await deliver(fakeJob({ deliver: "slack:123" }), "hi");
		expect(err).toContain('unknown platform "slack"');
	});

	it("a platform without a connected adapter returns an error string", async () => {
		const adapter = new FakeAdapter("telegram");
		const cfg = makeConfig((c) => {
			c.discord.homeChannel = "chan42";
		});
		const deliver = createPlatformDeliverer(new Map([["telegram", adapter]]), cfg);
		const err = await deliver(fakeJob({ deliver: "discord" }), "hi");
		expect(err).toContain("no adapter connected for discord");
	});

	it("send failure returns an error string; later targets are still attempted", async () => {
		const telegram = new FakeAdapter("telegram");
		telegram.failNext = true;
		const discord = new FakeAdapter("discord");
		const deliver = createPlatformDeliverer(
			new Map([
				["telegram", telegram],
				["discord", discord],
			]),
			makeConfig(),
		);
		const err = await deliver(fakeJob({ deliver: "telegram:1,discord:2" }), "hi");
		expect(err).toContain("telegram send failed: boom");
		expect(discord.sent).toHaveLength(1); // second target still attempted
	});

	it("wraps content and splits to the adapter's maxMessageLength", async () => {
		const adapter = new FakeAdapter("telegram", 40);
		const deliver = createPlatformDeliverer(new Map([["telegram", adapter]]), makeConfig());
		const body = "word ".repeat(30).trim();
		const err = await deliver(fakeJob({ deliver: "telegram:1" }), body);
		expect(err).toBeNull();
		expect(adapter.sent.length).toBeGreaterThan(1);
		for (const msg of adapter.sent) {
			expect(msg.text.length).toBeLessThanOrEqual(40);
		}
		expect(adapter.sent[0].text).toContain("☾ Cron: testjob");
		expect(adapter.sent.map((m) => m.text).join("")).toContain("word");
	});
});

describe("wrapCronContent", () => {
	it("is the compact cron header", () => {
		expect(wrapCronContent(fakeJob({ name: "nightly" }), "body")).toBe("☾ Cron: nightly\n———\nbody");
	});
});

// ---------------------------------------------------------------------------
// startGatewayCron end-to-end (stub session factory)
// ---------------------------------------------------------------------------

describe("startGatewayCron", () => {
	function stubSessionFactory(text: string, onPrompt?: () => void) {
		return async () => ({
			prompt: async () => {
				onPrompt?.();
			},
			abort: async () => {},
			subscribe: () => () => {},
			state: {
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text }],
						stopReason: "stop",
					},
				],
			},
			dispose: () => {},
		});
	}

	it("fires a due job, delivers wrapped content, advances job state; stop() halts", async () => {
		const adapter = new FakeAdapter("telegram");
		const runAt = new Date(Date.now() + 700).toISOString();
		const job = await createJob({
			prompt: "report status",
			schedule: runAt,
			name: "e2ejob",
			deliver: "telegram:123",
			origin: { platform: "telegram", chatId: "123" },
		});

		let guardSeenDuringPrompt = false;
		const cron = startGatewayCron({
			adapters: new Map([["telegram", adapter]]),
			cfg: makeConfig((c) => {
				c.telegram.homeChannel = "123";
			}),
			intervalMs: 100,
			sessionFactory: stubSessionFactory("all green", () => {
				guardSeenDuringPrompt = isCronFire();
			}),
		});
		stoppers.push(cron.stop);

		const deadline = Date.now() + 5000;
		while (adapter.sent.length === 0 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect(adapter.sent).toHaveLength(1);
		expect(adapter.sent[0].chatId).toBe("123");
		expect(adapter.sent[0].text).toBe("☾ Cron: e2ejob\n———\nall green");
		expect(guardSeenDuringPrompt).toBe(true);

		const after = getJob(job.id);
		expect(after.state).toBe("completed"); // one-shot fired
		expect(after.lastStatus).toBe("ok");

		cron.stop();
		const sendsAfterStop = adapter.sent.length;
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(adapter.sent).toHaveLength(sendsAfterStop);
	});

	it("replaces the global @lunr/cron-delivery bridge with the platform deliverer", async () => {
		const adapter = new FakeAdapter("telegram");
		const cron = startGatewayCron({
			adapters: new Map([["telegram", adapter]]),
			cfg: makeConfig(),
			intervalMs: 60_000,
			sessionFactory: stubSessionFactory("unused"),
		});
		stoppers.push(cron.stop);

		const bridge = (globalThis as Record<symbol, unknown>)[Symbol.for("@lunr/cron-delivery")] as (
			job: CronJob,
			content: string,
		) => Promise<string | null>;
		expect(bridge).toBeTypeOf("function");
		const err = await bridge(fakeJob({ deliver: "telegram:321", name: "bridgejob" }), "via bridge");
		expect(err).toBeNull();
		expect(adapter.sent[0].chatId).toBe("321");
		expect(adapter.sent[0].text).toBe("☾ Cron: bridgejob\n———\nvia bridge");
	});

	it("rejects an explicit deliver target not in the allowlist", async () => {
		const adapter = new FakeAdapter("telegram");
		const cfg = makeConfig((c) => {
			c.telegram.homeChannel = "homeChat";
			c.telegram.allowedChats = ["allowed1"];
		});
		const cron = startGatewayCron({
			adapters: new Map([["telegram", adapter]]),
			cfg,
			intervalMs: 60_000,
			sessionFactory: stubSessionFactory("unused"),
		});
		stoppers.push(cron.stop);

		await expect(
			createJob({
				prompt: "p",
				schedule: "30m",
				deliver: "telegram:attackerChat",
				origin: { platform: "telegram", chatId: "originChat" },
			}),
		).rejects.toThrow(/not an allowed chat/);

		const allowedExplicit = await createJob({
			prompt: "p",
			schedule: "30m",
			deliver: "telegram:allowed1",
			origin: { platform: "telegram", chatId: "originChat" },
		});
		expect(allowedExplicit.deliver).toBe("telegram:allowed1");
	});

	it("rejects a bare platform deliver when no homeChannel is configured", async () => {
		const adapter = new FakeAdapter("telegram");
		const cron = startGatewayCron({
			adapters: new Map([["telegram", adapter]]),
			cfg: makeConfig(),
			intervalMs: 60_000,
			sessionFactory: stubSessionFactory("unused"),
		});
		stoppers.push(cron.stop);

		await expect(createJob({ prompt: "p", schedule: "30m", deliver: "telegram" })).rejects.toThrow(/no homeChannel/);
	});

	it("allows deliver='origin' for a job with an origin", async () => {
		const adapter = new FakeAdapter("telegram");
		const cron = startGatewayCron({
			adapters: new Map([["telegram", adapter]]),
			cfg: makeConfig(),
			intervalMs: 60_000,
			sessionFactory: stubSessionFactory("unused"),
		});
		stoppers.push(cron.stop);

		const job = await createJob({
			prompt: "p",
			schedule: "30m",
			deliver: "origin",
			origin: { platform: "telegram", chatId: "chat1" },
		});
		expect(job.deliver).toBe("origin");
	});
});
