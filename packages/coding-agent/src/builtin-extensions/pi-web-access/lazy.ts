// @ts-nocheck
/** Cached dynamic imports for heavy web-access implementation modules. */

type ExtractMod = typeof import("./extract.ts");
type SearchMod = typeof import("./gemini-search.ts");
type CuratorMod = typeof import("./curator-server.ts");
type SummaryMod = typeof import("./summary-review.ts");
type GeminiWebMod = typeof import("./gemini-web.ts");
type GeminiApiMod = typeof import("./gemini-api.ts");
type OpenAIMod = typeof import("./openai-search.ts");
type BraveMod = typeof import("./brave.ts");
type ParallelMod = typeof import("./parallel.ts");
type TavilyMod = typeof import("./tavily.ts");
type PerplexityMod = typeof import("./perplexity.ts");
type ExaMod = typeof import("./exa.ts");
type GithubExtractMod = typeof import("./github-extract.ts");
type PdfExtractMod = typeof import("./pdf-extract.ts");
type YoutubeExtractMod = typeof import("./youtube-extract.ts");
type VideoExtractMod = typeof import("./video-extract.ts");
type GeminiUrlContextMod = typeof import("./gemini-url-context.ts");

let extractMod: Promise<ExtractMod> | undefined;
let searchMod: Promise<SearchMod> | undefined;
let curatorMod: Promise<CuratorMod> | undefined;
let summaryMod: Promise<SummaryMod> | undefined;
let geminiWebMod: Promise<GeminiWebMod> | undefined;
let geminiApiMod: Promise<GeminiApiMod> | undefined;
let openaiMod: Promise<OpenAIMod> | undefined;
let braveMod: Promise<BraveMod> | undefined;
let parallelMod: Promise<ParallelMod> | undefined;
let tavilyMod: Promise<TavilyMod> | undefined;
let perplexityMod: Promise<PerplexityMod> | undefined;
let exaMod: Promise<ExaMod> | undefined;
let githubExtractMod: Promise<GithubExtractMod> | undefined;
let pdfExtractMod: Promise<PdfExtractMod> | undefined;
let youtubeExtractMod: Promise<YoutubeExtractMod> | undefined;
let videoExtractMod: Promise<VideoExtractMod> | undefined;
let geminiUrlContextMod: Promise<GeminiUrlContextMod> | undefined;

export function loadExtract(): Promise<ExtractMod> {
	return (extractMod ??= import("./extract.ts"));
}

export function loadGeminiSearch(): Promise<SearchMod> {
	return (searchMod ??= import("./gemini-search.ts"));
}

export function loadCuratorServer(): Promise<CuratorMod> {
	return (curatorMod ??= import("./curator-server.ts"));
}

export function loadSummaryReview(): Promise<SummaryMod> {
	return (summaryMod ??= import("./summary-review.ts"));
}

export function loadGeminiWeb(): Promise<GeminiWebMod> {
	return (geminiWebMod ??= import("./gemini-web.ts"));
}

export function loadGeminiApi(): Promise<GeminiApiMod> {
	return (geminiApiMod ??= import("./gemini-api.ts"));
}

export function loadOpenAISearch(): Promise<OpenAIMod> {
	return (openaiMod ??= import("./openai-search.ts"));
}

export function loadBrave(): Promise<BraveMod> {
	return (braveMod ??= import("./brave.ts"));
}

export function loadParallel(): Promise<ParallelMod> {
	return (parallelMod ??= import("./parallel.ts"));
}

export function loadTavily(): Promise<TavilyMod> {
	return (tavilyMod ??= import("./tavily.ts"));
}

export function loadPerplexity(): Promise<PerplexityMod> {
	return (perplexityMod ??= import("./perplexity.ts"));
}

export function loadExa(): Promise<ExaMod> {
	return (exaMod ??= import("./exa.ts"));
}

export function loadGithubExtract(): Promise<GithubExtractMod> {
	return (githubExtractMod ??= import("./github-extract.ts"));
}

export function loadPdfExtract(): Promise<PdfExtractMod> {
	return (pdfExtractMod ??= import("./pdf-extract.ts"));
}

export function loadYoutubeExtract(): Promise<YoutubeExtractMod> {
	return (youtubeExtractMod ??= import("./youtube-extract.ts"));
}

export function loadVideoExtract(): Promise<VideoExtractMod> {
	return (videoExtractMod ??= import("./video-extract.ts"));
}

export function loadGeminiUrlContext(): Promise<GeminiUrlContextMod> {
	return (geminiUrlContextMod ??= import("./gemini-url-context.ts"));
}

/** Test-only: reset cached promises so import barriers can be re-asserted. */
export function resetLazyCachesForTests(): void {
	extractMod = undefined;
	searchMod = undefined;
	curatorMod = undefined;
	summaryMod = undefined;
	geminiWebMod = undefined;
	geminiApiMod = undefined;
	openaiMod = undefined;
	braveMod = undefined;
	parallelMod = undefined;
	tavilyMod = undefined;
	perplexityMod = undefined;
	exaMod = undefined;
	githubExtractMod = undefined;
	pdfExtractMod = undefined;
	youtubeExtractMod = undefined;
	videoExtractMod = undefined;
	geminiUrlContextMod = undefined;
}
