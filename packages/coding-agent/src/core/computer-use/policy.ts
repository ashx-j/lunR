type ComputerSettings = { enabled: boolean; foreground: boolean };
const settingsListeners = new Set<(settings: ComputerSettings) => void>();
export function computerSettingsChanged(settings: ComputerSettings): void {
	for (const listener of settingsListeners) listener(settings);
}
export function onComputerSettingsChanged(listener: (settings: ComputerSettings) => void): () => void {
	settingsListeners.add(listener);
	return () => {
		settingsListeners.delete(listener);
	};
}

export const COMPUTER_TOOLS = [
	"computer_load",
	"computer_apps",
	"computer_observe",
	"computer_click",
	"computer_drag",
	"computer_key",
	"computer_text",
	"computer_window",
	"computer_launch",
	"computer_scroll",
	"computer_end",
] as const;

export function computerPolicy(
	name: string,
	input: Record<string, unknown>,
): { observation: boolean; foreground: boolean } | undefined {
	if (!name.startsWith("computer_")) return undefined;
	switch (name) {
		case "computer_load":
		case "computer_apps":
		case "computer_observe":
		case "computer_end":
			return { observation: true, foreground: false };
		case "computer_click":
		case "computer_drag":
		case "computer_key":
		case "computer_text":
		case "computer_scroll":
			return { observation: false, foreground: input.foreground === true || input.desktop === true };
		case "computer_window":
		case "computer_launch":
			return { observation: false, foreground: true };
		default:
			throw new Error(`Unknown computer operation: ${name}`);
	}
}

export function computerRefusal(
	name: string,
	input: Record<string, unknown>,
	policy: {
		enabled: boolean;
		foreground: boolean;
		child: boolean;
		vision: boolean;
	},
): string | undefined {
	const operation = computerPolicy(name, input);
	if (!operation) return "Unknown computer operation.";
	if (policy.child) return "Computer tools are available only to main agents.";
	if (!policy.enabled) return "Computer use is disabled in settings.";
	if (operation.foreground && !policy.foreground) return "Foreground control is disabled. Use background operations.";
	if (
		!policy.vision &&
		((name !== "computer_window" && (input.x !== undefined || input.y !== undefined)) ||
			name === "computer_drag" ||
			input.screenshot === true ||
			input.desktop === true)
	) {
		return "This model cannot receive images. Use accessibility elements or select an image-capable model.";
	}
	return undefined;
}
