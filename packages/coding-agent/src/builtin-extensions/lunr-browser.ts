import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "../core/extensions/types.ts";
import { onBrowserEnabledChange, readBrowserSettings } from "../core/browser/settings.ts";
import { BROWSER_DESCRIPTION, BrowserParams } from "../core/browser/schema.ts";
import type { BrowserSession } from "../core/browser/runtime.ts";

export default function browserExtension(pi: ExtensionAPI): void {
	let enabled = readBrowserSettings().enabled;
	let unsubscribe: (() => void) | undefined;
	let session: BrowserSession | undefined;
	let generation = 0;
	const close = async () => {
		generation++;
		const previous = session;
		session = undefined;
		await previous?.close();
	};
	pi.on("session_shutdown", async () => {
		unsubscribe?.();
		unsubscribe = undefined;
		await close();
	});
	pi.on("session_start", async () => {
		await close();
		enabled = readBrowserSettings().enabled;
		unsubscribe?.();
		unsubscribe = onBrowserEnabledChange((value) => {
			enabled = value;
			if (!enabled) void close().catch(() => undefined);
		});
	});
	pi.on("agent_end", async (event) => {
		if (event.messages.some((message) => message.role === "assistant" && message.stopReason === "aborted")) await close();
	});
	pi.registerTool({
		name: "browser",
		label: "Browser",
		description: BROWSER_DESCRIPTION,
		parameters: BrowserParams,
		async execute(_id, input, signal) {
			if (!enabled) {
				await close();
				throw new Error("Browser is disabled. The user can enable Browser in /settings.");
			}
			const current = generation;
			const { BrowserSession } = await import("../core/browser/runtime.ts");
			if (current !== generation || signal?.aborted) throw new Error("Browser call cancelled during initialization.");
			session ??= new BrowserSession(readBrowserSettings().allowPrivate);
			return session.run(input, signal);
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", `browser ${args.action ?? ""}`), 0, 0);
		},
	});
}
