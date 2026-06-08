param(
    [switch]$InstallDeps,
    [switch]$RunFullTests = $true,
    [switch]$OpenUi,
    [string]$DbPath = "tmp_smoke.db",
    [string]$SheetPath = "tmp_smoke.tsv",
    [int]$Port = 8000
)

$ErrorActionPreference = "Stop"

function Write-Step([string]$Message) {
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Assert-Command([string]$Cmd) {
    if (-not (Get-Command $Cmd -ErrorAction SilentlyContinue)) {
        throw "Required command not found: $Cmd"
    }
}

function Invoke-External([scriptblock]$Command) {
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "External command failed with exit code $LASTEXITCODE"
    }
}

Assert-Command "python"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $repoRoot

$venvPython = Join-Path $repoRoot ".venv\Scripts\python.exe"
$venvWhatsclear = Join-Path $repoRoot ".venv\Scripts\whatsclear.exe"
$venvWeb = Join-Path $repoRoot ".venv\Scripts\whatsclear-web.exe"

if (-not (Test-Path $venvPython)) {
    Write-Step "Creating virtual environment"
    Invoke-External { python -m venv .venv }
}

if ($InstallDeps -or -not (Test-Path $venvWhatsclear) -or -not (Test-Path $venvWeb)) {
    Write-Step "Installing project + dev dependencies"
    Invoke-External { & $venvPython -m pip install -e .[dev] }
}

if ($RunFullTests) {
    Write-Step "Running full test suite"
    Invoke-External { & $venvPython -m pytest -q }
} else {
    Write-Step "Running pipeline-only tests"
    Invoke-External { & $venvPython -m pytest -q tests\test_pipeline.py }
}

$payloadPath = Join-Path $repoRoot "tmp_smoke_email.json"
$payload = @'
[
  {
    "message_id": "demo-customer-1",
    "thread_id": "demo-thread-1",
    "subject": "Pickup scheduled",
    "body": "Please coordinate for Globex Transport Ltd on this shipment, from Monterrey, NL to Laredo, TX.",
    "timestamp": "2026-03-04T10:00:00",
    "attachments": []
  }
]
'@

Write-Step "Preparing smoke payload"
[System.IO.File]::WriteAllText($payloadPath, $payload, [System.Text.UTF8Encoding]::new($false))

if (Test-Path $DbPath) {
    Remove-Item $DbPath -Force
}
if (Test-Path $SheetPath) {
    Remove-Item $SheetPath -Force
}

Write-Step "Running CLI ingest"
Invoke-External { & $venvWhatsclear --db-path $DbPath --sheet-path $SheetPath ingest --email-json $payloadPath }

Write-Step "Listing shipments"
Invoke-External { & $venvWhatsclear --db-path $DbPath list-shipments }

Write-Step "Validating customer extraction from DB"
$customer = & $venvPython -c "from whatsclear.repository import Repository; r=Repository('$DbPath'); s=r.list_shipments()[0]; print(s.customer or ''); r.close()"
if ($customer -ne "Globex Transport Ltd") {
    throw "Unexpected customer value: '$customer' (expected 'Globex Transport Ltd')"
}
Write-Host "Customer extraction OK: $customer" -ForegroundColor Green

Write-Step "Starting temporary API server and validating /health + login + shipments"
$proc = Start-Process -FilePath $venvWeb -ArgumentList "--host","127.0.0.1","--port",$Port,"--db-path",$DbPath -PassThru
Start-Sleep -Seconds 2
try {
    $health = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/health" -f $Port) -Method GET
    if ($health.status -ne "ok") {
        throw "Health endpoint not OK"
    }

    $login = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/auth/login" -f $Port) -Method POST -ContentType "application/json" -Body '{"email":"ops@whatsclear.local","password":"ops123"}'
    $headers = @{ Authorization = "Bearer $($login.access_token)" }
    $shipments = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/shipments?page_size=10" -f $Port) -Method GET -Headers $headers
    if ($shipments.total -lt 1) {
        throw "No shipments returned by API smoke check"
    }
    Write-Host "API smoke OK: total shipments = $($shipments.total)" -ForegroundColor Green
}
finally {
    if ($proc -and -not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force
    }
}

if ($OpenUi) {
    Write-Step "Starting UI server for manual browser checks (Ctrl+C to stop)"
    Write-Host ("Open: http://127.0.0.1:{0}" -f $Port) -ForegroundColor Yellow
    & $venvWeb --host 127.0.0.1 --port $Port --db-path $DbPath
}

Write-Step "Done"
Write-Host "Smoke flow completed successfully." -ForegroundColor Green
Write-Host ("Artifacts: {0}, {1}, {2}" -f $DbPath, $SheetPath, $payloadPath)
