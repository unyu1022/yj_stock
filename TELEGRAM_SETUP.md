# Telegram bridge setup

This repository includes a first-pass Telegram polling bridge.

## Files

- `scripts/telegram_bridge.py`
- `telegram-bridge.env.example`

## Setup

0. Confirm `codex` runs successfully in PowerShell on this PC.
1. Copy `telegram-bridge.env.example` to `telegram-bridge.env`.
2. Fill in:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_ALLOWED_CHAT_ID`
   - `CODEX_WORKSPACE` (optional, defaults to this repository root)
   - `CODEX_RUN_TIMEOUT_SECONDS` (optional, default `900`)
   - `CODEX_COMMAND` (optional, set this explicitly on Windows if PATH differs)
3. Run:

```powershell
python scripts\telegram_bridge.py
```

Or use the fixed launcher with the explicit Python path:

```powershell
.\run_telegram_bridge.cmd
```

## Cloudflare deploy

Avoid `npx wrangler deploy` inside the bridge. Use the fixed launcher instead:

```powershell
.\deploy_cloudflare.cmd
```

If Wrangler is not installed yet, install it once in a normal desktop PowerShell:

```powershell
npm install -g wrangler
```

## Autostart on Windows logon

Register the Task Scheduler entry:

```powershell
powershell -ExecutionPolicy Bypass -File .\register_telegram_bridge_task.ps1
```

Remove it later if needed:

```powershell
powershell -ExecutionPolicy Bypass -File .\unregister_telegram_bridge_task.ps1
```

## Current behavior

- Accepts messages only from the configured `chat_id`
- Supports `/start`, `/help`, `/ping`, `/status`, `/run <text>`
- `/run` executes `codex exec` inside the configured workspace
- The bridge uses `--skip-git-repo-check` so it can run in a non-Git workspace
- Only one Codex task runs at a time
- The bridge sends the final Codex summary back to Telegram
- Final assistant text is also written to `.telegram-codex-last-message.txt`
- `/status` also reports the resolved Codex executable path
