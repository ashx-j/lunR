const assert = require("node:assert/strict");
const { test } = require("node:test");
const editorFrame = require("./remote-pty-tui-frame.cjs");

const boot = "╭── boot ──╮\n╰──────────╯\n";
const editor = "╭────────────╮\n│ >          │";
const bottom = "╰── model ──╯";

test("waits for a prompt and later complete editor border across PTY line endings", () => {
	for (const ending of ["\n", "\r\n", "\r\r\n"]) {
		assert.equal(editorFrame.test(boot + editor + ending + bottom), true, JSON.stringify(ending));
		assert.equal(editorFrame.test(boot + editor + ending), false, JSON.stringify(ending));
	}
	assert.equal(editorFrame.test(boot), false);
	assert.equal(editorFrame.test(boot + bottom + editor), false);
});
