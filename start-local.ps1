# Start L12 with the user-local Node at %USERPROFILE%\.local\nodejs.
# No admin rights and no Program Files install.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$NodeDir = Join-Path $env:USERPROFILE ".local\nodejs"
$Python = Join-Path $Root ".venv\Scripts\python.exe"

if (-not (Test-Path (Join-Path $NodeDir "node.exe"))) {
    throw "Portable Node not found at $NodeDir. Extract the Windows x64 zip from https://nodejs.org/dist/ into that folder."
}
if (-not (Test-Path $Python)) {
    throw "Python venv missing at $Python. From the repo root: python -m venv .venv; .\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt"
}

$env:Path = "$NodeDir;" + $env:Path
$env:API_PROXY = "http://127.0.0.1:8000"

function Listening($port) {
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    return [bool]$conns
}

if (-not (Listening 8000)) {
    Start-Process -FilePath $Python -ArgumentList "-m","uvicorn","app.main:app","--reload","--host","127.0.0.1","--port","8000" -WorkingDirectory (Join-Path $Root "backend") -WindowStyle Minimized
}

if (-not (Listening 3000)) {
    Start-Process -FilePath (Join-Path $NodeDir "npm.cmd") -ArgumentList "run","dev" -WorkingDirectory (Join-Path $Root "frontend") -WindowStyle Minimized
}

Write-Host "UI  http://localhost:3000"
Write-Host "API http://localhost:8000/docs"
Write-Host "login test@test / test"
