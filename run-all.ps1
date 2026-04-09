[CmdletBinding()]
param(
    [switch]$SkipInstall,
    [switch]$SkipBrowser,
    [switch]$Foreground
)

$ErrorActionPreference = "Stop"

function Write-Step {
    param([string]$Message)
    Write-Host "[E-Reputation] $Message" -ForegroundColor Cyan
}

function Write-WarnMsg {
    param([string]$Message)
    Write-Host "[E-Reputation] $Message" -ForegroundColor Yellow
}

function Invoke-CheckedExternal {
    param(
        [string]$FilePath,
        [string[]]$Arguments,
        [string]$FailureMessage
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$FailureMessage (exit code: $LASTEXITCODE)"
    }
}

function Get-ChromePath {
    $candidates = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "$env:ProgramFiles(x86)\Google\Chrome\Application\chrome.exe",
        "$env:LocalAppData\Google\Chrome\Application\chrome.exe"
    )

    foreach ($path in $candidates) {
        if (Test-Path $path) {
            return $path
        }
    }

    return $null
}

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendDir = Join-Path $repoRoot "backend"
$extensionDir = Join-Path $repoRoot "extension"
$envFile = Join-Path $repoRoot ".env"
$envExample = Join-Path $repoRoot ".env.example"
$requirementsFile = Join-Path $backendDir "requirements.txt"
$venvDir = Join-Path $repoRoot ".venv"
$venvPython = Join-Path $venvDir "Scripts\python.exe"

if (-not (Test-Path $backendDir)) {
    throw "Missing backend directory: $backendDir"
}

if (-not (Test-Path $extensionDir)) {
    throw "Missing extension directory: $extensionDir"
}

if (-not (Test-Path $requirementsFile)) {
    throw "Missing requirements file: $requirementsFile"
}

if (-not (Test-Path $envFile)) {
    if (Test-Path $envExample) {
        Copy-Item $envExample $envFile
        Write-WarnMsg ".env was missing, created from .env.example. Update credentials before production use."
    } else {
        throw "Missing .env and .env.example."
    }
}

$pythonCommand = Get-Command python -ErrorAction SilentlyContinue
if (-not $pythonCommand) {
    throw "Python was not found in PATH. Install Python 3.10+ and rerun."
}

$pythonVersion = (& $pythonCommand.Source -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')").Trim()
Write-Step "Using Python $pythonVersion"

if (-not (Test-Path $venvPython)) {
    Write-Step "Creating virtual environment..."
    Invoke-CheckedExternal -FilePath $pythonCommand.Source -Arguments @("-m", "venv", $venvDir) -FailureMessage "Failed to create virtual environment"
}

if (-not $SkipInstall) {
    Write-Step "Installing backend dependencies..."
    Invoke-CheckedExternal -FilePath $venvPython -Arguments @("-m", "pip", "install", "--upgrade", "pip") -FailureMessage "Failed to upgrade pip"
    Invoke-CheckedExternal -FilePath $venvPython -Arguments @("-m", "pip", "install", "-r", $requirementsFile) -FailureMessage "Failed to install backend dependencies"
} else {
    Write-Step "Skipping dependency installation as requested."
}

$uvicornArgs = @(
    "-m",
    "uvicorn",
    "main:app",
    "--host",
    "0.0.0.0",
    "--port",
    "8000",
    "--reload"
)

if ($Foreground) {
    Write-Step "Starting backend in foreground mode..."
    Push-Location $backendDir
    try {
        & $venvPython @uvicornArgs
    } finally {
        Pop-Location
    }
    exit 0
}

Write-Step "Starting backend in background mode..."
$backendProcess = Start-Process -FilePath $venvPython -ArgumentList $uvicornArgs -WorkingDirectory $backendDir -PassThru
Write-Step "Backend PID: $($backendProcess.Id)"

Write-Step "Waiting for health check on http://localhost:8000/health ..."
$healthy = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    try {
        $health = Invoke-RestMethod -Uri "http://localhost:8000/health" -Method Get -TimeoutSec 3
        if ($health.status -eq "ok") {
            $healthy = $true
            break
        }
    } catch {
        # Keep polling until timeout.
    }
}

if ($healthy) {
    Write-Step "Backend is healthy."
} else {
    Write-WarnMsg "Backend started but health check timed out. Check logs manually if needed."
}

if (-not $SkipBrowser) {
    $chromePath = Get-ChromePath
    Write-Step "Opening extension setup and Facebook groups pages..."

    if ($chromePath) {
        Start-Process -FilePath $chromePath -ArgumentList "chrome://extensions/"
        Start-Process -FilePath $chromePath -ArgumentList "https://www.facebook.com/groups/"
    } else {
        Start-Process "chrome://extensions/"
        Start-Process "https://www.facebook.com/groups/"
    }

    Start-Process -FilePath "explorer.exe" -ArgumentList $extensionDir
} else {
    Write-Step "Skipping browser launch as requested."
}

Write-Host ""
Write-Host "Run completed." -ForegroundColor Green
Write-Host "Next actions:" -ForegroundColor White
Write-Host "1) In Chrome extensions page, enable Developer Mode."
Write-Host "2) Click Load unpacked and select: $extensionDir"
Write-Host "3) Open the extension popup and complete Config tab values."
Write-Host "4) Browse your target Facebook group page."
Write-Host ""
Write-Host "To stop backend later: Stop-Process -Id $($backendProcess.Id)" -ForegroundColor White
