import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: { environment: "node", testTimeout: 5_000 },
	resolve: {
		alias: [
			{
				find: /^@earendil-works\/pi-coding-agent$/,
				replacement: fileURLToPath(new URL("../coding-agent/src/index.ts", import.meta.url)),
			},
		],
	},
});
