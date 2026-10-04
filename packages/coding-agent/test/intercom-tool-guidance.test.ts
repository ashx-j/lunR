import { afterEach, expect, it, vi } from "vitest";
import intercomExtension from "../src/builtin-extensions/pi-intercom/index.ts";

type ExtensionAPI = Parameters<typeof intercomExtension>[0];
type ToolDefinition = Parameters<ExtensionAPI["registerTool"]>[0];

vi.mock("../src/builtin-extensions/pi-intercom/broker/spawn.ts", () => ({
	isNativeSupervisorChannelActive: () => false,
	spawnBrokerIfNeeded: vi.fn(),
}));
vi.mock("../src/builtin-extensions/pi-intercom/config.ts", () => ({
	loadConfig: () => ({}),
	getAskTimeoutMs: () => 30_000,
}));

afterEach(() => vi.unstubAllEnvs());

it("registers local-session guidance with the existing action contract", () => {
	vi.stubEnv("PI_SUBAGENT_CHILD", "0");
	const tools: ToolDefinition[] = [];
	const api = {
		on: vi.fn(),
		events: { on: vi.fn(() => vi.fn()) },
		registerMessageRenderer: vi.fn(),
		registerCommand: vi.fn(),
		registerShortcut: vi.fn(),
		registerTool: (tool: ToolDefinition) => tools.push(tool),
	} as unknown as ExtensionAPI;
	intercomExtension(api);
	const tool = tools.find((entry) => entry.name === "intercom");
	expect(tool).toBeDefined();
	expect(tool?.description).toContain("another lunR session running on this machine");
	expect(tool?.promptSnippet).toContain("other local lunR sessions");
	expect({
		name: tool?.name,
		description: tool?.description,
		promptSnippet: tool?.promptSnippet,
		parameters: tool?.parameters,
	}).toMatchSnapshot();
});
