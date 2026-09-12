import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
	connectGate: Promise.resolve(),
	connectStarted: vi.fn(),
	clientClose: vi.fn(async () => {}),
	transportClose: vi.fn(async () => {}),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
	Client: class {
		async connect() {
			fakes.connectStarted();
			await fakes.connectGate;
		}
		async listTools() {
			return { tools: [] };
		}
		async listResources() {
			return { resources: [] };
		}
		setNotificationHandler() {}
		close = fakes.clientClose;
	},
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
	StdioClientTransport: class {
		close = fakes.transportClose;
	},
}));

import { McpServerManager } from "../src/builtin-extensions/pi-mcp-adapter/server-manager.ts";

describe("McpServerManager shutdown", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		fakes.connectGate = Promise.resolve();
	});

	it("closes a transport whose connection finishes after closeAll", async () => {
		let release!: () => void;
		fakes.connectGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const manager = new McpServerManager();
		const definition = { command: "node", args: ["fixture.js"] };
		const connecting = manager.connect("playwright", definition);
		await vi.waitFor(() => expect(fakes.connectStarted).toHaveBeenCalledTimes(1));
		const duplicate = manager.connect("playwright", definition);

		await manager.closeAll();
		expect(fakes.clientClose).toHaveBeenCalled();
		expect(fakes.transportClose).toHaveBeenCalled();

		release();
		await expect(connecting).rejects.toThrow(/closed|shutdown|aborted/i);
		await expect(duplicate).rejects.toThrow(/closed|shutdown|aborted/i);
		expect(manager.getConnection("playwright")).toBeUndefined();
	});
});
