#!/bin/sh
# One installer, two entry points. Run from an unpacked release tarball or a checkout
# (`sh install.sh`) it installs that tree. Piped from curl
# (`curl -fsSL https://raw.githubusercontent.com/qiz029/dscode/main/install.sh | sh`)
# it resolves a GitHub release, verifies the sha256 digest that release publishes,
# unpacks it and hands over to the installer the archive itself carries, so the
# downloaded archive and this script can never disagree about the install layout.
set -eu

REPOSITORY=${DSCODE_REPOSITORY:-qiz029/dscode}
RELEASES_API=${DSCODE_RELEASES_API:-https://api.github.com/repos/$REPOSITORY/releases}
install_dir=${DSCODE_INSTALL_DIR:-"$HOME/.local/share/dscode"}
bin_dir=${DSCODE_BIN_DIR:-"$HOME/.local/bin"}
case "$install_dir" in /*) ;; *) echo 'DSCODE_INSTALL_DIR must be absolute' >&2; exit 1 ;; esac
case "$bin_dir" in /*) ;; *) echo 'DSCODE_BIN_DIR must be absolute' >&2; exit 1 ;; esac

need() {
  command -v "$1" >/dev/null 2>&1 || { printf 'DSCODE needs %s on PATH; install it and run this again.\n' "$1" >&2; exit 1; }
}
need node
need npm
need git
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (!(major >= 24 || (major === 22 && minor >= 19))) { console.error("Node 22.19+ (22.x), or Node 24+ required"); process.exit(1); }'
if [ -e "$install_dir" ] || [ -L "$install_dir" ]; then
  echo "Install directory already exists: $install_dir. Use a new DSCODE_INSTALL_DIR for another installation." >&2
  exit 1
fi
if [ -e "$bin_dir/dscode" ] || [ -L "$bin_dir/dscode" ]; then
  echo "Command already exists: $bin_dir/dscode. It has not been replaced." >&2
  exit 1
fi

install_from() {
  source_dir=$1
  mkdir -p "$install_dir" "$bin_dir"
  for entry in package.json package-lock.json .npmrc .env.example bin scripts packages plugins tests presets config README.md docs install.sh; do
    cp -R "$source_dir/$entry" "$install_dir/"
  done
  cd "$install_dir"
  npm ci --ignore-scripts --no-audit
  npm run setup
  chmod +x bin/dscode.mjs
  ln -s "$install_dir/bin/dscode.mjs" "$bin_dir/dscode"
  printf '\nInstalled: %s/dscode\n' "$bin_dir"
  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) printf 'Add this directory to your shell PATH: %s\n' "$bin_dir" ;;
  esac
  printf 'Run dscode from your project directory, then configure a model with /model.\n'
}

# Resolve, download and verify the release in Node, then extract with tar: the lookup
# needs JSON parsing and sha256, and the piped script has no dependencies of its own to
# borrow from. Nothing enters the install locations before the digest matches the one
# GitHub publishes for that asset.
bootstrap_release() {
  wanted=$1
  need curl
  need tar
  work=$(mktemp -d "${TMPDIR:-/tmp}/dscode-install.XXXXXX")
  trap 'rm -rf "$work"' EXIT
  version=$(DSCODE_RELEASES_API="$RELEASES_API" DSCODE_WANTED="$wanted" DSCODE_WORK="$work" node --input-type=module -e '
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const api = process.env.DSCODE_RELEASES_API;
const wanted = process.env.DSCODE_WANTED;
const work = process.env.DSCODE_WORK;
const fail = message => { console.error("DSCODE install: " + message); process.exit(1); };
const exact = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[\w.-]+)?$/;
if (wanted !== "latest" && !exact.test(wanted)) fail("Usage: sh -s -- <exact-version>, or no argument to install the latest release.");
const headers = { accept: "application/vnd.github+json", "user-agent": "dscode-install" };
const listing = await fetch(wanted === "latest" ? api + "/latest" : api + "/tags/v" + wanted, { headers });
if (!listing.ok) fail("GitHub has no release for " + (wanted === "latest" ? "the latest tag" : "v" + wanted) + " (HTTP " + listing.status + ").");
const body = await listing.json();
const version = String(body.tag_name ?? "").replace(/^v/, "");
if (body.draft || body.prerelease || !exact.test(version)) fail("the release on GitHub is not a published DSCODE release.");
if (wanted !== "latest" && version !== wanted) fail("GitHub published " + version + " for the requested tag; refusing to install another version.");
const name = "dscode-" + version + ".tar.gz";
const asset = (Array.isArray(body.assets) ? body.assets : []).find(candidate => candidate?.name === name);
if (!asset?.browser_download_url) fail("release " + version + " carries no " + name + ".");
const digest = typeof asset.digest === "string" && asset.digest.startsWith("sha256:") ? asset.digest.slice("sha256:".length) : "";
if (!digest) fail("release " + version + " publishes no sha256 digest; refusing an unverified download.");
console.error("Downloading DSCODE " + version + " (" + asset.browser_download_url + ")");
const download = await fetch(asset.browser_download_url, { headers: { "user-agent": "dscode-install" } });
if (!download.ok) fail("downloading " + name + " failed (HTTP " + download.status + ").");
const bytes = Buffer.from(await download.arrayBuffer());
if (createHash("sha256").update(bytes).digest("hex") !== digest) fail("the downloaded tarball does not match the release digest; nothing was installed.");
writeFileSync(join(work, name), bytes, { mode: 0o600 });
console.log(version);
')
  # The version lands in a filename below, so refuse anything that is not plainly one.
  case "$version" in
    ''|*[!A-Za-z0-9._-]*) echo 'DSCODE install: the release reported no usable version.' >&2; exit 1 ;;
  esac
  mkdir -p "$work/unpack"
  tar -xzf "$work/dscode-$version.tar.gz" -C "$work/unpack"
  if [ ! -f "$work/unpack/install.sh" ]; then
    echo 'DSCODE install: the release tarball has an unexpected layout.' >&2
    exit 1
  fi
  printf 'Installing DSCODE %s...\n' "$version"
  DSCODE_INSTALL_DIR=$install_dir DSCODE_BIN_DIR=$bin_dir sh "$work/unpack/install.sh"
}

# `$0` names this file only when it came from disk; piped from curl it is just "sh", so a
# run inside an unrelated directory is never mistaken for a source tree.
local_tree=''
if [ -f "$0" ]; then
  case "$0" in
    *install.sh) local_tree=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) ;;
  esac
fi
if [ ! -f "$local_tree/scripts/harness.mjs" ] || [ ! -f "$local_tree/package.json" ]; then
  local_tree=''
fi

if [ -n "$local_tree" ]; then
  # A version argument only means something for the piped form; quietly installing the
  # tree under a version the user asked for would report the wrong thing as installed.
  if [ -n "${1:-}" ]; then
    echo "DSCODE install: this script installs the tree it came from; run it without a version, or pipe it from curl to choose a release." >&2
    exit 1
  fi
  install_from "$local_tree"
else
  bootstrap_release "${1:-${DSCODE_VERSION:-latest}}"
fi
