#!/bin/sh
set -eu

source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
install_dir=${DSCODE_INSTALL_DIR:-"$HOME/.local/share/dscode"}
bin_dir=${DSCODE_BIN_DIR:-"$HOME/.local/bin"}
case "$install_dir" in /*) ;; *) echo 'DSCODE_INSTALL_DIR must be absolute' >&2; exit 1 ;; esac
case "$bin_dir" in /*) ;; *) echo 'DSCODE_BIN_DIR must be absolute' >&2; exit 1 ;; esac

command -v node >/dev/null
command -v npm >/dev/null
command -v git >/dev/null
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (!(major >= 24 || (major === 22 && minor >= 19))) { console.error("Node 22.19+ (22.x), or Node 24+ required"); process.exit(1); }'
if [ -e "$install_dir" ] || [ -L "$install_dir" ]; then
  echo "Install directory already exists: $install_dir. Use a new DSCODE_INSTALL_DIR for another installation." >&2
  exit 1
fi
if [ -e "$bin_dir/dscode" ] || [ -L "$bin_dir/dscode" ]; then
  echo "Command already exists: $bin_dir/dscode. It has not been replaced." >&2
  exit 1
fi
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
