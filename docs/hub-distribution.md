# npm + Hub distribution

## Packages and responsibilities

- `@toddzheng024/dscode`: the global `dscode` command; the first launch applies the Hub's `dscode` profile and later runs the installed version directly. It ships its own install-tool shims on `PATH`: `pnpm` is pinned to 10.15.1 for the profile install, and the `npx` shim pins DSH together with pnpm for a Hub release that still spawns a pinned-DSH `npx` command. Hub CLI 0.5.0 prepares and verifies the pinned DSH runtime itself — an exact-version `npm install` into `$DSCODE_HOME/.hub/runtimes/<version>`, then launch with the current Node — so a rewritten `PATH` cannot pick up a system version by mistake.
- `@toddzheng024/dscode-bundle`: the complete Cordis composition, including the base layer, Computer Use, the modified TUI/runtime modules and this repository's plugins. Modified modules are generated at build time, and no third-party file is changed at install time.
- Hub profile `dscode`: the exact versions and integrity hashes of the bundle and the DSH runtime.

The complete bundle pins the shared DSH dependencies explicitly. Do not stack it with another base/TUI bundle in one profile: installing several root bundles in Hub order resolves a wide transitive dependency to the other rc line first. A standalone profile's pnpm hoisted + autoInstallPeers=false is the verified installation path. A direct `npm install` of the bundle hits Computer Use's old peer range; end users install through the launcher.

## User

```sh
npm install -g @toddzheng024/dscode
dscode
```

The first install fetches the code from Hub/npm over the network. It needs macOS 14+, Node 22.19+ (22.x) or 24+, Git and Chrome. Dependencies install with ignore-scripts, matching the verified precompiled-module path, so no third-party install script runs automatically. A normal agent shell does not force this npm option.

DeepSeek and OpenRouter keys are stored locally through `/login` (`/login openrouter`), and `/provider` switches between them; other model keys are configured in `/model`, or set `DEEPSEEK_API_KEY` / `OPENROUTER_API_KEY`. Accessibility/Screen Recording permission is granted by macOS.

```sh
dscode update 0.7.8
dscode history
dscode rollback
dscode doctor
```

`dscode update` first replaces the global launcher itself with npm at the target version, then moves the profile to the same version: an explicit version updates both to that exact version; with no version it asks npm for the latest launcher and updates both when there is a newer one, otherwise the profile only follows the current launcher's recommended version (the same fallback applies when npm is unreachable, so `latest` is never tracked implicitly). `npm install -g @toddzheng024/dscode@<version>` also works manually. One data directory can run several launchers/root sessions at once. Startup and version management serialise admission through a short-lived kernel lock, and each running Host holds its own version-protection lock; install/update/rollback has to wait for those Hosts to exit. When a launcher exits unexpectedly, the runtime or Hub child process inherits the lock descriptor so it does not lose protection while still running. A newer launcher notices an older one still alive and asks it to exit first. Session write exclusivity stays with the native Harness lock.

The default state directory is `~/.local/share/dscode-hub`, overridable with `DSCODE_HOME`; it is separate from the existing tar installation and this repository's `.runtime`. Sessions, credentials, review and cost records live in the data directory, not inside the npm package. Configuration lives in that directory's `.env` and `config/`, supporting `hooks.local.json`, `mcp.local.yml` and `harness.local.yml`. The profile lives in `profiles/dscode`. Hub manages upgrade and rollback directories; sessions do not roll back with the profile, but crossing a future incompatible session-format version still needs a migration.

A user who already has dsh-hub installed can apply directly, but must use pnpm 10.15.1, set a dedicated `DSH_HOME` and `DSH_AGENTS_HOME`, and set `npm_config_ignore_scripts=true` on the install command. The launcher is recommended because it unifies those conditions.

## Release checklist

Cutting a release from this repository, in order. The rule that matters most: **the git tag must equal `v<package.json version>`, and that version must not already be on npm from a different build.**

1. Decide the version and bump `package.json` `version`. Never re-tag a version that has already been published.
2. Ship the release documentation in the same commit: `docs/releases/<version>.md`, `docs/CHANGELOG.md` and both READMEs (see [AGENTS.md](../AGENTS.md)).
3. Commit, then tag and push:
   ```sh
   git tag v<version>
   git push origin main --tags
   ```
   The `build` job fails immediately when the tag and the manifest version disagree.
4. Watch the run:
   ```sh
   gh run list --workflow=release.yml --limit 3
   gh run view <run-id>                 # job and step status
   gh run view --job=<job-id> --log-failed
   ```
5. On a tag push the `publish` job runs: credential check → bundle → profile sync → launcher → attach the tarballs. **The launcher is published last on purpose**; a user's first launch fails when the launcher reaches npm before its bundle and its Hub profile. The order is enforced by the job, not by discipline.
6. Confirm the published result rather than the green check: the credential step prints `free to publish` (or `already on npm with the tested integrity` for a re-run), and the attach step either creates or updates the GitHub release the `dscode update` assets come from.

7. The Homebrew tap follows on its own: `qiz029/homebrew-tap` runs a scheduled (and manually dispatchable) workflow that reads `npm view @toddzheng024/dscode version`, recomputes the launcher tarball's sha256 and commits the formula change. It is deliberately not wired to this repository's tag push — the launcher is the last stage the publish job releases, so a formula bumped earlier would send a user to a Hub profile that is not there yet.

Before tagging, a dry run needs no publication: Actions → Release → Run workflow with both switches left `false` (build and verify only), or tick `verify_credentials` to check the tokens and whether the version is still free.

### Known failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `publish` fails in about 30 seconds at *Check the publishing credentials* with `... is already on npm with a different build; bump the version before pushing a release tag` | That version was already published from a different build. An identical `dist.integrity` is treated as a skippable re-run; anything else is a conflict. | Bump `package.json` and cut a new tag. Do not re-tag, and do not force-push the tag. |
| `publish` fails at `test -n "$NPM_PUBLISH_TOKEN"` / `$DSH_HUB_TOKEN` | The repository secret is missing or empty. | Add it under Settings → Secrets and variables → Actions; see the table below. |
| A credential that is present but dead: `npm credential OK` or `Hub credential OK` never prints and the step dies inside `npm whoami` or the profile read | The token expired or lost its scope. | Regenerate the granular npm token (Read and write for both `@toddzheng024` packages, bypass 2FA) and update the secret. |
| `build` fails in under a minute | A code or packaging problem, not credentials (0.7.14 failed this way on a missing bundle export). | Read that step's log, fix, and bump the version again if it was already published. |
| `make release`, `make verify` or `npm run doctor` fails inside a dscode session with `sandbox-exec: sandbox_apply: Operation not permitted` | The session's own sandbox refuses to apply a nested profile. | Run them from a normal terminal, or configure `plugins/tui-tools/sandbox-runner.mjs`; see [Verification](verification.md). |

A tag push is the only thing that publishes. A manual run only publishes when `publish` is ticked, so a mis-typed dispatch cannot ship a release.

## Publisher

```sh
# Write the real GitHub repository into the release metadata; never a fabricated URL.
DSCODE_REPOSITORY=https://github.com/OWNER/REPO npm run build:packages
npm run release:hub
npm test
npm run verify:hub
```

The same sequence is wrapped in Make targets: `make release` runs version-check, `npm run check`, `build:packages`, `release:hub`, `dist`, `verify:hub` in order and packs `release-candidates.tar.gz` (matching CI's build job); `make publish` runs the read-only credential check, then bundle, profile, launcher and release-asset upload (matching CI's publish job, requiring `NPM_PUBLISH_TOKEN`, `DSH_HUB_TOKEN` and, for attaching assets, `GH_TOKEN`). A single stage can be re-run with `make publish-bundle|publish-profile|publish-launcher`, and `make help` lists every target; the workflow itself does not call make.

Artifacts live in `artifacts/npm/`: two npm tgz files, the Hub draft/release JSON and the `.dshprofile`. A build copies only whitelisted files, never user configuration, credentials or sessions; a release carries the original MIT licence and the modification notice.

`verify:hub` installs a real launcher in a temporary directory, serves the not-yet-published bundle from a loopback npm registry, and uses the real dsh-cli and Hub lifecycle to verify the composition, the agent loop, replacement and rollback. It is not equivalent to public Hub discovery or a real npm publish. The tests request no remote model.

The publication order:

1. Validate the package metadata and the real public source repository with `dsh-hub validate artifacts/npm/bundle`.
2. Confirm `npm whoami` is `toddzheng024`, then publish the bundle tgz (`npm publish ... --access public`).
3. Register/claim `@toddzheng024/dscode-bundle` in the Hub publisher console and confirm the exact version resolves.
4. Save the generated profile draft, then publish the `dscode` release for the same version.
5. After verifying a public Hub apply/doctor under a fresh DSH_HOME, publish the launcher tgz.
6. Complete a first-launch verification in another clean directory using the launcher from public npm.

Never publish the launcher before the bundle/Hub release is available, or the user's first launch fails. A new version has to regenerate packages and the release; an old integrity hash cannot be reused. `build:packages` and `release:hub` produce the candidate artifacts; a release counts as done only after it is published and confirmed on the public registry. v0.1.0 has been distributed publicly through npm + Hub.

Hub calls retry in a bounded way (`scripts/hub-retry.mjs`): a 5xx or transport failure retries 5 times by default, 3 seconds apart, overridable with `DSCODE_HUB_RETRY_ATTEMPTS` / `DSCODE_HUB_RETRY_MS`; a 4xx (invalid token, missing package, immutable version) fails immediately. Exhausting the retries throws the last error, so a long Hub outage fails the release rather than continuing without verification.

The publish script runs per stage: `npm run publish:hub -- bundle`, `npm run publish:hub -- profile`, `npm run publish:hub -- launcher`. Each stage verifies the hashes of the tested artifacts; before publishing the launcher it checks the exact version and integrity of the public Hub release. The profile stage first calls the Hub's `sync` interface (available since dsh-hub CLI 0.3.0) so Hub pulls the bundle from npm immediately instead of waiting for the hourly sync; after the sync it still requires Hub to list that exact version. Claiming still needs the publisher console, and login uses `dsh-hub login`.

### Login-free publishing (local machine)

The account has auth-and-writes two-factor enabled, so `npm login`'s session token expires and every `npm publish` asks for a one-time code again. Use a **granular access token** instead, which the publish script picks up automatically:

1. Generate a granular token on npm's Access Tokens page: tick *Bypass two-factor authentication*, grant Read and write only to `@toddzheng024/dscode` and `@toddzheng024/dscode-bundle` under Packages and scopes, and pick an expiry that suits you (repeat this step when it expires). Granular tokens can currently only be created on the website.
2. `npm run publish:token store` and paste the token at the `security` password prompt. It goes into the login keychain (service `dscode-npm-publish`) and never into `~/.npmrc`, the command line or the shell history.
3. `npm run publish:token check` confirms the token authenticates as `toddzheng024`.

After that `npm run publish:hub -- bundle|launcher` takes the token from the keychain and hands it to npm through a one-off temporary `--userconfig`, so no login and no one-time code are needed. A temporary environment can override with `NPM_PUBLISH_TOKEN`; with neither present it falls back to the original interactive flow. `npm run publish:token remove` deletes the keychain token.

npm has announced that publishing directly with a bypass-2FA token is retired in January 2027; from then local publishing has to move to trusted publishing (OIDC) in CI.

### GitHub Actions

Two workflows:

- `.github/workflows/checks.yml`: runs `npm run check` on `macos-14` for every push/PR (a matrix of Node 22.19.0 and 24) and uploads the coverage artifacts; a newer push to the same ref cancels the previous run.
- `.github/workflows/release.yml`: on a `v*` tag push (or a manual `workflow_dispatch`) it runs the `build` job first — `npm run check` → `npm run build:packages` → `npm run release:hub` → `npm run verify:hub` — uploading `artifacts/npm` and `artifacts/local/hub-verification.json` as the `release-candidates` artifact. The `publish` job depends on it and is attached to the `release` environment (add required reviewers under repository Settings → Environments for manual approval).

Publish credentials live in repository Secrets (Settings → Secrets and variables → Actions):

| Secret | Purpose |
| --- | --- |
| `DSH_HUB_TOKEN` | Hub CI credential. `@dsh-plugin-hub/cli`'s `getAccessToken()` prefers it, so the pipeline runs no device login and does not depend on a 5-minute WorkOS access token. |
| `NPM_PUBLISH_TOKEN` | npm granular token (tick *Bypass two-factor authentication*, granting Read and write only to `@toddzheng024/dscode` and `@toddzheng024/dscode-bundle`). `npm run publish:hub` writes it into a one-off `--userconfig` that never touches disk or the shell history. |

Publishing runs in the three documented stages, each re-verifying the hashes checked above: `publish:hub -- bundle` → `publish:hub -- profile` (sync Hub from npm first, then require that exact version to resolve) → `publish:hub -- launcher`. **The launcher always follows the bundle and the public Hub release**, or the user's first launch fails. Claiming a new package in the Hub console is still manual; when the tag and the `package.json` version disagree the `build` job fails outright and nothing is published.

Manual dry run: Actions → Release → Run workflow with both switches left at `false`, which only builds and verifies the candidate artifacts without publishing.

Credential check only: Actions → Release → Run workflow with `verify_credentials` ticked. It runs the full `build` job, then enters the `publish` job and uses `node scripts/check-publish-credentials.mjs` to do a **read-only** check — whether the npm token authenticates as `toddzheng024`, whether the Hub token can read the `dscode` profile, and whether the current version number is still free on npm — then stops without publishing anything. The check fails when the version is already on npm, which is exactly what blocks "push a tag after forgetting to bump the version".

The Hub stage (`profile`) uses the WorkOS session written by `dsh-hub login` into `~/.dsh/.hub/auth.json`; the access token lasts 5 minutes and the script refreshes it automatically with the refresh token, so `dsh-hub login` is only needed again once the refresh token expires.
