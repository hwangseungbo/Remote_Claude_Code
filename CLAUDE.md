# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Node.js web server that wraps the `claude` CLI in a chat-style mobile web UI (iPhone/Android over HTTPS). The repo is **three files of substance** (`server.js`, `setup.sh`, `config.example.json`) plus docs. `server.js` is a single ~1086-line file that contains the HTTP/HTTPS server, auth, session store, Claude subprocess manager, and the full inlined HTML/CSS/JS for the chat UI — there is no build step, no bundler, no framework on the client.

Two sibling docs describe user-facing setup and are worth knowing exist but should not be duplicated into code:
- `SETUP_GUIDE.md` — end-user installation walkthrough (Tailscale, iOS cert trust, etc.)
- `CLAUDE_INSTRUCTIONS.md` — a script-for-Claude that walks through `npm install` → `setup.sh` → `config.json` → firewall → `node server.js`. If the user asks you to "set this up", follow that file verbatim.

## Commands

```bash
npm install              # install express + express-ws
bash setup.sh            # generate certs/ (CA + server cert + ca.mobileconfig) — prompts for comma-separated IPs
cp config.example.json config.json   # required before first run; server exits if missing
node server.js           # start (or: npm start)
```

There are **no tests, no linter, and no build step**. Don't invent any. `npm run setup` is an alias for `bash setup.sh`.

Prerequisites that must exist at runtime: `certs/server.key`, `certs/server.crt`, `certs/ca.crt` (from `setup.sh`), `config.json`, and the `claude` CLI reachable at `config.claude.path`.

## Architecture

### Request/response model is polling, not streaming-to-client

The server streams from `claude -p --output-format stream-json --verbose` into a per-token in-memory buffer, and the client polls `GET /api/poll?from=<index>` every 500ms for new chunks. **This is deliberate** — iOS backgrounding kills long-lived connections (SSE/WebSocket), so chunks survive in `responseBuffers` until the client returns. When touching the response path, preserve this: do not convert `/api/chat` → `/api/poll` into SSE or a single long response without accounting for iOS backgrounding. `express-ws` is a dependency but the chat flow does not use it.

Lifecycle of one user message (all in `server.js`):
1. `POST /api/chat` — validates token, handles immediate commands (`exit`, `/clear`, `!<shell>`), else spawns `claude` with `-c` or `--resume <id>`. Returns `{ok:true}` immediately.
2. stdout is parsed line-by-line as JSON; `assistant` blocks and terminal `result` are pushed into `responseBuffers.get(token).chunks`.
3. `GET /api/poll?from=N` returns `chunks.slice(N)` plus `done`/`error`. When `done && from >= chunks.length`, the buffer is deleted.
4. `POST /api/cancel` kills the subprocess and flips `buf.done = true`.

### Four in-memory maps are the entire state layer

No database, no Redis. Everything keyed by the session token:
- `validTokens: Set<string>` — 32-byte hex cookies, evicted by `setTimeout` after `session.tokenExpiry` seconds (default 7 days).
- `conversations: Map<token, {isFirst, busy, resumeId, cwd}>` — `isFirst` gates the `-c` flag; `resumeId` is consumed once then cleared.
- `activeProcs: Map<token, ChildProcess>` — used by `/api/cancel` and `/api/new` to kill in-flight processes.
- `responseBuffers: Map<token, {chunks, done, error}>` — the polling buffer.

All four are wiped together when the token expires. Restarting `node server.js` wipes every in-flight conversation but **cookies remain valid** — `GET /chat` re-creates a fresh `conversations` entry for a surviving cookie token (see the `if (!conversations.has(token))` branch). Keep that recovery path intact.

### Conversation continuity uses Claude's own session store, not ours

`getRecentSessions()` and `getSessionHistory()` scan `~/.claude/projects/**/*.jsonl` directly — that's Claude CLI's on-disk session log. We parse it to render the "sessions" panel and to backfill history on resume. Resuming a session just sets `conv.resumeId`, which adds `--resume <id>` to the next `claude` invocation exactly once. If Claude CLI's jsonl schema changes, both parsers (lines ~77–156) need updating in tandem.

### The client is plain DOM + `fetch`, inlined

The entire chat UI (HTML, CSS, JS) is a template literal inside the `/chat` route handler. There is no component framework, no transpilation. Notable quirks enforced by the UI layer that matter when editing:
- `visualViewport` listener repositions `#app` on keyboard open/close and preserves scroll ratio (iOS Safari keyboard handling).
- Collapse thresholds: 15 lines or 500 chars → bubble gets `.collapsed` + "더보기" button.
- `IntersectionObserver` on `#history-sentinel` triggers incremental history load (20 messages at a time, newest-first offset).
- Scroll-position logic uses `isNearBottom` (<200px from bottom) to decide auto-scroll vs. "new message" indicator.
- When editing UI strings inside the template literal, remember it is JS-in-JS: `\\n`, `\\'`, `\\u25B2` are deliberate (they need to survive into the emitted HTML/JS).

### HTTP → HTTPS

Port 9000 exists only to redirect to 9443 and to serve `/ca.crt` and `/install` (the `.mobileconfig`) over plain HTTP so iOS can install the trust profile. Do not add authenticated endpoints on port 9000.

### Shell command path (`!<cmd>`)

Messages starting with `!` bypass Claude and `spawn('bash', ['-c', cmd])` in `conv.cwd || WORK_DIR` with a 60s kill timeout. stdout and stderr both flow into the same buffer as Claude output. This is an intentional power-user feature — don't sanitize the command (the user is already authenticated with their own credentials to run Claude CLI, which is strictly more powerful).

## Conventions

- **UI text is Korean.** User-facing strings (errors, buttons, status messages) should stay Korean; server log lines stay English.
- **Config is source of truth for secrets and paths.** `config.json` is gitignored; never hardcode `auth`, `claude.path`, or ports. `setup.sh` and `config.example.json` are the templates.
- **`certs/` is gitignored** and regenerated per-host by `setup.sh`. Never commit anything under `certs/`.
- Node 18+ is assumed (uses optional chaining heavily, no polyfills).
