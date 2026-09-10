# PrintMyDoc Agent

A tray app that runs on the shop's counter PC. It detects the real printers installed on that machine, polls the API for incoming print jobs, downloads the file, and sends it to the chosen printer.

- **Windows**: printer listing + printing via [`pdf-to-printer`](https://www.npmjs.com/package/pdf-to-printer) (bundles SumatraPDF).
- **macOS/Linux**: printer listing + printing via CUPS (`lpstat`/`lp`) through [`unix-print`](https://www.npmjs.com/package/unix-print).

## How a shop connects it

1. In the merchant dashboard → **Printers**, click "Generate agent credentials" — this creates a `deviceKey` + `token` (shown once).
2. Install/run the agent on the counter PC. On first launch it opens a small setup window — paste the API URL, device key, and token, then **Connect**.
3. The agent then runs in the background (system tray icon), reporting its real printers to the dashboard every minute and picking up print jobs automatically.

## Development

```bash
cd apps/agent
npm run build   # compile TypeScript
npm run dev      # build + launch via local Electron
```

## Packaging an installer

```bash
npm run dist:mac   # .dmg / .zip — must be run on macOS
npm run dist:win    # NSIS .exe — must be run on Windows (or a Windows CI runner)
```

electron-builder can't cross-compile a Windows installer from macOS (or vice versa) without extra tooling like Wine, so build each target on its own OS or via CI.

## Notes

- Config (API URL, device key, token, agent ID) is stored in Electron's per-user `userData` directory (`config.json`) — not in the repo.
- The tray menu has "Disconnect", which clears local config and reopens the setup window.
- Printer color/duplex capability isn't queried from the OS (Windows/CUPS don't expose this reliably without extra native calls) — the agent reports both as supported and lets the order's requested settings (from the shop's pricing rules) drive what's actually sent to the print command.
