$ErrorActionPreference = "Stop"

Set-Location -LiteralPath $PSScriptRoot

$branch = "main"
$message = if ($args.Count -gt 0) { $args -join " " } else { "update $(Get-Date -Format 'yyyy-MM-dd HH:mm')" }

Write-Host "Deploy folder: $PSScriptRoot" -ForegroundColor Cyan
Write-Host "Branch: $branch" -ForegroundColor Cyan

git status --short
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

git add -A
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

git diff --cached --quiet
$hasChanges = $LASTEXITCODE -ne 0

if (-not $hasChanges) {
  Write-Host "No changes to deploy." -ForegroundColor Yellow
  exit 0
}

git commit -m $message
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

git push origin HEAD:$branch
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Deploy complete." -ForegroundColor Green
