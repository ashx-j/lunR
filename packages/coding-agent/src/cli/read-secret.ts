/**
 * Hidden TTY secret prompt. Never logs the value or its length.
 * Empty input = skip (undefined). Ctrl+C restores tty and exits 130.
 */

export async function readSecret(prompt: string): Promise<string | undefined> {
	const stdin = process.stdin;
	if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
		console.error("set LUNR_TELEGRAM_BOT_TOKEN / LUNR_DISCORD_BOT_TOKEN or re-run from a terminal.");
		return undefined;
	}

	process.stderr.write(`${prompt}\nToken: `);

	stdin.setRawMode(true);
	stdin.resume();
	stdin.setEncoding("utf8");

	try {
		const value = await new Promise<string | undefined>((resolve, reject) => {
			let buf = "";
			const onData = (chunk: string) => {
				for (const ch of chunk) {
					if (ch === "\u0003") {
						// Ctrl+C
						cleanup();
						process.stderr.write("\n");
						process.exit(130);
						return;
					}
					if (ch === "\r" || ch === "\n") {
						cleanup();
						process.stderr.write("********\n");
						resolve(buf.length === 0 ? undefined : buf);
						return;
					}
					if (ch === "\u007f" || ch === "\b") {
						buf = buf.slice(0, -1);
						continue;
					}
					if (ch >= " ") {
						buf += ch;
					}
				}
			};
			const cleanup = () => {
				stdin.off("data", onData);
				stdin.off("error", onError);
			};
			const onError = (err: Error) => {
				cleanup();
				reject(err);
			};
			stdin.on("data", onData);
			stdin.on("error", onError);
		});
		return value;
	} finally {
		if (typeof stdin.setRawMode === "function") {
			stdin.setRawMode(false);
		}
		stdin.pause();
	}
}
