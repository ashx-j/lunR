import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lightBuiltinExtensions, loadDeferredBuiltinExtensions } from "../src/builtin-extensions/index.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

/** The tool part of a request, as the model sees it: names, descriptions and schemas, in order. */
function toolPayload(session: AgentSession): string {
	return JSON.stringify(
		session.agent.state.tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		})),
	);
}

describe("/reload", () => {
	const dirs: string[] = [];
	afterEach(() => {
		while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
	});

	it("sends the same tool payload after a reload as at startup, with the built-in extensions loaded", async () => {
		const tempDir = join(tmpdir(), `lunr-reload-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		dirs.push(tempDir);
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			settingsManager: SettingsManager.create(tempDir, tempDir),
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				extensionFactories: lightBuiltinExtensions,
			},
		});
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(tempDir),
		});
		try {
			// As interactive startup does: light built-ins first, the deferred ones attached after paint. A
			// bound shutdown handler makes reload emit session_start, as it does in the TUI.
			await session.bindExtensions({ mode: "print", shutdownHandler: () => {} });
			// lunr-computer-use deactivates its tools in session_start on platforms it does not support, and the
			// attach path's tool refresh runs after that, so its tools would be active here but not in the TUI.
			const deferred = (await loadDeferredBuiltinExtensions()).filter(
				(extension) => extension.name !== "lunr-computer-use",
			);
			await session.attachInlineExtensions(deferred);
			const namesAtStartup = session.getActiveToolNames();
			const atStartup = toolPayload(session);
			expect(namesAtStartup).toContain("subagent_supervisor");

			await session.reload();

			expect(session.getActiveToolNames()).toEqual(namesAtStartup);
			expect(toolPayload(session)).toBe(atStartup);
		} finally {
			session.dispose();
		}
	}, 60_000);
});
