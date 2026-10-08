# Plugin Hub in Harness Desktop

The DSCODE Desktop plugin includes **Settings → Plugin Hub**, backed by
[DSH Plugin Hub](https://dshpluginhub.ai). It uses the same public catalog as
the Hub website and CLI. No Hub login is required to browse.

## Find and inspect plugins

Enter a package name or describe a capability, optionally choose a category,
and select **Search**. **Load more plugins** continues the current search.
Open **View details** to read the description, repository, license, weekly
downloads, publisher indicators, reported security checks and declared
compatibility. The website link opens the corresponding Hub listing.

Publisher verification and a passing scan do not guarantee safety. Missing,
failed and incomplete scans remain visible. Compatibility declarations come
from the catalog; the official installer also checks the actual package.

In a DSCODE conversation, ask the agent to find a plugin. The read-only
`plugin_hub_search` and `plugin_hub_info` tools use the same catalog and Desktop
compatibility checks. These tools do not install plugins, change the Profile
or expose account credentials. Catalog descriptions are third-party data.
The native Standard preset does not receive these tools.

## Install and enable

1. Open the package details and choose **Review installation**.
2. Review the exact npm package, version and registry returned by the official
   plugin manager, alongside the Hub's scan and compatibility information.
3. Choose **Confirm installation**. The official manager downloads the package
   and dependencies. **Cancel installation** requests cancellation through that
   manager; the displayed outcome determines whether it completed in time.
4. Select **Manage installed plugin**, then enable and configure it in the
   official **Settings → Plugins** page.

Installation leaves the plugin disabled. Enabling third-party plugins runs
their code in the Host. Build-script approvals, enable/disable, configuration
and removal remain with the official plugin manager. When it reports a failure,
cancellation, override or restart requirement, the Hub preserves that outcome.
It does not report every completed package command as successful activation.

An installation preview expires after five minutes. Reopen the preview if it
expires. Closing and reopening the Hub page recovers the latest operation while
the same Host remains running. After a Host restart, check **Plugins** before
retrying; the Hub's operation history is not persisted.

## Current boundaries

- The first integration installs the catalog's latest exact npm version. It
  checks DSH and Node ranges, platform, interface support, withdrawal and
  deprecation. Git/tarball-only entries remain discoverable but are not installed
  through this integration.
- Already available bundles link to official management. This page does not
  replace them, select older versions, check for updates or roll back a Profile.
- Searches cover the community catalog, including packages for other Harness
  interfaces. Details explain when a package does not fit this Desktop.
- The DSCODE terminal package and Desktop package are separate entries. A
  terminal-only package is not made Desktop-compatible by appearing in search.
- Search queries and package lookups go to `api.dshpluginhub.ai`. Provider keys,
  conversation text, workspace files and local credentials are not sent by this
  catalog client. The agent may include task terms in a query you ask it to make.
- The Desktop plugin is published as `@toddzheng024/dscode-desktop@0.7.34`
  on npm, with the `preview` tag. Official Add plugin installation, Hub installation with
  handoff to official management, and migration from the legacy probe name
  have passed on macOS Desktop 0.2.0-rc.2.

See [Desktop installation](browser-use.md#install-the-experimental-combined-desktop-package)
and [distribution](hub-distribution.md) for package setup and release status.
