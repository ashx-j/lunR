import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { completeProviderAuthentication, type LoginFlowHost } from "../src/modes/interactive/login-flow.ts";

const unknownModel = { provider: "unknown", id: "unknown", api: "unknown" } as Model<Api>;
const claude = (id: string) =>
	({ provider: "anthropic", id, api: "anthropic-messages" }) as Model<"anthropic-messages">;

async function logIn(available: Model<"anthropic-messages">[]) {
	const host = {
		session: { modelRuntime: { getAvailable: async () => available }, setModel: vi.fn(async () => {}) },
		updateAvailableProviderCount: vi.fn(async () => {}),
		invalidateFooter: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(async () => {}),
		openModelSelectorIfUnset: vi.fn(async () => {}),
	};
	await completeProviderAuthentication(
		host as unknown as LoginFlowHost,
		"anthropic",
		"Anthropic",
		"oauth",
		unknownModel,
		{
			savedNote: "Saved.",
		},
	);
	return host;
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
