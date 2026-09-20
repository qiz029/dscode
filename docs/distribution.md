# Distribution and one-command start

The npm + Hub release path is covered in [Hub distribution](hub-distribution.md). The tar installation below is retained.

The deliverable is an installable `dscode-0.7.8.tar.gz`, not just a configured `.dshprofile`. After installing, the user runs `dscode` directly. The npm + Hub installation is available and the tar packages ship through GitHub Releases; there is no Homebrew formula yet.

## Publisher

```sh
npm run dist
```

It produces three tarballs, all attached to the GitHub release:

| File | Contents | Needed to install |
|---|---|---|
| `dscode-<version>-darwin-arm64.tar.gz`, `dscode-<version>-darwin-x64.tar.gz` | Prebuilt package: the source tree + the locked `node_modules` installed for that platform + a `.dscode-prebuilt` marker (about 70 MB) | Node, Git; **no npm and no npm registry access** |
| `dscode-<version>.tar.gz` | Source package: launcher, preset, dependency manifest and the complete lockfile, without node_modules (about 1 MB) | Node, npm, Git; downloads the locked dependencies from npm at install time |

None of them contains model keys, local override configuration, sessions or research files. The prebuilt package is produced in a staging directory with `npm ci --ignore-scripts --os=darwin --cpu=<arch>` — the same command the installer runs itself, and the native modules are all precompiled optional dependencies selected by `os`/`cpu`, so one runner can build both architectures. `DSCODE_PREBUILT_ARCHS=arm64` builds one architecture only, and an empty string builds the source package alone.

## User

macOS 14+, Node 22.19+ (22.x) or 24+, Git (for `apply_patch`) and Google Chrome are required. npm is needed only when installing from the source package.

The same script can fetch the package by itself: run from a pipe it enters remote mode, resolves the latest release, verifies the publisher's sha256 digest, unpacks, and then hands over to the `install.sh` inside the package, so the downloaded version and the install script's understanding of the layout cannot diverge. It prefers the prebuilt package for the current platform, and the whole installation only reaches GitHub — a corporate npm registry proxy blocking installs does not affect it; when a release has no prebuilt package for the platform it falls back to the source package with a notice, and `DSCODE_INSTALL_SOURCE=1` asks for the source package explicitly. When the packaged `install.sh` sees `.dscode-prebuilt` and `node_modules` it skips `npm ci` and provisions directly with `node scripts/harness.mjs setup`; a marker for a different platform refuses the installation.

```sh
curl -fsSL https://raw.githubusercontent.com/qiz029/dscode/main/install.sh | sh
# pin a version
curl -fsSL https://raw.githubusercontent.com/qiz029/dscode/main/install.sh | sh -s -- 0.7.8
```

Or unpack the same tarball by hand:

```sh
mkdir dscode-install
tar -xzf dscode-0.7.8-darwin-arm64.tar.gz -C dscode-install
sh dscode-install/install.sh
cd /path/to/project
dscode
```

The default installation goes to `~/.local/share/dscode` with the command linked as `~/.local/bin/dscode`. If that bin directory is not on PATH, add `export PATH="$HOME/.local/bin:$PATH"` to the shell configuration and reopen the terminal.

Enter `/model` once to configure a provider and a model. macOS Computer Use still needs the user to grant Accessibility/Screen Recording permission; those permissions and credentials cannot be distributed with the package.

`dscode --continue`, `dscode --resume SESSION_ID` and `dscode --cwd /path/to/project` are supported. By default it operates on the current terminal directory; state is kept in the installation's `.runtime`. A custom location can be set at install time with the absolute `DSCODE_INSTALL_DIR` and `DSCODE_BIN_DIR`.

The installer never overwrites an existing installation or command. Since the version with a self-contained `dscode update`, a tar installation supports self-upgrade: `dscode update [exact version]` downloads the tarball from GitHub Releases, verifies it against the publisher's sha256 digest, migrates `.runtime`, `.env` and the local config, and swaps the directory in place (the `dscode` command path does not change and needs no relinking), keeping the old installation as a sibling backup directory to switch back to or discard by hand. An update requires no running session; when the release has a prebuilt package for the current platform it takes that, so the upgrade needs no npm either, otherwise it takes the source package and downloads the locked dependencies with npm ci. A tar installation older than that has no updater: unpack the new tarball into a new directory and migrate the state by hand once.

## Why not plain npm install -g today

An npm `overrides` entry in the dependencies does not become the resolution rule of a root project when the package is installed as a third-party dependency. This composition needs a single pinned DSH rc line, so it keeps the verified locked dependency graph by using the root manifest inside the install package and `npm ci`. `package.json` already declares the `dscode` bin, but a bare bin declaration is not evidence of npm global-install compatibility.

A one-line `curl | sh` installation is available, reusing the GitHub Releases tarball and the publisher's sha256 digest, and preferring the npm-free prebuilt package; a release without a digest is refused rather than installed unverified. A Homebrew formula remains a possible follow-up and needs the official download address and the version release channel settled first.

The complete tarball contains `presets/dscode`, `bin/apply_patch` and the version-locked runtime patch scripts. setup enables dscode by default and installs Ultra effort support; the node_modules inside a prebuilt package comes from a fresh install of the lockfile in a staging directory, so the local node_modules is never packed. An old session keeps resuming under its original preset; use `dscode --mode dscode` to create a new session explicitly.
