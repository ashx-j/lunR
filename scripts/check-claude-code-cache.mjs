// Live qualification for the Claude subscription bridge: runs a 3-tool-call print-mode turn (4 requests)
// on a signed-in profile and fails unless each request reads from the prompt cache everything the request
// before it read or wrote, which holds only when the conversation history is cached. Run it before shipping
// a CLAUDE_CODE_VERSION bump. It sends real requests.
//
//   PI_CODING_AGENT_DIR=<profile with /login anthropic done> node scripts/check-claude-code-cache.mjs [model]
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const model = process.argv[2] ?? 'claude-sonnet-5-5';
if (!process.env.PI_CODING_AGENT_DIR) {
	console.error('Set PI_CODING_AGENT_DIR to a lunR profile signed in with /login anthropic.');
	process.exit(2);
}
const prompt =
	"Run these three bash commands one at a time, each in its own turn, waiting for each result: 'echo one', 'echo two', 'echo three'. Then reply done.";
const run = spawnSync(
	process.execPath,
	[path.join(root, 'packages/coding-agent/dist/cli.js'), '-p', '--mode', 'json', '--no-session', '--model', `anthropic/${model}`, prompt],
	{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 600_000 },
);
const usage = run.stdout
	.split('\n')
	.flatMap((line) => {
		try {
			const event = JSON.parse(line);
			return event.type === 'message_end' && event.message?.role === 'assistant' ? [event.message] : [];
		} catch {
			return [];
		}
	})
	.map((message) => ({ cacheRead: message.usage?.cacheRead ?? 0, cacheWrite: message.usage?.cacheWrite ?? 0, error: message.errorMessage }));
for (const [index, row] of usage.entries())
	console.log(`request ${index + 1}: cacheRead ${row.cacheRead}, cacheWrite ${row.cacheWrite}${row.error ? `, error: ${row.error}` : ''}`);
const failure =
	usage.length < 3
		? `expected at least 3 requests, got ${usage.length}`
		: usage.find((row) => row.error)
			? 'a request failed'
			: usage.slice(1).find((row, index) => row.cacheRead < usage[index].cacheRead + usage[index].cacheWrite)
				? 'a request did not read what the request before it cached: conversation history is not read from the prompt cache'
				: undefined;
if (failure) {
	console.error(`FAIL: ${failure}`);
	process.exit(1);
}
console.log('PASS: history is read from the prompt cache');
