/**
 * lunR-native: ships the bundled `skill-creator` skill.
 *
 * The skill is contributed through the `resources_discover` hook (the same
 * mechanism external extensions use to add resource paths) and its frontmatter
 * sets `disable-model-invocation: true`, so it is EXCLUDED from the system
 * prompt — zero automatic triggers. It only runs via explicit
 * `/skill:skill-creator [topic]`.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Resolved like pi-subagents' bundled agents dir: src/ and dist/ mirror each
// other, and copy-assets carries the SKILL.md into dist.
const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "skills");

export default function (pi: ExtensionAPI) {
  pi.on("resources_discover", async () => ({ skillPaths: [SKILLS_DIR] }));
}
