import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SubscriptionManager, subscriptionKeyFingerprint } from "../src/core/subscriptions.ts";

function makeManager(authData: Parameters<typeof AuthStorage.inMemory>[0] = {}) {
	const authStorage = AuthStorage.inMemory(authData);
	const manager = SubscriptionManager.inMemory(authStorage);
	return { authStorage, manager };
}

describe("SubscriptionManager", () => {
	test("lazy-imports a stored api_key credential as Sub 1", async () => {
		const { manager } = makeManager({ openai: { type: "api_key", key: "sk-1" } });
		const entries = await manager.list("openai");
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ id: "1", name: "Sub 1", key: "sk-1" });
		expect((await manager.getActive("openai"))?.id).toBe("1");
	});

	test("does not import OAuth credentials", async () => {
		const { manager } = makeManager({
			anthropic: { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 60_000 },
		});
		expect(await manager.list("anthropic")).toEqual([]);
		expect(await manager.getActive("anthropic")).toBeUndefined();
	});

	test("addKey defaults the name to Sub N and mirrors active into auth.json", async () => {
		const { authStorage, manager } = makeManager({ openai: { type: "api_key", key: "sk-1" } });
		await manager.list("openai"); // trigger lazy import

		const added = await manager.addKey("openai", "sk-2");
		expect(added).toMatchObject({ id: "2", name: "Sub 2", key: "sk-2" });
		expect((await manager.getActive("openai"))?.id).toBe("2");
		expect(await authStorage.read("openai")).toEqual({ type: "api_key", key: "sk-2" });
	});

	test("addKey on a provider with no credential starts the pool at Sub 1", async () => {
		const { authStorage, manager } = makeManager();
		const added = await manager.addKey("google", "gk-1");
		expect(added).toMatchObject({ id: "1", name: "Sub 1", key: "gk-1" });
		expect(await authStorage.read("google")).toEqual({ type: "api_key", key: "gk-1" });
	});

	test("setActive mirrors the chosen key into auth.json", async () => {
		const { authStorage, manager } = makeManager({ openai: { type: "api_key", key: "sk-1" } });
		await manager.addKey("openai", "sk-2");

		await manager.setActive("openai", "1");
		expect((await manager.getActive("openai"))?.key).toBe("sk-1");
		expect(await authStorage.read("openai")).toEqual({ type: "api_key", key: "sk-1" });
	});

	test("removeKey promotes the next key when the active key is removed", async () => {
		const { authStorage, manager } = makeManager({ openai: { type: "api_key", key: "sk-1" } });
		await manager.addKey("openai", "sk-2");
		await manager.setActive("openai", "1");

		await manager.removeKey("openai", "1");
		expect((await manager.getActive("openai"))?.id).toBe("2");
		expect(await authStorage.read("openai")).toEqual({ type: "api_key", key: "sk-2" });
	});

	test("removeKey on the last key deletes the pool and the auth.json credential", async () => {
		const { authStorage, manager } = makeManager({ openai: { type: "api_key", key: "sk-1" } });
		await manager.list("openai");

		await manager.removeKey("openai", "1");
		expect(await manager.list("openai")).toEqual([]);
		expect(await authStorage.read("openai")).toBeUndefined();
	});

	test("renameKey updates the name", async () => {
		const { manager } = makeManager({ openai: { type: "api_key", key: "sk-1" } });
		await manager.renameKey("openai", "1", "Work sub");
		expect((await manager.list("openai"))[0]?.name).toBe("Work sub");
	});

	test("rotateOnFailure persists exhaustion with a parseable reset time and rotates", async () => {
		const { authStorage, manager } = makeManager({ openai: { type: "api_key", key: "sk-1" } });
		await manager.addKey("openai", "sk-2");
		await manager.setActive("openai", "1");

		const before = Date.now();
		const rotated = await manager.rotateOnFailure(
			"openai",
			"quota exceeded, reset in 2h",
			subscriptionKeyFingerprint("openai", "sk-1"),
		);
		expect(rotated?.id).toBe("2");
		expect(await authStorage.read("openai")).toEqual({ type: "api_key", key: "sk-2" });

		const exhausted = (await manager.list("openai")).find((entry) => entry.id === "1");
		expect(exhausted?.lastError).toBe("quota exceeded, reset in 2h");
		expect(exhausted?.exhaustedUntil).toBeGreaterThanOrEqual(before + 2 * 3600_000);
	});

	test("rotateOnFailure keeps unparseable exhaustion process-local and wraps around", async () => {
		const { manager } = makeManager({ openai: { type: "api_key", key: "sk-1" } });
		await manager.addKey("openai", "sk-2");
		await manager.setActive("openai", "1");

		// 1 exhausted (in-memory) → rotate to 2.
		const first = await manager.rotateOnFailure(
			"openai",
			"quota exceeded",
			subscriptionKeyFingerprint("openai", "sk-1"),
		);
		expect(first?.id).toBe("2");
		// Unparseable reset time: nothing persisted on the entry.
		expect((await manager.list("openai")).find((entry) => entry.id === "1")?.exhaustedUntil).toBeUndefined();

		// 2 exhausted (in-memory) → wraps around past 1 (exhausted) → no alternative.
		const second = await manager.rotateOnFailure(
			"openai",
			"quota exceeded",
			subscriptionKeyFingerprint("openai", "sk-2"),
		);
		expect(second).toBeNull();
		expect((await manager.getActive("openai"))?.id).toBe("2");
	});

	test("rotateOnFailure skips keys whose persisted exhaustion is still in the future", async () => {
		const { manager } = makeManager({
			openai: { type: "api_key", key: "sk-1" },
		});
		await manager.addKey("openai", "sk-2");
		await manager.addKey("openai", "sk-3");
		await manager.setActive("openai", "2");

		// Exhaust 2 with a persisted reset time, landing on 3.
		expect(
			(
				await manager.rotateOnFailure(
					"openai",
					"quota exceeded, reset in 2h",
					subscriptionKeyFingerprint("openai", "sk-2"),
				)
			)?.id,
		).toBe("3");
		// Exhaust 3 in-memory; round-robin order is 1, 2 — 2 is still exhausted → 1.
		expect(
			(await manager.rotateOnFailure("openai", "quota exceeded", subscriptionKeyFingerprint("openai", "sk-3")))?.id,
		).toBe("1");
	});

	test("clearExhaustion reactivates a key", async () => {
		const { manager } = makeManager({ openai: { type: "api_key", key: "sk-1" } });
		await manager.addKey("openai", "sk-2");
		await manager.setActive("openai", "1");
		await manager.rotateOnFailure(
			"openai",
			"quota exceeded, reset in 2h",
			subscriptionKeyFingerprint("openai", "sk-1"),
		);

		await manager.clearExhaustion("openai", "1");
		const cleared = (await manager.list("openai")).find((entry) => entry.id === "1");
		expect(cleared?.exhaustedUntil).toBeUndefined();
		expect(cleared?.lastError).toBeUndefined();

		// Rotating 2 can now fall back to the reactivated 1.
		expect(
			(await manager.rotateOnFailure("openai", "quota exceeded", subscriptionKeyFingerprint("openai", "sk-2")))?.id,
		).toBe("1");
	});
});

describe("subscription transactions", () => {
	test("preserves interleaved changes from independent managers and allocates current IDs", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lunr-subscriptions-"));
		try {
			const auth = AuthStorage.create(join(dir, "auth.json"));
			const path = join(dir, "subscriptions.json");
			const first = SubscriptionManager.create(auth, path);
			const second = SubscriptionManager.create(auth, path);
			await first.list("openai");
			await second.list("openai");
			await first.addKey("openai", "fake-a");
			await second.addKey("google", "fake-g");
			await second.addKey("openai", "fake-b");
			await first.renameKey("openai", "1", "Renamed");
			await second.rotateOnFailure(
				"openai",
				"quota exceeded, reset in 2h",
				subscriptionKeyFingerprint("openai", "fake-b"),
			);
			const third = SubscriptionManager.create(auth, path);
			expect(await third.list("openai")).toMatchObject([
				{ id: "1", name: "Renamed" },
				{ id: "2", lastError: "quota exceeded, reset in 2h" },
			]);
			expect(await third.list("google")).toHaveLength(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("keeps the pool locked until its mirror settles, preserving selection order", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lunr-subscriptions-"));
		try {
			const auth = AuthStorage.inMemory();
			const path = join(dir, "subscriptions.json");
			const first = SubscriptionManager.create(auth, path);
			const second = SubscriptionManager.create(auth, path);
			await first.addKey("openai", "fake-a");
			await first.addKey("openai", "fake-b");
			let release: (() => void) | undefined;
			const modify = auth.modify.bind(auth);
			vi.spyOn(auth, "modify").mockImplementation(async (provider, fn) => {
				if (!release)
					await new Promise<void>((resolve) => {
						release = resolve;
					});
				return modify(provider, fn);
			});
			const old = first.setActive("openai", "1");
			await vi.waitFor(() => expect(release).toBeTypeOf("function"));
			const newer = second.setActive("openai", "2");
			release!();
			await Promise.all([old, newer]);
			expect(await auth.read("openai")).toMatchObject({
				type: "api_key",
				key: "fake-b",
			});
			expect((await first.getActive("openai"))?.id).toBe("2");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("does not exhaust unknown, removed, or replaced request credentials", async () => {
		const { manager, authStorage } = makeManager({ openai: { type: "api_key", key: "old-key" } });
		await manager.addKey("openai", "other-key");
		const identity = subscriptionKeyFingerprint("openai", "old-key");
		await manager.removeKey("openai", "1");
		await manager.addKey("openai", "replacement-key");
		const before = await manager.list("openai");
		for (const unknown of [undefined, identity, subscriptionKeyFingerprint("openai", "never-used")]) {
			expect(await manager.rotateOnFailure("openai", "quota exceeded, reset in 2h", unknown)).toBeNull();
		}
		expect(await manager.list("openai")).toEqual(before);
		expect(await authStorage.read("openai")).toMatchObject({ key: "replacement-key" });
	});

	test("process-local exhaustion follows key material rather than a reused entry id", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lunr-subscriptions-"));
		try {
			const auth = AuthStorage.inMemory({ openai: { type: "api_key", key: "old-key" } });
			const path = join(dir, "subscriptions.json");
			const manager = SubscriptionManager.create(auth, path);
			await manager.addKey("openai", "other-key");
			await manager.setActive("openai", "1");
			await manager.rotateOnFailure("openai", "quota exceeded", subscriptionKeyFingerprint("openai", "old-key"));
			const data = JSON.parse(readFileSync(path, "utf8"));
			data.openai.keys[0].key = "replacement-key";
			writeFileSync(path, JSON.stringify(data));
			expect(
				(
					await manager.rotateOnFailure(
						"openai",
						"quota exceeded",
						subscriptionKeyFingerprint("openai", "other-key"),
					)
				)?.key,
			).toBe("replacement-key");
			expect(await auth.read("openai")).toMatchObject({ key: "replacement-key" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("preserves provider env through add, select, and rotation", async () => {
		const env = { CLOUDFLARE_ACCOUNT_ID: "fake-account", CLOUDFLARE_GATEWAY_ID: "fake-gateway" };
		const { manager, authStorage } = makeManager({
			"cloudflare-ai-gateway": { type: "api_key", key: "fake-a", env },
		});
		await manager.addKey("cloudflare-ai-gateway", "fake-b");
		expect(await authStorage.read("cloudflare-ai-gateway")).toMatchObject({ key: "fake-b", env });
		await manager.setActive("cloudflare-ai-gateway", "1");
		expect(await authStorage.read("cloudflare-ai-gateway")).toMatchObject({ key: "fake-a", env });
		await manager.rotateOnFailure(
			"cloudflare-ai-gateway",
			"quota exceeded, reset in 2h",
			subscriptionKeyFingerprint("cloudflare-ai-gateway", "fake-a"),
		);
		expect(await authStorage.read("cloudflare-ai-gateway")).toMatchObject({ key: "fake-b", env });
	});

	test.each(["{broken", "[]", '{"openai":{"active":"1","keys":[]}}'])(
		"refuses mutations of malformed storage %s",
		async (content) => {
			const dir = mkdtempSync(join(tmpdir(), "lunr-subscriptions-"));
			try {
				const path = join(dir, "subscriptions.json");
				writeFileSync(path, content);
				const auth = AuthStorage.inMemory();
				await expect(SubscriptionManager.create(auth, path).addKey("openai", "fake-key")).rejects.toThrow(
					"malformed",
				);
				expect(readFileSync(path, "utf8")).toBe(content);
				expect(await auth.read("openai")).toBeUndefined();
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);

	test("rejects a failed mirror without committing the changed selection", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lunr-subscriptions-"));
		try {
			const auth = AuthStorage.inMemory();
			const path = join(dir, "subscriptions.json");
			const manager = SubscriptionManager.create(auth, path);
			await manager.addKey("openai", "fake-a");
			await manager.addKey("openai", "fake-b");
			vi.spyOn(auth, "modify").mockRejectedValueOnce(new Error("fake persistence failure"));
			await expect(manager.setActive("openai", "1")).rejects.toThrow("fake persistence failure");
			expect((await manager.getActive("openai"))?.id).toBe("2");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
