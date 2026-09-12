/**
 * Static host graph for the Bun binary. bun/cli.ts imports this so VIRTUAL_MODULES
 * still contains jiti, providers/all, and the public coding-agent barrel.
 * Node CLI must not import this file.
 */
import * as bundledPiCodingAgent from "../../index.ts";
import * as bundledPiAiProviders from "@earendil-works/pi-ai/providers/all";
import { createJiti } from "jiti/static";
import { registerBunExtensionHost } from "./loader.ts";

registerBunExtensionHost({
	createJiti,
	providersAll: bundledPiAiProviders,
	codingAgent: bundledPiCodingAgent,
});
