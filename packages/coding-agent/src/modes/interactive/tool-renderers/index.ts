import type { ToolName } from "../../../core/tools/index.ts";
import { bashToolRenderer } from "./bash.ts";
import { editToolRenderer } from "./edit.ts";
import { findToolRenderer } from "./find.ts";
import { grepToolRenderer } from "./grep.ts";
import { lsToolRenderer } from "./ls.ts";
import { readToolRenderer } from "./read.ts";
import type { ToolRenderer } from "./render-utils.ts";
import { writeToolRenderer } from "./write.ts";

// Core tool definitions carry no drawing code. The interactive mode and HTML export draw a built-in
// tool through this table, keyed by tool name. bash_job has no renderer but still counts as built-in.
const builtinToolRenderers: Record<ToolName, ToolRenderer> = {
	read: readToolRenderer,
	bash: bashToolRenderer,
	bash_job: {},
	edit: editToolRenderer,
	write: writeToolRenderer,
	grep: grepToolRenderer,
	find: findToolRenderer,
	ls: lsToolRenderer,
};

/** The renderer for a built-in tool name, or undefined for any other tool. */
export function getBuiltinToolRenderer(toolName: string): ToolRenderer | undefined {
	return Object.hasOwn(builtinToolRenderers, toolName) ? builtinToolRenderers[toolName as ToolName] : undefined;
}
