---
name: skill-creator
description: Guide for creating new Agent Skills (SKILL.md files). Use when the user asks to create, scaffold, or write a skill.
disable-model-invocation: true
---

# Skill Creator

Help the user create a new skill: a directory containing a `SKILL.md` with YAML
frontmatter, optionally plus supporting files (scripts, references, assets).

## 1. Understand the skill first

Ask (or infer from the request, if clearly specified):

- What should the skill do? What triggers it (tasks, file types, phrases)?
- Should the model be able to invoke it automatically? If the skill is a
  workflow the user wants to run only on demand, set
  `disable-model-invocation: true` — it is then excluded from the system prompt
  and only runs via `/skill:<name>`.
- Scope: global (`~/.lunr/agent/skills/<name>/`, every project) or project
  (`<cwd>/.lunr/skills/<name>/`, this repo only; requires project trust).
  Default to global unless the skill is project-specific.

## 2. Create the skill

Directory name = skill name. Name rules (validated on load):

- lowercase a-z, 0-9, hyphens only; max 64 chars
- no leading/trailing hyphen, no consecutive hyphens

Write `<dir>/SKILL.md`:

```markdown
---
name: my-skill
description: One or two sentences — what it does AND when to use it. This is the only part the model sees before deciding to load the skill, so make the trigger conditions explicit.
---

# My Skill

Step-by-step instructions for the model...
```

Frontmatter fields: `name` (must match the directory name), `description`
(required, max 1024 chars), `disable-model-invocation` (optional, default false).

Writing guidance:

- The body is loaded only AFTER the model decides the skill is relevant
  (progressive disclosure), so put effort into the description.
- Keep the body focused; a few hundred lines max. Move long reference material
  into sibling files (e.g. `reference.md`) and point at them — the model reads
  them on demand. Relative paths in the body resolve against the skill
  directory.
- Include concrete examples and exact commands over abstract advice.
- Scripts shipped in the skill directory can be run with the bash tool.

## 3. Activate it

New skills are picked up on `/reload` (or the next session start). The user can
then invoke it explicitly with `/skill:<name> [args]` or, when model invocation
is enabled, just ask for the task it describes.

## 4. Verify

After creating, confirm: frontmatter parses (name/description present), the
directory name matches `name`, and `/reload` shows no skill warnings.
