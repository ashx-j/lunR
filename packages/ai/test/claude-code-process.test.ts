import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeCodeEnvironment } from "../src/api/claude-code-process.ts";

afterEach(() => vi.unstubAllEnvs());

describe("claudeCodeEnvironment proxy settings", () => {
	it("keeps the user's proxy and bypass list and adds loopback to the bypass list", () => {
		vi.stubEnv("HTTPS_PROXY", "http://proxy.example:8080");
		vi.stubEnv("NO_PROXY", "internal.example, .corp.example");
		vi.stubEnv("no_proxy", "");
		const env = claudeCodeEnvironment();
		expect(env.HTTPS_PROXY).toBe("http://proxy.example:8080");
		expect(env.NO_PROXY).toBe("internal.example,.corp.example,127.0.0.1,localhost");
		expect(env.no_proxy).toBe("127.0.0.1,localhost");
	});

	it("bypasses the proxy for loopback even when no bypass list is set", () => {
		vi.stubEnv("NO_PROXY", "");
		vi.stubEnv("no_proxy", "");
		const env = claudeCodeEnvironment();
		expect(env.NO_PROXY).toBe("127.0.0.1,localhost");
		expect(env.no_proxy).toBe("127.0.0.1,localhost");
	});

	it("does not duplicate loopback entries", () => {
		vi.stubEnv("NO_PROXY", "localhost,127.0.0.1");
		expect(claudeCodeEnvironment().NO_PROXY).toBe("localhost,127.0.0.1");
	});
});
