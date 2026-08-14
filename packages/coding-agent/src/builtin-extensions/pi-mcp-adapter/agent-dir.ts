// @ts-nocheck
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function getAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) {
    // lunr: fallback was ~/.pi/agent — lunr's agent dir is ~/.lunr/agent. Normally the
    // env branch wins because core config.ts defaults PI_CODING_AGENT_DIR at startup.
    return join(homedir(), ".lunr", "agent");
  }
  if (configured === "~") {
    return homedir();
  }
  if (configured.startsWith("~/")) {
    return resolve(homedir(), configured.slice(2));
  }
  return resolve(configured);
}

export function getAgentPath(...segments: string[]): string {
  return join(getAgentDir(), ...segments);
}
