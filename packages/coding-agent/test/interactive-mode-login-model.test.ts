import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
	completeProviderAuthentication,
	type LoginFlowHost,
	showCustomProviderWizard,
} from "../src/modes/interactive/login-flow.ts";

const unknownModel = { provider: "unknown", id: "unknown", api: "unknown" } as Model<Api>;
const claude = (id: string) =>
	({ provider: "anthropic", id, api: "anthropic-messages" }) as Model<"anthropic-messages">;

async function logIn(available: Model<"anthropic-messages">[], providerId = "anthropic", providerName = "Anthropic") {
	const host = {
		session: { modelRuntime: { getAvailable: async () => available }, setModel: vi.fn(async () => {}) },
		updateAvailableProviderCount: vi.fn(async () => {}),
		invalidateFooter: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(async () => {}),
		onLoginSucceeded: vi.fn(async () => {}),
		openModelSelectorIfUnset: vi.fn(async () => {}),
	};
	await completeProviderAuthentication(
		host as unknown as LoginFlowHost,
		providerId,
		providerName,
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

	it("selects the first model of a provider with no configured default", async () => {
		const model = {
			provider: "nebius",
			id: "glm-9",
			api: "openai-completions",
		} as unknown as Model<"anthropic-messages">;
		const context = await logIn([model], "nebius", "Nebius");
		expect(context.session.setModel).toHaveBeenCalledWith(model);
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("still prefers the provider default when it is offered", async () => {
		const context = await logIn([claude("claude-sonnet-5"), claude("claude-opus-4-8")]);
		expect(context.session.setModel).toHaveBeenCalledWith(claude("claude-opus-4-8"));
	});
});

describe("the post-login hook", () => {
	it("runs before /model after an account or API key login", async () => {
		const calls: string[] = [];
		const host = await logIn([claude("claude-sonnet-5")]);
		expect(host.onLoginSucceeded).toHaveBeenCalledTimes(1);
		host.onLoginSucceeded.mockImplementation(async () => {
			calls.push("hook");
		});
		host.openModelSelectorIfUnset.mockImplementation(async () => {
			calls.push("model");
		});
		await completeProviderAuthentication(
			host as unknown as LoginFlowHost,
			"anthropic",
			"Anthropic",
			"api_key",
			unknownModel,
		);
		expect(calls).toEqual(["hook", "model"]);
	});

	// Display name, base URL, model ids and API key, then the protocol and the one-model choice.
	async function addCustomProvider(modelIds: string, choice?: "Select model" | "Skip") {
		const inputs = ["Local", "http://127.0.0.1:1/v1", modelIds, ""];
		const selections = ["openai-completions", ...(choice ? [choice] : [])];
		const model = { provider: "local", id: "m1", api: "openai-completions" } as Model<Api>;
		const host = {
			session: {
				modelRuntime: {
					getProviders: () => [],
					reloadConfig: vi.fn(async () => {}),
					getModel: () => model,
					login: vi.fn(async () => {}),
				},
				setModel: vi.fn(async () => {}),
			},
			showExtensionInput: vi.fn(async () => inputs.shift()),
			showExtensionSelector: vi.fn(async () => selections.shift()),
			showStatus: vi.fn(),
			showError: vi.fn(),
			updateAvailableProviderCount: vi.fn(async () => {}),
			invalidateFooter: vi.fn(),
			updateEditorBorderColor: vi.fn(),
			onLoginSucceeded: vi.fn(async () => {}),
			openModelSelectorIfUnset: vi.fn(async () => {}),
		};
		await showCustomProviderWizard(host as unknown as LoginFlowHost);
		return host;
	}

	it.each([
		["one model, selected", "m1", "Select model"],
		["one model, skipped", "m1", "Skip"],
		["two models", "m1, m2", undefined],
	] as const)("runs after a custom endpoint with %s", async (_label, modelIds, choice) => {
		const host = await addCustomProvider(modelIds, choice);
		expect(host.showError).not.toHaveBeenCalled();
		expect(host.onLoginSucceeded).toHaveBeenCalledTimes(1);
	});
});
