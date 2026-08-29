> lunR can help you create packages. Ask it to bundle your extensions, skills, prompt templates, or themes.

# Packages

lunR packages bundle extensions, skills, prompt templates, and themes so you can share them through npm or git. A package can declare resources in `package.json` under the `pi` key (keep that key), or use conventional directories.

## Table of Contents

- [Install and Manage](#install-and-manage)
- [Package Sources](#package-sources)
- [Creating a Package](#creating-a-package)
- [Package Structure](#package-structure)
- [Dependencies](#dependencies)
- [Package Filtering](#package-filtering)
- [Enable and Disable Resources](#enable-and-disable-resources)
- [Scope and Deduplication](#scope-and-deduplication)

## Install and Manage

> **Security:** Packages run with full system access. Extensions execute arbitrary code, and skills can instruct the model to perform any action including running executables. Review source code before installing third-party packages.

```bash
lunr install npm:@foo/bar@1.0.0
lunr install git:github.com/user/repo@v1
lunr install https://github.com/user/repo  # raw URLs work too
lunr install /absolute/path/to/package
lunr install ./relative/path/to/package

lunr remove npm:@foo/bar
lunr uninstall npm:@foo/bar   # alias for remove (requires a source)
lunr list                     # show installed packages from settings
lunr update                   # reinstall global @ashx-j/lunr only
lunr update --self            # same as lunr update
```

`lunr update` does not take `--models`, `--all`, `--force`, or `--extensions`. Refresh catalogs with `/refresh`. Reinstall a git package at a new ref with `lunr install git:host/user/repo@new-ref`.

These commands manage packages. `lunr update` reinstalls the published global CLI. To uninstall lunR itself, see [Quickstart](quickstart.md#uninstall). `lunr uninstall` with no source removes the CLI; `lunr uninstall <source>` removes a package.

By default, `install` and `remove` write to user settings (`~/.lunr/agent/settings.json`). Use `-l` to write to project settings (`.lunr/settings.json`) instead. Project settings can be shared with your team, and lunR installs any missing packages automatically on startup after the project is trusted.

To try a package without installing it, use `--extension` or `-e`. This installs to a temporary directory for the current run only:

```bash
lunr -e npm:@foo/bar
lunr -e git:github.com/user/repo
```

## Package Sources

lunR accepts three source types in settings and `lunr install`.

### npm

```
npm:@scope/pkg@1.2.3
npm:pkg
```

- Versioned specs are pinned. `lunr update` does not refresh packages; reinstall with a new spec to move a pin.
- User installs go under `~/.lunr/agent/npm/`.
- Project installs go under `.lunr/npm/`.
- Set `npmCommand` in `settings.json` to pin npm package lookup and install operations to a specific wrapper command such as `mise` or `asdf`.

Example:

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

### git

```
git:github.com/user/repo@v1
git:git@github.com:user/repo@v1
https://github.com/user/repo@v1
ssh://git@github.com/user/repo@v1
```

- Without `git:` prefix, only protocol URLs are accepted (`https://`, `http://`, `ssh://`, `git://`).
- With `git:` prefix, shorthand formats are accepted, including `github.com/user/repo` and `git@github.com:user/repo`.
- HTTPS and SSH URLs are both supported.
- SSH URLs use your configured SSH keys automatically (respects `~/.ssh/config`).
- For non-interactive runs (for example CI), you can set `GIT_TERMINAL_PROMPT=0` to disable credential prompts and set `GIT_SSH_COMMAND` (for example `ssh -o BatchMode=yes -o ConnectTimeout=5`) to fail fast.
- Refs are pinned tags or commits. `lunr update` does not refresh packages. Use `lunr install git:host/user/repo@new-ref` to move an existing package to a new pinned ref.
- Cloned to `~/.lunr/agent/git/<host>/<path>` (global) or `.lunr/git/<host>/<path>` (project).
- When the checkout changes, lunR resets and cleans the clone, then runs `npm install` if `package.json` exists.

**SSH examples:**
```bash
# git@host:path shorthand (requires git: prefix)
lunr install git:git@github.com:user/repo

# ssh:// protocol format
lunr install ssh://git@github.com/user/repo

# With version ref
lunr install git:git@github.com:user/repo@v1.0.0
```

### Local Paths

```
/absolute/path/to/package
./relative/path/to/package
```

Local paths point to files or directories on disk and are added to settings without copying. Relative paths are resolved against the settings file they appear in. If the path is a file, it loads as a single extension. If it is a directory, lunR loads resources using package rules.

## Creating a Package

Add a `pi` manifest to `package.json` or use conventional directories. Include the `pi-package` keyword for discoverability.

```json
{
  "name": "my-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Paths are relative to the package root. Arrays support glob patterns and `!exclusions`.

### Gallery Metadata

The [package gallery](https://pi.dev/packages) displays packages tagged with `pi-package`. Add `video` or `image` fields to show a preview:

```json
{
  "name": "my-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "video": "https://example.com/demo.mp4",
    "image": "https://example.com/screenshot.png"
  }
}
```

- **video**: MP4 only. On desktop, autoplays on hover. Clicking opens a fullscreen player.
- **image**: PNG, JPEG, GIF, or WebP. Displayed as a static preview.

If both are set, video takes precedence.

## Package Structure

### Convention Directories

If no `pi` manifest is present, pi auto-discovers resources from these directories:

- `extensions/` loads `.ts` and `.js` files
- `skills/` recursively finds `SKILL.md` folders and loads top-level `.md` files as skills
- `prompts/` loads `.md` files
- `themes/` loads `.json` files

## Dependencies

Third party runtime dependencies belong in `dependencies` in `package.json`. Dependencies that do not register extensions, skills, prompt templates, or themes also belong in `dependencies`. When lunr installs a package from npm or git, it runs `npm install`, so those dependencies are installed automatically.

lunR bundles core packages for extensions and skills. If you import any of these, list them in `peerDependencies` with a `"*"` range and do not bundle them: `@ashx-j/lunr-ai`, `@ashx-j/lunr-agent`, `@ashx-j/lunr`, `@ashx-j/lunr-tui`, `typebox`.

Other packages must be bundled in your tarball. Add them to `dependencies` and `bundledDependencies`, then reference their resources through `node_modules/` paths. lunR loads packages with separate module roots, so separate installs do not collide or share modules.

Example:

```json
{
  "dependencies": {
    "shitty-extensions": "^1.0.1"
  },
  "bundledDependencies": ["shitty-extensions"],
  "pi": {
    "extensions": ["extensions", "node_modules/shitty-extensions/extensions"],
    "skills": ["skills", "node_modules/shitty-extensions/skills"]
  }
}
```

## Package Filtering

Filter what a package loads using the object form in settings:

```json
{
  "packages": [
    "npm:simple-pkg",
    {
      "source": "npm:my-package",
      "extensions": ["extensions/*.ts", "!extensions/legacy.ts"],
      "skills": [],
      "prompts": ["prompts/review.md"],
      "themes": ["+themes/legacy.json"]
    }
  ]
}
```

`+path` and `-path` are exact paths relative to the package root.

- Omit a key to load all of that type.
- Use `[]` to load none of that type.
- `!pattern` excludes matches.
- `+path` force-includes an exact path.
- `-path` force-excludes an exact path.
- Filters layer on top of the manifest. They narrow down what is already allowed.

## Enable and Disable Resources

Use `lunr config` to enable or disable extensions, skills, prompt templates, and themes from installed packages and local directories. `lunr config` starts in global settings (`~/.lunr/agent/settings.json`); press Tab to switch between global and project-local modes. Use `lunr config -l` to start in project overrides (`.lunr/settings.json`) with inherited global resources dimmed.

## Scope and Deduplication

Packages can appear in both global and project settings. If the same package appears in both, the project entry wins unless the project entry has `autoload: false`, in which case it is applied as a delta over the global entry. Identity is determined by:

- npm: package name
- git: repository URL without ref
- local: resolved absolute path
