import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function lifecycleFixture(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		if (!process.env.ACP_FIXTURE_STARTUP_DIALOG) return;
		const selected = await ctx.ui.select("startup select", ["yes"]);
		const confirmed = await ctx.ui.confirm("startup confirm", "continue?");
		const input = await ctx.ui.input("startup input");
		const edited = await ctx.ui.editor("startup editor");
		writeFileSync(join(ctx.cwd, "startup-results.json"), JSON.stringify([selected, confirmed, input, edited]));
	});
	for (const kind of ["timed", "aborted"] as const) {
		pi.registerCommand(`fixture-${kind}-form`, {
			async handler(_args, ctx) {
				const controller = new AbortController();
				const timer = kind === "aborted" ? setTimeout(() => controller.abort(), 200) : undefined;
				try {
					const answer = await ctx.ui.input(
						`${kind} question`,
						undefined,
						kind === "timed" ? { timeout: 200 } : { signal: controller.signal },
					);
					writeFileSync(join(ctx.cwd, `${kind}-answer`), answer ?? "cancelled");
				} finally {
					if (timer) clearTimeout(timer);
				}
			},
		});
	}
	pi.registerCommand("fixture-protocol-failure", {
		async handler(_args, ctx) {
			// inherited descriptors bypass javascript stdout redirection.
			spawnSync(process.execPath, ["-e", "console.log('extension child status notice')"], { stdio: "inherit" });
			await new Promise((resolve) => setTimeout(resolve, 500));
			writeFileSync(join(ctx.cwd, "after-failure"), "worker continued");
			pi.sendMessage({ customType: "fixture-error", display: true, content: "work continued after failure" });
		},
	});
	let abortTimer: ReturnType<typeof setInterval> | undefined;
	pi.on("before_agent_start", (_event, ctx) => {
		ctx.ui.notify("MCP: 1 servers connected (83 tools)", "info");
		abortTimer = setInterval(() => {
			if (!existsSync(join(ctx.cwd, "abort-approval"))) return;
			clearInterval(abortTimer);
			ctx.abort();
		}, 20);
	});
	pi.on("agent_end", () => {
		if (abortTimer) clearInterval(abortTimer);
	});
}
