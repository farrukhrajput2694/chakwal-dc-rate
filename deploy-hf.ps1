<#
.SYNOPSIS
    Publish the Chakwal DC Rate Calculator to a Hugging Face Space.

.DESCRIPTION
    A Space is a container that Hugging Face runs for you, so it removes the
    need for a VPS and for this machine to be on. It is not a guaranteed
    always-on server, though:

      * The free CPU Basic tier sleeps after 48 hours without a request. Any
        visitor wakes it, but it is asleep in the meantime, so this is the same
        trade as Render free rather than the promise of a VPS.
      * The app's reference lists live in the process (app.py: "live and die
        with the process"), so every wake re-reads all 1,070 lists -- roughly
        2,300 calls to the government portal, about six minutes. The page
        loads and looks correct throughout; only lookups fail.

    The Space is assembled into a scratch directory from the repository, rather
    than being kept as a second copy of app.py. A committed copy would drift
    from the original the first time one of them was edited, and the wrong
    file would get deployed. This script copies at run time so that cannot
    happen.

.PARAMETER Space
    Target Space repository, as your-hugging-face-handle/space-name.

.PARAMETER Token
    Hugging Face write token. Read from $env:HF_TOKEN when not supplied. It is
    never written to disk, never logged, and never passed on a command line
    that another process could see.

.EXAMPLE
    $env:HF_TOKEN = 'hf_...'
    .\deploy-hf.ps1 -Space farrukhrajput2694/chakwal-dc-rates
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Space,

    [Parameter(Mandatory = $false)]
    [string]$Token = $env:HF_TOKEN
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$Stage    = Join-Path $env:TEMP ("chakwal-hf-space-" + [guid]::NewGuid().ToString('N').Substring(0, 8))

function Say  { param($m) Write-Host "==> $m" }
function Die  { param($m) Write-Host "error: $m" -ForegroundColor Red; exit 1 }

# --------------------------------------------------------------- preflight --
if (-not $Token) { Die "no token. Set `$env:HF_TOKEN to a Hugging Face write token." }
if ($Token -notmatch '^hf_') {
    Die "the token does not start with 'hf_'. A Hugging Face access token always does; check it was copied in full."
}
if ($Space -notmatch '^[\w.-]+/[\w.-]+$') {
    Die "the Space must be written as handle/space-name, e.g. your-handle/chakwal-dc-rates. Got '$Space'."
}
$handle = $Space.Split('/')[0]

# ----------------------------------------------------------------- the CLI --
Say "checking for the Hugging Face CLI"
$hf = Get-Command hf -ErrorAction SilentlyContinue
if (-not $hf) {
    $hf = Get-Command huggingface-cli -ErrorAction SilentlyContinue
    # Newer huggingface_hub renamed the entry point; the old one still works.
    if ($hf) { Say "found legacy huggingface-cli at $($hf.Source) - the 'hf' command is preferred" }
}
if (-not $hf) {
    Say "installing huggingface_hub"
    $py = Get-Command python -ErrorAction SilentlyContinue
    if (-not $py) { Die "python is not on PATH, so huggingface_hub cannot be installed." }
    & $py.Source -m pip install --user --quiet --disable-pip-version-check `
        --no-warn-script-location --upgrade "huggingface_hub[cli]"

    # pip --user installs scripts into a *versioned* directory, e.g.
    # ...\AppData\Roaming\Python\Python38\Scripts, which is neither
    # site.USER_BASE nor site.USER_SCRIPTS on every layout, and is often not on
    # PATH. Search the candidates rather than computing a single path: getting
    # that wrong makes the script claim the CLI is missing when it is installed
    # and working.
    $candidates = @()
    $candidates += (& $py.Source -c "import sysconfig;print(sysconfig.get_path('scripts','nt_user'))")
    # site.USER_SCRIPTS does not exist on Python 3.8, and asking for it there
    # raises an AttributeError that floods the output. getattr keeps it quiet.
    $candidates += (& $py.Source -c "import site;print(getattr(site,'USER_SCRIPTS',''))")
    $candidates += (Get-ChildItem (Join-Path $env:APPDATA 'Python') -Directory `
                    -Filter 'Python*' -ErrorAction SilentlyContinue |
                    ForEach-Object { Join-Path $_.FullName 'Scripts' })
    $candidates = @($candidates | Where-Object { $_ } | Select-Object -Unique)

    $found = $candidates | Where-Object { Test-Path (Join-Path $_ 'hf.exe') } | Select-Object -First 1
    if ($found) {
        Say "found hf at $found - adding it to PATH for this session"
        $env:PATH = "$found;$env:PATH"
        $hf = Get-Command hf -ErrorAction SilentlyContinue
    }
    if (-not $hf) {
        Die @"
huggingface_hub installed, but 'hf' could not be located.
  Looked for hf.exe in:
$($candidates | ForEach-Object { "    $_" })
  Add the right one to PATH and re-run.
"@
    }
}
Say "using CLI: $($hf.Source)"

# Run the CLI and return its exit code, without letting its stderr become a
# terminating error. With $ErrorActionPreference = 'Stop' -- which this script
# sets, correctly, for its own PowerShell work -- Windows PowerShell 5.1 turns a
# native command writing to stderr into a terminating error. Hugging Face's CLI
# reports every failure that way, including a plain "bad token", so the run
# would abort on a Python traceback and the reader would never see what went
# wrong. Output is written with Write-Host so the return value is only the code.
function Invoke-Hf {
    param([Parameter(Mandatory = $true)][string[]]$HfArgs)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & $hf.Source @HfArgs 2>&1
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prev
    }
    foreach ($line in $out) { Write-Host "    $line" }
    return $code
}

# ------------------------------------------------------------------ stage --
Say "assembling the Space in $Stage"
# Keep the long form of the path. $env:TEMP is the 8.3 short form on this
# machine, and mixing the two with FullName below shifts every displayed name.
$Stage = (New-Item -ItemType Directory -Path $Stage -Force).FullName

# Exactly the five things the image needs, and nothing else. history.db is
# deliberately not copied: the app creates it empty on first run and nothing
# ever writes to it.
foreach ($f in @('app.py', 'govapi.py', 'requirements.txt', 'Dockerfile')) {
    $src = Join-Path $RepoRoot $f
    if (-not (Test-Path $src)) { Die "missing $f in $RepoRoot" }
    Copy-Item $src $Stage
}
Copy-Item (Join-Path $RepoRoot 'static') $Stage -Recurse

# The Space README is the Space landing page and must carry the SDK frontmatter.
# It is generated rather than copied, because the project's own README is 33KB
# of deployment notes that mean nothing on a Space page.
@"
---
title: Chakwal DC Rate Calculator
emoji: 🏛️
colorFrom: green
colorTo: blue
sdk: docker
app_port: 8000
pinned: false
license: mit
short_description: Punjab land-rate calculator for Chakwal DC, reading the official rate list live.
---

# Chakwal DC Rate Calculator

A calculator for land rates in **Chakwal District, Punjab**, reading the
official DC rate list live rather than from a stored copy.

**Try it:** the page at the top of this Space, or `/health` for a machine-readable status.

### What it does

- Calculates total land value in Rs, and per-acre and per-marla figures, from
  mouza, khewat number, kanoongi number, and the land category.
- Covers Agricultural, Residential, Commercial, Industrial and Semi-Industrial
  land categories.
- The four **Notification** rates (General, 1-Acre, 2.5-Acre, 5-Acre) as well as
  the main rate.
- **Bulk runs** for a whole khewat or kanoongi, queued so the government portal
  is not hit with more than a few requests at once.
- Saves what you look up, in your browser's own storage. Nothing is sent anywhere
  but the rate portal, and there is no account.

### Running status

`/health` reports whether the nightly reference-list walk has finished. **On a
freshly woken Space this takes about six minutes**, because all 1,070 reference
lists are re-read from the government portal on each start. Until it completes,
the page loads normally but lookups will not return a rate. That is a cold
start, not a fault.

### Cost and honesty

The free CPU Basic tier sleeps after 48 hours without a request. A visitor
wakes it, but it is not an always-on server, and the six-minute cold start
above applies to every wake. If you need it genuinely always on, that needs a
real VPS.

### Source

The full source, deployment guides and the Windows desktop build live in the
project repository:
**https://github.com/farrukhrajput2694/chakwal-dc-rate**

Two upstream hosting attempts are documented there as well: EdgeOne, which
deploys successfully but fails at runtime, and Render, which works but sleeps
on the free tier.
"@ | Set-Content -LiteralPath (Join-Path $Stage 'README.md') -Encoding UTF8

Say "staged files:"
Get-ChildItem $Stage -Recurse -File |
  ForEach-Object { Write-Host ("    {0,8:N0}  {1}" -f $_.Length, $_.FullName.Substring($Stage.Length + 1)) }

# ------------------------------------------------------------------ guard --
# Last check before anything leaves the machine. The Space would be public, and
# a credential in it would be public too.
$stagedText = Get-ChildItem $Stage -Recurse -File |
  Where-Object { $_.Extension -in '.py', '.md', '.txt', '.json' -or $_.Name -eq 'Dockerfile' }
$secretPatterns = @(
  'hf_[A-Za-z0-9]{20,}',
  'sk-[A-Za-z0-9]{20,}',
  'AKIA[0-9A-Z]{16}',
  '(?i)(api[_-]?key|secret|password|token)\s*[=:]\s*["''][A-Za-z0-9/_+-]{16,}'
)
$found = $false
foreach ($pat in $secretPatterns) {
    $hits = $stagedText | Select-String -Pattern $pat -ErrorAction SilentlyContinue
    foreach ($h in $hits) {
        $found = $true
        Write-Host "    POSSIBLE SECRET: $($h.Filename):$($h.LineNumber)" -ForegroundColor Yellow
    }
}
if ($found) { Die "a possible secret is in the staged files. Nothing was uploaded. Fix and re-run." }
Say "secret scan clean"

# ------------------------------------------------------------------- push --
$env:HF_TOKEN = $Token
try {
    # Flag names verified against `hf repo create --help` on
    # huggingface_hub 0.36.2: it is --space_sdk with an underscore, and a Space
    # is public unless --private is passed, so there is no --public flag. Using
    # --exist-ok makes this idempotent without a separate existence probe.
    Say "creating the Space if absent (public, docker SDK)"
    $code = Invoke-Hf @('repo', 'create', $Space, '--repo-type', 'space', '--space_sdk', 'docker', '--exist-ok')
    if ($code -ne 0) {
        Die @"
creating the Space failed (exit $code). The usual causes:
  * the token is not a WRITE token, or has expired
  * the handle '$handle' does not exist on huggingface.co
  * that Space name is already taken by someone else
Check the token at https://huggingface.co/settings/tokens - it must have the
'Write' permission, not just 'Read'.
"@
    }

    Say "uploading"
    $code = Invoke-Hf @('upload', $Space, $Stage, '--repo-type', 'space',
                        '--commit-message', 'Deploy Chakwal DC Rate Calculator')
    if ($code -ne 0) { Die "the upload failed (exit $code). See the output above." }

    Say "verifying what landed"
    $null = Invoke-Hf @('repo-files', $Space)
} finally {
    # Scrub the token from this process and any child that inherited it.
    Remove-Item Env:\HF_TOKEN -ErrorAction SilentlyContinue
    $Token = $null
}

$slug = $Space.Split('/')[1]
$url = "https://huggingface.co/spaces/$handle/$slug"
Say "uploaded"
Write-Host ""
Write-Host "  Space:  $url"
Write-Host ""
Write-Host "  The first build installs the Python image and the three dependencies,"
Write-Host "  then the app walks 1,070 reference lists. Budget about six minutes"
Write-Host "  before lookups work. The page itself will load far sooner."
Write-Host ""
Write-Host "  Prove it with a real lookup, not a page load. This should return"
Write-Host "  Rs 366,025 per acre:"
Write-Host "    Mouza Alawal / Qanoongoee Balkassar / Agricultural / Link Road / Khasra 947"
Write-Host ""
Write-Host "  If the Space reports a runtime error, the logs are at"
Write-Host "  $Space -> Files and versions -> Logs."
Write-Host ""
Write-Host "  The token was used from memory only and has been cleared from this"
Write-Host "  process. It is still a write token for your account: revoke it at"
Write-Host "  https://huggingface.co/settings/tokens once you are satisfied."

try { Remove-Item $Stage -Recurse -Force -ErrorAction SilentlyContinue } catch { }
