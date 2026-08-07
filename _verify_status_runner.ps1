$ErrorActionPreference = "Continue"
$NODE = "$env:LOCALAPPDATA\nodejs-portable\node-v24.19.0-win-x64"
$env:PATH = "$NODE;$env:PATH"

Write-Host "=== terminals ==="
Get-ChildItem "$env:USERPROFILE\.cursor\projects\c-Users-tril-Projects-po-calendar\terminals" -ErrorAction SilentlyContinue |
  ForEach-Object {
    Write-Host ("---- " + $_.Name)
    Get-Content $_.FullName -TotalCount 14
  }

Write-Host "`n=== probe api ==="
try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:8000/docs" -UseBasicParsing -TimeoutSec 5
  Write-Host "api docs: $($r.StatusCode)"
} catch { Write-Host "api docs: FAIL $($_.Exception.Message)" }

Write-Host "`n=== probe frontend ==="
try {
  $r = Invoke-WebRequest -Uri "http://localhost:3000" -UseBasicParsing -TimeoutSec 5
  Write-Host "frontend: $($r.StatusCode)"
} catch { Write-Host "frontend: FAIL $($_.Exception.Message)" }

Write-Host "`n=== node version ==="
& "$NODE\node.exe" -v
& "$NODE\npx.cmd" -v
