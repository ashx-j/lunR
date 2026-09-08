// Node caches loaded modules; retaining rejected promises here would prevent resolution retries.
export const loadExtract = () => import("./extract.ts");
export const loadGeminiSearch = () => import("./gemini-search.ts");
export const loadCuratorServer = () => import("./curator-server.ts");
export const loadSummaryReview = () => import("./summary-review.ts");
export const loadGeminiWeb = () => import("./gemini-web.ts");
export const loadGeminiApi = () => import("./gemini-api.ts");
export const loadOpenAISearch = () => import("./openai-search.ts");
export const loadBrave = () => import("./brave.ts");
export const loadParallel = () => import("./parallel.ts");
export const loadTavily = () => import("./tavily.ts");
export const loadPerplexity = () => import("./perplexity.ts");
export const loadExa = () => import("./exa.ts");
export const loadGithubExtract = () => import("./github-extract.ts");
export const loadPdfExtract = () => import("./pdf-extract.ts");
export const loadYoutubeExtract = () => import("./youtube-extract.ts");
export const loadVideoExtract = () => import("./video-extract.ts");
export const loadGeminiUrlContext = () => import("./gemini-url-context.ts");
