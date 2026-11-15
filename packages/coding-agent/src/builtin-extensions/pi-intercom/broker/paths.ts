import { chmodSync, lstatSync, mkdirSync, readFileSync } from "fs";
import { createHash } from "crypto";
import { dirname, isAbsolute, join, resolve } from "path";
import { homedir } from "os";

export const INTERCOM_DIR_MODE = 0o700;
export const INTERCOM_RUNTIME_FILE_MODE = 0o600;
export const INTERCOM_TCP_HOST = "127.0.0.1";
export const INTERCOM_PROTOCOL_NAME = "pi-intercom";
export const INTERCOM_PROTOCOL_VERSION = 1;

export interface BrokerTcpEndpoint {
  transport: "tcp";
  host: string;
  port: number;
  stateId?: string;
}

export type BrokerConnectTarget = string | BrokerTcpEndpoint;

function sanitizePipeSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "default";
}

export function getAgentDirPath(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
  cwd: string = process.cwd(),
): string {
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) {
    // lunr: fallback was ~/.pi/agent — lunr's agent dir is ~/.lunr/agent. Normally the
    // env branch wins because core config.ts defaults PI_CODING_AGENT_DIR at startup.
    return join(homeDir, ".lunr/agent");
  }

  return isAbsolute(configured) ? configured : resolve(cwd, configured);
}

export function getIntercomDirPath(agentDir: string = getAgentDirPath()): string {
  return join(agentDir, "intercom");
}

export function shouldUseWindowsTcpTransport(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (platform !== "win32") {
    return false;
  }

  const transport = env.PI_INTERCOM_TRANSPORT?.trim().toLowerCase();
  if (transport === "tcp") {
    return true;
  }

  const legacyOptIn = env.PI_INTERCOM_TCP?.trim().toLowerCase();
  return legacyOptIn === "1" || legacyOptIn === "true";
}

export function getBrokerPortFilePath(intercomDir: string = getIntercomDirPath()): string {
  return join(intercomDir, "broker.port.json");
}

// sun_path holds 108 bytes on Linux and 104 on macOS and the BSDs, including the NUL.
function maxSocketPathBytes(platform: NodeJS.Platform): number {
  return platform === "linux" ? 107 : 103;
}

/**
 * Broker socket path shared by the broker and its clients. The socket lives in the profile's
 * intercom dir when that path fits in sun_path, so existing profiles keep their socket. A longer
 * profile path gets a per-user private dir under /tmp and a socket named by a hash of the agent
 * dir. The base dir ignores the environment, so sessions that see different XDG_RUNTIME_DIR or
 * TMPDIR values (a systemd service, cron, ssh) still share one broker per profile.
 */
export function getBrokerSocketPath(
  platform: NodeJS.Platform = process.platform,
  agentDir: string = getAgentDirPath(),
): string {
  if (platform === "win32") {
    return `\\\\.\\pipe\\pi-intercom-${sanitizePipeSegment(agentDir)}`;
  }

  const profileSocket = join(getIntercomDirPath(agentDir), "broker.sock");
  if (Buffer.byteLength(profileSocket) <= maxSocketPathBytes(platform)) {
    return profileSocket;
  }

  const hash = createHash("sha256").update(agentDir).digest("hex").slice(0, 16);
  return join("/tmp", `lunr-intercom-${process.getuid?.() ?? "user"}`, `${hash}.sock`);
}

/**
 * Creates the directory that holds a short socket path. Refuses one that is a symlink, belongs to
 * another user or has any group or other permission bits, because anyone could have created the
 * fixed /tmp name first or left a socket in it. The error names the dir so the user can remove it.
 */
export function ensurePrivateSocketDir(socketPath: string, agentDir: string = getAgentDirPath()): void {
  const socketDir = dirname(socketPath);
  if (socketDir === getIntercomDirPath(agentDir)) {
    return;
  }

  mkdirSync(socketDir, { recursive: true, mode: INTERCOM_DIR_MODE });
  const stat = lstatSync(socketDir);
  const uid = process.getuid?.();
  const problem = !stat.isDirectory()
    ? "is not a directory"
    : uid !== undefined && stat.uid !== uid
      ? `is owned by uid ${stat.uid}, not ${uid}`
      : stat.mode & 0o077
        ? `has mode ${(stat.mode & 0o777).toString(8).padStart(4, "0")}; it must be 0700`
        : undefined;
  if (problem) {
    throw new Error(`Intercom socket directory ${socketDir} ${problem}. Remove it and start lunR again.`);
  }
}

export function getBrokerConnectTarget(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  intercomDir: string = getIntercomDirPath(getAgentDirPath(env)),
): BrokerConnectTarget {
  if (shouldUseWindowsTcpTransport(platform, env)) {
    const endpointFile = getBrokerPortFilePath(intercomDir);
    const raw = readFileSync(endpointFile, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Invalid intercom TCP endpoint at ${endpointFile}: expected a JSON object`);
    }
    const endpoint = parsed as Record<string, unknown>;
    if (
      endpoint.transport !== "tcp"
      || endpoint.host !== INTERCOM_TCP_HOST
      || typeof endpoint.port !== "number"
      || !Number.isSafeInteger(endpoint.port)
      || endpoint.port <= 0
      || endpoint.port > 65535
      || typeof endpoint.stateId !== "string"
      || endpoint.stateId.length === 0
    ) {
      throw new Error(`Invalid intercom TCP endpoint at ${endpointFile}`);
    }
    return { transport: "tcp", host: endpoint.host, port: endpoint.port, stateId: endpoint.stateId };
  }

  const agentDir = getAgentDirPath(env);
  const socketPath = getBrokerSocketPath(platform, agentDir);
  if (platform !== "win32") {
    ensurePrivateSocketDir(socketPath, agentDir);
  }
  return socketPath;
}

export function getBrokerListenTarget(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): BrokerConnectTarget {
  if (shouldUseWindowsTcpTransport(platform, env)) {
    return { transport: "tcp", host: INTERCOM_TCP_HOST, port: 0 };
  }

  return getBrokerSocketPath(platform, getAgentDirPath(env));
}

export function ensureIntercomRuntimeDir(
  intercomDir: string = getIntercomDirPath(),
  platform: NodeJS.Platform = process.platform,
): void {
  mkdirSync(intercomDir, { recursive: true, mode: INTERCOM_DIR_MODE });
  if (platform !== "win32") {
    chmodSync(intercomDir, INTERCOM_DIR_MODE);
  }
}

export function restrictIntercomRuntimeFile(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "win32") {
    chmodSync(filePath, INTERCOM_RUNTIME_FILE_MODE);
  }
}
