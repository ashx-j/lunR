import chalk from "chalk";
import type { Args } from "./args.ts";

const PIPED_STDIN_FIRST_BYTE_MS = 3_000;
const PIPED_STDIN_SILENCE_MS = 10_000;

/**
 * Read piped stdin for print mode. Returns undefined if stdin is a TTY.
 *
 * A caller that holds stdin open and never writes (Node `spawn`, Python
 * `stdin=PIPE`, `ssh host 'lunr -p ...'`) must not stall the turn, so reading
 * gives up after `firstByteMs` without a first byte. Once bytes arrive the
 * producer is real, so reading continues until the writer closes stdin, or
 * until `silenceMs` passes with no new bytes. A timeout prints a note on stderr.
 * The stream is paused afterwards so an open pipe does not keep the process
 * alive once the turn is done.
 */
export async function readPipedStdin(
	stream: NodeJS.ReadStream = process.stdin,
	options: { firstByteMs?: number; silenceMs?: number } = {},
): Promise<string | undefined> {
	if (stream.isTTY) {
		return undefined;
	}

	const firstByteMs = options.firstByteMs ?? PIPED_STDIN_FIRST_BYTE_MS;
	const silenceMs = options.silenceMs ?? PIPED_STDIN_SILENCE_MS;

	return new Promise((resolve) => {
		let data = "";
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			stream.off("data", onData);
			stream.off("end", finish);
			stream.off("error", finish);
			stream.pause();
			resolve(data.trim() || undefined);
		};

		const giveUpAfter = (ms: number, warning: string) => {
			clearTimeout(timer);
			timer = setTimeout(() => {
				console.error(chalk.yellow(`Warning: ${warning}. Close stdin or pass "< /dev/null" to skip this wait.`));
				finish();
			}, ms);
		};

		const onData = (chunk: string | Buffer) => {
			data += typeof chunk === "string" ? chunk : chunk.toString("utf8");
			giveUpAfter(silenceMs, `stdin sent nothing for ${silenceMs / 1000} s, continuing with what arrived`);
		};

		stream.setEncoding("utf8");
		stream.on("data", onData);
		stream.on("end", finish);
		stream.on("error", finish);
		giveUpAfter(firstByteMs, `no stdin data received in ${firstByteMs / 1000} s, continuing without it`);
		stream.resume();
	});
}

/**
 * --session can ask to fork a session from another project and --resume opens a session
 * picker. Both may read stdin before the turn, so their launches read piped stdin only
 * at the turn, not early during startup.
 */
export function readsStdinBeforeTurn(parsed: Args): boolean {
	return parsed.session !== undefined || parsed.resume === true;
}
