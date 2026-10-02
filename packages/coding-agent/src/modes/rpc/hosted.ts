import { isAbsolute, join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { ENV_AGENT_DIR, getAgentDir, VERSION } from "../../config.ts";
import { recordHostedUsage } from "../../core/hosted-usage.ts";
import { ModelRuntime } from "../../core/model-runtime.ts";
import { takeOverStdout, writeRawStdout } from "../../core/output-guard.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";

export const HOST_PROTOCOL_VERSION = 1;
export type HostPolicy = "approval-required" | "full-access" | "read-only";
export interface HostInitialize {
	id: string;
	type: "host_initialize";
	version: 1;
	intent: "discovery" | "session" | "text-generation";
	profile?: string;
	cwd?: string;
	sessionDir?: string;
	sessionFile?: string;
	projectTrusted?: boolean;
	policy?: HostPolicy;
	instructions?: string;
	provider?: string;
	modelId?: string;
	prompt?: string;
	mcp?: { endpoint: string; authorization: string };
}

export const hostOutput = (value: unknown): void => writeRawStdout(serializeJsonLine(value));

export function decodeHostInitialize(value: unknown): HostInitialize {
	if (!value || typeof value !== "object") throw new Error("Expected host_initialize object");
	const v = value as Record<string, unknown>;
	if (v.type !== "host_initialize" || typeof v.id !== "string" || !v.id)
		throw new Error("Expected host_initialize with request id");
	if (v.version !== HOST_PROTOCOL_VERSION)
		throw new Error("Unsupported hosted protocol; update lunR and the host together (protocol 1 required)");
	if (!["discovery", "session", "text-generation"].includes(String(v.intent)))
		throw new Error("Invalid hosted intent");
	for (const key of ["profile", "cwd", "sessionDir", "sessionFile"]) {
		if (v[key] !== undefined && (typeof v[key] !== "string" || !isAbsolute(v[key] as string)))
			throw new Error(`${key} must be an absolute path`);
	}
	for (const key of ["instructions", "provider", "modelId", "prompt"]) {
		if (v[key] !== undefined && typeof v[key] !== "string") throw new Error(`${key} must be a string`);
	}
	if (v.mcp !== undefined) {
		const mcp = v.mcp as Record<string, unknown>;
		if (
			!mcp ||
			typeof mcp.endpoint !== "string" ||
			typeof mcp.authorization !== "string" ||
			!/^https?:\/\//.test(mcp.endpoint)
		)
			throw new Error("Invalid host MCP endpoint");
	}
	if (v.intent === "session") {
		if (!v.cwd || !v.sessionDir || typeof v.projectTrusted !== "boolean")
			throw new Error("Session requires cwd, sessionDir and an explicit project trust decision");
		if (!["approval-required", "full-access", "read-only"].includes(String(v.policy)))
			throw new Error("Unsupported hosted policy");
	}
	if (v.intent === "text-generation" && (!v.provider || !v.modelId || !v.prompt))
		throw new Error("Text generation requires provider, modelId and prompt");
	return v as unknown as HostInitialize;
}

/** No workspace resources or agent hooks exist until this handshake completes. */
export async function readHostInitialize(): Promise<HostInitialize> {
	takeOverStdout();
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			cleanup();
			reject(new Error("Hosted initialization timed out"));
		}, 30_000);
		const onEnd = () => {
			cleanup();
			reject(new Error("Host disconnected before initialization"));
		};
		const cleanup = () => {
			clearTimeout(timeout);
			detach();
			process.stdin.off("end", onEnd);
			process.stdin.pause();
		};
		const detach = attachJsonlLineReader(process.stdin, (line) => {
			try {
				const request = decodeHostInitialize(JSON.parse(line));
				cleanup();
				if (request.profile) process.env[ENV_AGENT_DIR] = request.profile;
				if (request.intent !== "discovery") process.env.LUNR_HOSTED_USAGE = "1";
				resolve(request);
			} catch (error) {
				hostOutput({ type: "response", command: "host_initialize", success: false, error: String(error) });
				cleanup();
				reject(error);
			}
		});
		process.stdin.once("end", onEnd);
		process.stdin.resume();
	});
}

/** Model-only helper: never constructs a ResourceLoader or AgentSession. */
export async function runHostedHelper(request: HostInitialize): Promise<void> {
	const profile = getAgentDir();
	const runtime = await ModelRuntime.create({
		authPath: join(profile, "auth.json"),
		modelsPath: join(profile, "models.json"),
		allowModelNetwork: false,
	});
	const models = await runtime.getAvailable();
	let data: unknown;
	if (request.intent === "discovery") {
		const { loadSkills } = await import("../../core/skills.ts");
		const { SettingsManager } = await import("../../core/settings-manager.ts");
		const { DefaultPackageManager } = await import("../../core/package-manager.ts");
		const cwd = request.cwd ?? profile;
		const settingsManager = SettingsManager.create(cwd, profile, { projectTrusted: request.projectTrusted === true });
		// Resolve only already installed resources. No package install, extension import, or hook executes.
		const resources = await new DefaultPackageManager({ cwd, agentDir: profile, settingsManager }).resolve(
			async () => "skip",
		);
		const skills = loadSkills({
			cwd,
			agentDir: profile,
			skillPaths: resources.skills.filter((resource) => resource.enabled).map((resource) => resource.path),
			includeDefaults: false,
		}).skills;

		data = {
			version: VERSION,
			protocolVersion: HOST_PROTOCOL_VERSION,
			skills: skills.map((skill) => ({
				name: skill.name,
				description: skill.description,
				path: skill.filePath,
				enabled: true,
				userInvocationOnly: skill.disableModelInvocation,
			})),
			models: models.map((model) => ({
				provider: model.provider,
				modelId: model.id,
				name: model.name,
				input: model.input,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				thinkingLevels: getSupportedThinkingLevels(model),
			})),
			capabilities: {
				policies: ["approval-required", "full-access", "read-only"],
				textGeneration: true,
				conversationRollback: false,
			},
		};
	} else {
		const model = models.find((m) => m.provider === request.provider && m.id === request.modelId);
		if (!model)
			throw new Error(`Model unavailable: ${request.provider}/${request.modelId}; configure authentication in lunR`);
		const result = await runtime.completeSimple(
			model,
			{ messages: [{ role: "user", content: request.prompt!, timestamp: Date.now() }] },
			{ maxTokens: 4096 },
		);
		await recordHostedUsage(result, "t3-text-generation");
		if (result.stopReason === "error" || result.stopReason === "aborted")
			throw new Error(result.errorMessage ?? "Generation failed");
		data = {
			text: result.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join(""),
		};
	}
	hostOutput({ type: "response", id: request.id, command: "host_initialize", success: true, data });
}
