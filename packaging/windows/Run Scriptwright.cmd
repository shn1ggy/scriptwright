@echo off
rem Starts Scriptwright (downloads the Electron runtime on the first start).
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=%windir%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" (
  echo Windows PowerShell was not found at %PS%
  pause
  exit /b 1
)
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
if errorlevel 1 pause
