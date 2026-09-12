type RequestParams = {
	action?: string;
	task?: unknown;
	tasks?: unknown[];
	chain?: unknown[];
};

const LAUNCH_COMPATIBLE_ACTIONS = new Set(["schedule", "append-step", "resume", "steer"]);

function omitExecutionModeActionAlias<T extends RequestParams>(params: T): T {
	const action = params.action?.toLowerCase();
	if (action === "single" && params.task !== undefined) {
		const rest = { ...params };
		delete rest.action;
		return rest;
	}
	if ((action === "parallel" || action === "tasks") && (params.tasks?.length ?? 0) > 0) {
		const rest = { ...params };
		delete rest.action;
		return rest;
	}
	return params;
}

function hasLaunchFields(params: RequestParams): boolean {
	return params.task !== undefined
		|| (Array.isArray(params.tasks) && params.tasks.length > 0)
		|| (Array.isArray(params.chain) && params.chain.length > 0);
}

function omitConflictingControlAction<T extends RequestParams>(params: T): T {
	const action = params.action?.toLowerCase();
	if (!action || LAUNCH_COMPATIBLE_ACTIONS.has(action) || !hasLaunchFields(params)) return params;
	const rest = { ...params };
	delete rest.action;
	// Grok fills the flat schema, so a real single launch also carries dummy tasks/chain.
	if (typeof rest.task === "string" && rest.task.length > 0) {
		delete rest.tasks;
		delete rest.chain;
	}
	return rest;
}

/** Drop execution-mode aliases and control actions mixed into a launch payload. */
export function resolveSubagentRequestParams<T extends RequestParams>(params: T): T {
	return omitConflictingControlAction(omitExecutionModeActionAlias(params));
}
