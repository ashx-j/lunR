/**
 * Shared timing constants for LSP operations.
 */

/**
 * Longest wait (ms) for a server's diagnostics after an edit. tsserver answers lunR's direct request in
 * 5 to 330 ms once the project is loaded; pyright publishes with a version in about 300 ms. A slower
 * answer can go out with a later tool result if no file changed since.
 */
export const DIAGNOSTIC_WAIT_CAP_MS = 500;

/**
 * Longest wait (ms) in the lsp_diagnostics tool for the server to start and answer for the file's
 * current content. A first open loads the project, which took about 14 s on the lunR repo.
 */
export const DIAGNOSTIC_TOOL_WAIT_MS = 15_000;

/** Delay (ms) to wait for a daemon socket to start listening after spawn */
export const DAEMON_SOCKET_READY_DELAY_MS = 500;

/** Interval (ms) between retries when connecting to a daemon */
export const DAEMON_RETRY_INTERVAL_MS = 5000;

/** Maximum number of retries when connecting to a daemon (5 min total at 5s intervals) */
export const DAEMON_MAX_RETRIES = 60;

/** Delay (ms) to let LSP process a synthetic didChange before requesting completions */
export const SYNTHETIC_DOT_SETTLE_DELAY_MS = 100;

/**
 * Bounds one tree-sitter parse. A grammar bug that loops would otherwise grow wasm memory to its
 * 2 GB limit and abort the shared runtime, failing every later tree-sitter call in the session.
 * Normal files parse in milliseconds; a 50,000-line TypeScript file takes about 1.4 s.
 */
export const PARSE_TIMEOUT_SECONDS = 5;
