# Lineage Launcher

A full replacement home shell for NovaByte OS — custom app grid, taskbar, launchpad, notifications, and quick settings, all built from the ground up. Faster, cleaner, and more yours than the stock launcher.

## Features

- Full home shell replacement via the `home` role handler
- Custom app grid with icon support
- Taskbar with pinned apps, window strip, clock, and system tray
- Launchpad with search and category tabs
- Notification centre with per-app badges
- Quick Settings panel
- Snap assist and Alt+Tab window switcher
- Per-app settings and developer tools

## Requirements

- NovaByte OS or NBOSP fork
- Developer Mode enabled (Settings → Privacy & Security)
- Root Access enabled (required for `system:root` permission)

## Installation

**Recommended:** Install from the [NovaByte Store](https://novabyteteam.github.io/novabyte-os/#com.zeedev.lineagelauncher) — the store version is easier to install, digitally signed and reviewed by NovaByte, and includes tamper protection.

Alternatively, download the latest `.novaapp` from [Releases](https://github.com/sigma2026hproton/lineagelauncher/releases) and install via the NovaByte Package Manager. The release packages are built directly from this GitHub source and are **unsigned** — no tamper protection, no integrity digest, no NovaByte review. The OS will show an Unverified warning on install, which is expected. If that matters to you, use the store version instead.

> **Note:** Because Lineage Launcher uses `system:root` and `unrestrictedEntry`, you must have Developer Mode and Root Access turned on before launching. The app will show an error screen and refuse to run until both are enabled.

## Building from source

Edit `index.html`, `manifest.json`, or `root.js`, then repackage using [NovapackStudio](https://github.com/dirazcoder/novapack-studio) — the official NovaByte packaging tool.

Open the project folder in NovapackStudio, hit **Build**, and it'll produce the `.novaapp` file ready to install.

## Repository

[https://github.com/sigma2026hproton/lineagelauncher](https://github.com/sigma2026hproton/lineagelauncher)

## License

MIT — see [LICENSE](./LICENSE)

© 2026 ZeeDev
