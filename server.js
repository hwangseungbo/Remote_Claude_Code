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

  // 퀵버튼 HTML 사전 렌더 (config.json의 quickButtons 배열)
  const quickButtons = (config.quickButtons || [])
    .map(b => '<button onclick="quickSend(\'' + b.prompt.replace(/'/g, "\\'") + '\')">' + b.label + '</button>')
    .join('\n      ');

  // public/chat.html 로드 + ${token}, ${quickButtons} 치환 (매 요청 — 편집 후 새로고침만으로 반영됨)
  let html;
  try {
    html = fs.readFileSync(path.join(__dirname, 'public', 'chat.html'), 'utf8');
  } catch (e) {
    console.error('Template load failed:', e.message);
    return res.status(500).send('chat.html template not found');
  }
  html = html
    .replace(/\$\{token\}/g, () => token)
    .replace(/\$\{quickButtons\}/g, () => quickButtons);
  res.send(html);
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
  responseBuffers.set(token, { chunks: [], done: false, error: null, tokens: 0, model: null });

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
          if (obj.message?.model && !buf.model) {
            buf.model = obj.message.model;
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
    tokens: buf.tokens || 0,
    model: buf.model || null
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
