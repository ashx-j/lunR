export function buildInjectedContextLines(paths: string[]): string[] {
	const labels = paths.map((path) => path.trim()).filter((path) => path.length > 0);
	if (labels.length === 0) return [];
	return ["injected context", ...labels.map((path) => `  ${path}`)];
}
