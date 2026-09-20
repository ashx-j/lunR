import type { ImageContent, TextContent } from "@earendil-works/pi-ai/compat";
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";
import { truncateHead } from "../tools/truncate.ts";
import { browserUrl, createBrowserProxy, resolveBrowserHost } from "./network.ts";
import type { BrowserInput } from "./schema.ts";

type Resources = {
	browser: Browser;
	context: BrowserContext;
	proxy: Awaited<ReturnType<typeof createBrowserProxy>>;
	pages: Map<number, Page>;
	selected?: number;
	nextId: number;
};

export function boundedBrowserText(text: string): string {
	const result = truncateHead(text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ""), { maxBytes: 16384, maxLines: 300 });
	return (
		result.content +
		(result.truncated ? "\n[Snapshot truncated. Inspect a specific role/name or label to narrow it.]" : "")
	);
}

function target(page: Page, input: BrowserInput): Locator {
	if (input.label !== undefined && input.role === undefined && input.name === undefined) {
		return page.getByLabel(input.label, { exact: true });
	}
	if (input.role && input.label === undefined) return page.getByRole(input.role, { name: input.name, exact: true });
	throw new Error("Specify role with optional exact name, or label alone. Inspect the page to find a target.");
}

async function uniqueTarget(page: Page, input: BrowserInput): Promise<Locator> {
	const locator = target(page, input);
	const count = await locator.count();
	if (count !== 1)
		throw new Error(
			`Target matched ${count} elements. Inspect and choose a unique exact role/name or label; no action was taken.`,
		);
	return locator;
}

export class BrowserSession {
	private resources?: Promise<Resources>;
	private queue: Promise<unknown> = Promise.resolve();
	private closing: Promise<void> = Promise.resolve();
	private generation = 0;
	private queued = 0;
	private idle?: ReturnType<typeof setTimeout>;

	private readonly allowPrivate: boolean;
	private readonly idleMs: number;

	constructor(allowPrivate = false, idleMs = 300000) {
		this.allowPrivate = allowPrivate;
		this.idleMs = idleMs;
	}

	async close(): Promise<void> {
		this.generation++;
		clearTimeout(this.idle);
		const pending = this.resources;
		this.resources = undefined;
		const previous = this.closing;
		const closing = (async () => {
			await previous;
			const resources = await pending?.catch(() => undefined);
			if (!resources) return;
			try {
				await resources.browser.close();
			} finally {
				await resources.proxy.close();
			}
		})();
		this.closing = closing.catch(() => undefined);
		return closing;
	}

	async run(
		input: BrowserInput,
		signal?: AbortSignal,
	): Promise<{ content: (TextContent | ImageContent)[]; details: { action: string } }> {
		if (this.queued >= 16) throw new Error("Browser queue is full. Wait for the current operation.");
		const generation = this.generation;
		this.queued++;
		const operation = this.queue.then(async () => {
			if (signal?.aborted || generation !== this.generation)
				throw new Error("Browser operation cancelled; navigate again in a new call.");
			clearTimeout(this.idle);
			const cancellation = new AbortController();
			const abort = () => {
				cancellation.abort();
				void this.close().catch(() => undefined);
			};
			signal?.addEventListener("abort", abort, { once: true });
			const deadline = setTimeout(abort, 30000);
			try {
				if (input.action === "close") {
					await this.close();
					return {
						content: [{ type: "text" as const, text: "Browser closed; ephemeral cookies and tabs discarded." }],
						details: { action: input.action },
					};
				}
				await this.closing;
				if (signal?.aborted || generation !== this.generation) throw new Error("Browser operation cancelled.");
				if (
					!this.resources &&
					input.action !== "navigate" &&
					!(input.action === "tabs" && input.operation === "create")
				) {
					throw new Error(
						"No browser is open. Use navigate or tabs/create first. Idle cleanup discards tabs after 5 minutes.",
					);
				}
				this.resources ??= this.open().catch((error) => {
					if (generation === this.generation) this.resources = undefined;
					throw error;
				});
				const resources = await this.resources;
				if (generation !== this.generation) throw new Error("Browser operation cancelled.");
				const content = await Promise.race([
					this.perform(resources, input),
					new Promise<never>((_resolve, reject) => {
						const cancelled = () =>
							reject(
								new Error(
									"Browser cancelled or exceeded 30s; browser closed. External effects may already have occurred.",
								),
							);
						if (cancellation.signal.aborted) cancelled();
						else cancellation.signal.addEventListener("abort", cancelled, { once: true });
					}),
				]);
				if (signal?.aborted || generation !== this.generation)
					throw new Error(
						"Browser operation cancelled; external effects may already have occurred. Inspect before retrying.",
					);
				this.idle = setTimeout(() => {
					void this.close().catch(() => undefined);
				}, this.idleMs);
				this.idle.unref();
				return { content, details: { action: input.action } };
			} catch (error) {
				if (generation === this.generation) {
					this.idle = setTimeout(() => {
						void this.close().catch(() => undefined);
					}, this.idleMs);
					this.idle.unref();
				}
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(boundedBrowserText(message));
			} finally {
				clearTimeout(deadline);
				signal?.removeEventListener("abort", abort);
			}
		});
		this.queue = operation.catch(() => undefined);
		try {
			return await operation;
		} finally {
			this.queued--;
		}
	}

	private async open(): Promise<Resources> {
		const proxy = await createBrowserProxy(this.allowPrivate);
		let browser: Browser | undefined;
		try {
			const { chromium } = await import("playwright-core");
			browser = await chromium.launch({
				headless: true,
				timeout: 15000,
				chromiumSandbox: true,
				proxy: { server: proxy.url, bypass: "<-loopback>" },
				args: ["--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
			});
			const context = await browser.newContext({
				acceptDownloads: false,
				serviceWorkers: "block",
				permissions: [],
				viewport: { width: 1280, height: 800 },
			});
			context.setDefaultTimeout(10000);
			context.setDefaultNavigationTimeout(15000);
			await context.route("**/*", async (route) => {
				try {
					browserUrl(route.request().url());
					await route.continue();
				} catch {
					await route.abort().catch(() => undefined);
				}
			});
			await context.routeWebSocket("**/*", (socket) => socket.close());
			const resources: Resources = { browser, context, proxy, pages: new Map(), nextId: 1 };
			context.on("page", (page) => {
				if (resources.pages.size >= 4) {
					void page.close().catch(() => undefined);
					return;
				}
				const id = resources.nextId++;
				resources.pages.set(id, page);
				page.on("close", () => resources.pages.delete(id));
				page.on("dialog", (dialog) => {
					void dialog.dismiss().catch(() => undefined);
				});
				page.on("download", (download) => {
					void download.cancel().catch(() => undefined);
				});
			});
			return resources;
		} catch (error) {
			await browser?.close().catch(() => undefined);
			await proxy.close();
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`Browser launch failed. Ask the user to run lunr features enable browser to install matching Chromium, then restart. Nothing was installed by this call. ${message}`,
			);
		}
	}

	private async perform(resources: Resources, input: BrowserInput): Promise<(TextContent | ImageContent)[]> {
		const text = (value: string): TextContent[] => [{ type: "text", text: boundedBrowserText(value) }];
		let page = resources.pages.get(input.tab ?? resources.selected ?? -1);
		if (input.action === "tabs") {
			if (!input.operation) throw new Error("tabs requires operation list/create/select/close.");
			if (input.operation === "list")
				return text(
					JSON.stringify(
						[...resources.pages].map(([id, tab]) => ({
							id,
							selected: id === resources.selected,
							url: tab.url(),
						})),
					),
				);
			if (input.operation === "select") {
				if (!page || input.tab === undefined) throw new Error("Select requires an existing tab id from tabs/list.");
				resources.selected = input.tab;
				return text(`Selected tab ${input.tab}.`);
			}
			if (input.operation === "close") {
				if (!page) throw new Error("No matching tab. Use tabs/list.");
				await page.close();
				if (!resources.pages.has(resources.selected ?? -1))
					resources.selected = resources.pages.keys().next().value;
				return text("Tab closed.");
			}
		}
		if (input.action === "navigate" || (input.action === "tabs" && input.operation === "create")) {
			if (input.action === "navigate" && !input.url) throw new Error("navigate requires url.");
			const url = input.url ? browserUrl(input.url) : undefined;
			if (url) await resolveBrowserHost(url.hostname, this.allowPrivate);
			if (input.tab !== undefined && !page && input.action === "navigate")
				throw new Error("Unknown tab. Use tabs/list.");
			if (!page || input.action === "tabs") {
				if (resources.pages.size >= 4) throw new Error("Maximum 4 tabs. Close a tab first.");
				page = await resources.context.newPage();
			}
			resources.selected = [...resources.pages].find(([, candidate]) => candidate === page)?.[0];
			if (url) await page.goto(url.href, { waitUntil: "domcontentloaded" });
			return text(
				`Tab ${resources.selected}: ${page.url()}\nUse inspect for rendered content.${resources.proxy.blockedReason() ? `\nNetwork warning: ${resources.proxy.blockedReason()}` : ""}`,
			);
		}
		if (!page) throw new Error("No selected tab. Use tabs/list or navigate.");
		if (input.action === "inspect") {
			const locator =
				input.role || input.label !== undefined ? await uniqueTarget(page, input) : page.locator("body");
			return text(`Untrusted page content at ${page.url()}:\n${await locator.ariaSnapshot()}`);
		}
		if (input.action === "screenshot") {
			const image = await page.screenshot({ type: "jpeg", quality: 70, fullPage: false, timeout: 10000 });
			if (image.length > 2 * 1024 * 1024) throw new Error("Screenshot exceeds 2MB limit.");
			return [
				...text(`Untrusted viewport screenshot at ${page.url()}`),
				{ type: "image", mimeType: "image/jpeg", data: image.toString("base64") },
			];
		}
		if (input.action === "act") {
			const locator = await uniqueTarget(page, input);
			switch (input.interaction) {
				case "click":
					await locator.click();
					break;
				case "fill":
					if (input.value === undefined) throw new Error("fill requires value.");
					await locator.fill(input.value);
					break;
				case "select":
					if (input.value === undefined) throw new Error("select requires option value.");
					await locator.selectOption(input.value);
					break;
				case "check":
					if (input.checked === undefined) throw new Error("check requires checked.");
					await locator.setChecked(input.checked);
					break;
				case "press":
					if (
						!input.value ||
						!/^(Enter|Tab|Escape|Space|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown)$/.test(
							input.value,
						)
					) {
						throw new Error(
							"press accepts Enter/Tab/Escape/Space/Backspace/Delete/arrows/Home/End/PageUp/PageDown only. Use fill for text.",
						);
					}
					await locator.press(input.value);
					break;
				default:
					throw new Error("act requires interaction click/fill/select/check/press.");
			}
			return text(
				`Interaction completed at ${page.url()}. Inspect to verify the result. External effects cannot be undone by /undo.`,
			);
		}
		throw new Error("Unsupported browser action.");
	}
}
