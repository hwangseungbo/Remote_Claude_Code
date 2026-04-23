# AI Assistant Mobile — 설치 가이드

> **이 문서 하나만 읽으면 됩니다.**
> Claude Code CLI를 아이폰에서 채팅처럼 사용할 수 있는 웹 UI입니다.

---

## 전체 흐름 (5단계)

```
1. Tailscale 설치 (PC + 아이폰)
2. 이 폴더에서 서버 세팅 (Claude에게 시키면 됨)
3. 아이폰에 인증서 설치
4. 아이폰 Safari에서 접속
5. 끝!
```

---

## 1단계: Tailscale 설치

Tailscale은 무료 VPN입니다. PC와 아이폰이 어디에 있든 서로 직접 연결해줍니다.
(같은 와이파이가 아니어도 됩니다. 회사/카페/LTE 어디서든 접속 가능)

### PC (Windows)

1. https://tailscale.com/download 접속
2. **Download for Windows** 클릭 → 설치
3. 설치 후 **Sign up** → Google/Microsoft/GitHub 아무거나로 가입
4. 로그인하면 시스템 트레이에 Tailscale 아이콘이 뜸
5. 아이콘 우클릭 → **Connected** 상태 확인
6. 아이콘 우클릭 → 본인 PC의 **IP 주소 확인** (100.x.x.x 형태)
   - 이 IP를 메모해두세요. 나중에 씁니다.

### 아이폰 (iOS)

1. App Store에서 **"Tailscale"** 검색 → 설치
2. 앱 열기 → **Log in** → PC에서 가입한 **같은 계정**으로 로그인
3. VPN 설정 허용 팝업 → **허용**
4. 연결되면 상단에 VPN 아이콘 뜸

### 확인

아이폰에서 Safari를 열고 `http://100.x.x.x:9000` (PC의 Tailscale IP) 접속해보세요.
아직 서버가 안 돌아가니 접속은 안 되지만, "연결할 수 없음"이 뜨면 정상입니다.
"서버를 찾을 수 없음"이 뜨면 Tailscale 연결을 다시 확인하세요.

---

## 2단계: 서버 세팅

### 방법 A: Claude에게 시키기 (추천)

터미널에서 이 폴더로 이동한 뒤 Claude Code를 실행하고, 아래 메시지를 **그대로 복사해서** 보내세요:

```
이 폴더에 AI Assistant Mobile 웹 서버를 세팅해줘.

순서:
1. npm install 실행
2. bash setup.sh 실행 — IP 입력하라고 나오면 내 Tailscale IP를 입력해줘.
   (Tailscale IP는 `tailscale ip -4` 명령어로 확인 가능)
   추가로 내 로컬 IP도 같이 넣어줘 (예: 100.x.x.x,192.168.x.x)
3. config.example.json을 config.json으로 복사
4. config.json 수정:
   - username과 password를 내가 원하는 값으로 (물어봐줘)
   - claude.path를 내 claude CLI 실제 경로로 설정
     (which claude 또는 where claude로 확인)
   - claude.workDir를 내 작업 디렉토리로 설정
5. node server.js로 서버 실행해서 테스트
6. Windows 방화벽에 9000, 9443 포트 인바운드 허용 추가

각 단계 결과를 보여줘.
```

### 방법 B: 직접 하기

```bash
# 이 폴더에서 실행

# 1. 의존성 설치
npm install

# 2. Tailscale IP 확인
tailscale ip -4
# 출력 예: 100.64.0.1

# 3. 인증서 생성
bash setup.sh
# IP 입력 프롬프트가 나오면 입력 (쉼표로 구분)
# 예: 100.64.0.1,192.168.0.100

# 4. 설정 파일 생성
cp config.example.json config.json
```

config.json을 에디터로 열어서 수정:

```json
{
  "auth": {
    "username": "원하는ID",
    "password": "원하는비밀번호"
  },
  "ports": {
    "http": 9000,
    "https": 9443
  },
  "claude": {
    "path": "여기에_claude_경로",
    "workDir": "여기에_작업폴더_경로"
  }
}
```

**claude 경로 확인 방법:**
```bash
# Windows (Git Bash / PowerShell)
where claude
# 또는
which claude

# 결과 예시:
# C:\Users\username\AppData\Local\Microsoft\WinGet\Packages\Anthropic.ClaudeCode_...\claude.exe
# 또는 npm 설치했으면 그냥 "claude"
```

```bash
# 5. Windows 방화벽 열기 (PowerShell 관리자 권한)
New-NetFirewallRule -DisplayName "AI Assistant HTTP" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 9000
New-NetFirewallRule -DisplayName "AI Assistant HTTPS" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 9443

# 6. 서버 실행
node server.js
```

정상이면 이런 메시지가 나옵니다:
```
AI Assistant HTTP  → http://0.0.0.0:9000 (redirects to HTTPS)
AI Assistant HTTPS → https://0.0.0.0:9443
```

---

## 3단계: 아이폰 인증서 설치

HTTPS 접속을 위해 아이폰에 인증서를 설치해야 합니다. **최초 1회만** 하면 됩니다.

> **중요: 반드시 Safari로 접속하세요.** Chrome/다른 브라우저에서는 인증서 설치가 안 됩니다.

### 3-1. 인증서 다운로드

아이폰 **Safari**에서 아래 주소 접속:

```
http://[PC의 Tailscale IP]:9000/install
```

예: `http://100.64.0.1:9000/install`

**"이 웹사이트가 구성 프로파일을 다운로드하려고 합니다"** → **허용** 탭

### 3-2. 프로파일 설치

1. 아이폰 **설정** 앱 열기
2. 상단에 **"프로파일이 다운로드됨"** 배너가 보임 → 탭
   - 안 보이면: **설정 → 일반 → VPN 및 기기 관리** → "AI Assistant CA" 탭
3. 우측 상단 **설치** 탭
4. 아이폰 잠금 비밀번호 입력
5. **설치** → **설치** (경고 한번 더 나옴) → **완료**

### 3-3. 인증서 신뢰 활성화

**이 단계를 빠뜨리면 HTTPS 접속이 안 됩니다!**

1. **설정 → 일반 → 정보** (맨 아래까지 스크롤)
2. 맨 아래 **인증서 신뢰 설정** 탭
3. **"AI Assistant CA"** 오른쪽 스위치를 **켜기** (초록색)
4. 경고 팝업 → **계속** 탭

---

## 4단계: 접속!

아이폰 Safari (또는 아무 브라우저)에서:

```
https://[PC의 Tailscale IP]:9443
```

예: `https://100.64.0.1:9443`

- 로그인 화면이 뜨면 config.json에 설정한 ID/PW 입력
- 채팅 화면 진입 → 메시지 입력 → AI가 응답

### 홈 화면에 추가 (앱처럼 사용)

1. Safari에서 접속한 상태에서
2. 하단 **공유 버튼** (네모에서 화살표 나오는 아이콘) 탭
3. **"홈 화면에 추가"** 탭
4. 이름 설정 → **추가**
5. 홈 화면에 앱 아이콘이 생김 → 탭하면 바로 접속

---

## 서버 자동 시작 (선택)

PC 켤 때마다 서버가 자동으로 시작되게 하려면:

### Claude에게 시키기

```
이 폴더의 server.js를 Windows 시작 시 자동 실행되게 설정해줘.
Startup 폴더에 VBS 스크립트를 만들어서 백그라운드로 실행되게 해줘.
```

### 직접 하기

1. `Win + R` → `shell:startup` 입력 → Enter
2. 열린 폴더에 `start_ai_assistant.vbs` 파일 생성:

```vbs
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "여기에_이_폴더_절대경로"
WshShell.Run "node server.js", 0, False
```

---

## 문제 해결

### "연결할 수 없음" / 접속이 안 됨

- [ ] PC에서 `node server.js`가 실행 중인지 확인
- [ ] Tailscale이 PC와 아이폰 모두 연결 상태인지 확인
- [ ] Windows 방화벽에서 9000, 9443 포트가 열려있는지 확인
- [ ] PC에서 `curl -sk https://localhost:9443` 쳐서 응답 오는지 확인

### 인증서 오류 / "이 연결은 비공개가 아닙니다"

- [ ] 3단계를 모두 완료했는지 확인 (특히 3-3 신뢰 활성화!)
- [ ] setup.sh 실행 시 입력한 IP가 실제 Tailscale IP와 일치하는지 확인
- [ ] IP가 바뀌었으면 `bash setup.sh`를 다시 실행하고 인증서도 다시 설치

### 응답이 안 옴 / 타임아웃

- [ ] Claude Code CLI가 정상 동작하는지 확인: `claude -p "hello"`
- [ ] config.json의 claude.path가 정확한지 확인

### Tailscale IP 확인 방법

```bash
# PC에서
tailscale ip -4

# 또는 Tailscale 트레이 아이콘 우클릭 → IP 주소 복사
```

---

## Android에서 사용하기

Android는 인증서 설치 방법만 다르고 나머지는 동일합니다.

### 인증서 설치 (Android)

1. Chrome에서 `http://[PC의 Tailscale IP]:9000/ca.crt` 접속 → 다운로드
2. **설정 → 보안 → 암호화 및 사용자 인증 정보** (기기마다 경로 다름)
   - Samsung: **설정 → 생체 인식 및 보안 → 기타 보안 설정 → 인증서 설치**
   - Pixel: **설정 → 보안 → 암호화 및 사용자 인증 정보 → 인증서 설치**
3. 다운로드한 `CA.crt` 파일 선택
4. 이름: "AI Assistant CA" 입력
5. 용도: **VPN 및 앱** 또는 **Wi-Fi** 선택
6. **확인**

이후 Chrome에서 `https://[PC의 Tailscale IP]:9443` 접속.

> Android는 기기/제조사마다 설정 경로가 다릅니다.
> "인증서 설치"를 설정 검색창에서 검색하면 빠릅니다.

---

## 파일 구조

```
ai-assistant-mobile/
├── server.js              ← 메인 서버
├── config.example.json    ← 설정 템플릿 (복사해서 config.json 생성)
├── config.json            ← 실제 설정 (직접 생성, git 제외)
├── setup.sh               ← 인증서 생성 스크립트
├── package.json           ← npm 의존성
├── .gitignore             ← git 제외 목록
├── certs/                 ← 인증서 (setup.sh가 생성, git 제외)
│   ├── ca.crt, ca.key
│   ├── server.crt, server.key
│   └── ca.mobileconfig
├── README.md              ← 기술 문서
└── SETUP_GUIDE.md         ← 이 파일
```
