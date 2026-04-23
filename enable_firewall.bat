@echo off
chcp 65001 >nul
title AI Assistant - Firewall Setup

REM Self-elevate to admin
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo Requesting administrator privileges...
    powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

echo.
echo ===========================================
echo  AI Assistant - Windows Firewall Setup
echo ===========================================
echo.

REM Remove any old rules with the same name (idempotent)
powershell -NoProfile -Command "Get-NetFirewallRule -DisplayName 'AI Assistant*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule"

REM Add rules
powershell -NoProfile -Command "New-NetFirewallRule -DisplayName 'AI Assistant HTTP'  -Direction Inbound -Action Allow -Protocol TCP -LocalPort 9000 | Out-Null; Write-Host '[OK] HTTP  port 9000 allowed' -ForegroundColor Green"
powershell -NoProfile -Command "New-NetFirewallRule -DisplayName 'AI Assistant HTTPS' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 9443 | Out-Null; Write-Host '[OK] HTTPS port 9443 allowed' -ForegroundColor Green"

echo.
echo ===========================================
echo  Verification:
echo ===========================================
powershell -NoProfile -Command "Get-NetFirewallRule -DisplayName 'AI Assistant*' | Format-Table DisplayName, Enabled, Direction, Action -AutoSize"

echo.
echo Done. Press any key to close.
pause >nul
