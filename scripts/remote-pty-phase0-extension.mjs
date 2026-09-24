import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const maxImageBytes = 1024 * 1024;
const maxRequestBytes = Math.ceil(maxImageBytes * 4 / 3) + 1024;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export default function phase0Extension(pi) {
	pi.registerCommand("phase0-bind", {
		description: "Bind disposable local Phase 0 terminal proof",
		handler: async (_args, ctx) => {
			const token = process.env.PI_REMOTE_PHASE0_TOKEN;
			const portFile = process.env.PI_REMOTE_PHASE0_PORT_FILE;
			const uploadDir = process.env.PI_REMOTE_PHASE0_UPLOAD_DIR;
			if (!token || !portFile || !uploadDir) throw new Error("Phase 0 fixture environment is missing");
			let tui;
			let generation = 0;
			ctx.ui.setWidget("phase0-proof", (current) => {
				tui = current;
				return { render: () => [] };
			});
			const server = createServer(async (req, res) => {
				const reply = (status, data) => {
					res.writeHead(status, { "Content-Type": "application/json" });
					res.end(JSON.stringify(data));
				};
				if (req.method !== "POST" || req.headers["x-phase0-token"] !== token) {
					reply(403, { error: "denied" });
					return;
				}
				try {
					let body = "";
					for await (const chunk of req) {
						body += chunk;
						if (Buffer.byteLength(body) > maxRequestBytes) {
							reply(413, { error: "too large" });
							return;
						}
					}
					const message = JSON.parse(body);
					if (message.action === "prepare") {
						generation++;
						const marker = `PHASE0_BOUNDARY_${generation}_${randomUUID()}`;
						tui.terminal.write(`\r\n${marker}\r\n`);
						reply(200, { generation, marker });
						return;
					}
					if (message.generation !== generation || generation === 0) {
						reply(409, { error: "stale generation" });
						return;
					}
					if (message.action === "repaint") {
						tui.requestRender(true);
						reply(200, { repaintRequested: true });
						return;
					}
					if (message.action !== "image" || message.mimeType !== "image/png" || typeof message.data !== "string") {
						reply(400, { error: "invalid operation" });
						return;
					}
					if (message.data.length > Math.ceil(maxImageBytes * 4 / 3)) {
						reply(413, { error: "too large" });
						return;
					}
					const bytes = Buffer.from(message.data, "base64");
					if (bytes.length === 0 || bytes.length > maxImageBytes || bytes.toString("base64") !== message.data || !bytes.subarray(0, 8).equals(pngSignature)) {
						reply(400, { error: "invalid PNG" });
						return;
					}
					const editor = tui.focusedComponent;
					if (typeof editor?.insertImageMarker !== "function") {
						reply(409, { error: "editor unavailable" });
						return;
					}
					const path = join(uploadDir, `phase0-${randomUUID()}.png`);
					writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
					const id = editor.insertImageMarker({ path, mimeType: "image/png" });
					tui.requestRender();
					reply(200, { id });
				} catch {
					reply(400, { error: "invalid request" });
				}
			});
			server.listen(0, "127.0.0.1", () => {
				writeFileSync(portFile, String(server.address().port), { mode: 0o600 });
			});
		},
	});
}
