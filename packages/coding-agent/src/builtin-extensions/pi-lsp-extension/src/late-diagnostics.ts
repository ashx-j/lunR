import type { Diagnostic } from "vscode-languageserver-protocol";

/** Tools that cannot change files. Any other tool result counts as a possible file change. */
const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "lsp_diagnostics",
  "lsp_hover",
  "lsp_definition",
  "lsp_references",
  "lsp_symbols",
  "lsp_completions",
  "code_overview",
  "ast_search",
]);

interface Entry {
  relPath: string;
  /** The change count when the diagnostics were requested. */
  changes: number;
  diagnostics?: Diagnostic[];
}

/**
 * Edit diagnostics that arrived after their tool result. An answer is delivered only if no tool
 * that could change files ran since it was requested, since such a change (to this file or one it
 * imports) can make it wrong. Otherwise it is dropped.
 */
export class LateDiagnostics {
  private changes = 0;
  private readonly entries = new Map<string, Entry>();

  /** Counts `toolName`'s result as a possible file change unless the tool is read-only. */
  noteToolResult(toolName: string): void {
    if (!READ_ONLY_TOOLS.has(toolName)) this.changes++;
  }

  /** Waits for `answer`, the diagnostics requested for `uri` at the current change count. */
  add(uri: string, relPath: string, answer: Promise<Diagnostic[] | undefined>): void {
    const entry: Entry = { relPath, changes: this.changes };
    this.entries.set(uri, entry);
    void answer.then((diagnostics) => {
      if (this.entries.get(uri) !== entry) return;
      if (diagnostics) entry.diagnostics = diagnostics;
      else this.entries.delete(uri);
    });
  }

  /** Removes the entries whose answers have arrived and returns those still valid. */
  take(): Array<{ relPath: string; diagnostics: Diagnostic[] }> {
    const valid: Array<{ relPath: string; diagnostics: Diagnostic[] }> = [];
    for (const [uri, entry] of this.entries) {
      if (entry.changes !== this.changes) {
        this.entries.delete(uri);
      } else if (entry.diagnostics) {
        this.entries.delete(uri);
        valid.push({ relPath: entry.relPath, diagnostics: entry.diagnostics });
      }
    }
    return valid;
  }

  /** Drops every entry, for example when the agent's turn ends and the user may edit files. */
  clear(): void {
    this.entries.clear();
  }
}
