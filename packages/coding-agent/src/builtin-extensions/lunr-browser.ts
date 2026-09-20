import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "../core/extensions/types.ts";
import { getFeatureOption, isFeatureEnabled } from "../core/install-features.ts";
import { BROWSER_DESCRIPTION, BrowserParams } from "../core/browser/schema.ts";
import type { BrowserSession } from "../core/browser/runtime.ts";

export default function browserExtension(pi: ExtensionAPI): void {
	if (!isFeatureEnabled("browser")) return;
	let session: BrowserSession | undefined;
	let generation = 0;
	const close = async () => {
		generation++;
		const previous = session;
		session = undefined;
		await previous?.close();
	};
	pi.on("session_shutdown", close);
	pi.on("session_start", close);
	pi.on("agent_end", async (event) => {
		if (event.messages.some((message) => message.role === "assistant" && message.stopReason === "aborted")) await close();
	});
	pi.registerTool({
		name: "browser",
		label: "Browser",
		description: BROWSER_DESCRIPTION,
		parameters: BrowserParams,
		async execute(_id, input, signal) {
			if (!isFeatureEnabled("browser")) {
				await close();
				throw new Error("Browser is disabled. Ask the user to enable it with lunr features enable browser and restart.");
			}
			const current = generation;
			const { BrowserSession } = await import("../core/browser/runtime.ts");
			if (current !== generation || signal?.aborted) throw new Error("Browser call cancelled during initialization.");
			session ??= new BrowserSession(getFeatureOption("browser", "allow-private-network") === true);
			return session.run(input, signal);
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", `browser ${args.action ?? ""}`), 0, 0);
		},
	});
}
