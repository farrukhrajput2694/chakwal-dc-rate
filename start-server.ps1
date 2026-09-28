# Starts the Chakwal DC Rate Calculator and keeps it running.
#
# Registered as the ChakwalDCServer scheduled task (runs at startup as SYSTEM,
# 45s delay, restarts on failure). Runs uvicorn in the foreground so the task
# tracks the real server process: if uvicorn dies, the task fails, and Task
# Scheduler restarts it.
#
# The venv interpreter is required. The global Python has no uvicorn installed:
#   ModuleNotFoundError: No module named 'uvicorn'
#
# Bind 0.0.0.0, not 127.0.0.1. On 127.0.0.1 nothing but this machine can reach
# the server, whatever the firewall allows. Paired with the inbound firewall
# rule ChakwalRateCalc-8765 (TCP 8765).

$ErrorActionPreference = 'Continue'

$ProjectDir = 'C:\Users\Creative Computer\Desktop\Chakwal-DC-Rate-Calculator'
$Python     = Join-Path $ProjectDir '.venv\Scripts\python.exe'
$LogDir     = Join-Path $ProjectDir 'logs'

if (-not (Test-Path $Python)) {
    throw "venv interpreter missing: $Python"
}

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

Set-Location $ProjectDir

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$out   = Join-Path $LogDir "server-$stamp.out.log"
$err   = Join-Path $LogDir "server-$stamp.err.log"

# Port already held, most likely a second copy of this task or a server started
# by hand. Nothing to do, and crashing would make Task Scheduler retry a server
# that is already up.
if (Get-NetTCPConnection -State Listen -LocalPort 8765 -ErrorAction SilentlyContinue) {
    Write-Output "Port 8765 already in use; not starting a second server."
    exit 0
}

# uvicorn writes its logs to stderr. Under $ErrorActionPreference = 'Stop',
# PowerShell 5.1 raises NativeCommandError for that stderr output and treats it
# as terminating, which kills the server the instant it starts. Keep that
# variable at 'Continue' or the task exits 1 within a second of running.
& $Python -m uvicorn app:app `
    --host 0.0.0.0 `
    --port 8765 `
    --workers 1 `
    --log-level info `
    --proxy-headers `
    --forwarded-allow-ips='*' `
    *> $out

exit $LASTEXITCODE
