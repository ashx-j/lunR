import { existsSync } from "node:fs";
import { parseArgs } from "../../cli/args.ts";
import { isLocalPath, resolvePath } from "../../utils/paths.ts";

export function acpWorkerArgs(args: string[], restored = false): string[] {
	const parsed = parseArgs(args);
	if (
		parsed.messages.length ||
		parsed.fileArgs.length ||
		parsed.continue ||
		parsed.resume ||
		parsed.session ||
		parsed.sessionId ||
		parsed.noSession ||
		parsed.fork ||
		parsed.print ||
		parsed.export ||
		parsed.listModels
	) {
		throw new Error(
			"ACP clients own prompts and session selection. Remove prompt, print, resume, session, fork and export arguments.",
		);
	}
	const valueFlags = new Set([
		"--provider",
		"--model",
		"--api-key",
		"--system-prompt",
		"--append-system-prompt",
		"--thinking",
		"--name",
		"-n",
		"--session-dir",
		"--models",
		"--tools",
		"-t",
		"--exclude-tools",
		"-xt",
		"--extension",
		"-e",
		"--skill",
		"--prompt-template",
		"--theme",
	]);
	const paths = new Set(["--session-dir", "--extension", "-e", "--skill", "--prompt-template", "--theme"]);
	const newSessionDefaults = new Set(["--provider", "--model", "--thinking", "--name", "-n"]);
	const forwarded: string[] = [];
	for (let index = 0; index < args.length; index++) {
		if (args[index] === "--mode") {
			index++;
			continue;
		}
		const flag = args[index];
		if (valueFlags.has(flag) && index + 1 < args.length) {
			const value = args[++index];
			if (restored && newSessionDefaults.has(flag)) continue;
			const path =
				paths.has(flag) || ((flag === "--system-prompt" || flag === "--append-system-prompt") && existsSync(value));
			forwarded.push(flag, path && isLocalPath(value) ? resolvePath(value) : value);
		} else {
			forwarded.push(flag);
		}
	}
	return forwarded;
}
