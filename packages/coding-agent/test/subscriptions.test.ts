import { describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SubscriptionManager } from "../src/core/subscriptions.ts";

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
		const rotated = await manager.rotateOnFailure("openai", "quota exceeded, reset in 2h");
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
		const first = await manager.rotateOnFailure("openai", "quota exceeded");
		expect(first?.id).toBe("2");
		// Unparseable reset time: nothing persisted on the entry.
		expect((await manager.list("openai")).find((entry) => entry.id === "1")?.exhaustedUntil).toBeUndefined();

		// 2 exhausted (in-memory) → wraps around past 1 (exhausted) → no alternative.
		const second = await manager.rotateOnFailure("openai", "quota exceeded");
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
		expect((await manager.rotateOnFailure("openai", "quota exceeded, reset in 2h"))?.id).toBe("3");
		// Exhaust 3 in-memory; round-robin order is 1, 2 — 2 is still exhausted → 1.
		expect((await manager.rotateOnFailure("openai", "quota exceeded"))?.id).toBe("1");
	});

	test("clearExhaustion reactivates a key", async () => {
		const { manager } = makeManager({ openai: { type: "api_key", key: "sk-1" } });
		await manager.addKey("openai", "sk-2");
		await manager.setActive("openai", "1");
		await manager.rotateOnFailure("openai", "quota exceeded, reset in 2h");

		await manager.clearExhaustion("openai", "1");
		const cleared = (await manager.list("openai")).find((entry) => entry.id === "1");
		expect(cleared?.exhaustedUntil).toBeUndefined();
		expect(cleared?.lastError).toBeUndefined();

		// Rotating 2 can now fall back to the reactivated 1.
		expect((await manager.rotateOnFailure("openai", "quota exceeded"))?.id).toBe("1");
	});
});
