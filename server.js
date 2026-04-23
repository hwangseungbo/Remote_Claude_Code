const express = require('express');
const expressWs = require('express-ws');
const https = require('https');
const { spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const CERT_DIR = path.join(__dirname, 'certs');
const sslOptions = {
  key: fs.readFileSync(path.join(CERT_DIR, 'server.key')),
  cert: fs.readFileSync(path.join(CERT_DIR, 'server.crt')),
  ca: fs.readFileSync(path.join(CERT_DIR, 'ca.crt'))
};

const app = express();
const httpsServer = https.createServer(sslOptions, app);
expressWs(app, httpsServer);
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// 쿠키 파싱 (간이)
app.use((req, res, next) => {
  req.cookies = {};
  const h = req.headers.cookie;
  if (h) h.split(';').forEach(c => {
    const [k, v] = c.trim().split('=');
    if (k && v) req.cookies[k] = v;
  });
  next();
});

const TOKEN_MAX_AGE = 7 * 24 * 60 * 60; // 7일 (초)

// 토큰 추출 헬퍼 (body, query, cookie 순)
function getToken(req) {
  return req.body?.token || req.query?.token || req.cookies?.token || null;
}
function isValidToken(req) {
  const t = getToken(req);
  return t && validTokens.has(t) ? t : null;
}

// ── 설정 로드 ──
const CONFIG_PATH = path.join(__dirname, 'config.json');
if (!fs.existsSync(CONFIG_PATH)) {
  console.error('config.json not found. Copy config.example.json to config.json and edit it.');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const PORT = config.ports.http;
const HTTPS_PORT = config.ports.https;
const AUTH_USER = config.auth.username;
const AUTH_PASS = config.auth.password;
const CLAUDE_PATH = config.claude.path;
const WORK_DIR = path.resolve(config.claude.workDir);

app.use((req, res, next) => {
  if (!req.secure && req.headers['x-forwarded-proto'] !== 'https') {
    return res.redirect(`https://${req.hostname}:${HTTPS_PORT}${req.url}`);
  }
  next();
});

const validTokens = new Set();
const conversations = new Map();
const activeProcs = new Map();
// 폴링용: 응답 버퍼 저장소
const responseBuffers = new Map(); // token → { chunks: [], done: bool, error: null }

// ── 세션 목록 ──
function getRecentSessions(limit = 15) {
  try {
    const sessDir = path.join(process.env.HOME || process.env.USERPROFILE, '.claude', 'projects');
    const sessions = [];
    function extractFirstUserMessage(fp) {
      try {
        for (const line of fs.readFileSync(fp, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try {
            const d = JSON.parse(line);
            if (d.type === 'user' && d.message) {
              const c = d.message.content;
              if (typeof c === 'string') return c.replace(/\s+/g, ' ').trim().slice(0, 80);
              if (Array.isArray(c)) {
                const txt = c.find(x => x && x.type === 'text');
                if (txt) return txt.text.replace(/\s+/g, ' ').trim().slice(0, 80);
              }
            }
          } catch (_) {}
        }
      } catch (_) {}
      return '';
    }
    function scanDir(dir) {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) scanDir(path.join(dir, e.name));
        else if (e.name.endsWith('.jsonl')) {
          try {
            const fp = path.join(dir, e.name);
            sessions.push({ id: e.name.replace('.jsonl',''), project: dir.split('projects')[1]||'', date: fs.statSync(fp).mtime, filePath: fp });
          } catch (_) {}
        }
      }
    }
    scanDir(sessDir);
    sessions.sort((a,b) => b.date - a.date);
    return sessions.slice(0, limit).map(s => ({
      id: s.id, project: s.project.replace(/\\/g,'/').replace(/^\//,''),
      date: s.date.toISOString().slice(0,16).replace('T',' '),
      summary: extractFirstUserMessage(s.filePath)
    }));
  } catch (e) { return []; }
}

// ── 세션 히스토리 파싱 ──
function getSessionHistory(sessionId, offset = 0, limit = 20) {
  try {
    const sessDir = path.join(process.env.HOME || process.env.USERPROFILE, '.claude', 'projects');
    let targetFile = null;

    function findFile(dir) {
      if (targetFile) return;
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) findFile(path.join(dir, e.name));
        else if (e.name === sessionId + '.jsonl') { targetFile = path.join(dir, e.name); return; }
      }
    }
    findFile(sessDir);
    if (!targetFile) return { messages: [], total: 0, hasMore: false };

    const messages = [];
    for (const line of fs.readFileSync(targetFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        if (d.type === 'user' && d.message) {
          const c = d.message.content;
          let text = '';
          if (typeof c === 'string') text = c;
          else if (Array.isArray(c)) {
            text = c.filter(x => x && x.type === 'text').map(x => x.text).join('\n');
          }
          if (text) messages.push({ role: 'user', text });
        } else if (d.type === 'assistant' && d.message?.content) {
          const texts = [];
          for (const block of (Array.isArray(d.message.content) ? d.message.content : [])) {
            if (block.type === 'text' && block.text) texts.push(block.text);
          }
          if (texts.length) messages.push({ role: 'assistant', text: texts.join('\n') });
        }
      } catch (_) {}
    }

    const total = messages.length;
    // offset은 끝에서부터 (0 = 최신 20개, 20 = 그 이전 20개...)
    const start = Math.max(0, total - offset - limit);
    const end = Math.max(0, total - offset);
    const slice = messages.slice(start, end);

    return { messages: slice, total, hasMore: start > 0 };
  } catch (e) {
    console.error('History error:', e.message);
    return { messages: [], total: 0, hasMore: false };
  }
}

// 세션 ID로 원본 cwd 찾기 (resume 시 정확한 프로젝트 폴더에서 spawn해야 Claude CLI가 세션을 인식)
function getSessionCwd(sessionId) {
  try {
    const sessDir = path.join(process.env.HOME || process.env.USERPROFILE, '.claude', 'projects');
    let targetFile = null;
    function findFile(dir) {
      if (targetFile) return;
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) findFile(path.join(dir, e.name));
        else if (e.name === sessionId + '.jsonl') { targetFile = path.join(dir, e.name); return; }
      }
    }
    findFile(sessDir);
    if (!targetFile) return null;
    for (const line of fs.readFileSync(targetFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        if (d.cwd) return d.cwd;
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

// ── 인증서 다운로드 ──
app.get('/ca.crt', (req, res) => {
  res.setHeader('Content-Type', 'application/x-x509-ca-cert');
  res.sendFile(path.join(CERT_DIR, 'ca.crt'));
});
app.get('/install', (req, res) => {
  res.setHeader('Content-Type', 'application/x-apple-aspen-config');
  res.sendFile(path.join(CERT_DIR, 'ca.mobileconfig'));
});

// ── Login ──
app.get('/', (req, res) => {
  // 유효한 쿠키가 있으면 바로 채팅으로
  const cookieToken = req.cookies.token;
  if (cookieToken && validTokens.has(cookieToken)) {
    return res.redirect('/chat?token=' + cookieToken);
  }
  res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>AI Assistant</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#1e1e2e;color:#cdd6f4;font-family:-apple-system,sans-serif;
       display:flex;justify-content:center;align-items:center;height:100vh}
  .login{background:#313244;padding:32px;border-radius:12px;width:320px}
  .login h2{margin-bottom:24px;text-align:center;color:#89b4fa}
  .login input{width:100%;padding:14px;margin-bottom:12px;font-size:18px;
               background:#1e1e2e;color:#cdd6f4;border:1px solid #585b70;
               border-radius:8px;outline:none;-webkit-appearance:none}
  .login button{width:100%;padding:14px;font-size:18px;font-weight:bold;
                background:#89b4fa;color:#1e1e2e;border:none;border-radius:8px}
  .error{color:#f38ba8;text-align:center;margin-bottom:12px}
</style></head>
<body>
  <form class="login" method="POST" action="/login">
    <h2>Personal AI Assistant</h2>
    <div class="error" id="err"></div>
    <input type="text" name="user" placeholder="ID" autocomplete="username" autofocus>
    <input type="password" name="pass" placeholder="Password" autocomplete="current-password">
    <button type="submit">Login</button>
  </form>
  <script>if(location.search.includes('fail'))document.getElementById('err').textContent='인증 실패';</script>
</body></html>`);
});

app.post('/login', (req, res) => {
  if (req.body.user === AUTH_USER && req.body.pass === AUTH_PASS) {
    const token = crypto.randomBytes(32).toString('hex');
    validTokens.add(token);
    conversations.set(token, { isFirst: true, busy: false, resumeId: null, cwd: WORK_DIR });
    setTimeout(() => { validTokens.delete(token); conversations.delete(token); activeProcs.delete(token); responseBuffers.delete(token); }, TOKEN_MAX_AGE * 1000);
    res.setHeader('Set-Cookie', `token=${token}; Path=/; Max-Age=${TOKEN_MAX_AGE}; HttpOnly; Secure; SameSite=Strict`);
    return res.redirect('/chat?token=' + token);
  }
  res.redirect('/?fail=1');
});

// ── Chat Page ──
app.get('/chat', (req, res) => {
  const token = req.query.token || req.cookies.token;
  if (!token || !validTokens.has(token)) return res.redirect('/');
  // conversation이 없으면 새로 생성 (서버 재시작 후 쿠키만 남은 경우 대비)
  if (!conversations.has(token)) {
    conversations.set(token, { isFirst: true, busy: false, resumeId: null, cwd: WORK_DIR });
  }

  res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>AI Assistant</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  html{height:100%;overflow:hidden;background:#1e1e2e}
  body{height:100%;overflow:hidden;background:#1e1e2e;color:#cdd6f4;
       font-family:-apple-system,'Malgun Gothic',sans-serif}
  #app{position:fixed;top:0;left:0;right:0;bottom:0;display:flex;flex-direction:column}

  #header{background:#313244;padding:10px 12px;display:flex;gap:8px;align-items:center;
          border-bottom:1px solid #45475a;flex-shrink:0;z-index:10}
  #header h3{color:#89b4fa;font-size:15px;flex:1}
  .hdr-btn{background:#45475a;color:#cdd6f4;border:none;padding:6px 10px;
           border-radius:6px;font-size:12px;white-space:nowrap;-webkit-tap-highlight-color:transparent}

  #messages{flex:1;overflow-y:auto;padding:12px;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}
  .msg{margin-bottom:12px;max-width:90%}
  .msg.user{margin-left:auto}
  .msg.assistant{margin-right:auto}
  .msg.system{margin:0 auto;max-width:100%}
  .msg .bubble{padding:10px 14px;border-radius:16px;font-size:15px;line-height:1.5;
               word-wrap:break-word;white-space:pre-wrap}
  .msg.user .bubble{background:#89b4fa;color:#1e1e2e;border-bottom-right-radius:4px}
  .msg.assistant .bubble{background:#313244;color:#cdd6f4;border-bottom-left-radius:4px}
  .msg.system .bubble{background:#45475a;color:#a6adc8;font-size:13px;text-align:center;
                      border-radius:8px;padding:6px 12px}
  .msg .meta{font-size:11px;color:#6c7086;margin-top:4px;padding:0 4px}
  .msg.user .meta{text-align:right}

  #typing{color:#cdd6f4;font-size:14px;padding:10px 14px;display:none;align-items:center;gap:6px;
          border-top:1px solid #45475a;background:#1a1a26;flex-shrink:0}
  #typing.show{display:flex}
  .t-star{display:inline-block;color:#f9e2af;font-size:18px;line-height:1;
          animation:t-star-spin 2s linear infinite;will-change:transform}
  @keyframes t-star-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
  .t-meta{color:#6c7086;font-size:12px;margin-left:auto;margin-right:8px;
          font-feature-settings:"tnum";white-space:nowrap}
  #cancel-btn{background:#f38ba8;color:#1e1e2e;border:none;padding:4px 12px;
              border-radius:12px;font-size:12px;font-weight:bold;-webkit-tap-highlight-color:transparent}

  #input-area{background:#313244;border-top:1px solid #45475a;
              padding:8px 8px calc(8px + env(safe-area-inset-bottom, 0px));
              display:flex;gap:8px;flex-shrink:0;z-index:10}
  #input-area textarea{flex:1;padding:10px 12px;font-size:16px;min-height:44px;max-height:120px;
    background:#1e1e2e;color:#cdd6f4;border:1px solid #585b70;border-radius:20px;
    outline:none;resize:none;font-family:inherit;-webkit-appearance:none}
  #send-btn{background:#89b4fa;color:#1e1e2e;border:none;width:44px;height:44px;
            border-radius:50%;font-size:20px;font-weight:bold;align-self:flex-end;
            -webkit-tap-highlight-color:transparent}
  #send-btn:disabled{background:#45475a;color:#6c7086}

  #session-panel{display:none;position:fixed;top:0;left:0;right:0;bottom:0;
                 background:#1e1e2e;z-index:200;flex-direction:column}
  #session-panel.show{display:flex}
  #sp-header{background:#313244;padding:12px 16px;display:flex;justify-content:space-between;
             align-items:center;border-bottom:1px solid #45475a}
  #sp-header h3{color:#89b4fa;font-size:16px}
  #sp-list{flex:1;overflow-y:auto;padding:8px}
  .sp-item{background:#313244;border-radius:10px;padding:12px;margin-bottom:8px;cursor:pointer}
  .sp-item:active{background:#45475a}
  .sp-item .sp-date{font-size:12px;color:#6c7086}
  .sp-item .sp-proj{font-size:11px;color:#89b4fa;margin-top:2px}
  .sp-item .sp-summary{font-size:14px;margin-top:4px;color:#cdd6f4}

  .quick-btns{display:flex;gap:6px;flex-wrap:wrap;padding:8px 0}
  .quick-btns button{background:#45475a;color:#cdd6f4;border:1px solid #585b70;
                     padding:7px 12px;border-radius:16px;font-size:13px;
                     -webkit-tap-highlight-color:transparent}

  .streaming-cursor::after{content:'█';animation:cursor-blink .8s infinite;color:#89b4fa;margin-left:2px}
  @keyframes cursor-blink{0%,100%{opacity:1}50%{opacity:0}}

  /* 접어두기 */
  .msg .bubble.collapsed{max-height:240px;overflow:hidden;position:relative}
  .msg .bubble.collapsed::after{content:'';position:absolute;bottom:0;left:0;right:0;height:40px;
    background:linear-gradient(transparent, #313244)}
  .msg.user .bubble.collapsed::after{background:linear-gradient(transparent, #89b4fa)}
  .expand-btn{background:none;border:1px solid #585b70;color:#89b4fa;padding:4px 12px;
              border-radius:12px;font-size:12px;margin-top:6px;display:inline-block;
              -webkit-tap-highlight-color:transparent}

  /* 히스토리 로드 */
  #history-sentinel{text-align:center;padding:12px;color:#6c7086;font-size:13px}
  #history-sentinel.loading{color:#89b4fa}
  .history-start{text-align:center;color:#45475a;font-size:12px;padding:8px;margin-bottom:8px}

  /* 스크롤 네비 버튼 */
  .scroll-nav{position:absolute;right:12px;z-index:15;width:40px;height:40px;
              border-radius:50%;border:none;font-size:18px;
              background:rgba(69,75,90,0.85);color:#cdd6f4;
              display:none;align-items:center;justify-content:center;
              -webkit-tap-highlight-color:transparent;
              box-shadow:0 2px 8px rgba(0,0,0,0.3);
              backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px)}
  .scroll-nav.show{display:flex}
  .scroll-nav:active{background:rgba(137,180,250,0.6)}
  #scroll-up{bottom:120px}
  #scroll-down{bottom:72px}
  #scroll-down.has-new{background:rgba(137,180,250,0.85);color:#1e1e2e}
</style></head>
<body>
<div id="app">
  <div id="header">
    <h3 id="chat-title">AI Assistant</h3>
    <button class="hdr-btn" onclick="showSessions()">세션</button>
    <button class="hdr-btn" onclick="newChat()">새 대화</button>
    <button class="hdr-btn" onclick="logout()" style="color:#f38ba8">나가기</button>
  </div>
  <button id="scroll-up" class="scroll-nav" onclick="scrollToTop()">&#9650;</button>
  <button id="scroll-down" class="scroll-nav" onclick="scrollToBottom()">&#9660;</button>
  <div id="messages">
    <div class="msg assistant">
      <div class="bubble">Personal AI Assistant 입니다.
명령어: exit(세션종료) | !명령어(셸 실행)</div>
    </div>
    <div class="quick-btns">
' + (config.quickButtons || []).map(b => '<button onclick="quickSend(\'' + b.prompt.replace(/'/g, "\\'") + '\')">' + b.label + '</button>').join('
      ') + '
    </div>
  </div>
  <div id="typing">
    <span class="t-star">&#10038;</span>
    <span><span id="thinking-verb">생각 중</span>…</span>
    <span class="t-meta"><span id="elapsed">0초</span><span id="tokens-display"></span></span>
    <button id="cancel-btn" onclick="cancelRequest()">중단</button>
  </div>
  <div id="input-area">
    <textarea id="msg-input" rows="1" placeholder="메시지 입력... (!ls = 셸 명령)"
              oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,120)+'px'"></textarea>
    <button id="send-btn" onclick="sendMessage()">&#9654;</button>
  </div>
</div>

<div id="session-panel">
  <div id="sp-header"><h3>최근 세션</h3><button class="hdr-btn" onclick="closeSessions()">닫기</button></div>
  <div id="sp-list"></div>
</div>

<script>
const TOKEN = '${token}';
const msgArea = document.getElementById('messages');
const msgInput = document.getElementById('msg-input');
const sendBtn = document.getElementById('send-btn');
const typingEl = document.getElementById('typing');
const elapsedEl = document.getElementById('elapsed');
let busy = false, timer = null, pollTimer = null;
let streamDiv = null, fullText = '', lastPollIdx = 0;

msgInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

// iOS 키보드 대응
(function(){
  const vv = window.visualViewport;
  if (!vv) return;
  function onResize() {
    const app = document.getElementById('app');
    // 키보드 전 스크롤 비율 저장
    const sh = msgArea.scrollHeight;
    const ratio = sh > 0 ? msgArea.scrollTop / sh : 1;
    app.style.height = vv.height + 'px';
    app.style.top = vv.offsetTop + 'px';
    // 레이아웃 변경 후 스크롤 위치 복원 (비율 기반)
    setTimeout(() => {
      const newSh = msgArea.scrollHeight;
      msgArea.scrollTop = Math.round(ratio * newSh);
    }, 50);
  }
  vv.addEventListener('resize', onResize);
  vv.addEventListener('scroll', onResize);
  onResize();
})();

// textarea 포커스 시: 최하단 근처면 하단으로, 아니면 현재 위치 유지
msgInput.addEventListener('focus', () => {
  setTimeout(() => {
    if (isNearBottom) msgArea.scrollTop = msgArea.scrollHeight;
    // 위에서 보고 있는 경우 → 위치 유지 (아무것도 안 함)
  }, 300);
});
msgArea.addEventListener('touchstart', e => {
  if (document.activeElement === msgInput && e.target !== msgInput) msgInput.blur();
});

// ── 스크롤 네비 버튼 ──
const scrollUpBtn = document.getElementById('scroll-up');
const scrollDownBtn = document.getElementById('scroll-down');
let isNearBottom = true;

function updateScrollNav() {
  const st = msgArea.scrollTop;
  const sh = msgArea.scrollHeight;
  const ch = msgArea.clientHeight;
  const distFromTop = st;
  const distFromBottom = sh - st - ch;
  const threshold = 200;

  // 위로 버튼: 상단에서 멀 때
  if (distFromTop > threshold) scrollUpBtn.classList.add('show');
  else scrollUpBtn.classList.remove('show');

  // 아래로 버튼: 하단에서 멀 때
  isNearBottom = distFromBottom < threshold;
  if (!isNearBottom) scrollDownBtn.classList.add('show');
  else { scrollDownBtn.classList.remove('show'); scrollDownBtn.classList.remove('has-new'); }
}

msgArea.addEventListener('scroll', updateScrollNav, {passive: true});

function scrollToTop() { msgArea.scrollTo({top: 0, behavior: 'smooth'}); }
function scrollToBottom() {
  msgArea.scrollTo({top: msgArea.scrollHeight, behavior: 'smooth'});
  scrollDownBtn.classList.remove('has-new');
}

// 새 메시지 도착 시 하단에 없으면 "새 메시지" 표시
function notifyNewMessage() {
  if (!isNearBottom) {
    scrollDownBtn.classList.add('show');
    scrollDownBtn.classList.add('has-new');
  }
}

function quickSend(t) { msgInput.value = t; sendMessage(); }

function logout() {
  document.cookie = 'token=; Path=/; Max-Age=0; Secure';
  location.href = '/';
}

function newChat() {
  stopPolling();
  fetch('/api/new', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({token:TOKEN}) })
  .then(() => {
    msgArea.innerHTML = '<div class="msg system"><div class="bubble">새 대화를 시작합니다.</div></div>';
    document.getElementById('chat-title').textContent = 'AI Assistant';
  });
}

const COLLAPSE_LINES = 15;
const COLLAPSE_CHARS = 500;

function makeBubbleHtml(role, text, withTime) {
  const formatted = formatText(text);
  const lines = text.split('\\n').length;
  const needCollapse = role !== 'system' && (lines > COLLAPSE_LINES || text.length > COLLAPSE_CHARS);
  const bubbleClass = needCollapse ? 'bubble collapsed' : 'bubble';
  let html = '<div class="' + bubbleClass + '" data-full-text="' + encodeURIComponent(text) + '">' + formatted + '</div>';
  if (needCollapse) {
    html += '<button class="expand-btn" onclick="toggleCollapse(this)">\\u25BC 더보기 (' + lines + '줄)</button>';
  }
  if (withTime && role !== 'system') {
    html += '<div class="meta">' + new Date().toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'}) + '</div>';
  }
  return html;
}

function toggleCollapse(btn) {
  const bubble = btn.previousElementSibling;
  if (bubble.classList.contains('collapsed')) {
    bubble.classList.remove('collapsed');
    btn.textContent = '\\u25B2 접기';
  } else {
    bubble.classList.add('collapsed');
    const text = decodeURIComponent(bubble.getAttribute('data-full-text') || '');
    btn.textContent = '\\u25BC 더보기 (' + text.split('\\n').length + '줄)';
  }
}

function addMsg(role, text) {
  const opts = msgArea.querySelector('.quick-btns');
  if (opts) opts.remove();
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  div.innerHTML = makeBubbleHtml(role, text, true);
  msgArea.appendChild(div);
  if (isNearBottom) {
    msgArea.scrollTop = msgArea.scrollHeight;
  } else {
    notifyNewMessage();
  }
  return div;
}

// 히스토리용: 위에 prepend
function prependMsg(role, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  div.innerHTML = makeBubbleHtml(role, text, false);
  // sentinel 다음에 삽입
  const sentinel = document.getElementById('history-sentinel');
  if (sentinel && sentinel.nextSibling) {
    msgArea.insertBefore(div, sentinel.nextSibling);
  } else {
    msgArea.prepend(div);
  }
  return div;
}

function addStreamingMsg() {
  const opts = msgArea.querySelector('.quick-btns');
  if (opts) opts.remove();
  const div = document.createElement('div');
  div.className = 'msg assistant';
  div.innerHTML = '<div class="bubble streaming-cursor"></div><div class="meta"></div>';
  msgArea.appendChild(div);
  return div;
}

function updateStreamingMsg(div, text) {
  if (!div) return;
  const bubble = div.querySelector('.bubble');
  bubble.innerHTML = formatText(text);
  bubble.classList.add('streaming-cursor');
  msgArea.scrollTop = msgArea.scrollHeight;
}

function finalizeStreamingMsg(div, text) {
  if (!div) return;
  const bubble = div.querySelector('.bubble');
  // 접어두기 적용
  const lines = text.split('\\n').length;
  const needCollapse = lines > COLLAPSE_LINES || text.length > COLLAPSE_CHARS;
  bubble.innerHTML = formatText(text);
  bubble.setAttribute('data-full-text', encodeURIComponent(text));
  if (needCollapse) {
    bubble.classList.add('collapsed');
    const btn = document.createElement('button');
    btn.className = 'expand-btn';
    btn.textContent = '\\u25BC 더보기 (' + lines + '줄)';
    btn.onclick = function() { toggleCollapse(this); };
    bubble.parentNode.insertBefore(btn, bubble.nextSibling);
  }
  bubble.classList.remove('streaming-cursor');
  const meta = div.querySelector('.meta');
  meta.textContent = new Date().toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'});
  if (isNearBottom) { msgArea.scrollTop = msgArea.scrollHeight; }
  else { notifyNewMessage(); }
}

const THINKING_VERBS = ['생각 중', '고민 중', '사색 중', '숙고 중', '정리 중', '분석 중', '탐색 중', '검토 중'];
let verbTimer = null, lastTokenCount = 0, verbIdx = 0;
const verbEl = () => document.getElementById('thinking-verb');
const tokenEl = () => document.getElementById('tokens-display');

function fmtElapsed(s) {
  if (s < 60) return s + '초';
  return Math.floor(s/60) + '분 ' + (s%60) + '초';
}
function fmtTokens(n) {
  if (!n) return '';
  if (n >= 1000) return ' · \\u2193 ' + (n/1000).toFixed(1) + 'k tokens';
  return ' · \\u2193 ' + n + ' tokens';
}
function updateTokens(n) {
  if (n && n !== lastTokenCount) {
    lastTokenCount = n;
    tokenEl().textContent = fmtTokens(n);
  }
}

function showTyping() {
  typingEl.classList.add('show');
  let sec = 0;
  verbIdx = 0; lastTokenCount = 0;
  verbEl().textContent = THINKING_VERBS[0];
  elapsedEl.textContent = '0초';
  tokenEl().textContent = '';
  timer = setInterval(() => { sec++; elapsedEl.textContent = fmtElapsed(sec); }, 1000);
  verbTimer = setInterval(() => {
    verbIdx = (verbIdx + 1) % THINKING_VERBS.length;
    verbEl().textContent = THINKING_VERBS[verbIdx];
  }, 2500);
  msgArea.scrollTop = msgArea.scrollHeight;
}
function hideTyping() {
  typingEl.classList.remove('show');
  if (timer) { clearInterval(timer); timer = null; }
  if (verbTimer) { clearInterval(verbTimer); verbTimer = null; }
  elapsedEl.textContent = '';
  tokenEl().textContent = '';
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function cancelRequest() {
  stopPolling();
  fetch('/api/cancel', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({token:TOKEN}) });
  hideTyping();
  if (streamDiv && fullText) {
    finalizeStreamingMsg(streamDiv, fullText + '\\n\\n(중단됨)');
  } else {
    addMsg('system', '요청이 중단되었습니다.');
  }
  streamDiv = null; fullText = ''; lastPollIdx = 0;
  busy = false; sendBtn.disabled = false;
}

function formatText(text) {
  text = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  text = text.replace(/\\*\\*(.+?)\\*\\*/g, '<b>$1</b>');
  text = text.replace(/^### (.+)$/gm, '<b style="color:#f9e2af">$1</b>');
  text = text.replace(/^## (.+)$/gm, '<b style="color:#89b4fa;font-size:16px">$1</b>');
  text = text.replace(/^- (.+)$/gm, '  \\u2022 $1');
  text = text.replace(/^---$/gm, '\\u2500'.repeat(13));
  return text;
}

// 폴링으로 응답 가져오기
async function pollResponse() {
  try {
    const r = await fetch('/api/poll?token='+TOKEN+'&from='+lastPollIdx);
    if (!r.ok) return;
    const data = await r.json();

    if (data.chunks && data.chunks.length > 0) {
      // 첫 청크 도착 시 스트리밍 버블 생성 (타이핑 인디케이터는 done 시까지 유지 — 토큰/시간 카운트 계속 보이게)
      if (!streamDiv) {
        streamDiv = addStreamingMsg();
      }
      for (const c of data.chunks) {
        fullText += c;
      }
      lastPollIdx = data.index;
      updateStreamingMsg(streamDiv, fullText);
    }
    if (typeof data.tokens === 'number') updateTokens(data.tokens);

    if (data.done) {
      stopPolling();
      hideTyping();
      if (streamDiv) {
        finalizeStreamingMsg(streamDiv, fullText || '(응답 없음)');
      } else if (fullText) {
        addMsg('assistant', fullText);
      } else {
        addMsg('assistant', '(응답 없음)');
      }
      streamDiv = null; fullText = ''; lastPollIdx = 0;
      busy = false; sendBtn.disabled = false; msgInput.focus();
    }

    if (data.error) {
      stopPolling();
      hideTyping();
      addMsg('assistant', 'Error: ' + data.error);
      streamDiv = null; fullText = ''; lastPollIdx = 0;
      busy = false; sendBtn.disabled = false;
    }
  } catch(e) {
    // 폴링 실패는 무시 (다음 폴링에서 재시도)
  }
}

async function sendMessage() {
  const text = msgInput.value.trim();
  if (!text || busy) return;
  busy = true; sendBtn.disabled = true;
  msgInput.value = ''; msgInput.style.height = 'auto';
  addMsg('user', text);
  showTyping();

  // 상태 초기화
  streamDiv = null; fullText = ''; lastPollIdx = 0;

  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({token:TOKEN, message:text})
    });
    const data = await r.json();

    if (data.immediate) {
      // exit, clear 등 즉시 응답
      hideTyping();
      if (data.clear) {
        msgArea.innerHTML = '';
        addMsg('system', data.response);
      } else {
        addMsg('system', data.response);
      }
      busy = false; sendBtn.disabled = false;
      return;
    }

    if (data.error) {
      hideTyping();
      addMsg('assistant', 'Error: ' + data.error);
      busy = false; sendBtn.disabled = false;
      return;
    }

    // 비동기 처리 시작됨 → 폴링 시작
    pollTimer = setInterval(pollResponse, 500);

  } catch(e) {
    hideTyping();
    addMsg('assistant', '네트워크 오류: ' + e.message);
    busy = false; sendBtn.disabled = false;
  }
}

// 페이지 복귀 시 진행 중인 응답 자동 복구
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && busy && !pollTimer) {
    // 앱으로 돌아왔는데 폴링이 멈춰있으면 재시작
    pollTimer = setInterval(pollResponse, 500);
    pollResponse(); // 즉시 한번 실행
  }
});

// 세션 관리
async function showSessions() {
  const panel = document.getElementById('session-panel');
  const list = document.getElementById('sp-list');
  list.innerHTML = '<div style="padding:20px;color:#6c7086">로딩 중...</div>';
  panel.classList.add('show');
  const r = await fetch('/api/sessions?token='+TOKEN);
  const data = await r.json();
  if (!data.sessions || !data.sessions.length) {
    list.innerHTML = '<div style="padding:20px;color:#6c7086">저장된 세션이 없습니다.</div>';
    return;
  }
  list.innerHTML = data.sessions.map(s =>
    '<div class="sp-item" onclick="resumeSession(\\'' + s.id + '\\')">' +
    '<div class="sp-date">' + s.date + '</div>' +
    '<div class="sp-proj">' + s.project + '</div>' +
    '<div class="sp-summary">' + (s.summary || '(요약 없음)') + '</div></div>'
  ).join('');
}
function closeSessions() { document.getElementById('session-panel').classList.remove('show'); }

// ── 히스토리 로드 ──
let currentSessionId = null;
let historyOffset = 0;
let historyHasMore = false;
let historyLoading = false;
let historyObserver = null;

async function resumeSession(sid) {
  closeSessions();
  currentSessionId = sid;
  historyOffset = 0;
  historyHasMore = false;

  await fetch('/api/resume', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({token:TOKEN, sessionId:sid}) });

  document.getElementById('chat-title').textContent = 'AI Assistant (이어가기)';
  msgArea.innerHTML = '';

  // 최근 20개 로드
  await loadHistory(sid, true);
}

async function loadHistory(sid, isInitial) {
  if (historyLoading) return;
  historyLoading = true;

  const sentinel = document.getElementById('history-sentinel');
  if (sentinel) { sentinel.textContent = '로딩 중...'; sentinel.classList.add('loading'); }

  try {
    const r = await fetch('/api/history?token='+TOKEN+'&sessionId='+sid+'&offset='+historyOffset+'&limit=20');
    const data = await r.json();

    if (!data.messages || !data.messages.length) {
      if (sentinel) { sentinel.textContent = '대화 시작'; sentinel.classList.remove('loading'); }
      historyHasMore = false;
      historyLoading = false;
      return;
    }

    historyHasMore = data.hasMore;
    historyOffset += data.messages.length;

    if (isInitial) {
      // 최초 로드: sentinel 추가 후 메시지 append
      if (historyHasMore) {
        msgArea.innerHTML = '<div id="history-sentinel">\\u25B2 이전 대화</div>';
      } else {
        msgArea.innerHTML = '<div class="history-start">\\u2500 대화 시작 \\u2500</div>';
      }
      for (const m of data.messages) {
        const div = document.createElement('div');
        div.className = 'msg ' + m.role;
        div.innerHTML = makeBubbleHtml(m.role, m.text, false);
        msgArea.appendChild(div);
      }
      msgArea.scrollTop = msgArea.scrollHeight;
      setupHistoryObserver();
    } else {
      // 추가 로드: 위에 prepend (스크롤 보정)
      const prevHeight = msgArea.scrollHeight;
      const prevTop = msgArea.scrollTop;

      // 역순으로 prepend (오래된 것이 위로)
      const afterSentinel = sentinel ? sentinel.nextSibling : msgArea.firstChild;
      for (let i = data.messages.length - 1; i >= 0; i--) {
        const m = data.messages[i];
        const div = document.createElement('div');
        div.className = 'msg ' + m.role;
        div.innerHTML = makeBubbleHtml(m.role, m.text, false);
        msgArea.insertBefore(div, afterSentinel);
      }

      if (!historyHasMore) {
        // 더 이상 없으면 sentinel을 "대화 시작"으로 변경
        if (sentinel) {
          sentinel.outerHTML = '<div class="history-start">\\u2500 대화 시작 \\u2500</div>';
        }
      } else {
        if (sentinel) { sentinel.textContent = '\\u25B2 이전 대화'; sentinel.classList.remove('loading'); }
      }

      // 스크롤 보정: 추가된 높이만큼 스크롤 유지
      const addedHeight = msgArea.scrollHeight - prevHeight;
      msgArea.scrollTop = prevTop + addedHeight;
    }
  } catch(e) {
    console.error('History load error:', e);
    if (sentinel) { sentinel.textContent = '로드 실패 (탭하여 재시도)'; sentinel.classList.remove('loading'); }
  }
  historyLoading = false;
}

function setupHistoryObserver() {
  if (historyObserver) historyObserver.disconnect();

  const sentinel = document.getElementById('history-sentinel');
  if (!sentinel || !historyHasMore) return;

  let debounceTimer = null;

  historyObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting && historyHasMore && !historyLoading) {
        // 디바운스 0.5초
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          loadHistory(currentSessionId, false).then(() => {
            // 로드 후 observer 재설정 (sentinel이 교체될 수 있으므로)
            const newSentinel = document.getElementById('history-sentinel');
            if (newSentinel && historyHasMore) {
              historyObserver.observe(newSentinel);
            }
          });
        }, 500);
      }
    }
  }, { root: msgArea, threshold: 0.1 });

  historyObserver.observe(sentinel);
}
</script>
</body></html>`);
});

// ══════════════════════════════════════════════
// API: 폴링 기반 Chat
// ══════════════════════════════════════════════

// 요청 접수 (즉시 리턴, 서버에서 비동기 처리)
app.post('/api/chat', (req, res) => {
  const token = isValidToken(req);
  if (!token) return res.json({ error: 'Unauthorized' });
  const { message } = req.body;

  const conv = conversations.get(token);
  if (!conv) return res.json({ error: 'Invalid session' });

  // 클라이언트 명령
  const trimmed = (message || '').trim().toLowerCase();
  if (['exit', 'quit', '/exit', '/quit'].includes(trimmed)) {
    conv.isFirst = true; conv.resumeId = null;
    return res.json({ immediate: true, response: '세션을 종료했습니다.' });
  }
  if (trimmed === '/clear') {
    conv.isFirst = true; conv.resumeId = null;
    return res.json({ immediate: true, clear: true, response: '대화를 초기화했습니다.' });
  }

  if (conv.busy) return res.json({ error: '이전 요청 처리 중입니다.' });
  conv.busy = true;

  // 응답 버퍼 초기화
  responseBuffers.set(token, { chunks: [], done: false, error: null, tokens: 0 });

  // 셸 명령
  if (message.trim().startsWith('!')) {
    const cmd = message.trim().slice(1).trim();
    console.log(`[${new Date().toISOString()}] shell: ${cmd}`);
    const proc = spawn('bash', ['-c', cmd], {
      cwd: conv.cwd || WORK_DIR,
      env: Object.assign({}, process.env, { TERM: 'dumb' }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    activeProcs.set(token, proc);
    const buf = responseBuffers.get(token);

    proc.stdout.on('data', d => { buf.chunks.push(d.toString('utf8')); });
    proc.stderr.on('data', d => { buf.chunks.push(d.toString('utf8')); });
    proc.on('close', code => {
      activeProcs.delete(token); conv.busy = false;
      if (code !== 0) buf.chunks.push(`\n(exit code: ${code})`);
      buf.done = true;
    });
    proc.on('error', err => {
      activeProcs.delete(token); conv.busy = false;
      buf.error = err.message; buf.done = true;
    });
    const t = setTimeout(() => { proc.kill(); }, 60000);
    proc.on('close', () => clearTimeout(t));

    return res.json({ ok: true });
  }

  // Claude 실행
  // 모바일 UI엔 권한 승인 프롬프트가 없으므로 모든 권한 검사를 우회.
  // 본인 PC에서 본인 자격증명으로 돌리는 단일 사용자 환경이라 안전 (셸 `!` 명령과 동일한 위협 모델).
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
  if (conv.resumeId) { args.push('--resume', conv.resumeId); conv.resumeId = null; }
  else if (!conv.isFirst) { args.push('-c'); }
  args.push(message);

  console.log(`[${new Date().toISOString()}] chat: ${args.map(a=>a.length>40?a.slice(0,40)+'...':a).join(' ')}`);

  const proc = spawn(CLAUDE_PATH, args, {
    cwd: conv.cwd || WORK_DIR,
    env: Object.assign({}, process.env, { TERM: 'dumb', NO_COLOR: '1' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  activeProcs.set(token, proc);
  const buf = responseBuffers.get(token);

  let stdoutBuf = '';
  let stderrBuf = '';
  proc.stdout.on('data', d => {
    stdoutBuf += d.toString('utf8');
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'assistant' && obj.message?.content) {
          for (const block of obj.message.content) {
            if (block.type === 'text' && block.text) buf.chunks.push(block.text);
          }
          if (obj.message?.usage?.output_tokens) {
            buf.tokens += obj.message.usage.output_tokens;
          }
        } else if (obj.type === 'result' && obj.result && buf.chunks.length === 0) {
          buf.chunks.push(obj.result);
        }
      } catch (_) {
        if (line.trim()) buf.chunks.push(line);
      }
    }
  });

  proc.stderr.on('data', d => {
    const s = d.toString('utf8');
    stderrBuf += s;
    console.log(`[stderr] ${s.trim()}`);
  });

  const timeout = setTimeout(() => {
    proc.kill(); conv.busy = false; activeProcs.delete(token);
    buf.error = '시간 초과 (5분)'; buf.done = true;
  }, 300000);

  proc.on('close', code => {
    clearTimeout(timeout); activeProcs.delete(token);
    conv.busy = false; conv.isFirst = false;
    // 잔여 버퍼
    if (stdoutBuf.trim()) {
      try {
        const obj = JSON.parse(stdoutBuf);
        if (obj.type === 'assistant' && obj.message?.content) {
          for (const block of obj.message.content) {
            if (block.type === 'text' && block.text) buf.chunks.push(block.text);
          }
        } else if (obj.type === 'result' && obj.result && buf.chunks.length === 0) {
          buf.chunks.push(obj.result);
        }
      } catch (_) {
        if (stdoutBuf.trim()) buf.chunks.push(stdoutBuf.trim());
      }
    }
    // Claude가 비정상 종료(exit != 0)했고 출력도 비었으면 stderr를 사용자에게 노출
    if (code !== 0 && buf.chunks.length === 0 && stderrBuf.trim()) {
      buf.error = `Claude 종료 코드 ${code}\n${stderrBuf.trim()}`;
    }
    buf.done = true;
    console.log(`[${new Date().toISOString()}] done code=${code} chunks=${buf.chunks.length}`);
  });

  proc.on('error', err => {
    clearTimeout(timeout); activeProcs.delete(token); conv.busy = false;
    buf.error = err.message; buf.done = true;
  });

  return res.json({ ok: true });
});

// 폴링: 새 청크 가져가기
app.get('/api/poll', (req, res) => {
  const token = isValidToken(req);
  if (!token) return res.json({ error: 'Unauthorized' });
  const from = parseInt(req.query.from) || 0;

  const buf = responseBuffers.get(token);
  if (!buf) return res.json({ chunks: [], done: true, index: 0 });

  const newChunks = buf.chunks.slice(from);
  const result = {
    chunks: newChunks,
    index: buf.chunks.length,
    done: buf.done,
    error: buf.error,
    tokens: buf.tokens || 0
  };

  if (buf.done && from >= buf.chunks.length) {
    responseBuffers.delete(token);
  }

  res.json(result);
});

// 취소
app.post('/api/cancel', (req, res) => {
  const token = isValidToken(req);
  if (!token) return res.json({ error: 'Unauthorized' });
  const proc = activeProcs.get(token);
  if (proc) { proc.kill(); activeProcs.delete(token); }
  const conv = conversations.get(token);
  if (conv) conv.busy = false;
  const buf = responseBuffers.get(token);
  if (buf) { buf.done = true; }
  res.json({ ok: true });
});

// History
app.get('/api/history', (req, res) => {
  const token = isValidToken(req);
  if (!token) return res.json({ error: 'Unauthorized' });
  const sessionId = req.query.sessionId;
  const offset = parseInt(req.query.offset) || 0;
  const limit = parseInt(req.query.limit) || 20;
  if (!sessionId) return res.json({ error: 'sessionId required' });
  res.json(getSessionHistory(sessionId, offset, limit));
});

// Sessions
app.get('/api/sessions', (req, res) => {
  const token = isValidToken(req);
  if (!token) return res.json({ error: 'Unauthorized' });
  res.json({ sessions: getRecentSessions(20) });
});

// Resume
app.post('/api/resume', (req, res) => {
  const token = isValidToken(req);
  if (!token) return res.json({ error: 'Unauthorized' });
  const { sessionId } = req.body;
  const conv = conversations.get(token);
  if (conv) {
    conv.isFirst = true; conv.resumeId = sessionId; conv.busy = false;
    const sessCwd = getSessionCwd(sessionId);
    if (sessCwd) conv.cwd = sessCwd;
  }
  res.json({ ok: true });
});

// New chat
app.post('/api/new', (req, res) => {
  const token = isValidToken(req);
  if (!token) return res.json({ error: 'Unauthorized' });
  const proc = activeProcs.get(token);
  if (proc) { proc.kill(); activeProcs.delete(token); }
  conversations.set(token, { isFirst: true, busy: false, resumeId: null, cwd: WORK_DIR });
  responseBuffers.delete(token);
  res.json({ ok: true });
});

// Start
app.listen(PORT, '0.0.0.0', () => {
  console.log(`AI Assistant HTTP on http://0.0.0.0:${PORT} (redirect to HTTPS)`);
});
httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
  console.log(`AI Assistant HTTPS on https://0.0.0.0:${HTTPS_PORT}`);
});
