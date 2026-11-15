/**
 * Shared timing constants for LSP operations.
 */

/**
 * Longest wait (ms) for tsserver's diagnostics after an edit. lunR asks tsserver directly, which answers in
 * 5 to 330 ms once the project is loaded. A slower answer goes out with a later tool result.
 */
export const DIAGNOSTIC_PULL_CAP_MS = 500;

/** Longest wait (ms) for a server without that request to publish diagnostics for the edit's version */
export const DIAGNOSTIC_PUBLISH_CAP_MS = 1500;

/** Delay (ms) to wait for a daemon socket to start listening after spawn */
export const DAEMON_SOCKET_READY_DELAY_MS = 500;

/** Interval (ms) between retries when connecting to a daemon */
export const DAEMON_RETRY_INTERVAL_MS = 5000;

/** Maximum number of retries when connecting to a daemon (5 min total at 5s intervals) */
export const DAEMON_MAX_RETRIES = 60;

/** Delay (ms) to let LSP process a synthetic didChange before requesting completions */
export const SYNTHETIC_DOT_SETTLE_DELAY_MS = 100;
