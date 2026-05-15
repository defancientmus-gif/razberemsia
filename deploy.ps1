param([string]$msg = "update")

$dir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $PSCommandPath }

if (-not $dir -or -not (Test-Path $dir)) {
    Write-Host "ERR: folder not found" -ForegroundColor Red
    exit 1
}

Write-Host "DIR: $dir" -ForegroundColor Cyan
Set-Location $dir

$swPath = Join-Path $dir "sw.js"
if (Test-Path $swPath) {
    $sw = Get-Content $swPath -Raw -Encoding UTF8
    if ($sw -match "rz-v(\d+)") {
        $oldVer = [int]$Matches[1]
        $newVer = $oldVer + 1
        $sw = $sw -replace "rz-v$oldVer", "rz-v$newVer"
        [System.IO.File]::WriteAllText($swPath, $sw, [System.Text.UTF8Encoding]::new($false))
        Write-Host "SW: rz-v$oldVer -> rz-v$newVer" -ForegroundColor Yellow
    }
}

git add -A

$changed = git status --short
if (-not $changed) {
    Write-Host "Nothing to commit" -ForegroundColor Green
    exit 0
}

git commit -m $msg
if ($LASTEXITCODE -ne 0) { exit 1 }

git push origin HEAD:main
if ($LASTEXITCODE -ne 0) {
    git pull --rebase origin main
    git push origin HEAD:main
}

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "OK: $msg" -ForegroundColor Green
    Write-Host "https://defancientmus-gif.github.io/razberemsia/" -ForegroundColor Cyan
    Write-Host "https://github.com/defancientmus-gif/razberemsia/actions" -ForegroundColor Cyan
} else {
    Write-Host "PUSH FAILED" -ForegroundColor Red
    exit 1
}
