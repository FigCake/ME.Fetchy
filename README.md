# Fetchy

An extension installer for [Marinara Engine](https://github.com/Pasta-Devs/Marinara-Engine): install and update External Extensions from a GitHub URL instead of downloading and importing zips by hand. 한국어: [README-ko.md](README-ko.md)

## Features

* **Install from URL** — A GitHub repository (`owner/repo`, a `/tree/<branch>/<folder>` URL or `owner/repo/<folder>@<branch>`), a raw `manifest.json` URL, or a `.zip` URL. Without a branch, `main` is tried, then `master`
* **Preview before anything is sent** — Name, version, description, runtime, capabilities (a loud warning for `full_page_access`), file sizes, the README, the downloaded code itself, and the exact content hash Marinara will show in Review and Run
* **Changes** — When the extension already exists in Marinara: its current version and state, per-file size before → after, lines added and removed, and a warning when its code was edited in Marinara since the last install
* **Install, update or link** — Creates the record through Marinara's own API, updates an existing one, or links an extension installed by hand without changing its code. Marinara keeps every install disabled until you approve its hash
* **FigCake extensions** — **🍰 Bundle install** in the panel's header opens them: tick Dispensa, Fornello and Polyglot and install them together, one after another, from their GitHub repositories; each goes in switched off like a single install (an installed one is updated, one with the same code only linked), and you approve each in Marinara (with “Keep updated extensions on”, an update of one that was on switches it back on at once). The cake turns coloured when one of them has an update
* **Manage extensions** — Every External Extension in Marinara in one list: on / off / needs approval, capability badges, view code, switch off and back on, delete, roll back to a kept revision. Extensions installed through Fetchy get update checks (one or all) and updates; hand-installed ones can be linked to their GitHub address. Your own folders and tags (Options → Folders and tags; set on each one under More), a tag filter above the list. Every extension is checked for updates when the panel opens, except those checked in the last 30 minutes (can be switched off; **Check all** checks all now; a check only reads public GitHub files and costs nothing)
* **Update all** — Applies every update the last check found. With “Keep updated extensions on” (one acknowledgement), every update made here, single or bulk, approves extensions that were on and switches them back on at once; versions asking for new capabilities are left off
* **Automatic updates (per extension, off by default)** — Switched on under an extension's More, Fetchy installs its updates by itself: when Marinara opens (at most every 6 hours) and after the check on open. Marinara keeps the new code switched off until you approve it, unless auto re-approval or “Keep updated extensions on” is set. One whose code was changed in Marinara since Fetchy installed it is skipped, and Fetchy says so; update it by hand to replace that code. Not offered for Fetchy itself
* **Revisions** — Restore any revision Marinara keeps; the restored code needs approval again
* **Export / Import** — The source list as JSON, to move between browsers or Marinara instances. Import adds only extensions not yet in the list, with automatic updates and auto re-approval off; listed ones keep their address and switches
* **Errors that say what to do** — Both External Extension gates, Admin Access, untrusted host, CSRF, CORS, GitHub API rate limit, a source that changed during download
* **Change log** — Installs, updates, links, rollbacks and removals with versions, hashes and capabilities. Updates that finished while the panel was closed are completed on the next open
* **Auto re-approval after updates (per extension, off by default)** — When on, Fetchy approves the new code after an update and switches the extension back on. Turning it on requires the same two acknowledgements as Marinara's approval dialog; it applies only to an extension that was on before the update and only when the new version asks for no new capability. **With this on, code the repository owner publishes runs without your review.** Use it only for authors you trust
* **Authority warnings** — A loud warning when an update asks for new capabilities, or changes code without changing its version
* **Switch back on** — Under More, an extension that is off goes back on only when its code is exactly the code you approved (the same hash); one with full page access first asks for the acknowledgement Marinara's dialog asks for. Changed code needs a new approval in Marinara
* **Update notice** — A little after Marinara opens (at most every 6 hours), Fetchy reads each source's `manifest.json` only and shows a small notice when a newer version is out, once per version; a dot on the settings button while an update waits; a new Fetchy shows at the top of the panel with "Add as a source to update". Can be switched off
* **What changed** — An extension with an update lists its folder's commits since the one it was installed from (the 20 newest, read only when you open it)
* **Repository marks** — "archived" or "not updated for 6 months" beside an installed extension's name (GitHub is asked once a week per repository)
* **Select** — Tick several rows to hide them (a fold at the end still says when one has an update), give them a tag, or check them for conflicts
* **Conflict check** — Reads the code of extensions with full page access as text (never runs it) for the names they take on the page: globals, custom elements, element ids, storage keys, Dispensa commands, shortcuts, `!important` styles. In an install preview against those installed, or among the ones you tick. Conflicts in red, notes in grey, each with its line; installing is never blocked
* **Stored data** — Each extension's data size against Marinara's 1 MB limit, with its biggest keys. Back it up to a file, restore it (the current data is saved to a file first), or clear it (after a backup file and the name typed again). The browser's own storage for the site, to look at only
* **Switched-on sets** — Save which extensions are on under a name, and switch to that set later
* **Find a problem extension** — Switches half of them off, asks after a reload whether the problem is still there, and halves again until one is left. It goes on across reloads; automatic updates wait; put everything back at any time
* **Full backup** — The source list, your folders and tags, and the picked extensions' stored data in one file, to move to another browser or Marinara
* **Copy diagnostics** — A text for a bug report: Marinara's and Fetchy's versions, the gates, the browser, each extension's state, source and last check, the last conflict check and the change log. Never code, stored data or the admin secret
* **First-time setup** — The first time the panel opens with nothing installed through Fetchy: what Marinara allows, FigCake's extensions to pick, the options, installing, and how to approve each
* **Other recommended lists** — In the bundle window, add someone's list by its address; each entry still installs alone through its preview
* **Korean and English UI**, light and dark theme, a bottom sheet on narrow screens

## Setup

1. In the server `.env`, set `ENABLE_EXTERNAL_EXTENSIONS=true` and restart Marinara
2. Settings → Addons → External Extensions: turn on **Allow third-party extension imports**, then import `ME-Fetchy-<version>.zip`
3. Open **Fetchy** in the list → **Review and Run**: read the code and approve the hash (it must equal the one in `SHA256SUMS.txt`)
4. An **Install from GitHub (Fetchy)** button appears next to the import buttons on that same screen (Settings → Addons → External Extensions). Shortcut: Alt+Shift+F. Explanations sit behind the small (?) marks

On a remote (non-localhost) Marinara, set `ADMIN_SECRET` in the server `.env` and enter it under Settings → Admin Access. To update Fetchy itself, add `FigCake/ME.Fetchy` as a source (the panel offers it when a new version is out).

## Is it safe

Fetchy is only a helper. It downloads the code and puts it into Marinara **switched off**; it never runs it. Turning it on is your act (except for extensions where you switched auto re-approval on): open Settings → Addons → External Extensions, read the code and approve it with **Review and Run**. If the hash Fetchy showed you matches the one on that screen, the code arrived unchanged.

Updates work the same way. New code switches the extension off again until you approve it, so changed code never runs behind your back.

Switching an extension back on (under More, by a switched-on set, or while finding a problem extension) approves nothing new: Fetchy does it only when Marinara still holds your approval of exactly that code (the same hash), and checks again right before. Code that changed needs your approval in Marinara. Fetchy itself is never switched off.

The conflict check reads code as text and runs none of it. An extension's stored data leaves Marinara only into a file you ask for (a backup); the diagnostics text and the change log never hold it, nor code or the admin secret.

No login or token is used to read GitHub. Public repositories only. An install or update reads every file from one commit, so a push during the download can't mix two versions.

## Making your extension installable with Fetchy

Your repository needs just two files:

```
manifest.json      ← the Marinara External Extension manifest (the same one a zip import uses)
extension.js       ← the file manifest.json's jsPath points to
```

Put them at the top of the repository and users type `owner/repo`. They can also live in a folder; users then type `owner/repo/folder`.

* Raise `version` in `manifest.json` for every release. That is how Fetchy notices an update.
* Always write `capabilities`, even empty (`[]`); without it Marinara treats the package as a legacy extension.
* Zips uploaded to GitHub Releases cannot be downloaded by a browser. To ship a zip, commit it as a repository file and share that file's address.

## Requirements

* Marinara Engine 2.5.0 or newer, with External Extensions enabled
* A browser with `DecompressionStream` (Chrome, Edge, Firefox, Safari 16.4+) for zip sources

License: MIT.
