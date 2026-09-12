// Bun needs these modules embedded for extensions. Node resolves aliases on demand.
import * as agent from "@earendil-works/pi-agent-core";
import * as ai from "@earendil-works/pi-ai/compat";
import * as oauth from "@earendil-works/pi-ai/oauth";
import * as providers from "@earendil-works/pi-ai/providers/all";
import * as tui from "@earendil-works/pi-tui";
import { createJiti } from "jiti/static";
import * as typebox from "typebox";
import * as compile from "typebox/compile";
import * as value from "typebox/value";
import * as codingAgent from "../../index.ts";
import { registerBunExtensionHost } from "./loader.ts";

const virtualModules: Record<string, unknown> = {
	typebox,
	"typebox/compile": compile,
	"typebox/value": value,
	"@sinclair/typebox": typebox,
	"@sinclair/typebox/compile": compile,
	"@sinclair/typebox/value": value,
};

for (const [names, module] of [
	[["@earendil-works/pi-agent-core", "@ashx-j/lunr-agent", "@mariozechner/pi-agent-core"], agent],
	[["@earendil-works/pi-tui", "@ashx-j/lunr-tui", "@mariozechner/pi-tui"], tui],
	[["@earendil-works/pi-ai", "@ashx-j/lunr-ai", "@mariozechner/pi-ai"], ai],
	[["@earendil-works/pi-ai/compat", "@ashx-j/lunr-ai/compat", "@mariozechner/pi-ai/compat"], ai],
	[["@earendil-works/pi-ai/oauth", "@ashx-j/lunr-ai/oauth", "@mariozechner/pi-ai/oauth"], oauth],
	[
		["@earendil-works/pi-ai/providers/all", "@ashx-j/lunr-ai/providers/all", "@mariozechner/pi-ai/providers/all"],
		providers,
	],
	[["@earendil-works/pi-coding-agent", "@ashx-j/lunr", "@mariozechner/pi-coding-agent"], codingAgent],
] as const) {
	for (const name of names) virtualModules[name] = module;
}

registerBunExtensionHost({ createJiti, virtualModules });
