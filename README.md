# AI Assistant Mobile v2

Claude Code CLI를 모바일(iPhone/Android)에서 사용할 수 있는 채팅 스타일 웹 UI.

## Features

- **HTTPS** — 자체 서명 CA 인증서 기반, iOS Safari 완벽 호환
- **iOS 최적화** — visualViewport 키보드 대응, safe-area, 스크롤 위치 보존
- **폴링 기반 응답** — iOS 백그라운드 전환 시에도 응답 유실 없음
- **실시간 스트리밍** — `claude -p --output-format stream-json` 기반, 응답이 점진적으로 표시
- **중단 기능** — 응답 대기 중 "중단" 버튼으로 즉시 프로세스 kill
- **셸 명령** — `!ls`, `!git status` 등 `!` 접두어로 bash 직접 실행
- **세션 관리** — 이전 대화 목록 조회 및 이어가기 (resume)
- **히스토리 로드** — 세션 resume 시 이전 대화 자동 로드, 위로 스크롤하면 추가 로드
- **긴 메시지 접어두기** — 15줄/500자 초과 시 자동 접기, 탭으로 펼치기/접기
- **스크롤 네비** — 플로팅 ▲▼ 버튼, 새 메시지 도착 알림
- **로그인 유지** — 쿠키 기반 7일 (config.json에서 변경 가능)
- **커스텀 퀵버튼** — config.json에서 자유롭게 설정

## Requirements

- **Node.js** 18+
- **Claude Code CLI** (`claude`) 설치 및 로그인 완료
- **openssl** (인증서 생성용)

## Quick Start

```bash
# 1. 의존성 설치
npm install

# 2. 인증서 생성 (IP 입력 필요)
bash setup.sh

# 3. 설정 파일 생성
cp config.example.json config.json
# config.json 편집 — username, password, claude 경로 등

# 4. Windows 방화벽 9000/9443 포트 허용 (모바일 접속에 필수)
#    탐색기에서 enable_firewall.bat 더블클릭 → UAC "예"
#    (자동 권한 상승, 두 규칙 등록 + 검증 출력까지 한 번에)

# 5. 서버 실행
node server.js
```

또는 Claude Code에서 이 폴더를 열고:
```
이 폴더의 CLAUDE_INSTRUCTIONS.md를 읽고 그대로 실행해줘
```

## config.json

```json
{
  "auth": {
    "username": "admin",
    "password": "changeme"
  },
  "ports": {
    "http": 9000,
    "https": 9443
  },
  "claude": {
    "path": "claude",
    "workDir": "."
  },
  "session": {
    "tokenExpiry": 604800,
    "timeout": 300000
  },
  "quickButtons": [
    { "label": "오늘 할일", "prompt": "오늘 할일" },
    { "label": "프로젝트 현황", "prompt": "프로젝트 현황" }
  ]
}
```

| 설정 | 설명 |
|------|------|
| `auth` | 로그인 ID/PW |
| `ports.http` | HTTP 포트 (HTTPS로 리다이렉트) |
| `ports.https` | HTTPS 메인 포트 |
| `claude.path` | Claude CLI 경로 (`which claude`로 확인) |
| `claude.workDir` | Claude 작업 디렉토리 |
| `session.tokenExpiry` | 로그인 유지 시간 (초, 기본 7일=604800) |
| `session.timeout` | 응답 타임아웃 (ms, 기본 5분=300000) |
| `quickButtons` | 채팅 화면 퀵버튼 (자유롭게 추가/삭제) |

### Claude CLI 경로 예시

| OS | 설치 방법 | 경로 |
|----|-----------|------|
| Windows | winget | `C:/Users/<user>/AppData/Local/Microsoft/WinGet/Packages/Anthropic.ClaudeCode_.../claude.exe` |
| Windows | npm | `claude` (PATH에 등록됨) |
| macOS/Linux | npm | `claude` |

## iOS에서 접속하기

### 사전 조건
- PC와 iPhone이 같은 네트워크에 있거나 Tailscale VPN 연결

### 인증서 설치 (최초 1회)

1. iPhone **Safari**에서 `http://<서버IP>:9000/install` 접속
2. "구성 프로파일 다운로드" → **허용**
3. **설정 → 일반 → VPN 및 기기 관리** → "AI Assistant CA" → **설치**
4. **설정 → 일반 → 정보 → 인증서 신뢰 설정** → **AI Assistant CA 켜기**

### 접속

`https://<서버IP>:9443`

### 홈 화면에 추가 (앱처럼 사용)

Safari → 공유 버튼 → "홈 화면에 추가"

## 사용법

| 명령 | 동작 |
|------|------|
| 일반 메시지 | Claude에게 질문/요청 |
| `!ls` `!git status` | 셸 명령 직접 실행 |
| `exit` `/exit` | 세션 종료 (새 대화 시작) |
| `/clear` | 화면 초기화 |
| 세션 버튼 | 이전 세션 목록 → 이어가기 |
| 새 대화 버튼 | 새 세션 시작 |
| 나가기 버튼 | 로그아웃 |

## 네트워크 옵션

| 방법 | 장점 | 단점 |
|------|------|------|
| **Tailscale** | 어디서나 접속, 무료, 설정 간단 | 양쪽 앱 설치 필요 |
| **같은 공유기** | 추가 설치 없음 | 외부 접속 불가 |
| **포트포워딩** | 어디서나 접속 | 공유기 설정 필요, 보안 주의 |

## 파일 구조

```
ai-assistant-mobile/
├── server.js              ← 메인 서버
├── config.example.json    ← 설정 템플릿
├── config.json            ← 실제 설정 (직접 생성, git 제외)
├── setup.sh               ← 인증서 생성 스크립트
├── enable_firewall.bat    ← Windows 방화벽 자동 설정 (UAC 자동 권한 상승)
├── package.json           ← npm 의존성
├── .gitignore
├── certs/                 ← 인증서 (setup.sh가 생성)
├── SETUP_GUIDE.md         ← 상세 설치 가이드
├── CLAUDE_INSTRUCTIONS.md ← Claude 자동 세팅 지침
├── CLAUDE.md              ← Claude Code 작업용 코드베이스 가이드
└── README.md              ← 이 파일
```

## License

MIT

---

_Last updated: 2026-04-23 15:30 (KST)_
