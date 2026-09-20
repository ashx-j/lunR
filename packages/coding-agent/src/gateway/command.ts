/**
 * lunR: `lunr gateway` subcommand interception, following the
 * handlePackageCommand/handleConfigCommand pattern in package-manager-cli.ts.
 * Returns true when the args were a gateway command (handled — the caller
 * must not continue normal startup).
 */

export async function handleGatewayCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "gateway") {
		return false;
	}
	try {
		const sub = args[1];
		if (sub === "setup") {
			await (await import("./setup.ts")).setupGateway();
		} else if (sub === "pair" && args[2] === "approve" && args.includes("--owner")) {
			console.log((await import("./setup.ts")).approveGatewayOwner(args[3], args[4]));
		} else if (["start", "stop", "restart", "status", "logs", "doctor", "autostart"].includes(sub)) {
			const service = await import("./service.ts");
			if (sub === "start") console.log(await service.startGatewayService());
			if (sub === "stop") console.log(await service.stopGatewayService());
			if (sub === "restart") {
				await service.stopGatewayService();
				console.log(await service.startGatewayService());
			}
			if (sub === "status" || sub === "doctor") console.log(service.serviceStatusText());
			if (sub === "logs") console.log(service.readGatewayLog());
			if (sub === "autostart") {
				const mode = args[2];
				if (mode !== "off" && mode !== "login" && mode !== "boot")
					throw new Error("Usage: lunr gateway autostart off|login|boot");
				await service.configureStartup(mode);
				console.log(`Automatic startup: ${mode}`);
			}
			if (sub === "doctor") {
				const { loadGatewayConfig, resolvePlatformToken } = await import("./config.ts");
				const cfg = loadGatewayConfig();
				for (const platform of ["telegram", "discord"] as const)
					console.log(
						`${platform}: ${cfg[platform].enabled ? "enabled" : "disabled"}, token ${resolvePlatformToken(platform, cfg[platform]) ? "configured" : "missing"}, owners ${cfg.owners?.[platform].length ?? 0}`,
					);
				console.log(
					`Project roots: ${cfg.projectRoots?.length ?? 0}. Run lunr gateway setup to change these.\nIf startup is not responding, inspect lunr gateway logs. Do not delete a lock while its process is alive.`,
				);
			}
		} else if (sub === "--help" || sub === "help" || sub === "-h") {
			console.log(
				"lunr gateway setup|start|stop|restart|status|logs|doctor|run\nlunr gateway autostart off|login|boot\nlunr gateway pair approve <platform> <code> [--owner]\nlunr gateway pair list",
			);
		} else {
			const { runGateway } = await import("./index.ts");
			process.exitCode = await runGateway(sub === "run" ? args.slice(2) : args.slice(1));
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
	return true;
}
