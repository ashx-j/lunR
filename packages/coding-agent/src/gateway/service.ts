import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "../config.ts";

export type StartupMode = "off" | "login" | "boot";
export interface GatewayServiceSettings {
	startup: StartupMode;
}
export interface GatewayRuntimeStatus {
	version: 1;
	instance: string;
	pid: number;
	startedAt: string;
	updatedAt: string;
	state: "starting" | "ready" | "stopping";
	platforms: Record<string, string>;
}
const servicePrefix = "lunr-gateway";
export const serviceDirectory = () => join(getAgentDir(), "gateway-service");
export const gatewayLogPath = () => join(serviceDirectory(), "gateway.log");
const statusPath = () => join(serviceDirectory(), "status.json");
const controlPath = () => join(serviceDirectory(), "control.json");
const settingsPath = () => join(serviceDirectory(), "service.json");

export function atomicJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.${randomUUID()}.tmp`;
	writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	renameSync(temp, path);
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

export function loadServiceSettings(): GatewayServiceSettings {
	const raw = readJson(settingsPath());
	if (raw && typeof raw === "object" && "startup" in raw && (raw.startup === "login" || raw.startup === "boot")) {
		return { startup: raw.startup };
	}
	return { startup: "off" };
}

export function processExists(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !(error && typeof error === "object" && "code" in error && error.code === "ESRCH");
	}
}

export function readGatewayStatus(file = statusPath()): GatewayRuntimeStatus | undefined {
	const raw = readJson(file);
	if (
		!raw ||
		typeof raw !== "object" ||
		!("version" in raw) ||
		raw.version !== 1 ||
		!("pid" in raw) ||
		typeof raw.pid !== "number"
	)
		return undefined;
	if (
		!("instance" in raw) ||
		typeof raw.instance !== "string" ||
		!("updatedAt" in raw) ||
		typeof raw.updatedAt !== "string"
	)
		return undefined;
	if (!("state" in raw) || !["starting", "ready", "stopping"].includes(String(raw.state))) return undefined;
	if (
		!("platforms" in raw) ||
		!raw.platforms ||
		typeof raw.platforms !== "object" ||
		!("startedAt" in raw) ||
		typeof raw.startedAt !== "string"
	)
		return undefined;
	return raw as GatewayRuntimeStatus;
}

export function gatewayIsRunning(): boolean {
	const status = readGatewayStatus();
	return !!status && processExists(status.pid);
}

export function claimGateway(onStop: () => void): {
	update: (platforms: Record<string, string>, state?: GatewayRuntimeStatus["state"]) => void;
	release: () => void;
} {
	const dir = serviceDirectory();
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const lock = join(dir, "lock");
	try {
		mkdirSync(lock);
	} catch (error) {
		if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
		const previous = readGatewayStatus(join(lock, "owner.json"));
		if (!previous || processExists(previous.pid))
			throw new Error("Gateway already running or startup lock is unresolved. Run lunr gateway doctor.");
		// Recovery is serialized; a late recoverer must not remove a new owner's lock.
		const recovery = join(dir, "recovery");
		mkdirSync(recovery);
		try {
			const current = readGatewayStatus(join(lock, "owner.json"));
			if (!current || current.instance !== previous.instance || processExists(current.pid))
				throw new Error("Gateway ownership changed. Try again.");
			rmSync(lock, { recursive: true });
			mkdirSync(lock);
		} finally {
			rmSync(recovery, { recursive: true, force: true });
		}
	}
	const status: GatewayRuntimeStatus = {
		version: 1,
		instance: randomUUID(),
		pid: process.pid,
		startedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		state: "starting",
		platforms: {},
	};
	atomicJson(join(lock, "owner.json"), status);
	const save = () => {
		status.updatedAt = new Date().toISOString();
		atomicJson(statusPath(), status);
	};
	save();
	let stopping = false;
	const timer = setInterval(() => {
		save();
		const control = readJson(controlPath());
		if (
			!stopping &&
			control &&
			typeof control === "object" &&
			"instance" in control &&
			control.instance === status.instance &&
			"action" in control &&
			control.action === "stop"
		) {
			stopping = true;
			status.state = "stopping";
			onStop();
		}
	}, 500);
	return {
		update(platforms, state = "ready") {
			status.platforms = { ...platforms };
			status.state = state;
			save();
		},
		release() {
			clearInterval(timer);
			if (readGatewayStatus()?.instance === status.instance) {
				rmSync(statusPath(), { force: true });
				rmSync(controlPath(), { force: true });
				rmSync(lock, { recursive: true, force: true });
			}
		},
	};
}

function cliPath(): string {
	const candidate = process.argv[1];
	if (candidate && existsSync(candidate)) return resolve(candidate);
	return fileURLToPath(new URL("../cli.js", import.meta.url));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function startGatewayService(): Promise<string> {
	if (gatewayIsRunning()) return "Gateway is already running.";
	mkdirSync(serviceDirectory(), { recursive: true, mode: 0o700 });
	const startup = loadServiceSettings().startup;
	if (startup !== "off") {
		const user = userInfo();
		const spec = startupSpec(process.platform, startup, {
			home: homedir(),
			agentDir: getAgentDir(),
			node: process.execPath,
			cli: cliPath(),
			username: user.username,
			uid: user.uid,
		});
		execute(spec.start);
		for (let i = 0; i < 100; i++) {
			if (readGatewayStatus()?.state === "ready" && gatewayIsRunning()) return "Gateway started.";
			await sleep(200);
		}
		throw new Error(`Startup service did not become ready. Run lunr gateway doctor and inspect ${gatewayLogPath()}`);
	}
	const { openSync, closeSync } = await import("node:fs");
	const log = openSync(gatewayLogPath(), "a", 0o600);
	const child = spawn(process.execPath, [cliPath(), "gateway", "run"], {
		cwd: homedir(),
		detached: true,
		windowsHide: true,
		stdio: ["ignore", log, log],
		env: { ...process.env, PI_CODING_AGENT_DIR: getAgentDir() },
	});
	closeSync(log);
	let spawnError: Error | undefined;
	child.on("error", (error) => {
		spawnError = error;
	});
	child.unref();
	for (let i = 0; i < 100; i++) {
		if (spawnError) throw spawnError;
		const status = readGatewayStatus();
		if (status && status.pid === child.pid && status.state === "ready") return "Gateway started.";
		if (child.exitCode !== null)
			throw new Error(`Gateway exited with code ${child.exitCode}. See ${gatewayLogPath()}`);
		await sleep(200);
	}
	throw new Error(`Gateway did not become ready within 20 seconds. Check lunr gateway status and ${gatewayLogPath()}`);
}

export async function stopGatewayService(): Promise<string> {
	const status = readGatewayStatus();
	if (!status || !processExists(status.pid)) return "Gateway is not running.";
	atomicJson(controlPath(), { instance: status.instance, action: "stop" });
	for (let i = 0; i < 150; i++) {
		if (readGatewayStatus()?.instance !== status.instance || !processExists(status.pid)) return "Gateway stopped.";
		await sleep(200);
	}
	throw new Error("Gateway is still stopping after 30 seconds. Inspect the log; no unrelated process was terminated.");
}

export interface StartupSpec {
	path: string;
	content: string;
	install: string[][];
	remove: string[][];
	verify: string[];
	start: string[];
}
function xml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
function systemdArg(value: string): string {
	return `"${value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
function ps(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

export function startupSpec(
	platform: NodeJS.Platform,
	mode: Exclude<StartupMode, "off">,
	options: { home: string; agentDir: string; node: string; cli: string; username: string; uid: number },
): StartupSpec {
	const { home, agentDir, node, cli, username, uid } = options;
	if ([home, agentDir, node, cli, username].some((value) => /[\r\n\0]/.test(value)))
		throw new Error("Startup paths and account names must not contain control characters.");
	const suffix = createHash("sha256").update(resolve(agentDir)).digest("hex").slice(0, 10);
	const serviceName = `${servicePrefix}-${suffix}`;
	const log = join(agentDir, "gateway-service", "gateway.log");
	if (platform === "linux") {
		const path = join(home, ".config", "systemd", "user", `${serviceName}.service`);
		return {
			path,
			content: `[Unit]\nDescription=lunR chat gateway\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=${systemdArg(node)} ${systemdArg(cli)} gateway run\nWorkingDirectory=${systemdArg(home)}\nEnvironment=${systemdArg(`PI_CODING_AGENT_DIR=${agentDir}`)}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=30\nStandardOutput=append:${log.replaceAll("%", "%%")}\nStandardError=append:${log.replaceAll("%", "%%")}\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`,
			install: [
				...(mode === "boot" ? [["loginctl", "enable-linger", username]] : []),
				["systemctl", "--user", "daemon-reload"],
				["systemctl", "--user", "enable", `${serviceName}.service`],
			],
			remove: [["systemctl", "--user", "disable", `${serviceName}.service`]],
			verify: ["systemctl", "--user", "is-enabled", `${serviceName}.service`],
			start: ["systemctl", "--user", "start", `${serviceName}.service`],
		};
	}
	if (platform === "darwin") {
		const label = `dev.lunr.gateway.${suffix}`;
		const path =
			mode === "boot"
				? `/Library/LaunchDaemons/${label}.plist`
				: join(home, "Library", "LaunchAgents", `${label}.plist`);
		const domain = mode === "boot" ? "system" : `gui/${uid}`;
		const command = (args: string[]) => (mode === "boot" ? ["sudo", "launchctl", ...args] : ["launchctl", ...args]);
		return {
			path,
			content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${[node, cli, "gateway", "run"].map((v) => `<string>${xml(v)}</string>`).join("")}</array><key>WorkingDirectory</key><string>${xml(home)}</string>${mode === "boot" ? `<key>UserName</key><string>${xml(username)}</string>` : ""}<key>EnvironmentVariables</key><dict><key>PI_CODING_AGENT_DIR</key><string>${xml(agentDir)}</string><key>HOME</key><string>${xml(home)}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string></dict></plist>\n`,
			install: [command(["bootstrap", domain, path])],
			remove: [command(["bootout", `${domain}/${label}`])],
			verify: command(["print", `${domain}/${label}`]),
			start: command(["kickstart", `${domain}/${label}`]),
		};
	}
	if (platform === "win32") {
		const path = join(agentDir, "gateway-service", "startup.ps1");
		const content = `$env:PI_CODING_AGENT_DIR = ${ps(agentDir)}\nSet-Location -LiteralPath ${ps(home)}\n& ${ps(node)} ${ps(cli)} gateway run *>> ${ps(log)}\nexit $LASTEXITCODE\n`;
		const action = `New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${ps(`-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${path}"`)}`;
		const trigger =
			mode === "boot"
				? "New-ScheduledTaskTrigger -AtStartup"
				: `New-ScheduledTaskTrigger -AtLogOn -User ${ps(username)}`;
		const register = `$ErrorActionPreference='Stop'; $a=${action}; $t=${trigger}; $s=New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries; ${mode === "boot" ? `$c=Get-Credential -UserName ${ps(username)} -Message 'Windows needs your account credentials to run lunR before login'; if(!$c){throw 'Cancelled'}; Register-ScheduledTask -TaskName '${serviceName}' -Action $a -Trigger $t -Settings $s -User $c.UserName -Password $c.GetNetworkCredential().Password -Force | Out-Null` : `Register-ScheduledTask -TaskName '${serviceName}' -Action $a -Trigger $t -Settings $s -User ${ps(username)} -Force | Out-Null`}`;
		const command = (script: string) => ["powershell.exe", "-NoProfile", "-Command", script];
		return {
			path,
			content,
			install: [command(register)],
			remove: [
				command(
					`$ErrorActionPreference='Stop'; Unregister-ScheduledTask -TaskName '${serviceName}' -Confirm:$false`,
				),
			],
			verify: command(`$ErrorActionPreference='Stop'; Get-ScheduledTask -TaskName '${serviceName}' | Out-Null`),
			start: command(`$ErrorActionPreference='Stop'; Start-ScheduledTask -TaskName '${serviceName}'`),
		};
	}
	throw new Error(`Automatic startup is not supported on ${platform}. Run lunr gateway start manually.`);
}

function execute(command: string[]): void {
	const [file, ...args] = command;
	const result = spawnSync(file, args, { stdio: "inherit", windowsHide: true, timeout: 120_000 });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${file} failed. Check OS permissions and run lunr gateway doctor.`);
}

export async function configureStartup(mode: StartupMode): Promise<void> {
	const previous = loadServiceSettings().startup;
	if (process.platform === "linux" && mode === "login") {
		const linger = spawnSync("loginctl", ["show-user", userInfo().username, "--property=Linger", "--value"], {
			encoding: "utf8",
			timeout: 10_000,
		});
		if (linger.stdout?.trim() === "yes")
			throw new Error(
				"Linux user services already start at boot because lingering is enabled. Choose boot, or disable lingering yourself before choosing login. lunR will not change other user services.",
			);
	}
	const user = userInfo();
	const options = {
		home: homedir(),
		agentDir: getAgentDir(),
		node: process.execPath,
		cli: cliPath(),
		username: user.username,
		uid: user.uid,
	};
	if (previous !== "off") {
		const old = startupSpec(process.platform, previous, options);
		for (const command of old.remove) execute(command);
		if (process.platform === "darwin" && previous === "boot") execute(["sudo", "rm", "-f", old.path]);
		else rmSync(old.path, { force: true });
		atomicJson(settingsPath(), { startup: "off" });
	}
	if (mode === "off") {
		atomicJson(settingsPath(), { startup: "off" });
		return;
	}
	const spec = startupSpec(process.platform, mode, options);
	mkdirSync(serviceDirectory(), { recursive: true, mode: 0o700 });
	if (process.platform === "darwin" && mode === "boot") {
		const temporary = join(serviceDirectory(), "install.plist");
		writeFileSync(temporary, spec.content, { mode: 0o600 });
		try {
			execute(["sudo", "install", "-o", "root", "-g", "wheel", "-m", "644", temporary, spec.path]);
		} finally {
			rmSync(temporary, { force: true });
		}
	} else {
		mkdirSync(dirname(spec.path), { recursive: true, mode: 0o700 });
		writeFileSync(spec.path, spec.content, { mode: 0o600 });
	}
	for (const command of spec.install) execute(command);
	execute(spec.verify);
	atomicJson(settingsPath(), { startup: mode });
}

function startupVerification(): string {
	const mode = loadServiceSettings().startup;
	if (mode === "off") return "";
	try {
		const user = userInfo();
		const spec = startupSpec(process.platform, mode, {
			home: homedir(),
			agentDir: getAgentDir(),
			node: process.execPath,
			cli: cliPath(),
			username: user.username,
			uid: user.uid,
		});
		const [command, ...args] = spec.verify[0] === "sudo" ? spec.verify.slice(1) : spec.verify;
		const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 5000 });
		return result.status === 0 ? " (native service verified)" : " (native service missing or unavailable)";
	} catch {
		return " (native service could not be checked)";
	}
}

export function serviceStatusText(): string {
	const status = readGatewayStatus();
	const alive = !!status && processExists(status.pid);
	const fresh = !!status && Date.now() - Date.parse(status.updatedAt) < 5000;
	return [
		`Gateway: ${alive ? `${status.state}${fresh ? "" : " (not responding)"}` : "stopped"}`,
		`Automatic startup: ${loadServiceSettings().startup}${startupVerification()}`,
		...(alive
			? [`PID: ${status.pid}`, ...Object.entries(status.platforms).map(([name, state]) => `${name}: ${state}`)]
			: []),
		`Log: ${gatewayLogPath()}`,
	].join("\n");
}

export function readGatewayLog(): string {
	try {
		return readFileSync(gatewayLogPath(), "utf8")
			.split("\n")
			.slice(-100)
			.join("\n")
			.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[redacted]");
	} catch {
		return "No gateway log yet.";
	}
}
