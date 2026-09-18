# DSCODE release entry points.
#
# Every target mirrors a step of .github/workflows/release.yml, so the sequence can be
# rehearsed on this machine before a tag is pushed. The workflow is unchanged and remains the
# only path that publishes from CI; a local `make publish` uses the npm token in the Keychain
# (scripts/npm-token.mjs) and the Hub token exported in your shell.
#
#   make release    the build job: check, build the candidates, verify and pack them
#   make publish    the publish job: credentials, three publish phases, the release asset
#
# Publishing reads NPM_PUBLISH_TOKEN, DSH_HUB_TOKEN and, for the release asset, GH_TOKEN.

SHELL := /bin/sh
# Every phase consumes the artifacts of the one before it, so parallel prerequisites would
# reorder a release.
.NOTPARALLEL:
.DEFAULT_GOAL := help

VERSION := $(shell node -p "require('./package.json').version" 2>/dev/null)
REPOSITORY ?= https://github.com/qiz029/dscode
TAG ?= v$(VERSION)

.PHONY: help install check version-check build verify candidates unpack release credentials publish publish-bundle publish-profile publish-launcher attach

help:
	@echo 'DSCODE release targets (VERSION=$(VERSION)):'
	@echo '  make release            version-check, check, build, verify, candidates'
	@echo '  make publish            credentials, bundle, profile, launcher, attach'
	@echo '  make install            npm ci --ignore-scripts'
	@echo '  make check              npm run check (lint, coverage, integration, package, eval)'
	@echo '  make version-check      TAG must match the manifest version (TAG defaults to v$(VERSION))'
	@echo '  make build              build:packages, release:hub, dist'
	@echo '  make verify             verify:hub against the candidates in artifacts/'
	@echo '  make candidates         pack release-candidates.tar.gz for a publish job'
	@echo '  make unpack             restore release-candidates.tar.gz into artifacts/'
	@echo '  make credentials        read-only npm and Hub credential check'
	@echo '  make publish-bundle     publish the bundle to npm'
	@echo '  make publish-profile    sync the Hub to npm, then publish the dscode profile'
	@echo '  make publish-launcher   publish the launcher to npm'
	@echo '  make attach             attach artifacts/dscode-$(VERSION).tar.gz to the GitHub release'

# The workflow installs with --ignore-scripts: the exact dependency set the release is
# verified against.
install:
	npm ci --ignore-scripts

check:
	npm run check

# A tag push publishes, so the tag has to name the version the manifest carries. Pass
# TAG=v0.7.15 to check another tag.
version-check:
	@version=$$(node -p "require('./package.json').version"); test "$(TAG)" = "v$$version" || { echo "tag $(TAG) does not match version $$version" >&2; exit 1; }; echo "tag $(TAG) matches version $$version"

# The workflow exports this for the whole build step, so a fork names itself in everything
# the step generates instead of publishing the upstream URL.
build:
	DSCODE_REPOSITORY="$(REPOSITORY)" npm run build:packages
	DSCODE_REPOSITORY="$(REPOSITORY)" npm run release:hub
	DSCODE_REPOSITORY="$(REPOSITORY)" npm run dist

verify:
	npm run verify:hub

# One tarball keeps the exact layout the publish job restores, artifacts/ prefix included.
candidates:
	tar -czf release-candidates.tar.gz artifacts/npm artifacts/local/hub-verification.json artifacts/dscode-$(VERSION).tar.gz

# The publish job restores the candidates it downloaded and refuses an incomplete archive;
# locally this is also how a candidate tarball from another machine enters the tree.
unpack:
	@test -f release-candidates.tar.gz || { echo "release-candidates.tar.gz is missing; run make candidates" >&2; exit 1; }
	tar -xzf release-candidates.tar.gz
	@test -f artifacts/npm/bundle-pack.json || { echo "the release candidate archive is incomplete" >&2; exit 1; }
	@test -f artifacts/local/hub-verification.json || { echo "the hub verification record is missing" >&2; exit 1; }

release: version-check check build verify candidates

# Read-only: the npm token authenticates as the publishing user — NPM_PUBLISH_TOKEN, or the
# Keychain token scripts/npm-token.mjs stores for a login-free local release — the Hub token
# can read the dscode profile, and this version is still free on npm, so a forgotten version
# bump stops here. It reads the verification record, so run make release (or make unpack) first.
credentials:
	@test -n "$$DSH_HUB_TOKEN" || { echo "DSH_HUB_TOKEN is not set; see docs/hub-distribution.md" >&2; exit 1; }
	node scripts/check-publish-credentials.mjs

# Each phase re-checks the hashes verify:hub recorded: the launcher is never published before
# its bundle and its public Hub release resolve.
publish-bundle:
	npm run publish:hub -- bundle

publish-profile:
	npm run publish:hub -- profile

publish-launcher:
	npm run publish:hub -- launcher

# The tag always comes from the manifest version — the build job refuses a tag that does not
# name it — and the curl installer and the README fetch this asset.
attach:
	@test -f "artifacts/dscode-$(VERSION).tar.gz" || { echo "artifacts/dscode-$(VERSION).tar.gz is missing; run make build" >&2; exit 1; }
	@version=$(VERSION); if gh release view "v$$version" >/dev/null 2>&1; then gh release upload "v$$version" "artifacts/dscode-$$version.tar.gz" --clobber; else test -f "docs/releases/$$version.md" || { echo "docs/releases/$$version.md is missing; write the release notes first" >&2; exit 1; }; gh release create "v$$version" "artifacts/dscode-$$version.tar.gz" --title "DSCODE $$version" --notes-file "docs/releases/$$version.md"; fi

publish: credentials publish-bundle publish-profile publish-launcher attach
