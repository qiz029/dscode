# DSCODE and Plugin Hub

DSCODE and [DSH Plugin Hub](https://dshpluginhub.ai) are separate products.
Installing DSCODE should not also install a Hub browsing interface.

## Current checkout: removal is unreleased

The Desktop build no longer includes the Hub settings page, Host endpoint,
`plugin_hub_search` or `plugin_hub_info` tools, Hub source files or Hub-specific
runtime dependencies. DSCODE sessions do not require the community catalog to
start or use coding and browser features.

The package retains its catalog listing metadata so people can discover DSCODE
through Hub. Release-time catalog synchronization and the terminal launcher's
existing Hub distribution mechanism remain in place. Neither adds the Desktop
Hub interface to a user's DSCODE installation.

Hub discovery is available on the separate website. This change does not publish
a standalone Hub Desktop plugin or move Hub into the official Plugins page.

## Published versions 0.7.33 and 0.7.34

These releases still contain **Settings → Plugin Hub**, catalog search and
categories, package details, and the two read-only discovery tools in DSCODE
sessions. Their installation handoff delegates to the official plugin manager;
enabling, configuration and removal stay in **Settings → Plugins**.

Installing or reinstalling 0.7.34 will therefore not remove the bundled Hub.
Wait for a later release containing the removal, or test a local build in a
disposable profile using the [Desktop installation guide](browser-use.md#install-the-experimental-combined-desktop-package).
Fully quit and reopen Desktop after updating; an already running Host may keep
the old plugin modules loaded.

Historical Hub installation and UI verification applies to those earlier
versions. It does not establish availability of a separate Hub Desktop package.
See [distribution](hub-distribution.md) for release gates.
