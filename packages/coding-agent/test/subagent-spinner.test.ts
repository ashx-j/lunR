import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { buildWidgetLines, renderSubagentResult } from "../src/builtin-extensions/pi-subagents/src/tui/render.ts";
import { getCustomizeBridge, registerCustomizeBridge } from "../src/core/customize.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { getSubagentSpinnerDefinition, SUBAGENT_SPINNER_NAMES } from "../src/core/subagent-spinner.ts";

const theme = {
	fg: (_token: string, value: string) => value,
	bold: (value: string) => value,
};

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("subagent spinner setting", () => {
	it("defaults to braille and persists a named choice", async () => {
		const root = mkdtempSync(join(tmpdir(), "lunr-subagent-spinner-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		const manager = SettingsManager.create(root, agentDir);
		expect(manager.getSubagentSpinner()).toBe("braille");

		manager.setSubagentSpinner("snake");
		await manager.flush();
		expect(SettingsManager.create(root, agentDir).getSubagentSpinner()).toBe("snake");
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).subagentSpinner).toBe("snake");
	});

	it("keeps every frame width stable", () => {
		for (const name of SUBAGENT_SPINNER_NAMES) {
			const widths = new Set(getSubagentSpinnerDefinition(name).frames.map(visibleWidth));
			expect(widths.size, name).toBe(1);
		}
	});

	it("applies bridge changes to active async rows without rebuilding state", () => {
		const manager = SettingsManager.inMemory({ subagentSpinner: "braille" });
		registerCustomizeBridge(manager);
		const job = {
			asyncId: "spinner-run",
			asyncDir: "Z:/missing/spinner-run",
			status: "running",
			mode: "single",
			agents: ["Inspect runtime"],
			steps: [{ agent: "Inspect runtime", description: "Inspect runtime", status: "running", index: 0 }],
		};
		const braille = buildWidgetLines([job] as never, theme as never, 80, false, 0)[0]!;
		expect(braille).toContain(getSubagentSpinnerDefinition("braille").frames[0]);

		manager.setSubagentSpinner("snake");
		expect(getCustomizeBridge()?.getSubagentSpinner()).toBe("snake");
		const snake = buildWidgetLines([job] as never, theme as never, 80, false, 0)[0]!;
		expect(snake).toContain(getSubagentSpinnerDefinition("snake").frames[0]);
		expect(snake).not.toBe(braille);

		const foreground = renderSubagentResult(
			{
				content: [{ type: "text", text: "running" }],
				details: {
					mode: "single",
					results: [
						{
							agent: "Inspect runtime",
							description: "Inspect runtime",
							task: "Inspect runtime",
							exitCode: 0,
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
							progress: {
								index: 0,
								status: "running",
								toolCount: 0,
								tokens: 0,
								durationMs: 0,
							},
						},
					],
				},
			} as never,
			{ expanded: false },
			theme as never,
			0,
		);
		expect(foreground.render(80)[0]).toContain(getSubagentSpinnerDefinition("snake").frames[0]);
	});
});
