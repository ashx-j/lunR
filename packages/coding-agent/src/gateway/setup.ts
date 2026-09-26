import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Container, SelectList, Spacer, Text } from "@earendil-works/pi-tui";
import { readSecret } from "../cli/read-secret.ts";
import { createStartupTui, showStartupInput, startStartupTui } from "../cli/startup-ui.ts";
import { loadInstallFeatures, saveInstallFeatures } from "../core/install-features.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { getSelectListTheme, theme } from "../modes/interactive/theme/theme.ts";
import { loadGatewayConfig, saveGatewayConfig } from "./config.ts";
import { createPairingStore } from "./pairing.ts";
import { configureStartup, loadServiceSettings, type StartupMode, startGatewayService } from "./service.ts";

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

export async function selectSetupOption<T>(
	settings: SettingsManager,
	title: string,
	options: Array<{ label: string; value: T }>,
	initial?: T,
): Promise<T | undefined> {
	const ui = await createStartupTui(settings);
	try {
		return await new Promise<T | undefined>((resolve) => {
			const list = new SelectList(
				options.map((option, index) => ({ label: option.label, value: String(index) })),
				8,
				getSelectListTheme(),
			);
			list.setSelectedIndex(
				Math.max(
					0,
					options.findIndex((option) => option.value === initial),
				),
			);
			list.onSelect = (item) => resolve(options[Number(item.value)].value);
			list.onCancel = () => resolve(undefined);
			const panel = new Container();
			panel.addChild(new Text(theme.fg("accent", title), 1, 0));
			panel.addChild(new Spacer(1));
			panel.addChild(list);
			panel.addChild(new Text("Up/Down to navigate, Enter to select, Esc to cancel", 1, 1));
			ui.addChild(panel);
			ui.setFocus(list);
			startStartupTui(ui, settings);
		});
	} finally {
		ui.clear();
		ui.requestRender();
		await new Promise((resolve) => setTimeout(resolve, 25));
		ui.stop();
	}
}

export async function setupGateway(): Promise<void> {
	if (!process.stdin.isTTY || !process.stdout.isTTY)
		throw new Error(
			"Run lunr gateway setup in a terminal. Bot tokens are entered privately, not as command arguments.",
		);
	const uiSettings = SettingsManager.inMemory({ theme: "moon" });
	const cancelled = new Error("Setup cancelled.");
	let saved = false;
	const choose = async <T>(title: string, options: Array<{ label: string; value: T }>, initial?: T) => {
		const value = await selectSetupOption(uiSettings, title, options, initial);
		if (value === undefined) throw cancelled;
		return value;
	};
	const ask = async (title: string) => {
		const value = await showStartupInput(uiSettings, title);
		if (value === undefined) throw cancelled;
		return value.trim();
	};
	const cfg = loadGatewayConfig();
	try {
		console.log("Set up lunR on your phone\nYour computer must stay awake and connected to the internet.\n");
		const choice = await choose(
			"Connect a chat platform",
			[
				{ label: "Telegram", value: "telegram" },
				{ label: "Discord", value: "discord" },
				{ label: "Both", value: "both" },
			],
			cfg.discord.enabled ? (cfg.telegram.enabled ? "both" : "discord") : "telegram",
		);
		for (const platform of ["telegram", "discord"] as const) {
			if (choice !== platform && choice !== "both") continue;
			console.log(
				platform === "telegram"
					? "\nTelegram\n1. Open https://t.me/BotFather and send /newbot.\n2. Follow its prompts and copy the bot token.\n3. Open your new bot and send /whoami. If your ID was not configured, it sends a pairing code for local approval.\nGuide: https://core.telegram.org/bots/tutorial"
					: "\nDiscord\n1. Open https://discord.com/developers/applications and create an application.\n2. Open Bot, create or reset its token, and enable Message Content Intent for ordinary chat.\n3. Under Installation, add bot and applications.commands scopes. Grant View Channels, Send Messages, Read Message History, Attach Files, and thread permissions if needed.\n4. Use the install link to add your bot. In Discord, enable Developer Mode and copy your user ID.\nGuide: https://docs.discord.com/developers/quick-start/getting-started",
			);
			let token = cfg[platform].token;
			if (
				!token ||
				(await choose(`${platform} bot token`, [
					{ label: "Keep the saved token", value: false },
					{ label: "Enter a different token", value: true },
				]))
			) {
				token = (await readSecret(`${platform} bot token`))?.trim();
			}
			if (!token) throw new Error("No token entered. Existing configuration was not changed.");
			console.log(`Connected bot: ${await validateBotToken(platform, token)}`);
			cfg[platform].token = token;
			cfg[platform].enabled = true;
			cfg.owners ??= { telegram: [], discord: [] };
			const ownerChoice = await choose(`${platform} owner access`, [
				...(cfg.owners[platform].length ? [{ label: "Keep the saved owners", value: "keep" }] : []),
				{ label: "Enter my user ID", value: "enter" },
				{ label: "Approve a pairing code later on this computer", value: "later" },
			]);
			const owner = ownerChoice === "enter" ? await ask(`Your ${platform} user ID`) : "";
			if (ownerChoice === "enter" && !/^\d+$/.test(owner)) throw new Error("User IDs contain digits only.");
			if (owner) {
				cfg.owners[platform] = [...new Set([...cfg.owners[platform], owner])];
				cfg[platform].allowedUsers = [...new Set([...cfg[platform].allowedUsers, owner])];
			}
		}
		const folders = [...new Set([cfg.defaultProject, ...(cfg.projectRoots ?? []), process.cwd()])].filter(
			(folder): folder is string => !!folder,
		);
		const folder = await choose<string | null>("Default project", [
			...folders.map((value) => ({ label: value, value })),
			{ label: "Enter another folder path", value: null },
		]);
		const root = folder ?? (await ask("Project folder path"));
		if (!root) throw new Error("Enter a project folder. Nothing saved.");
		const path = resolve(root);
		if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error("That project folder does not exist.");
		cfg.defaultProject = realpathSync(path);
		cfg.projectRoots = [...new Set([...(cfg.projectRoots ?? []), cfg.defaultProject])];
		const startup = await choose<StartupMode>(
			"Automatic startup",
			[
				{ label: "Off. Start manually", value: "off" },
				{ label: "When I sign in", value: "login" },
				{ label: "When the computer boots", value: "boot" },
			],
			loadServiceSettings().startup,
		);
		if (startup === "boot")
			console.log(
				"Boot startup may require administrator permission or OS-managed account credentials. lunR does not save your account password.",
			);
		const { ModelRuntime } = await import("../core/model-runtime.ts");
		const runtime = await ModelRuntime.create({ allowModelNetwork: false });
		const models = await runtime.getAvailable();
		if (!models.length)
			throw new Error(
				"No saved model credentials found. Open lunr locally and use /login, then rerun gateway setup. Nothing saved.",
			);
		const settings = SettingsManager.create(cfg.defaultProject);
		const providers = [...new Set(models.map((model) => model.provider))];
		const provider = await choose(
			"Model provider",
			providers.map((value) => ({ label: value, value })),
			settings.getDefaultProvider(),
		);
		const choices = models.filter((model) => model.provider === provider);
		const model = await choose(
			"Model",
			choices.map((value) => ({ label: value.id, value })),
			choices.find((model) => model.id === settings.getDefaultModel()),
		);
		if (
			!(await choose(
				`Save gateway settings?\nProject: ${cfg.defaultProject}\nModel: ${model.provider}/${model.id}\nStartup: ${startup}`,
				[
					{ label: "Save", value: true },
					{ label: "Cancel", value: false },
				],
			))
		) {
			console.log("Cancelled. Nothing saved.");
			return;
		}
		saveGatewayConfig(cfg);
		saved = true;
		settings.setDefaultModelAndProvider(model.provider, model.id);
		await settings.flush();
		const features = loadInstallFeatures();
		features.features["chat-platforms"] = {
			enabled: true,
			options: {
				...features.features["chat-platforms"]?.options,
				autostart: loadServiceSettings().startup !== "off",
			},
		};
		saveInstallFeatures(features);
		try {
			await configureStartup(startup);
		} finally {
			features.features["chat-platforms"].options.autostart = loadServiceSettings().startup !== "off";
			saveInstallFeatures(features);
		}
		if (
			await choose("Start the gateway now?", [
				{ label: "Start now", value: true },
				{ label: "Not now", value: false },
			])
		)
			console.log(await startGatewayService());
		console.log(
			"\nIf you entered your user ID, send /start to your bot, then send a task. Otherwise send /whoami, then on this computer run:\nlunr gateway pair approve <telegram|discord> <code> --owner\nOrdinary pairing without --owner does not grant project or TUI access.",
		);
	} catch (error) {
		if (error !== cancelled) throw error;
		console.log(saved ? "Settings saved. Start the gateway with lunr gateway start." : "Cancelled. Nothing saved.");
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
