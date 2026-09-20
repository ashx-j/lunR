import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { readSecret } from "../cli/read-secret.ts";
import { loadInstallFeatures, saveInstallFeatures } from "../core/install-features.ts";
import { loadGatewayConfig, saveGatewayConfig } from "./config.ts";
import { createPairingStore } from "./pairing.ts";
import { configureStartup, type StartupMode, startGatewayService } from "./service.ts";

export async function validateBotToken(platform: "telegram" | "discord", token: string): Promise<string> {
	const url =
		platform === "telegram" ? `https://api.telegram.org/bot${token}/getMe` : "https://discord.com/api/v10/users/@me";
	let response: Response;
	try {
		response = await fetch(url, {
			headers: platform === "discord" ? { Authorization: `Bot ${token}` } : {},
			signal: AbortSignal.timeout(15_000),
		});
	} catch {
		throw new Error(`${platform}: could not reach the bot API. Check your connection and try again.`);
	}
	if (!response.ok)
		throw new Error(
			`${platform}: token check failed with HTTP ${response.status}. Check the token and bot permissions.`,
		);
	const value: unknown = await response.json();
	if (!value || typeof value !== "object") throw new Error(`${platform}: unexpected bot API response.`);
	const user = platform === "telegram" && "result" in value ? value.result : value;
	if (!user || typeof user !== "object" || !("id" in user)) throw new Error(`${platform}: bot identity was missing.`);
	return "username" in user && typeof user.username === "string" ? user.username : String(user.id);
}

export async function setupGateway(): Promise<void> {
	if (!process.stdin.isTTY || !process.stdout.isTTY)
		throw new Error(
			"Run lunr gateway setup in a terminal. Bot tokens are entered privately, not as command arguments.",
		);
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const ask = async (question: string, fallback = "") =>
		(await rl.question(`${question}${fallback ? ` [${fallback}]` : ""}: `)).trim() || fallback;
	const cfg = loadGatewayConfig();
	try {
		console.log(
			"Set up lunR on your phone\nYour computer must stay awake and connected to the internet. Press Ctrl+C to cancel.\n",
		);
		const choice = (
			await ask(
				"Connect telegram, discord, or both",
				cfg.discord.enabled ? (cfg.telegram.enabled ? "both" : "discord") : "telegram",
			)
		).toLowerCase();
		if (!["telegram", "discord", "both"].includes(choice)) throw new Error("Choose telegram, discord, or both.");
		for (const platform of ["telegram", "discord"] as const) {
			if (choice !== platform && choice !== "both") continue;
			console.log(
				platform === "telegram"
					? "\nTelegram\n1. Open https://t.me/BotFather and send /newbot.\n2. Follow its prompts and copy the bot token.\n3. Open your new bot and send /whoami. After startup it will show your user ID and pairing code.\nGuide: https://core.telegram.org/bots/tutorial"
					: "\nDiscord\n1. Open https://discord.com/developers/applications and create an application.\n2. Open Bot, create or reset its token, and enable Message Content Intent for ordinary chat.\n3. Under Installation, add bot and applications.commands scopes. Grant View Channels, Send Messages, Read Message History, Attach Files, and thread permissions if needed.\n4. Use the install link to add your bot. In Discord, enable Developer Mode and copy your user ID.\nGuide: https://docs.discord.com/developers/quick-start/getting-started",
			);
			let token = cfg[platform].token;
			if (!token || (await ask("Replace the saved token? yes/no", "no")) === "yes") {
				rl.pause();
				try {
					token = (await readSecret(`${platform} bot token`))?.trim();
				} finally {
					rl.resume();
				}
			}
			if (!token) throw new Error("No token entered. Existing configuration was not changed.");
			console.log(`Connected bot: ${await validateBotToken(platform, token)}`);
			cfg[platform].token = token;
			cfg[platform].enabled = true;
			cfg.owners ??= { telegram: [], discord: [] };
			const owner = await ask(
				`Your ${platform} user ID, or leave empty to pair after startup`,
				cfg.owners[platform][0] ?? "",
			);
			if (owner && !/^\d+$/.test(owner)) throw new Error("User IDs contain digits only.");
			if (owner) {
				cfg.owners[platform] = [...new Set([...cfg.owners[platform], owner])];
				cfg[platform].allowedUsers = [...new Set([...cfg[platform].allowedUsers, owner])];
			}
		}
		const root = await ask(
			"Project folder you want to browse from your phone",
			cfg.projectRoots?.[0] ?? process.cwd(),
		);
		const path = resolve(root);
		if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error("That project folder does not exist.");
		cfg.projectRoots = [...new Set([...(cfg.projectRoots ?? []), realpathSync(path)])];
		const startup = await ask("Automatic startup: off, login, or boot", "off");
		if (!["off", "login", "boot"].includes(startup)) throw new Error("Choose off, login, or boot.");
		if (startup === "boot")
			console.log(
				"Boot startup may require administrator permission or OS-managed account credentials. lunR does not save your account password.",
			);
		console.log(
			"Gateway uses your saved lunR model and credentials. Configure them locally with /login and /model if needed.",
		);
		if ((await ask("Save these settings? yes/no", "yes")) !== "yes") {
			console.log("Cancelled. Nothing saved.");
			return;
		}
		saveGatewayConfig(cfg);
		const features = loadInstallFeatures();
		features.features["chat-platforms"] = {
			enabled: true,
			options: { ...features.features["chat-platforms"]?.options, autostart: startup !== "off" },
		};
		saveInstallFeatures(features);
		await configureStartup(startup as StartupMode);
		if ((await ask("Start the gateway now? yes/no", "yes")) === "yes") console.log(await startGatewayService());
		console.log(
			"\nSend /whoami to your bot. To approve your own pairing code with access to projects and TUI sessions, run:\nlunr gateway pair approve <telegram|discord> <code> --owner\nThen use /project, /sessions, or /continue on your phone.",
		);
	} finally {
		rl.close();
	}
}

export function approveGatewayOwner(platform: string, code: string): string {
	if (platform !== "telegram" && platform !== "discord") throw new Error("Choose telegram or discord.");
	const pairing = createPairingStore();
	const user = pairing.approve(platform, code);
	if (!user) throw new Error("Pairing code is invalid or expired.");
	const cfg = loadGatewayConfig();
	cfg.owners ??= { telegram: [], discord: [] };
	cfg.owners[platform] = [...new Set([...cfg.owners[platform], user])];
	cfg[platform].allowedUsers = [...new Set([...cfg[platform].allowedUsers, user])];
	saveGatewayConfig(cfg);
	return `Approved ${platform} owner ${user}. Owner access includes local projects and TUI session history.`;
}
