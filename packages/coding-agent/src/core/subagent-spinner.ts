import { spinners } from "unicode-animations";
import type { SubagentSpinnerName } from "./subagent-spinner-setting.ts";

export {
	DEFAULT_SUBAGENT_SPINNER,
	isSubagentSpinnerName,
	SUBAGENT_SPINNER_LABELS,
	SUBAGENT_SPINNER_NAMES,
	type SubagentSpinnerName,
} from "./subagent-spinner-setting.ts";

export function getSubagentSpinnerDefinition(name: SubagentSpinnerName) {
	return spinners[name];
}
