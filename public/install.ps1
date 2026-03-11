# ─────────────────────────────────────────────────────────────────────────────
#  ShareSecure — One-Line Self-Hosted Installer for Windows
#  Usage (PowerShell, run as Administrator):
#    irm https://raw.githubusercontent.com/ishaanman7898/ShareSecure/main/public/install.ps1 | iex
# ─────────────────────────────────────────────────────────────────────────────
#Requires -Version 5.1
$ErrorActionPreference = 'Stop'

# ── config (override via env vars) ──────────────────────────────────────────
$RepoUrl    = if ($env:SHARESECURE_REPO) { $env:SHARESECURE_REPO } else { "https://github.com/ishaanman7898/ShareSecure" }
$InstallDir = if ($env:SHARESECURE_DIR)  { $env:SHARESECURE_DIR  } else { "$env:USERPROFILE\sharesecure" }
$Port       = if ($env:SHARESECURE_PORT) { $env:SHARESECURE_PORT } else { "3000" }
$MinNode    = 18

# ── helpers ───────────────────────────────────────────────────────────────────
function Write-Step  { param($msg) Write-Host "  " -NoNewline; Write-Host $msg -ForegroundColor Cyan }
function Write-Ok    { param($msg) Write-Host "  " -NoNewline; Write-Host "[OK] " -ForegroundColor Green -NoNewline; Write-Host $msg }
function Write-Warn  { param($msg) Write-Host "  " -NoNewline; Write-Host "[!]  " -ForegroundColor Yellow -NoNewline; Write-Host $msg }
function Write-Fail  { param($msg) Write-Host "  " -NoNewline; Write-Host "[X]  " -ForegroundColor Red -NoNewline; Write-Host $msg; exit 1 }
function Write-Header { param($msg) Write-Host "`n  $msg" -ForegroundColor Blue }

Write-Host ""
Write-Host "  +--------------------------------------+" -ForegroundColor Blue
Write-Host "  |  ShareSecure  .  Self-Host Setup    |" -ForegroundColor Blue
Write-Host "  +--------------------------------------+" -ForegroundColor Blue
Write-Host ""

# ── check / install Node.js ───────────────────────────────────────────────────
Write-Header "Checking Node.js (required >= $MinNode)"

function Install-Node {
  # try winget first (available on Windows 10 1709+ and all Windows 11)
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Step "Installing Node.js LTS via winget..."
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    # refresh PATH
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH","User")
    Write-Ok "Node.js installed via winget"
  } else {
    # Fallback: download the official Node.js MSI installer
    Write-Step "Downloading Node.js 20 LTS installer..."
    $msiUrl  = "https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi"
    $msiPath = "$env:TEMP\node-installer.msi"
    Invoke-WebRequest -Uri $msiUrl -OutFile $msiPath -UseBasicParsing
    Write-Step "Running installer (this may take a moment)..."
    Start-Process msiexec.exe -ArgumentList "/i `"$msiPath`" /qn" -Wait
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH","User")
    Remove-Item $msiPath -Force
    Write-Ok "Node.js installed"
  }
}

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
  $nodeVer = (node -v).TrimStart('v')
  $nodeMaj = [int]($nodeVer.Split('.')[0])
  if ($nodeMaj -lt $MinNode) {
    Write-Warn "Node.js $nodeVer is too old (need >= $MinNode). Upgrading..."
    Install-Node
  } else {
    Write-Ok "Node.js v$nodeVer"
  }
} else {
  Write-Warn "Node.js not found. Installing..."
  Install-Node
}

# verify
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Fail "Node.js installation failed. Please install manually from https://nodejs.org and re-run this script."
}

# ── download ShareSecure ───────────────────────────────────────────────────────
Write-Header "Downloading ShareSecure"

if (Test-Path (Join-Path $InstallDir ".git")) {
  Write-Step "Existing installation found — updating..."
  git -C $InstallDir pull --ff-only
  Write-Ok "Updated to latest version"
} elseif (Get-Command git -ErrorAction SilentlyContinue) {
  Write-Step "Cloning from $RepoUrl..."
  git clone --depth=1 $RepoUrl $InstallDir
  Write-Ok "Downloaded to $InstallDir"
} else {
  # Fallback: download zip
  $zipUrl  = "$RepoUrl/archive/refs/heads/main.zip"
  $zipPath = "$env:TEMP\sharesecure.zip"
  Write-Step "Downloading zip from $zipUrl..."
  Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing
  Write-Step "Extracting..."
  $tmpDir = "$env:TEMP\sharesecure-extract"
  if (Test-Path $tmpDir) { Remove-Item $tmpDir -Recurse -Force }
  Expand-Archive -Path $zipPath -DestinationPath $tmpDir
  # GitHub zip has a top-level folder like "ShareSecure-main"
  $innerDir = Get-ChildItem $tmpDir | Select-Object -First 1
  if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
  Copy-Item -Path $innerDir.FullName -Destination $InstallDir -Recurse
  Remove-Item $zipPath, $tmpDir -Recurse -Force
  Write-Ok "Extracted to $InstallDir"
}

# ── npm install ───────────────────────────────────────────────────────────────
Write-Header "Installing dependencies"
Set-Location $InstallDir
npm install --omit=dev --silent
Write-Ok "Dependencies installed"

# ── configure .env ────────────────────────────────────────────────────────────
Write-Header "Configuring environment"
$envPath = Join-Path $InstallDir ".env"

if (-not (Test-Path $envPath)) {
  $encKey = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  @"
PORT=$Port
BASE_URL=http://localhost:$Port
ENCRYPTION_KEY=$encKey
DATA_DIR=$InstallDir\data
"@ | Set-Content $envPath -Encoding UTF8
  Write-Ok ".env created with a fresh AES-256 encryption key"
} else {
  Write-Ok ".env already exists — skipping (delete it to reset)"
}

# ── create data directories ───────────────────────────────────────────────────
$dataDir = Join-Path $InstallDir "data\uploads"
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
Write-Ok "Data directory ready at $(Join-Path $InstallDir 'data')"

# ── create a start shortcut on Desktop ───────────────────────────────────────
try {
  $startScript = Join-Path $InstallDir "start.bat"
  @"
@echo off
cd /d "$InstallDir"
npm start
pause
"@ | Set-Content $startScript -Encoding ASCII

  $desktop   = [Environment]::GetFolderPath("Desktop")
  $lnkPath   = Join-Path $desktop "ShareSecure.lnk"
  $shell     = New-Object -ComObject WScript.Shell
  $shortcut  = $shell.CreateShortcut($lnkPath)
  $shortcut.TargetPath       = $startScript
  $shortcut.WorkingDirectory = $InstallDir
  $shortcut.Description      = "Start ShareSecure"
  $shortcut.Save()
  Write-Ok "Desktop shortcut created: ShareSecure.lnk"
} catch {
  # non-critical — skip silently
}

# ── done ──────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  +--------------------------------------+" -ForegroundColor Green
Write-Host "  |   ShareSecure is ready to launch!   |" -ForegroundColor Green
Write-Host "  +--------------------------------------+" -ForegroundColor Green
Write-Host ""
Write-Host "  Start:   cd $InstallDir && npm start" -ForegroundColor White
Write-Host "  Open:    http://localhost:$Port" -ForegroundColor White
Write-Host ""
Write-Host "  Your files are stored in $InstallDir\data" -ForegroundColor DarkGray
Write-Host "  Edit .env to change the port, base URL, or encryption key." -ForegroundColor DarkGray
Write-Host ""

$launch = Read-Host "  Start ShareSecure now? [Y/n]"
if ($launch -eq "" -or $launch -match "^[Yy]") {
  Start-Process "cmd.exe" -ArgumentList "/k cd /d `"$InstallDir`" && npm start" -WorkingDirectory $InstallDir
  Start-Sleep -Seconds 3
  Start-Process "http://localhost:$Port"
}
