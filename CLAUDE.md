# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Node.js web server that wraps the `claude` CLI in a chat-style mobile web UI (iPhone/Android over HTTPS). Two files of substance:
- **`server.js`** (~520 lines) — HTTP/HTTPS server, auth, session store, Claude subprocess manager. Reads `public/chat.html` per request and substitutes `${token}` + `${quickButtons}`.
- **`public/chat.html`** (~810 lines) — entire client UI (HTML + CSS + JS) including the design system tokens, themes, and the polling/streaming/session/history JS. Hot-reloadable: edit + browser refresh, no server restart.

Plus `setup.sh` (cert generation), `enable_firewall.bat` (Windows firewall, self-elevating), `config.example.json`. No build step, no bundler, no client framework.

User-facing docs that should not be duplicated into code:
- `SETUP_GUIDE.md` — end-user installation walkthrough (Tailscale, iOS cert trust, etc.)
- `CLAUDE_INSTRUCTIONS.md` — script-for-Claude that walks through `npm install` → `setup.sh` → `config.json` → firewall → `node server.js`. If the user asks you to "set this up", follow that file verbatim.
- `Claude Code Remote - standalone.html` — design reference (bundled artifact, do not edit). Source of the design tokens used by `chat.html`.

## Commands

```bash
npm install              # install express + express-ws
bash setup.sh            # generate certs/ — prompts for comma-separated IPs
cp config.example.json config.json   # required before first run; server exits if missing
node server.js           # start (or: npm start)
```

There are **no tests, no linter, and no build step**. Don't invent any. `npm run setup` is an alias for `bash setup.sh`.

Prerequisites at runtime: `certs/server.key|crt|ca.crt` (from `setup.sh`), `config.json`, the `claude` CLI at `config.claude.path`, and `public/chat.html`.

## Architecture

### Request/response model is polling, not streaming-to-client

The server streams `claude -p --output-format stream-json --verbose --dangerously-skip-permissions` into a per-token in-memory buffer; the client polls `GET /api/poll?from=<index>` every 500ms. **This is deliberate** — iOS backgrounding kills long-lived connections (SSE/WebSocket), so chunks survive in `responseBuffers` until the client returns. When touching the response path, preserve this: do not convert `/api/chat` → `/api/poll` into SSE or a single long response without accounting for iOS backgrounding. `express-ws` is a dependency but the chat flow does not use it.

`--dangerously-skip-permissions` is intentional — the mobile UI has no way to surface permission prompts; same threat model as the `!` shell command path. Do not remove.

Lifecycle of one user message (all in `server.js`):
1. `POST /api/chat` — validates token, handles immediate commands (`exit`, `/clear`, `!<shell>`), else spawns `claude` with `-c` or `--resume <id>`. Returns `{ok:true}` immediately.
2. stdout parsed line-by-line as JSON; `assistant` text blocks pushed into `buf.chunks`; `usage.output_tokens` summed into `buf.tokens`; first `message.model` cached in `buf.model`.
3. `GET /api/poll?from=N` returns `chunks.slice(N)` plus `done`/`error`/`tokens`/`model`. When `done && from >= chunks.length`, the buffer is deleted.
4. On non-zero exit with empty chunks, `stderrBuf` is surfaced as `buf.error` so the user sees the actual Claude CLI error instead of `(응답 없음)`.
5. `POST /api/cancel` kills the subprocess and flips `buf.done = true`.

### Four in-memory maps are the entire state layer

No database, no Redis. Everything keyed by the session token:
- `validTokens: Set<string>` — 32-byte hex cookies, evicted by `setTimeout` after `session.tokenExpiry` seconds (default 7 days).
- `conversations: Map<token, {isFirst, busy, resumeId, cwd}>` — `isFirst` gates the `-c` flag; `resumeId` is consumed once then cleared; `cwd` is set per session on resume.
- `activeProcs: Map<token, ChildProcess>` — used by `/api/cancel` and `/api/new` to kill in-flight processes.
- `responseBuffers: Map<token, {chunks, done, error, tokens, model}>` — the polling buffer.

All four are wiped together when the token expires. Restarting `node server.js` wipes every in-flight conversation but **cookies remain valid** — `GET /chat` re-creates a fresh `conversations` entry for a surviving cookie token. Keep that recovery path intact.

### Conversation continuity uses Claude's own session store

`getRecentSessions()` and `getSessionHistory()` scan `~/.claude/projects/**/*.jsonl` directly — Claude CLI's on-disk session log. We parse it for the "sessions" panel and to backfill history on resume. **`getSessionCwd()` is critical**: it reads the first line of the target session's jsonl to recover the original `cwd`, which is then set on `conv.cwd` so the spawned `claude --resume <id>` runs from the matching project folder. Without this, Claude CLI returns "No conversation found with session ID" because its resume lookup is cwd-scoped. If Claude CLI's jsonl schema changes, all three parsers need updating in tandem.

### Template architecture: `${token}` and `${quickButtons}` are the only injection points

`/chat` route reads `public/chat.html` as plain text, prerenders the quick-buttons HTML from `config.quickButtons`, and replaces those two literal strings via `String.replace(/\$\{...\}/g, () => value)` (function form to bypass `$&` interpretation). Function form matters — never use the string-replacement form for tokens. Reading per-request is intentional: edit `public/chat.html` and refresh the browser, no server restart needed.

The HTML contains plain JS — **no `\\n` / `\\u25BC` double-escaping** (that legacy was an artifact of when the template lived inside a JS template literal in `server.js`). All escapes are single-backslash JS strings.

### The client is plain DOM + `fetch`

UI quirks enforced by `chat.html` JS that matter when editing:
- `visualViewport` listener repositions `#app` on keyboard open/close and preserves scroll ratio (iOS Safari keyboard handling).
- Collapse thresholds: 15 lines or 500 chars → bubble gets `.collapsed` + "더보기" button.
- `IntersectionObserver` on `#history-sentinel` triggers incremental history load (20 messages at a time, newest-first offset).
- Scroll-position logic uses `isNearBottom` (<200px from bottom) to decide auto-scroll vs. "new message" indicator.
- The thinking indicator (`#typing`) stays visible from `showTyping()` until `done` (not just until first chunk) so the running token counter and elapsed time remain visible during streaming.
- Model name in the header subtitle (`#model-short`) and input pill (`#model-full`) is auto-updated from `data.model` in poll responses via `updateModel()` — never hardcode model names.

### HTTP → HTTPS

Port 9000 exists only to redirect to 9443 and to serve `/ca.crt` and `/install` (the `.mobileconfig`) over plain HTTP so iOS can install the trust profile. Do not add authenticated endpoints on port 9000.

### Shell command path (`!<cmd>`)

Messages starting with `!` bypass Claude and `spawn('bash', ['-c', cmd])` in `conv.cwd || WORK_DIR` with a 60s kill timeout. stdout and stderr both flow into the same buffer as Claude output. Intentional power-user feature — don't sanitize.

## UI Design Rules

The UI follows the Claude Code terminal aesthetic from `Claude Code Remote - standalone.html`. **All four rules are load-bearing — do not deviate without an explicit user override.**

1. **Terminal style only.** Replicate Claude Code's terminal look — minimal chrome, monospace text, `>` and `✶` line markers. Reference `Claude Code Remote - standalone.html` for any new component layout. Do not introduce material-style cards, gradients, glassmorphism, or other UI metaphors that conflict with the terminal feel.
2. **Color tokens are the palette: `--crail`, `--amber`, `--sage`, `--sky` only** (plus the neutral `--bg*`, `--surface`, `--line*`, `--text*` family). Do not introduce new accent hex codes. `--crail-soft`/`--crail-deep`/`--rose` are allowed as accent variants. Anything outside this set requires importing the value from design-reference's `:root`, not inventing.
3. **Geist Mono is the default font.** All UI text — headings, buttons, pills, message body, input — uses `var(--mono)` (Geist Mono with fallbacks). `var(--sans)` (Geist) is reserved for body fallback only. Do not use system sans-serif for new UI elements.
4. **Terminal metaphor for new elements.** Minimize bubbles, large border-radius, and shadows. Prefer `::before` line markers, dashed dividers, pill-style border accents, and inline pills (`.pill` pattern). When adding a new component, ask: "would this look at home in a terminal?" If not, restyle.

When `chat.html` JS emits inline styles (e.g., `formatText` markdown headings), reference the tokens via `var(--crail)`, `var(--amber)` etc. — never hardcode hex.

## Conventions

- **UI text is Korean.** User-facing strings (errors, buttons, status messages) stay Korean; server log lines stay English.
- **Config is source of truth for secrets and paths.** `config.json` is gitignored; never hardcode `auth`, `claude.path`, or ports. `setup.sh` and `config.example.json` are the templates.
- **`certs/`, `server.log`, `.omc/`, `.claude/`, `screenshots/`, `Claude Code Remote - standalone.html` are gitignored.** Never commit anything under those.
- Node 18+ is assumed (optional chaining heavily, no polyfills).
- The `<script>` block in `public/chat.html` (the polling/session/history logic) is load-bearing — design changes restyle CSS and tweak markup but should not touch JS. Function-named entry points (`pollResponse`, `sendMessage`, `cancelRequest`, `loadHistory`, `resumeSession`, `addMsg`, `addStreamingMsg`, `finalizeStreamingMsg`) and the IDs/classes they reference are part of the contract.
