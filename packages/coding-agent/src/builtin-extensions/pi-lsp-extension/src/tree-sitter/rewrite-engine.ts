/**
 * Rewrite Engine — apply structural replacements using matched patterns.
 *
 * Takes search matches and a replacement template with metavariable references,
 * substitutes captured values, and applies the text changes.
 */

import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { protectedTargetWriteReason } from "../../../../core/protected-targets.js";
import { withFileMutationQueue } from "../../../../core/tools/file-mutation-queue.js";
import { readFile, writeFile } from "node:fs/promises";
import type { SearchMatch } from "./search-engine.js";

// ── Result types ────────────────────────────────────────────────────────────

export interface RewriteChange {
  file: string;
  line: number;
  column: number;
  before: string;
  after: string;
}

export interface RewriteResult {
  changes: RewriteChange[];
  filesModified: number;
  modifiedFiles: string[];
  failures: { file: string; reason: string; writeAttempted?: boolean }[];
  skippedFiles: string[];
}

// ── Replacement template substitution ───────────────────────────────────────

const METAVAR_REF_RE = /\$\$\$([A-Z_][A-Z0-9_]*)|\$([A-Z_][A-Z0-9_]*)/g;

/**
 * Substitute metavariable references in a replacement template with captured values.
 */
export function substituteCaptures(
  template: string,
  captures: Record<string, string>,
): string {
  return template.replace(METAVAR_REF_RE, (match, variadicName, singleName) => {
    const name = variadicName ?? singleName;
    if (name in captures) return captures[name];
    return match; // Leave unmatched references as-is
  });
}

/**
 * If the original matched text ends with a semicolon (possibly preceded by whitespace)
 * and the replacement doesn't, append the semicolon. This preserves statement terminators
 * that are part of the AST node but not part of the pattern/replacement.
 */
function preserveTrailingSemicolon(original: string, replacement: string): string {
  const trailingMatch = original.match(/(\s*;)\s*$/);
  if (trailingMatch && !replacement.trimEnd().endsWith(";")) {
    return replacement + trailingMatch[1];
  }
  return replacement;
}

// ── Rewrite application ─────────────────────────────────────────────────────

/**
 * Compute rewrite changes from matches and a replacement template.
 * Returns the list of changes without applying them.
 */
export function computeRewrites(
  matches: SearchMatch[],
  replacementTemplate: string,
): RewriteChange[] {
  return matches.map((m) => {
    const raw = substituteCaptures(replacementTemplate, m.captures);
    const after = preserveTrailingSemicolon(m.matchedText, raw);
    return {
      file: m.file,
      line: m.line,
      column: m.column,
      before: m.matchedText,
      after,
    };
  });
}

/**
 * Preflight every protected destination, then queue each file's read/validate/write.
 * Stop on the first failure and retain an accurate partial result. This is not a
 * multi-file transaction; earlier successful files remain changed.
 */
export async function applyRewrites(
  matches: SearchMatch[],
  replacementTemplate: string,
  cwd?: string,
): Promise<RewriteResult> {
  const byFile = new Map<string, SearchMatch[]>();
  for (const match of matches) {
    const existing = byFile.get(match.file);
    if (existing) existing.push(match);
    else byFile.set(match.file, [match]);
  }
  const result: RewriteResult = { changes: [], filesModified: 0, modifiedFiles: [], failures: [], skippedFiles: [] };
  const files = [...byFile.keys()];
  // An allowed directory scope never authorizes a protected matched file.
  for (const file of files) {
    const reason = protectedTargetWriteReason(file, cwd ?? dirname(file));
    if (reason) result.failures.push({ file, reason });
  }
  if (result.failures.length) {
    result.skippedFiles = files.filter((file) => !result.failures.some((failure) => failure.file === file));
    return result;
  }

  for (const [file, fileMatches] of byFile) {
    let writeAttempted = false;
    try {
      const applied = await withFileMutationQueue(file, async () => {
        const reason = protectedTargetWriteReason(file, cwd ?? dirname(file));
        if (reason) throw new Error(reason);
        const source = await readFile(file, "utf-8");
        const sourceHash = createHash("sha256").update(source).digest("hex");
        const sorted = [...fileMatches].sort((a, b) => b.startIndex - a.startIndex);
        let nextStart = source.length;
        for (const match of sorted) {
          if (match.sourceHash !== sourceHash || !Number.isInteger(match.startIndex) ||
            !Number.isInteger(match.endIndex) || match.startIndex < 0 || match.endIndex > nextStart ||
            match.startIndex > match.endIndex || source.slice(match.startIndex, match.endIndex) !== match.matchedText) {
            throw new Error("Source changed or match offsets are invalid. Search again before applying a rewrite.");
          }
          nextStart = match.startIndex;
        }
        let content = source;
        const changes: RewriteChange[] = [];
        for (const match of sorted) {
          const raw = substituteCaptures(replacementTemplate, match.captures);
          const replacement = preserveTrailingSemicolon(match.matchedText, raw);
          content = content.slice(0, match.startIndex) + replacement + content.slice(match.endIndex);
          changes.push({ file, line: match.line, column: match.column, before: match.matchedText, after: replacement });
        }
        const modified = content !== source;
        if (modified) {
          writeAttempted = true;
          await writeFile(file, content, "utf-8");
        }
        return { changes: changes.reverse(), modified };
      });
      result.changes.push(...applied.changes);
      if (applied.modified) result.modifiedFiles.push(file);
    } catch (error) {
      result.failures.push({ file, reason: error instanceof Error ? error.message : String(error), writeAttempted });
      result.skippedFiles = files.slice(files.indexOf(file) + 1);
      break;
    }
  }
  result.filesModified = result.modifiedFiles.length;
  return result;
}
