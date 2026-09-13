// @ts-nocheck
interface AsyncLaunchParams {
	task?: unknown;
	tasks?: unknown[];
	chain?: unknown[];
	action?: unknown;
	async?: boolean;
	clarify?: boolean;
	foregroundOnly?: boolean;
}

interface LegacyAsyncLaunchConfig {
	asyncByDefault?: boolean;
	forceTopLevelAsync?: boolean;
}

export function normalizeAsyncLaunchConfig<T extends LegacyAsyncLaunchConfig>(config: T): T & {
	asyncByDefault: true;
	forceTopLevelAsync: false;
} {
	return { ...config, asyncByDefault: true, forceTopLevelAsync: false };
}

export function subagentLaunchRunsAsync(params: AsyncLaunchParams): boolean {
	if (params.foregroundOnly === true || params.clarify === true || params.async === false) return false;
	return true;
}

export function isAsyncSubagentExecution(params: AsyncLaunchParams): boolean {
	if (params.action) return false;
	if (!params.task && !params.tasks?.length && !params.chain?.length) return false;
	return subagentLaunchRunsAsync(params);
}
