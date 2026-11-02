---
name: instagram-publisher
description: Publish, schedule and manage posts on the user's Instagram business account via the local ig-publisher service (~/ig-publisher). Use whenever the user asks to post/upload/schedule a Reel, photo, carousel or story to Instagram ("instagramga joyla", "reels qo'y", "ertaga 9 da post qil"), check the post queue/history, view Instagram stats/insights, or read/reply to Instagram comments.
---

# Instagram publisher (ig-publisher)

Local service at `~/ig-publisher` (adjust the path if you cloned it elsewhere). CLI: `ig` (in PATH). MCP server `ig-publisher` exposes the same functions as `ig_*` tools — use either.
Setup guide: `~/ig-publisher/SETUP.md`; full docs: `~/ig-publisher/README.md`.

## Rules
- Publishing is public and hard to undo. Unless the user clearly asked to post now, run `--dry-run` first and show the caption.
- Never print or send the access token. It lives in `~/ig-publisher/data/ig.sqlite`.
- If a command fails with code=190 / "token yo'q", tell the user to follow SETUP.md step 3 (`ig auth token -`).
- Duplicate media is refused (exit code 3). Only use `--force` if the user explicitly wants a re-post.
- Replying to comments posts publicly — confirm the text with the user first.

## Common commands
```bash
ig doctor                                  # health: token, ffmpeg, host, quota, scheduler
ig post reel <video> --caption "..." [--cover img.png] [--at "ertaga 09:00"] [--dry-run]
ig post image <img> --caption "..." [--alt "..."]
ig post carousel <f1> <f2> ... --caption "..."
ig post story <file>
ig post --spec post.json [--at ...]
ig queue [--all] | ig queue cancel <id> | ig queue retry <id> --at "+1h"
ig history | ig limit | ig media | ig insights <media-id|account> | ig comments <media-id>
```
Add `--json` for machine-readable output. Times: `+2h`, `09:00`, `ertaga 09:00`, `2026-10-27 18:30` (local).

Publishing a reel takes 1–5 minutes (Instagram processing); scheduled posts are published by the systemd timer every 5 min.
