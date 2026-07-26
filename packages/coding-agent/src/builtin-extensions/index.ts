/**
 * Built-in extensions for lunR.
 *
 * These extensions are compiled into the build and loaded as inline factories
 * on every startup. They do not appear as user-installable extensions.
 * Each entry imports the extension's default factory function and registers
 * it as a named InlineExtension so it shows as `<inline:name>` in diagnostics.
 */

import type { ExtensionFactory, InlineExtension } from "../core/extensions/types.ts";

import piIntercom from "./pi-intercom/index.ts";
import piLspExtension from "./pi-lsp-extension/src/index.ts";
import piMcpAdapter from "./pi-mcp-adapter/index.ts";

/**
 * Wrap a raw factory function as a named InlineExtension.
 * The cast bridges the gap between the source-level ExtensionFactory type
 * (used here) and the dist-level type that extensions import via the package
 * name. The underlying function signatures are structurally identical.
 */
function ext(name: string, factory: unknown): InlineExtension {
	return { name, factory: factory as ExtensionFactory };
}

export const builtinExtensions: InlineExtension[] = [
	ext("pi-intercom", piIntercom),
	ext("pi-lsp-extension", piLspExtension),
	ext("pi-mcp-adapter", piMcpAdapter),
];
