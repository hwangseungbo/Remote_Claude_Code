# Claude Instructions — AI Assistant Mobile 자동 세팅

> **이 파일은 Claude Code CLI가 읽고 실행하기 위한 지침입니다.**
> 사용자에게: Claude Code에서 이 폴더를 열고 아래 명령을 그대로 입력하세요.
>
> ```
> 이 폴더의 CLAUDE_INSTRUCTIONS.md를 읽고 그대로 실행해줘
> ```

---

## 목표

이 폴더에 있는 AI Assistant Mobile 웹 서버를 세팅한다.
완료되면 사용자의 아이폰에서 Claude Code를 채팅 UI로 사용할 수 있다.

## 실행 순서

### Step 1: 의존성 설치

```bash
npm install
```

### Step 2: 네트워크 정보 수집

```bash
# Tailscale IP 확인 (Tailscale이 설치되어 있어야 함)
tailscale ip -4

# 로컬 IP 확인 (Windows)
ipconfig | grep -E "IPv4|192\\.168|10\\."
# 또는
hostname -I  # Linux/macOS
```

- Tailscale이 설치 안 되어 있으면 사용자에게 안내:
  - https://tailscale.com/download 에서 설치
  - 가입 후 로그인
  - `tailscale ip -4`로 IP 확인
- 아이폰에도 Tailscale 앱 설치 + 같은 계정 로그인 필요

### Step 3: 인증서 생성

```bash
bash setup.sh
```

- IP 입력 프롬프트가 나오면 Step 2에서 확인한 IP를 쉼표로 구분하여 입력
- 예: `100.64.0.1,192.168.0.100`
- Tailscale IP는 반드시 포함할 것

### Step 4: 설정 파일 생성

```bash
cp config.example.json config.json
```

config.json을 아래와 같이 수정:

```json
{
  "auth": {
    "username": "사용자에게 물어볼 것",
    "password": "사용자에게 물어볼 것"
  },
  "ports": {
    "http": 9000,
    "https": 9443
  },
  "claude": {
    "path": "claude CLI 실제 경로 (which claude 또는 where claude로 확인)",
    "workDir": "사용자의 주 작업 디렉토리 (사용자에게 물어볼 것)"
  },
  "session": {
    "tokenExpiry": 86400,
    "timeout": 300000
  },
  "quickButtons": [
    { "label": "오늘 할일", "prompt": "오늘 할일" },
    { "label": "프로젝트 현황", "prompt": "프로젝트 현황" }
  ]
}
```

**사용자에게 물어볼 것:**
1. 로그인 ID/PW를 뭘로 할지
2. Claude가 기본으로 작업할 폴더 경로
3. 퀵버튼에 넣고 싶은 명령이 있는지

**자동으로 채울 것:**
- `claude.path`: `which claude` 또는 `where claude` 결과
- 포트는 기본값 유지 (충돌 시 변경)

### Step 5: Windows 방화벽

관리자 권한이 필요하다. PowerShell 관리자 실행이 안 되면 사용자에게 직접 하도록 안내.

```powershell
# PowerShell (관리자)
New-NetFirewallRule -DisplayName "AI Assistant HTTP" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 9000
New-NetFirewallRule -DisplayName "AI Assistant HTTPS" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 9443
```

### Step 6: 서버 실행 테스트

```bash
node server.js
```

정상 출력:
```
AI Assistant HTTP  → http://0.0.0.0:9000 (redirects to HTTPS)
AI Assistant HTTPS → https://0.0.0.0:9443
```

로컬 테스트:
```bash
curl -sk https://localhost:9443
```

HTML이 출력되면 성공.

### Step 7: 사용자에게 아이폰 설정 안내

서버가 정상 실행되면 사용자에게 아래 내용을 전달:

---

**아이폰 설정 (3분이면 끝)**

1. **Tailscale 앱**이 연결 상태인지 확인 (상단 VPN 아이콘)

2. **Safari**에서 아래 주소 접속 (Chrome 안 됨!):
   `http://[Tailscale IP]:9000/install`

3. **"구성 프로파일 다운로드"** 팝업 → **허용**

4. **설정** 앱 열기 → 상단에 **"프로파일이 다운로드됨"** 배너 탭
   → 우측 상단 **설치** → 비밀번호 입력 → **설치** → **완료**

5. **설정 → 일반 → 정보** → 맨 아래 **인증서 신뢰 설정**
   → **"AI Assistant CA"** 스위치 **켜기** → **계속**

6. Safari에서 접속:
   `https://[Tailscale IP]:9443`

7. 로그인 → 채팅 시작!

---

[Tailscale IP]는 Step 2에서 확인한 PC의 Tailscale IP (100.x.x.x)로 대체.

### Step 8: 자동 시작 설정 (선택)

사용자가 원하면 Windows 시작 시 자동 실행 설정:

```bash
# Startup 폴더 경로
STARTUP_DIR="$(cmd.exe /c 'echo %APPDATA%' 2>/dev/null | tr -d '\r')/Microsoft/Windows/Start Menu/Programs/Startup"
```

VBS 파일 생성:
```vbs
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "이_폴더의_절대경로"
WshShell.Run "node server.js", 0, False
```

## 주의사항

- `config.json`과 `certs/` 폴더에는 인증 정보가 있으므로 git에 올리지 말 것
- 포트 9000/9443이 다른 프로그램과 충돌하면 config.json에서 변경 가능
- Tailscale IP가 바뀌는 경우는 거의 없지만, 바뀌면 setup.sh 재실행 + 인증서 재설치 필요
