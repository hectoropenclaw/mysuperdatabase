param(
    [switch]$InstallDeps,
    [switch]$ResetData,
    [string]$DbPath = "whatsclear.db",
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
$venvWeb = Join-Path $repoRoot ".venv\Scripts\whatsclear-web.exe"

if (-not (Test-Path $venvPython)) {
    Write-Step "Creating virtual environment"
    Invoke-External { python -m venv .venv }
}

if ($InstallDeps -or -not (Test-Path $venvWeb)) {
    Write-Step "Installing project + dev dependencies"
    Invoke-External { & $venvPython -m pip install -e .[dev] }
}

if ($ResetData) {
    Write-Step "Resetting ingested operational data (shipments/messages/attachments/audits/errors)"
    $tmpResetPath = Join-Path $env:TEMP "wc_reset_data.py"
    $resetPy = @'
import sqlite3
import sys

db = sys.argv[1]
conn = sqlite3.connect(db)
cur = conn.cursor()
tables = ['shipments', 'messages', 'attachments', 'audit_log', 'extraction_audits', 'intake_errors']
for t in tables:
    cur.execute("DELETE FROM " + t)
for t in tables:
    cur.execute("DELETE FROM sqlite_sequence WHERE name=?", (t,))
cur.execute("UPDATE intake_channels SET active = 0, last_error = NULL, last_successful_sync = NULL")
conn.commit()
conn.close()
print("reset_ok", db)
'@
    [System.IO.File]::WriteAllText($tmpResetPath, $resetPy, [System.Text.UTF8Encoding]::new($false))
    try {
        Invoke-External {
            & $venvPython $tmpResetPath $DbPath
        }
    } finally {
        if (Test-Path $tmpResetPath) {
            Remove-Item $tmpResetPath -Force
        }
    }
    $masterSheet = Join-Path $repoRoot "master_sheet.tsv"
    if (Test-Path $masterSheet) {
        Remove-Item $masterSheet -Force
    }
}

Write-Step "Starting WhatsClear web server (real mode)"
Write-Host ("Open: http://127.0.0.1:{0}" -f $Port) -ForegroundColor Yellow
Write-Host "Login (admin): admin@whatsclear.local / admin123" -ForegroundColor Yellow
Write-Host "Then configure real intake channels in Admin tab and sync." -ForegroundColor Yellow

& $venvWeb --host 127.0.0.1 --port $Port --db-path $DbPath
