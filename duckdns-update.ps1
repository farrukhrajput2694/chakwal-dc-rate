<#
.SYNOPSIS
    Update a DuckDNS record to this machine's current public IP.

.DESCRIPTION
    DuckDNS updates by GET, with the token in the query string, so the token must
    never be logged, echoed, or written into an error message. Everything here
    is written to keep it out of output: the token is read from a file or the
    environment, the request URL is never printed, and the log records only
    domain, IP, and the OK/KO result.

    Only writes to the log when the IP actually changes, so a task running
    hourly does not produce 24 identical lines a day.

.EXAMPLE
    .\duckdns-update.ps1 -Domain myname
    .\duckdns-update.ps1 -Domain myname -Verbose

.EXAMPLE
    Create the token file so the token is not in the command line or in this
    file. It is ignored by git via duckdns.token in .gitignore.
    Set-Content -Path .\duckdns.token -Value 'your-token-here' -NoNewline
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$Domain = $env:DUCKDNS_DOMAIN,

    [Parameter(Mandatory = $false)]
    [string]$TokenFile,

    [Parameter(Mandatory = $false)]
    [string]$StateFile,

    [Parameter(Mandatory = $false)]
    [string]$LogFile
)

$ErrorActionPreference = 'Stop'

if (-not $TokenFile) { $TokenFile = Join-Path $PSScriptRoot 'duckdns.token' }
if (-not $StateFile) { $StateFile = Join-Path $PSScriptRoot 'duckdns.lastip' }
if (-not $LogFile)   { $LogFile   = Join-Path $PSScriptRoot 'logs\duckdns.log' }

function Write-DuckLog {
    param([string]$Message, [string]$Level = 'INFO')
    $ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    $line = "$ts [$Level] $Message"
    try {
        $dir = Split-Path -Parent $LogFile
        if ($dir -and -not (Test-Path -LiteralPath $dir)) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
        }
        Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
    } catch {
        # A logging failure must not fail the update itself.
    }
    if ($VerbosePreference -eq 'Continue') { Write-Host $line }
}

# --------------------------------------------------------------------- input --
if (-not $Domain) {
    $Domain = $env:DUCKDNS_DOMAIN
}
if (-not $Domain) {
    Write-DuckLog 'No domain given and DUCKDNS_DOMAIN is not set. Nothing to do.' 'ERROR'
    exit 2
}
$Domain = $Domain.Trim().ToLower()

# Prefer the token file. The environment variable is a fallback for scheduled
# tasks, but a file is easier to keep out of shell history and process listings.
$token = $null
if (Test-Path -LiteralPath $TokenFile) {
    $token = (Get-Content -LiteralPath $TokenFile -Raw -ErrorAction Stop).Trim()
}
if (-not $token) { $token = $env:DUCKDNS_TOKEN }
if (-not $token) {
    # Never print the path of a token file that was not found, in case it is
    # inside a shared directory. The domain is safe to name.
    Write-DuckLog "No token available for '$Domain'. Expected a token file or DUCKDNS_TOKEN." 'ERROR'
    exit 2
}
if ($token -match '\s') {
    Write-DuckLog 'Token contains whitespace; DuckDNS tokens do not. Refusing to send it.' 'ERROR'
    exit 2
}

# ------------------------------------------------------------------ old IP --
$previous = $null
if (Test-Path -LiteralPath $StateFile) {
    $previous = (Get-Content -LiteralPath $StateFile -Raw).Trim()
}

# -------------------------------------------------------------------- query --
# Several services here return the caller's address as plain text. Try a couple,
# because a single provider being down should not mean the IP is never updated.
$publicIp = $null
$providers = @(
    'https://api.ipify.org',
    'https://ifconfig.me/ip',
    'https://icanhazip.com'
)
foreach ($p in $providers) {
    try {
        $candidate = (Invoke-RestMethod -Uri $p -TimeoutSec 15 -UseBasicParsing).ToString().Trim()
        if ($candidate -match '^\d{1,3}(\.\d{1,3}){3}$') {
            $publicIp = $candidate
            break
        }
    } catch {
        Write-DuckLog "IP lookup failed via $p : $($_.Exception.Message)" 'WARN'
    }
}
if (-not $publicIp) {
    Write-DuckLog "Could not determine the public IP from any of $($providers.Count) providers." 'ERROR'
    exit 1
}

# ------------------------------------------------------------------- update --
# The token is in the query string, so this URL is never logged or echoed.
$uri = "https://www.duckdns.org/update?domains=$Domain&token=$token&ip=$publicIp&verbose=true"

$response = $null
for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
        $raw = (Invoke-WebRequest -Uri $uri -UseBasicParsing -TimeoutSec 30).Content
        # DuckDNS answers with no Content-Type, so PowerShell hands back a byte
        # array rather than a string. Joining that directly stringifies the
        # byte *values* -- "OK" becomes "7975" -- and the success test below
        # then fails on an update that actually worked.
        $response = if ($raw -is [byte[]]) {
            [System.Text.Encoding]::UTF8.GetString($raw)
        } else {
            [string]$raw
        }
        break
    } catch {
        Write-DuckLog "Update attempt $attempt failed: $($_.Exception.Message)" 'WARN'
        if ($attempt -lt 3) { Start-Sleep -Seconds (5 * $attempt) }
    }
}
if ($null -eq $response) {
    Write-DuckLog "Update to DuckDNS failed after 3 attempts for '$Domain'." 'ERROR'
    exit 1
}

$text = ($response -replace "`r`n", "`n").Trim()

# DuckDNS answers OK, or KO followed by a reason. With verbose=true the body is
# several lines: the verdict, the current IP, the requested IP, then either
# NOCHANGE or the error text.
$lines = @($text -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$verdict = if ($lines.Count) { $lines[0] } else { '' }
$note = if ($lines.Count -ge 4) { $lines[3] } else { '' }

if ($verdict -eq 'OK') {
    if ($note -eq 'NOCHANGE' -or $publicIp -eq $previous) {
        Write-DuckLog "'$Domain' already at $publicIp (DuckDNS: NOCHANGE)."
    } else {
        Set-Content -LiteralPath $StateFile -Value $publicIp -Encoding ASCII -NoNewline
        Write-DuckLog "'$Domain' updated: $(if ($previous) { "$previous -> " })$publicIp (DuckDNS: $(if ($note) { $note } else { 'OK' }))."
    }
    exit 0
}

# On failure the reason is appended after KO, and it never contains the token.
# Flatten to one line so each log entry stays a single record.
$reason = (($lines | Select-Object -Skip 3) -join ' / ')
if (-not $reason) {
    # A bare KO with nothing after it. In practice this is an invalid or
    # revoked token, or a domain the token does not own.
    $reason = 'no detail given by DuckDNS (an invalid or revoked token, or a domain this token does not own)'
}
$reason = $reason -replace '^KO\s*-?\s*', ''
if ($reason.Length -gt 200) { $reason = $reason.Substring(0, 200) }
Write-DuckLog "DuckDNS rejected the update for '$Domain' (HTTP was fine, verdict '$verdict'): $reason" 'ERROR'
exit 1
