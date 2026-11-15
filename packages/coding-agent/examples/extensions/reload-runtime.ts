/**
 * Reload Runtime Extension
 *
 * Demonstrates ctx.reload() from ExtensionCommandContext.
 * Only commands get ExtensionCommandContext, so reload is only reachable from a command.
 * Tools and shortcuts get ExtensionContext. pi.sendUserMessage("/cmd") does not run
 * extension commands, it sends the text to the model.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	// Treat reload as terminal for this handler.
	pi.registerCommand("reload-runtime", {
		description: "Reload extensions, skills, prompts, themes, and context files",
		handler: async (_args, ctx) => {
			await ctx.reload();
			return;
		},
	});
}
