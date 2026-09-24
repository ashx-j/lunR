import { createServer, request } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resolveChildExcludeTools } from "../src/builtin-extensions/pi-subagents/src/runs/shared/child-tools.ts";
import { browserUrl, createBrowserProxy, isPublicAddress, resolveBrowserHost } from "../src/core/browser/network.ts";
import { BrowserSession, boundedBrowserText } from "../src/core/browser/runtime.ts";
import { BrowserParams } from "../src/core/browser/schema.ts";
import {
	gateToolCall,
	resetAllPermissionContexts,
	setPermissionMode,
} from "../src/core/permissions.ts";

const text = (result: Awaited<ReturnType<BrowserSession["run"]>>) =>
	result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");

afterEach(() => {
	resetAllPermissionContexts();
});

describe("browser policy and contract", () => {
	it.each([
		"127.0.0.1",
		"0.0.0.0",
		"10.0.0.1",
		"172.16.0.1",
		"192.168.1.1",
		"169.254.169.254",
		"100.64.1.1",
		"224.0.0.1",
		"::1",
		"::ffff:127.0.0.1",
		"fc00::1",
		"fe80::1",
		"2001:db8::1",
		"2002:7f00:1::",
		"64:ff9b::7f00:1",
	])("rejects reserved address %s", (address) => {
		expect(isPublicAddress(address)).toBe(false);
	});
	it("permits public addresses and rejects malformed URLs", () => {
		expect(isPublicAddress("8.8.8.8")).toBe(true);
		expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
		for (const url of [
			"file:///tmp/test",
			"data:text/html,x",
			"javascript:alert(1)",
			"https://user:pass@example.com",
		])
			expect(() => browserUrl(url)).toThrow();
	});
	it("normalizes obfuscated IPs and resolves localhost before enforcing policy", async () => {
		expect(browserUrl("http://2130706433").hostname).toBe("127.0.0.1");
		await expect(resolveBrowserHost("localhost", false)).rejects.toThrow("network policy");
		expect(await resolveBrowserHost("127.0.0.1", true)).toBe("127.0.0.1");
	});
	it("caps snapshots and strips terminal controls", () => {
		expect(boundedBrowserText("x\u001b[31m")).not.toContain("\u001b");
		const result = boundedBrowserText("some text\n".repeat(10000));
		expect(result).toContain("truncated");
		expect(Buffer.byteLength(result)).toBeLessThan(16500);
		expect(result.split("\n").length).toBeLessThanOrEqual(301);
	});
	it("has one bounded schema without evaluation or file-transfer parameters", () => {
		expect(BrowserParams.properties.action.enum).toEqual([
			"navigate",
			"inspect",
			"act",
			"tabs",
			"screenshot",
			"close",
		]);
		expect(Object.keys(BrowserParams.properties)).not.toEqual(
			expect.arrayContaining(["evaluate", "script", "path", "cookies"]),
		);
		for (const permissions of ["full", "read-only"] as const)
			expect(resolveChildExcludeTools({ permissions })).not.toContain("browser");
	});
	it("keeps browser enablement and network settings user-managed", async () => {
		setPermissionMode("auto");
		for (const tool of ["edit", "write", "code_rewrite"]) {
			const result = await gateToolCall(
				tool,
				{ path: join(process.env.PI_CODING_AGENT_DIR!, "install-features.json") },
				process.cwd(),
			);
			expect(result?.reason).toContain("user-managed");
		}
	});
	it("gates interactions through existing modes, while observation stays allowed", async () => {
		for (const mode of ["yolo", "auto", "read-only"] as const) {
			setPermissionMode(mode);
			for (const action of ["navigate", "inspect", "screenshot", "tabs", "close"])
				expect(await gateToolCall("browser", { action }, process.cwd())).toBeUndefined();
			const result = await gateToolCall(
				"browser",
				{ action: "act", interaction: "click", name: "Submit" },
				process.cwd(),
			);
			expect(Boolean(result?.block)).toBe(mode === "read-only");
		}
	});
	it("blocks HTTP subrequests and HTTPS tunnels to private destinations at the proxy", async () => {
		const proxy = await createBrowserProxy(false);
		try {
			const status = await new Promise<number | undefined>((resolve, reject) => {
				const req = request(proxy.url, { path: "http://127.0.0.1:12345/private" }, (response) => {
					response.resume();
					resolve(response.statusCode);
				});
				req.on("error", reject);
				req.end();
			});
			expect(status).toBe(403);
			const response = await new Promise<string>((resolve, reject) => {
				const url = new URL(proxy.url);
				const socket = connect(Number(url.port), url.hostname, () =>
					socket.write("CONNECT [::1]:443 HTTP/1.1\r\nHost: [::1]:443\r\n\r\n"),
				);
				socket.once("data", (chunk) => {
					resolve(chunk.toString());
					socket.destroy();
				});
				socket.on("error", reject);
			});
			expect(response).toContain("403");
		} finally {
			await proxy.close();
		}
	});
});

describe.skipIf(!process.env.PLAYWRIGHT_BROWSERS_PATH)("actual Chromium fixture", () => {
	const sessions: BrowserSession[] = [];
	let url: string;
	let privateRequests = 0;
	const server = createServer((req, res) => {
		if (req.url === "/private-subrequest") privateRequests++;
		if (req.url === "/slow") return;
		if (req.url === "/redirect") {
			res.writeHead(302, { location: "/" }).end();
			return;
		}
		if (req.url === "/download") {
			res.writeHead(200, { "content-disposition": 'attachment; filename="no.txt"' }).end("no");
			return;
		}
		res.setHeader("content-type", "text/html");
		res.end(`<!doctype html><title>Fixture</title><h1>Initial</h1>
		<label>Name<input id="name"></label><label for="option">Option</label><select id="option"><option value="a">Alpha</option><option value="b">Beta</option></select>
		<label>Agree<input type="checkbox"></label><button onclick="document.querySelector('h1').textContent='Hello '+document.querySelector('input').value">Submit</button>
		<button>Duplicate</button><button>Duplicate</button><a href="/redirect">Redirect</a><a href="/download">Download</a>
		<script>document.querySelector('h1').textContent='Rendered with JavaScript'; document.body.insertAdjacentHTML('beforeend','<p>Cookie: '+document.cookie+'</p>');document.cookie='fixture=one';</script>`);
	});
	beforeAll(async () => {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No fixture port");
		url = `http://127.0.0.1:${address.port}`;
	});
	afterEach(async () => {
		await Promise.all(sessions.splice(0).map((session) => session.close()));
	});
	afterAll(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const session = (allowPrivate = true, idleMs?: number) => {
		const browser = new BrowserSession(allowPrivate, idleMs);
		sessions.push(browser);
		return browser;
	};
	it("renders JavaScript, performs multi-step accessible interactions, fails ambiguity, captures screenshots and redirects", async () => {
		const browser = session();
		await browser.run({ action: "navigate", url });
		expect(text(await browser.run({ action: "inspect" }))).toContain("Rendered with JavaScript");
		await browser.run({ action: "act", interaction: "fill", label: "Name", value: "Ada" });
		await browser.run({ action: "act", interaction: "select", label: "Option", value: "b" });
		await browser.run({ action: "act", interaction: "check", label: "Agree", checked: true });
		await browser.run({ action: "act", interaction: "press", role: "button", name: "Submit", value: "Enter" });
		expect(text(await browser.run({ action: "inspect", role: "heading" }))).toContain("Hello Ada");
		await expect(
			browser.run({ action: "act", interaction: "click", role: "button", name: "Duplicate" }),
		).rejects.toThrow("2 elements");
		await expect(
			browser.run({ action: "act", interaction: "press", label: "Name", value: "Control+V" }),
		).rejects.toThrow("press accepts");
		const image = await browser.run({ action: "screenshot" });
		expect(image.content.some((part) => part.type === "image" && part.mimeType === "image/jpeg")).toBe(true);
		await browser.run({ action: "act", interaction: "click", role: "link", name: "Redirect" });
		expect(text(await browser.run({ action: "inspect" }))).toContain("Rendered with JavaScript");
	}, 30000);
	it("isolates session cookies and bounds tabs", async () => {
		const first = session();
		const second = session();
		await first.run({ action: "navigate", url });
		await first.run({ action: "navigate", url });
		expect(text(await first.run({ action: "inspect" }))).toContain("fixture=one");
		await second.run({ action: "navigate", url });
		expect(text(await second.run({ action: "inspect" }))).not.toContain("fixture=one");
		for (let i = 0; i < 3; i++) await first.run({ action: "tabs", operation: "create" });
		await expect(first.run({ action: "tabs", operation: "create" })).rejects.toThrow("Maximum 4");
		await first.run({ action: "tabs", operation: "select", tab: 1 });
		await first.run({ action: "tabs", operation: "close", tab: 2 });
		expect(text(await first.run({ action: "tabs", operation: "list" }))).not.toContain('"id":2');
		await first.run({ action: "close" });
		await expect(first.run({ action: "inspect" })).rejects.toThrow("No browser");
	}, 30000);
	it("blocks private page subrequests before they reach the fixture server", async () => {
		const { chromium } = await import("playwright-core");
		const proxy = await createBrowserProxy(false);
		const browser = await chromium.launch({
			proxy: { server: proxy.url, bypass: "<-loopback>" },
			chromiumSandbox: true,
		});
		try {
			const page = await browser.newPage();
			await page.setContent(`<img src="${url}/private-subrequest">`);
			expect(proxy.blockedReason()).toContain("network policy");
			expect(privateRequests).toBe(0);
		} finally {
			await browser.close();
			await proxy.close();
		}
	}, 15000);
	it("blocks private navigation by default", async () => {
		await expect(session(false).run({ action: "navigate", url })).rejects.toThrow("network policy");
	}, 15000);
	it("cancels an in-flight operation and invalidates queued work", async () => {
		const browser = session();
		await browser.run({ action: "navigate", url });
		const controller = new AbortController();
		const pending = browser.run({ action: "navigate", url: `${url}/slow` }, controller.signal);
		const queued = browser.run({ action: "inspect" });
		const assertions = Promise.all([expect(pending).rejects.toThrow(), expect(queued).rejects.toThrow("cancelled")]);
		setTimeout(() => controller.abort(), 100);
		await assertions;
		await browser.close();
		await expect(browser.run({ action: "inspect" })).rejects.toThrow("No browser");
	}, 15000);
	it("closes idle contexts", async () => {
		const browser = session(true, 50);
		await browser.run({ action: "navigate", url });
		await new Promise((resolve) => setTimeout(resolve, 150));
		await expect(browser.run({ action: "inspect" })).rejects.toThrow("No browser");
	}, 15000);
});
