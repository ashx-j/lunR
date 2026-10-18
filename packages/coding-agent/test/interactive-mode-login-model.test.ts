import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type LoginContext = {
	session: {
		modelRuntime: { getAvailable: () => Promise<Model<"anthropic-messages">[]> };
		setModel: (model: unknown) => Promise<void>;
	};
	updateAvailableProviderCount: () => Promise<void>;
	footer: { invalidate: () => void };
	updateEditorBorderColor: () => void;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	maybeWarnAboutAnthropicSubscriptionAuth: () => Promise<void>;
};

type InteractiveModePrototype = {
	completeProviderAuthentication(
		this: LoginContext,
		providerId: string,
		providerName: string,
		authType: "oauth" | "api_key",
		previousModel: Model<any> | undefined,
		overrides?: { savedNote?: string },
	): Promise<void>;
};

const prototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;
const unknownModel = { provider: "unknown", id: "unknown", api: "unknown" } as Model<any>;
const claude = (id: string) =>
	({ provider: "anthropic", id, api: "anthropic-messages" }) as Model<"anthropic-messages">;

async function logIn(available: Model<"anthropic-messages">[]) {
	const context: LoginContext = {
		session: { modelRuntime: { getAvailable: async () => available }, setModel: vi.fn(async () => {}) },
		updateAvailableProviderCount: vi.fn(async () => {}),
		footer: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(async () => {}),
	};
	await prototype.completeProviderAuthentication.call(context, "anthropic", "Anthropic", "oauth", unknownModel, {
		savedNote: "Saved.",
	});
	return context;
}

describe("model selection after /login", () => {
	it("selects the provider's first model when its default is not offered", async () => {
		const context = await logIn([claude("claude-sonnet-5"), claude("claude-haiku-4-5-20251001")]);
		expect(context.session.setModel).toHaveBeenCalledWith(claude("claude-sonnet-5"));
		expect(context.showStatus).toHaveBeenCalledWith("Logged in to Anthropic. Selected claude-sonnet-5. Saved.");
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("still prefers the provider default when it is offered", async () => {
		const context = await logIn([claude("claude-sonnet-5"), claude("claude-opus-4-8")]);
		expect(context.session.setModel).toHaveBeenCalledWith(claude("claude-opus-4-8"));
	});
});
