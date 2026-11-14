import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ launch: vi.fn(), proxy: vi.fn() }));
vi.mock("playwright-core", () => ({ chromium: { launch: mocks.launch } }));
vi.mock("../src/core/browser/network.ts", () => ({ createBrowserProxy: mocks.proxy }));

import { BrowserSession } from "../src/core/browser/runtime.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function browserFixture() {
	const context = {
		setDefaultTimeout: vi.fn(),
		setDefaultNavigationTimeout: vi.fn(),
		route: vi.fn(async () => {}),
		routeWebSocket: vi.fn(async () => {}),
		on: vi.fn(),
		close: vi.fn(async () => {}),
		newPage: vi.fn(async () => ({ url: () => "about:blank" })),
	};
	return { close: vi.fn(async () => {}), newContext: vi.fn(async () => context), context };
}

beforeEach(() => {
	vi.useFakeTimers();
	mocks.launch.mockReset();
	mocks.proxy.mockReset();
	mocks.proxy.mockImplementation(async () => ({
		url: "http://proxy.invalid",
		blockedReason: () => undefined,
		close: vi.fn(async () => {}),
	}));
});
afterEach(() => vi.useRealTimers());

describe("browser initialization and cleanup boundaries", () => {
	it("settles stalled proxy creation and closes a late proxy once", async () => {
		const proxy = { url: "http://proxy.invalid", close: vi.fn(async () => {}) };
		const opening = deferred<typeof proxy>();
		mocks.proxy.mockReturnValue(opening.promise);
		const session = new BrowserSession();
		const controller = new AbortController();
		let error: unknown;
		const running = session
			.run({ action: "tabs", operation: "create" }, controller.signal)
			.catch((value: unknown) => {
				error = value;
			});
		await vi.advanceTimersByTimeAsync(0);
		controller.abort();
		await vi.advanceTimersByTimeAsync(0);
		try {
			expect(error).toBeInstanceOf(Error);
		} finally {
			opening.resolve(proxy);
			await running;
			await vi.advanceTimersByTimeAsync(0);
			await session.close();
		}
		expect(proxy.close).toHaveBeenCalledOnce();
		expect(mocks.launch).not.toHaveBeenCalled();
	});

	it.each(["abort", "deadline"])("settles stalled launch on %s and cleans a late browser once", async (reason) => {
		const launch = deferred<ReturnType<typeof browserFixture>>();
		const browser = browserFixture();
		mocks.launch.mockReturnValue(launch.promise);
		const session = new BrowserSession();
		const controller = new AbortController();
		let error: unknown;
		const running = session.run({ action: "tabs", operation: "create" }, controller.signal).catch((value) => {
			error = value;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(mocks.launch).toHaveBeenCalledOnce();
		if (reason === "abort") controller.abort();
		await vi.advanceTimersByTimeAsync(reason === "deadline" ? 30000 : 0);
		try {
			expect(error).toBeInstanceOf(Error);
			expect(String(error)).toMatch(/cancelled|30s/);
		} finally {
			launch.resolve(browser);
			await running;
			await vi.advanceTimersByTimeAsync(0);
			await session.close();
		}
		expect(browser.close).toHaveBeenCalledOnce();
		expect(browser.newContext).not.toHaveBeenCalled();
		expect((await mocks.proxy.mock.results[0].value).close).toHaveBeenCalledOnce();
	});

	it.each(["abort", "deadline", "session close"])(
		"closes partial resources during stalled context creation on %s",
		async (reason) => {
			const browser = browserFixture();
			const context = deferred<typeof browser.context>();
			browser.newContext.mockReturnValue(context.promise);
			mocks.launch.mockResolvedValue(browser);
			const session = new BrowserSession();
			const controller = new AbortController();
			let error: unknown;
			const running = session.run({ action: "tabs", operation: "create" }, controller.signal).catch((value) => {
				error = value;
			});
			await vi.advanceTimersByTimeAsync(0);
			const queued = session.run({ action: "tabs", operation: "list" }).catch((value: unknown) => value);
			if (reason === "abort") controller.abort();
			if (reason === "session close") await session.close();
			await vi.advanceTimersByTimeAsync(reason === "deadline" ? 30000 : 0);
			try {
				expect(error).toBeInstanceOf(Error);
				expect(browser.close).toHaveBeenCalledOnce();
				expect(String(await queued)).toMatch(/cancelled/);
				expect((await mocks.proxy.mock.results[0].value).close).toHaveBeenCalledOnce();
			} finally {
				context.resolve(browser.context);
				await running;
				await vi.advanceTimersByTimeAsync(0);
				await session.close();
			}
			expect(browser.context.route).not.toHaveBeenCalled();
			expect(browser.context.close).toHaveBeenCalledOnce();
			expect(browser.close).toHaveBeenCalledOnce();
		},
	);

	it.each(["abort", "deadline", "close abort", "close deadline"])(
		"bounds pending prior cleanup on %s",
		async (reason) => {
			const browser = browserFixture();
			mocks.launch.mockResolvedValue(browser);
			const session = new BrowserSession();
			await session.run({ action: "tabs", operation: "create" });
			const cleanup = deferred<void>();
			browser.close.mockReturnValue(cleanup.promise);
			const closing = session.close();
			const controller = new AbortController();
			let error: unknown;
			const running = session
				.run(
					reason.startsWith("close") ? { action: "close" } : { action: "tabs", operation: "create" },
					controller.signal,
				)
				.catch((value) => {
					error = value;
				});
			await vi.advanceTimersByTimeAsync(0);
			let queuedError: unknown;
			const queued = session.run({ action: "tabs", operation: "create" }).catch((value: unknown) => {
				queuedError = value;
			});
			if (reason.endsWith("abort")) controller.abort();
			await vi.advanceTimersByTimeAsync(reason.endsWith("abort") ? 0 : 30000);
			try {
				expect(error).toBeInstanceOf(Error);
				expect(queuedError).toBeInstanceOf(Error);
				expect(mocks.launch).toHaveBeenCalledOnce();
				expect((await mocks.proxy.mock.results[0].value).close).toHaveBeenCalledOnce();
			} finally {
				cleanup.resolve();
				await closing;
				await running;
				await queued;
				await session.close();
			}
		},
	);

	it("late initialization cannot close or clear a newer generation", async () => {
		const oldLaunch = deferred<ReturnType<typeof browserFixture>>();
		const oldBrowser = browserFixture(),
			nextBrowser = browserFixture();
		mocks.launch.mockReturnValueOnce(oldLaunch.promise).mockResolvedValueOnce(nextBrowser);
		const session = new BrowserSession();
		const controller = new AbortController();
		const oldRun = session.run({ action: "tabs", operation: "create" }, controller.signal).catch(() => {});
		await vi.advanceTimersByTimeAsync(0);
		controller.abort();
		await vi.advanceTimersByTimeAsync(0);
		try {
			expect(mocks.launch).toHaveBeenCalledOnce();
			const nextRun = session.run({ action: "tabs", operation: "create" });
			await vi.advanceTimersByTimeAsync(0);
			expect(mocks.launch).toHaveBeenCalledTimes(2);
			oldLaunch.resolve(oldBrowser);
			await oldRun;
			await nextRun;
			await vi.advanceTimersByTimeAsync(0);
			expect(oldBrowser.close).toHaveBeenCalledOnce();
			expect(nextBrowser.close).not.toHaveBeenCalled();
			await expect(session.run({ action: "tabs", operation: "list" })).resolves.toMatchObject({
				details: { action: "tabs" },
			});
		} finally {
			oldLaunch.resolve(oldBrowser);
			await oldRun;
			await vi.advanceTimersByTimeAsync(0);
			await session.close();
		}
		expect(nextBrowser.close).toHaveBeenCalledOnce();
	});
});
