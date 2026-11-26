/**
 * Tree-sitter Parser Manager — loads and caches WASM parsers per language.
 *
 * Uses web-tree-sitter (WASM) so no native compilation is needed.
 * The build copies the grammars mapped below into ./grammars (scripts/copy-tree-sitter-grammars.mjs):
 * the newer build in ./vendored-grammars when there is one (see its README), otherwise the
 * tree-sitter-wasms file. Source runs (tests, tsx) have no ./grammars and pick per file the same way.
 * A standalone binary keeps the same grammars, and web-tree-sitter's tree-sitter.wasm, beside the
 * executable (getPackageDir()), because its import.meta.url points into Bun's virtual filesystem.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setFlagsFromString } from "node:v8";
import Parser from "web-tree-sitter";
import { getPackageDir } from "../../../../config.js";

const require = createRequire(import.meta.url);
import { getLanguageIdFromPath } from "../shared/language-map.js";
import { PARSE_TIMEOUT_SECONDS } from "../shared/timing.js";

type Language = Parser.Language;
type Tree = Parser.Tree;

/** Map language IDs to tree-sitter-wasms grammar file names */
const LANGUAGE_TO_GRAMMAR: Record<string, string> = {
  typescript: "tree-sitter-typescript.wasm",
  typescriptreact: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  javascriptreact: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
  rust: "tree-sitter-rust.wasm",
  go: "tree-sitter-go.wasm",
  java: "tree-sitter-java.wasm",
  c: "tree-sitter-c.wasm",
  cpp: "tree-sitter-cpp.wasm",
  ruby: "tree-sitter-ruby.wasm",
  kotlin: "tree-sitter-kotlin.wasm",
  scala: "tree-sitter-scala.wasm",
  // No swift: every ABI 14 Swift build has a lexer V8 cannot optimize; the process dies of
  // "Fatal process out of memory: Zone" seconds after the first Swift parse.
  lua: "tree-sitter-lua.wasm",
  bash: "tree-sitter-bash.wasm",
  json: "tree-sitter-json.wasm",
  html: "tree-sitter-html.wasm",
  css: "tree-sitter-css.wasm",
};

// File extension → language ID mapping is in shared/language-map.ts

/** Thrown by parseDetached when a parse runs past PARSE_TIMEOUT_SECONDS. */
export class ParseTimeoutError extends Error {
  constructor() {
    super(`parsing took over ${PARSE_TIMEOUT_SECONDS} s`);
    this.name = "ParseTimeoutError";
  }
}

/**
 * V8 optimizes a wasm function after it has run for its tiering budget (13M by default), and
 * optimizing a large grammar lexer takes 0.2 to 0.6 GB for a moment. A session that touches several
 * grammars optimized them together: the 500-call probe peaked at 827 to 941 MB, 1 GB in the review.
 * A 14x budget spreads those compiles out (330 MB on the same probe). Hot parses run at the same
 * speed after tier-up, and a cold search over 600 TypeScript files took 4% longer, within noise.
 * The flag is process-wide and must be set before web-tree-sitter compiles; a command-line
 * --wasm-tiering-budget wins. Bun runs wasm on JavaScriptCore and needs none of this.
 */
function raiseWasmTieringBudget(): void {
  if (process.versions.bun || process.execArgv.some((flag) => flag.startsWith("--wasm-tiering-budget"))) return;
  try {
    setFlagsFromString("--wasm-tiering-budget=180000000");
  } catch {
    // An embedder without V8 flags parses at the default budget.
  }
}

const VENDORED_GRAMMARS = fileURLToPath(new URL("./vendored-grammars", import.meta.url));

/** web-tree-sitter's runtime; a standalone binary has no node_modules and ships it beside the executable. */
function webTreeSitterWasm(): string {
  try {
    return resolve(dirname(require.resolve("web-tree-sitter/package.json")), "tree-sitter.wasm");
  } catch {
    return join(getPackageDir(), "tree-sitter.wasm");
  }
}

/** Where a grammar comes from in a source run: the vendored build, else tree-sitter-wasms. */
function sourceGrammarPath(file: string): string | undefined {
  const vendored = resolve(VENDORED_GRAMMARS, file);
  if (existsSync(vendored)) return vendored;
  try {
    return resolve(dirname(require.resolve("tree-sitter-wasms/package.json")), "out", file);
  } catch {
    return undefined;
  }
}

interface CachedTree {
  tree: Tree;
  contentLength: number;
  hashHead: number;
  hashTail: number;
}

export class TreeSitterManager {
  private initialized = false;
  private initializing: Promise<void> | null = null;
  private languages: Map<string, Language> = new Map();
  private loadingLanguages: Map<string, Promise<Language | null>> = new Map();
  private parsers: Map<string, Parser> = new Map();
  private cachedTrees: Map<string, CachedTree> = new Map();
  /** Files whose last parse hit the bound, with that content's hash, so it is not parsed again. */
  private timedOut: Map<string, string> = new Map();
  /** The folder the build copied the grammars into, or undefined in a source run. */
  private copiedGrammars: string | undefined;

  /** Grammar files that failed to load, by language, so a missing file is reported and not retried. */
  private failedGrammars: Map<string, string> = new Map();

  constructor() {
    const copied = [fileURLToPath(new URL("./grammars", import.meta.url)), join(getPackageDir(), "grammars")];
    this.copiedGrammars = copied.find((dir) => existsSync(dir));
  }

  /** Why a mapped language has no grammar loaded, after getLanguage returned null for it. */
  grammarFailure(languageId: string): string | undefined {
    return this.failedGrammars.get(languageId);
  }

  /** The grammar file a language loads from, or undefined when the language has none. */
  grammarPath(languageId: string): string | undefined {
    const file = LANGUAGE_TO_GRAMMAR[languageId];
    if (!file) return undefined;
    return this.copiedGrammars ? resolve(this.copiedGrammars, file) : sourceGrammarPath(file);
  }

  /** Initialize web-tree-sitter WASM runtime. Must be called before any parsing. */
  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initializing) {
      await this.initializing;
      return;
    }
    const runtimeWasm = webTreeSitterWasm();
    // Emscripten never settles init() when its wasm file is missing, so check first.
    if (!existsSync(runtimeWasm)) throw new Error(`tree-sitter runtime not found: ${runtimeWasm}`);
    raiseWasmTieringBudget();
    this.initializing = Parser.init({ locateFile: () => runtimeWasm });
    await this.initializing;
    this.initialized = true;
  }

  /** Get the language ID for a file path based on extension */
  getLanguageId(filePath: string): string | undefined {
    return getLanguageIdFromPath(filePath);
  }

  /** Check if we have a grammar available for a language */
  hasGrammar(languageId: string): boolean {
    return languageId in LANGUAGE_TO_GRAMMAR;
  }

  /** Get all supported language IDs */
  getSupportedLanguages(): string[] {
    return Object.keys(LANGUAGE_TO_GRAMMAR);
  }

  /** Load a language grammar, caching the result */
  async getLanguage(languageId: string): Promise<Language | null> {
    const cached = this.languages.get(languageId);
    if (cached) return cached;

    // Deduplicate concurrent loads
    const loading = this.loadingLanguages.get(languageId);
    if (loading) return loading;

    if (!(languageId in LANGUAGE_TO_GRAMMAR) || this.failedGrammars.has(languageId)) return null;
    const grammarPath = this.grammarPath(languageId);
    if (!grammarPath) {
      this.failedGrammars.set(
        languageId,
        `tree-sitter grammar files are missing: lunR expected them in ${join(getPackageDir(), "grammars")}. Reinstall lunR`,
      );
      return null;
    }

    const loadPromise = (async (): Promise<Language | null> => {
      // A missing runtime or grammar costs only tree-sitter features, not the other LSP tools.
      await this.init();
      try {
        if (!existsSync(grammarPath)) {
          this.failedGrammars.set(
            languageId,
            this.copiedGrammars
              ? `tree-sitter grammar file not found: ${grammarPath}. Reinstall lunR`
              : `tree-sitter grammar file not found: ${grammarPath}`,
          );
          return null;
        }
        const language = await Parser.Language.load(grammarPath);
        this.languages.set(languageId, language);
        return language;
      } catch (error) {
        this.failedGrammars.set(languageId, `tree-sitter grammar ${grammarPath} did not load: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      } finally {
        this.loadingLanguages.delete(languageId);
      }
    })();

    this.loadingLanguages.set(languageId, loadPromise);
    return loadPromise;
  }

  /** Get or create a parser for a language */
  private async getParser(languageId: string): Promise<Parser | null> {
    const existing = this.parsers.get(languageId);
    if (existing) return existing;

    const language = await this.getLanguage(languageId);
    if (!language) return null;

    const parser = new Parser();
    parser.setLanguage(language);
    parser.setTimeoutMicros(PARSE_TIMEOUT_SECONDS * 1_000_000);
    this.parsers.set(languageId, parser);
    return parser;
  }

  /** Parse a file's content and return the tree. Caches by file path + content hash. */
  async parse(filePath: string, content: string): Promise<Tree | null> {
    const languageId = this.getLanguageId(filePath);
    if (!languageId) return null;
    return this.parseWithLanguage(filePath, content, languageId);
  }

  /** Parse content with an explicit language ID */
  async parseWithLanguage(filePath: string, content: string, languageId: string): Promise<Tree | null> {
    const length = content.length;
    const head = djb2Hash(content, 0, Math.min(length, 4096));
    const tail = length > 4096 ? djb2Hash(content, Math.max(0, length - 4096), length) : head;
    const cached = this.cachedTrees.get(filePath);
    if (cached && cached.contentLength === length && cached.hashHead === head && cached.hashTail === tail) {
      return cached.tree;
    }

    const stamp = `${languageId}:${length}:${head}:${tail}`;
    if (this.timedOut.get(filePath) === stamp) return null;
    let tree: Tree | null;
    try {
      tree = await this.parseDetached(content, languageId);
      this.timedOut.delete(filePath);
    } catch (error) {
      if (!(error instanceof ParseTimeoutError)) throw error;
      this.timedOut.set(filePath, stamp);
      return null;
    }
    if (!tree) return null;

    // Evict old tree
    if (cached) cached.tree.delete();

    this.cachedTrees.set(filePath, { tree, contentLength: length, hashHead: head, hashTail: tail });
    return tree;
  }

  /** Whether the last parse of this file stopped at PARSE_TIMEOUT_SECONDS, so a null tree is not "no syntax". */
  parseTimedOut(filePath: string): boolean {
    return this.timedOut.has(filePath);
  }

  /**
   * Parse without caching. The caller owns the tree and must call tree.delete(), since wasm
   * memory is not garbage collected. Returns null for a missing grammar and throws
   * ParseTimeoutError when the parse runs past PARSE_TIMEOUT_SECONDS.
   */
  async parseDetached(content: string, languageId: string): Promise<Tree | null> {
    const parser = await this.getParser(languageId);
    if (!parser) return null;
    try {
      return parser.parse(content);
    } catch {
      // A timed-out parse keeps its state for resuming; drop it so the next parse starts fresh.
      parser.reset();
      throw new ParseTimeoutError();
    }
  }

  /** Invalidate the cached tree for a file */
  invalidate(filePath: string): void {
    const cached = this.cachedTrees.get(filePath);
    if (cached) {
      cached.tree.delete();
      this.cachedTrees.delete(filePath);
    }
  }

  /** Get a cached tree without re-parsing */
  getCachedTree(filePath: string): Tree | null {
    return this.cachedTrees.get(filePath)?.tree ?? null;
  }

  /** Shut down — free all resources */
  shutdown(): void {
    for (const [, cached] of this.cachedTrees) cached.tree.delete();
    this.cachedTrees.clear();
    for (const [, parser] of this.parsers) parser.delete();
    this.parsers.clear();
    this.languages.clear();
  }

  /** Alias for shutdown() — conventional dispose pattern for extension lifecycle */
  dispose(): void {
    this.shutdown();
  }
}

/**
 * Fast non-cryptographic hash (djb2) over a range of a string.
 * Hashing head + tail separately gives collision resistance close to
 * a full-content hash without iterating every character of large files.
 */
function djb2Hash(str: string, start: number, end: number): number {
  let hash = 5381;
  for (let i = start; i < end; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}
