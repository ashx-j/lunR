import { existsSync, readFileSync } from "node:fs";
import { getWebSearchConfigPath } from "./utils.ts";

// Gemini Web, which searched through the user's signed-in Google browser session, was removed:
// Google bans accounts used from automated tools. Its old opt-ins (`allowBrowserCookies` or
// `chromeProfile` in web-search.json, or PI_ALLOW_BROWSER_COOKIES=1) are now ignored and left on disk.

let noticeShown = false;

function usedGeminiWeb(): boolean {
	if (process.env.PI_ALLOW_BROWSER_COOKIES === "1" || process.env.FEYNMAN_ALLOW_BROWSER_COOKIES === "1") return true;
	const path = getWebSearchConfigPath();
	if (!existsSync(path)) return false;
	try {
		const raw: { allowBrowserCookies?: unknown; chromeProfile?: unknown } = JSON.parse(readFileSync(path, "utf-8"));
		return raw.allowBrowserCookies === true || typeof raw.chromeProfile === "string";
	} catch {
		// The search modules report a broken config themselves.
		return false;
	}
}

/**
 * Returns a one-line explanation the first time in this process that a failure happens where Gemini Web
 * used to answer, and only for users who had turned Gemini Web on. Callers put it at the top of their error.
 */
function takeGeminiWebRemovedNotice(): string | null {
	if (noticeShown || !usedGeminiWeb()) return null;
	noticeShown = true;
	return `Gemini Web (search through your signed-in Google browser) was removed from lunR, so allowBrowserCookies is ignored. Set GEMINI_API_KEY, or geminiApiKey or another provider's key in ${getWebSearchConfigPath()}.`;
}

/** Prepends the removal notice to an error message when it applies. */
export function withGeminiWebRemovedNotice(message: string): string {
	const notice = takeGeminiWebRemovedNotice();
	return notice ? `${notice}\n${message}` : message;
}
