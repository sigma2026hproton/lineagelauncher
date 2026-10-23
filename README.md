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

- NovaByte OS v3 or an NBOSP fork
- Developer Mode enabled (Settings → Privacy & Security)
- Root Access enabled (required for `system:root` permission)

## Installation

Download the latest `.novaapp` from [Releases](https://github.com/sigma2026hproton/lineagelauncher/releases) and install via the NovaByte Package Manager.

> **Note:** Because Lineage Launcher uses `system:root` and `unrestrictedEntry`, you must have Developer Mode and Root Access turned on before launching. The app will show an error screen and refuse to run until both are enabled.

## Building from source

The package is a single JSON file with Base64-encoded source files. To repackage after edits:

```bash
node scripts/repackage.js . ../dist
```

Or manually — edit `index.html`, `manifest.json`, or `root.js`, then repack with any NovaByte-compatible packager.

## Repository

[https://github.com/sigma2026hproton/lineagelauncher](https://github.com/sigma2026hproton/lineagelauncher)

## License

MIT — see [LICENSE](./LICENSE)

© 2026 ZeeDev
