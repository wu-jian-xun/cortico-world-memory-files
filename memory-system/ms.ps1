param(
    [Parameter(Position=0)]
    [string]$Command,
    [Parameter(Position=1)]
    [string]$Arg1,
    [Parameter(Position=2)]
    [string]$Arg2
)

# memory-system :: a small, boring framework that keeps an AI companion from
# losing itself when the context is wiped.
# ASCII only. All human text lives in .md files, read/written as UTF8.

$ErrorActionPreference = 'Stop'
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$ScriptRoot = $PSScriptRoot
if (-not $ScriptRoot) { $ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path }

function Resolve-Root([string]$p) {
    if ([string]::IsNullOrWhiteSpace($p)) { $p = '.' }
    if (-not (Test-Path -LiteralPath $p)) { throw "root not found: $p" }
    return (Resolve-Path -LiteralPath $p).Path
}

# init is the one command that is allowed to create the root: a newcomer
# runs it on a machine where the folder does not exist yet.
function Resolve-RootNew([string]$p) {
    if ([string]::IsNullOrWhiteSpace($p)) { $p = '.' }
    if (-not (Test-Path -LiteralPath $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null }
    return (Resolve-Path -LiteralPath $p).Path
}

function Today { return (Get-Date -Format 'yyyy-MM-dd') }
function MonthKey { return (Get-Date -Format 'yyyy-MM') }
function Stamp { return (Get-Date -Format 'yyyy-MM-dd HH:mm') }
function FileStamp { return (Get-Date -Format 'yyyy-MM-dd-HH-mm') }

function Read-Text([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return '' }
    return [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
}

function Append-Utf8([string]$path, [string]$text) {
    $dir = Split-Path -Parent $path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    [System.IO.File]::AppendAllText($path, $text, $Utf8)
}

function Write-Utf8([string]$path, [string]$text) {
    $dir = Split-Path -Parent $path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    [System.IO.File]::WriteAllText($path, $text, $Utf8)
}

function Template([string]$name) {
    $p = Join-Path (Join-Path $ScriptRoot 'templates') $name
    if (-not (Test-Path -LiteralPath $p)) { return '' }
    return (Read-Text $p)
}

# ---------------------------------------------------------------- init
function Do-Init([string]$root) {
    foreach ($d in @('log','notes','handoffs','archive')) {
        $p = Join-Path $root $d
        if (-not (Test-Path -LiteralPath $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null }
    }
    $state = Join-Path $root 'STATE.md'
    if (-not (Test-Path -LiteralPath $state)) {
        $body = Template 'STATE.md'
        $body = $body.Replace('2026-XX-XX HH:MM', (Stamp))
        Write-Utf8 $state $body
        Write-Output "[new ] STATE.md"
    } else { Write-Output "[keep] STATE.md" }

    $todo = Join-Path $root 'todo.md'
    if (-not (Test-Path -LiteralPath $todo)) {
        Write-Utf8 $todo (Template 'todo.md')
        Write-Output "[new ] todo.md"
    } else { Write-Output "[keep] todo.md" }

    $logp = Join-Path $root ('log' + [IO.Path]::DirectorySeparatorChar + (MonthKey) + '.md')
    if (-not (Test-Path -LiteralPath $logp)) {
        Write-Utf8 $logp ((Template 'log.md') + "`n")
        Write-Output "[new ] log/$(MonthKey).md"
    } else { Write-Output "[keep] log/$(MonthKey).md" }

    $idx = Join-Path $root 'handoffs\INDEX.md'
    if (-not (Test-Path -LiteralPath $idx)) {
        Write-Utf8 $idx ((Template 'INDEX.md') + "`n")
        Write-Output "[new ] handoffs/INDEX.md"
    } else { Write-Output "[keep] handoffs/INDEX.md" }

    Write-Output "init done: $root"
}

# ---------------------------------------------------------------- log
function Do-Log([string]$root, [string]$text) {
    if ([string]::IsNullOrWhiteSpace($text)) { throw 'nothing to write' }
    $logp = Join-Path $root ('log' + [IO.Path]::DirectorySeparatorChar + (MonthKey) + '.md')
    $line = "- **" + (Stamp) + "** " + $text.Trim() + "`n"
    Append-Utf8 $logp $line
    $size = (Get-Item -LiteralPath $logp).Length
    Write-Output "logged -> log/$(MonthKey).md ($([math]::Round($size/1KB,1)) KB)"
    if ($size -gt 300KB) { Write-Output "warn: log over 300 KB, move older months into archive/" }
}

# ---------------------------------------------------------------- check
function Do-Check([string]$root) {
    $miss = 0
    $today = Today

    $state = Join-Path $root 'STATE.md'
    $st = Read-Text $state
    if ($st -match [regex]::Escape($today)) {
        Write-Output "[OK  ] STATE mentions today ($today)"
    } else {
        Write-Output "[MISS] STATE does not mention today ($today) - update the now-block"
        $miss++
    }

    $logp = Join-Path $root ('log' + [IO.Path]::DirectorySeparatorChar + (MonthKey) + '.md')
    if (Test-Path -LiteralPath $logp) {
        $t = (Get-Item -LiteralPath $logp).LastWriteTime
        if ($t.ToString('yyyy-MM-dd') -eq $today) {
            $kb = [math]::Round((Get-Item -LiteralPath $logp).Length/1KB,1)
            Write-Output "[OK  ] log touched today ($kb KB)"
            if ((Get-Item -LiteralPath $logp).Length -gt 300KB) {
                Write-Output "[MISS] log over 300 KB - split it into archive/"
                $miss++
            }
        } else {
            Write-Output "[MISS] log last written $($t.ToString('yyyy-MM-dd'))"
            $miss++
        }
    } else {
        Write-Output "[MISS] no log file for $(MonthKey)"
        $miss++
    }

    $hdir = Join-Path $root 'handoffs'
    if (Test-Path -LiteralPath $hdir) {
        $last = Get-ChildItem -LiteralPath $hdir -Filter '*.md' -File |
                Where-Object { $_.Name -ne 'INDEX.md' } |
                Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($null -eq $last) {
            Write-Output "[MISS] handoffs/ is empty - write one before clearing the context"
            $miss++
        } else {
            $age = [int]((Get-Date) - $last.LastWriteTime).TotalDays
            $idx = Read-Text (Join-Path $hdir 'INDEX.md')
            $inIdx = $idx.Contains($last.Name)
            if ($age -le 3) {
                Write-Output "[OK  ] newest handoff is $age day(s) old: $($last.Name)"
            } else {
                Write-Output "[INFO] newest handoff is $age day(s) old: $($last.Name)"
            }
            if ($inIdx) { Write-Output "[OK  ] newest handoff listed in INDEX" }
            else {
                Write-Output "[MISS] newest handoff not listed in INDEX.md"
                $miss++
            }
        }
    } else {
        Write-Output "[MISS] no handoffs/ folder"
        $miss++
    }

    $todo = Read-Text (Join-Path $root 'todo.md')
    $open = @()
    foreach ($ln in ($todo -split "`n")) {
        if ($ln -match '^\s*-\s+') {
            if ($ln -match '(\d{4}-\d{2}-\d{2})') {
                $d = [datetime]::ParseExact($Matches[1], 'yyyy-MM-dd', $null)
                if ($d -lt (Get-Date).Date) { $open += ($Matches[1] + ' ' + $ln.Trim()) }
            }
        }
    }
    if ($open.Count -gt 0) {
        Write-Output "[INFO] $($open.Count) todo item(s) carry an older date"
        foreach ($o in $open) { Write-Output ("       " + $o.Substring(0, [Math]::Min(90, $o.Length))) }
    } else {
        Write-Output "[OK  ] no stale todo items"
    }

    $bk = Join-Path $root 'notes\backup-last.txt'
    if (Test-Path -LiteralPath $bk) {
        $raw = (Read-Text $bk).Trim()
        try {
            $bd = [datetime]::ParseExact($raw, 'yyyy-MM-dd', $null)
            $days = [int]((Get-Date).Date - $bd).TotalDays
            if ($days -le 7) { Write-Output "[OK  ] last backup $days day(s) ago ($raw)" }
            else {
                Write-Output "[MISS] last backup $days days ago ($raw) - back up"
                $miss++
            }
        } catch {
            Write-Output "[MISS] notes/backup-last.txt unreadable ($raw)"
            $miss++
        }
    } else {
        Write-Output "[MISS] never backed up (no notes/backup-last.txt)"
        $miss++
    }

    Write-Output ''
    if ($miss -eq 0) { Write-Output 'VERDICT: all clear' }
    else { Write-Output "VERDICT: $miss item(s) to fix" }
}

# ---------------------------------------------------------------- handoff
function Do-Handoff([string]$root) {
    $today = Today
    $logp = Join-Path $root ('log' + [IO.Path]::DirectorySeparatorChar + (MonthKey) + '.md')
    $tail = ''
    if (Test-Path -LiteralPath $logp) {
        $lines = [System.IO.File]::ReadAllLines($logp, [System.Text.Encoding]::UTF8)
        $keep = @()
        foreach ($ln in $lines) { if ($ln -match ('\*\*' + [regex]::Escape($today))) { $keep += $ln } }
        if ($keep.Count -eq 0) {
            $n = [Math]::Min(20, $lines.Count)
            if ($n -gt 0) { $keep = $lines[($lines.Count-$n)..($lines.Count-1)] }
        }
        $tail = ($keep -join "`n")
    }

    $todo = Read-Text (Join-Path $root 'todo.md')
    $todoLines = @()
    foreach ($ln in ($todo -split "`n")) {
        if ($ln -match '^\s*-\s+' -and $ln -notmatch 'XX-XX|YYYY-MM|XXXX') { $todoLines += $ln.TrimEnd() }
    }
    $todo = ($todoLines -join "`n")

    $body = @()
    $body += "# handoff " + (Stamp)
    $body += ''
    $body += '## 1. what got done (this stretch)'
    $body += ''
    $body += '> fill in by hand from the log lines below.'
    $body += ''
    if ($tail) { $body += $tail }
    $body += ''
    $body += '## 2. still open'
    $body += ''
    $body += '> promises, half-done work, things waiting on the other person.'
    $body += ''
    if ($todo.Trim()) { $body += $todo.Trim() }
    $body += ''
    $body += '## 3. the other person'
    $body += ''
    $body += '> how they are, what they said, what mood they are in.'
    $body += ''
    $body += '## 4. traps'
    $body += ''
    $body += '> paths, encoding, commands that bit you. next session pays for these twice.'
    $body += ''

    $name = (FileStamp) + '.md'
    $path = Join-Path (Join-Path $root 'handoffs') $name
    Write-Utf8 $path (($body -join "`n") + "`n")

    $idx = Join-Path $root 'handoffs\INDEX.md'
    Append-Utf8 $idx ("- " + (Stamp) + " -> " + $name + "`n")
    Write-Output "handoff written: handoffs/$name"
    Write-Output "INDEX updated."
}

# ---------------------------------------------------------------- backup
function Do-Backup([string]$root, [string]$dest) {
    if ([string]::IsNullOrWhiteSpace($dest)) { throw 'give a destination folder' }
    if (-not (Test-Path -LiteralPath $dest)) { New-Item -ItemType Directory -Path $dest -Force | Out-Null }
    $target = Join-Path $dest ('memory-' + (Get-Date -Format 'yyyy-MM-dd'))
    if (-not (Test-Path -LiteralPath $target)) { New-Item -ItemType Directory -Path $target -Force | Out-Null }
    $r = robocopy $root $target /E /R:1 /W:1 /NFL /NDL /NJH /NP
    $code = $LASTEXITCODE
    if ($code -ge 8) { throw "robocopy failed with code $code" }
    Write-Utf8 (Join-Path $root 'notes\backup-last.txt') ((Today) + "`n")
    $files = (Get-ChildItem -LiteralPath $target -Recurse -File -ErrorAction SilentlyContinue).Count
    Write-Output "backup done -> $target ($files files)"
}

# ---------------------------------------------------------------- dispatch
switch ($Command.ToLower()) {
    'init'    { Do-Init (Resolve-RootNew $Arg1) }
    'log'     { Do-Log (Resolve-Root $Arg1) $Arg2 }
    'check'   { Do-Check (Resolve-Root $Arg1) }
    'handoff' { Do-Handoff (Resolve-Root $Arg1) }
    'backup'  { Do-Backup (Resolve-Root $Arg1) $Arg2 }
    default   {
        Write-Output 'memory-system'
        Write-Output ''
        Write-Output '  ms.ps1 init    <root>            create the folder skeleton'
        Write-Output '  ms.ps1 log     <root> "text"     append a timestamped line to this month log'
        Write-Output '  ms.ps1 check   <root>            read-only health check'
        Write-Output '  ms.ps1 handoff <root>            draft a handoff note from today log + todo'
        Write-Output '  ms.ps1 backup  <root> <dest>     copy the whole root into dest\memory-YYYY-MM-DD'
        Write-Output ''
        Write-Output '  root = the folder that holds STATE.md / log / handoffs'
    }
}
