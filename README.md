# Fetchy

An extension installer for [Marinara Engine](https://github.com/Pasta-Devs/Marinara-Engine): install and update External Extensions from a GitHub URL instead of downloading and importing zips by hand. 한국어: [README-ko.md](README-ko.md)

## Features

* **Install from URL** — A GitHub repository (`owner/repo`, a `/tree/<branch>/<folder>` URL or `owner/repo/<folder>@<branch>`), a raw `manifest.json` URL, or a `.zip` URL. Without a branch, `main` is tried, then `master`
* **Preview before anything is sent** — Name, version, description, runtime, capabilities (a loud warning for `full_page_access`), file sizes, the README, the downloaded code itself, and the exact content hash Marinara will show in Review and Run
* **Changes** — When the extension already exists in Marinara: its current version and state, per-file size before → after, lines added and removed, and a warning when its code was edited in Marinara since the last install
* **Install, update or link** — Creates the record through Marinara's own API, updates an existing one, or links an extension installed by hand without changing its code. Marinara keeps every install disabled until you approve its hash
* **Manage extensions** — Every External Extension in Marinara in one list: on / off / needs approval, capability badges, view code, switch off, delete, roll back to a kept revision. Extensions installed through Fetchy get update checks (one or all) and updates; hand-installed ones can be linked to their GitHub address. Optional check on open; nothing is ever installed automatically
* **Revisions** — Restore any revision Marinara keeps; the restored code needs approval again
* **Export / Import** — The source list as JSON, to move between browsers or Marinara instances. No code, no secrets
* **Errors that say what to do** — Both External Extension gates, Admin Access, untrusted host, CSRF, CORS, GitHub API rate limit, a source that changed during download
* **Change log** — Installs, updates, links, rollbacks and removals with versions, hashes and capabilities (last 200; never a secret). Updates that finished while the panel was closed are completed on the next open
* **Auto re-approval after updates (per extension, off by default)** — When on, Fetchy approves the new code after an update and switches the extension back on. Turning it on requires the same two acknowledgements as Marinara's approval dialog; it applies only to an extension that was on before the update and only when the new version asks for no new capability. **With this on, code the repository owner publishes runs without your review.** Use it only for authors you trust
* **Authority warnings** — A loud warning when an update asks for new capabilities, or changes code without changing its version
* **Korean and English UI**, light and dark theme, a bottom sheet on narrow screens

## Setup

1. In the server `.env`, set `ENABLE_EXTERNAL_EXTENSIONS=true` and restart Marinara
2. Settings → Addons → External Extensions: turn on **Allow third-party extension imports**, then import `ME-Fetchy-<version>.zip`
3. Open **Fetchy** in the list → **Review and Run**: read the code and approve the hash (it must equal the one in `SHA256SUMS.txt`)
4. An **Install from GitHub (Fetchy)** button appears next to the import buttons on that same screen (Settings → Addons → External Extensions). Shortcut: Alt+Shift+F; a floating button can be turned on under Options. Explanations sit behind the small (?) marks

On a remote (non-localhost) Marinara, set `ADMIN_SECRET` in the server `.env` and enter it under Settings → Admin Access. To update Fetchy itself, add `FigCake/ME.Fetchy` as a source.

## Is it safe

Fetchy is only a helper. It downloads the code and puts it into Marinara **switched off**; it never runs it. Turning it on is your act (except for extensions where you switched auto re-approval on): open Settings → Addons → External Extensions, read the code and approve it with **Review and Run**. If the hash Fetchy showed you matches the one on that screen, the code arrived unchanged.

Updates work the same way. New code switches the extension off again until you approve it, so changed code never runs behind your back.

No login or token is used to read GitHub. Public repositories only.

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

License: CC BY-NC 4.0.
