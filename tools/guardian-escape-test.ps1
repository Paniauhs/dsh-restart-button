# Exercises the real helper's guardian escape end to end, without touching the app.
#
# The plan points `app.pid` at a process that is not the desktop app (so the
# helper refuses to kill anything and falls back to a Host-only restart) and
# `host.exe` at a stub. What is being tested is the escape itself: the guardian
# is re-created through WMI, must claim the lock, and must do so without showing
# a single visible window.

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class WindowProbe3 {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  public static List<string> Visible() {
    var found = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      var cls = new StringBuilder(256);
      GetClassName(h, cls, 256);
      found.Add(pid.ToString() + "|" + cls.ToString());
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@

$node = 'C:\Users\norki\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$plugin = 'F:\DSH\_apps\dsh-restart-button'
$dir = Join-Path $env:TEMP 'dsh-guardian-escape-test'
Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $dir | Out-Null

# app.exe is node here, so the wrapper starts this same helper again without any
# desktop app involved; the "app" it may kill is only this test's own decoy.
$decoy = Start-Process -FilePath $node -ArgumentList '-e', 'setTimeout(() => {}, 120000)' -PassThru -WindowStyle Hidden

$stub = Join-Path $dir 'host-stub.cjs'
@'
const fs = require('node:fs');
fs.writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, ppid: process.ppid, argv: process.argv.slice(1) }));
'@ | Set-Content -Path $stub -Encoding UTF8
$marker = Join-Path $dir 'host-stub-marker.json'

$planPath = Join-Path $dir 'plan.json'
$plan = [ordered]@{
  version   = 1
  createdAt = (Get-Date).ToUniversalTime().ToString('o')
  dryRun    = $false
  mode      = 'app'
  port      = 19387
  profile   = 'desktop'
  helperPath = (Join-Path $plugin 'helper.cjs')
  planPath   = $planPath
  lockPath   = (Join-Path $dir 'helper.lock')
  logPath    = (Join-Path $dir 'helper.log')
  resultPath = (Join-Path $dir 'result.json')
  app        = [ordered]@{ pid = $decoy.Id; exe = $node; dir = (Split-Path $node); args = @(); env = @{ SystemRoot = $env:SystemRoot } }
  host       = [ordered]@{ exe = $node; args = @($stub, $marker); cwd = $dir; env = @{ SystemRoot = $env:SystemRoot; TEMP = $env:TEMP } }
}
$plan | ConvertTo-Json -Depth 6 | Set-Content -Path $planPath -Encoding ASCII
# Windows PowerShell's UTF8 encoder writes a BOM, which JSON.parse rejects.
$json = Get-Content $planPath -Raw
[System.IO.File]::WriteAllText($planPath, $json, (New-Object System.Text.UTF8Encoding($false)))
& $node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); console.log('plan.json parses')" $planPath

$before = [WindowProbe3]::Visible()
$helper = Start-Process -FilePath $node -ArgumentList @((Join-Path $plugin 'helper.cjs'), $planPath) -PassThru -WindowStyle Hidden
Write-Host ("helper started pid={0} decoy(app.pid)={1}" -f $helper.Id, $decoy.Id)

$seen = @()
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 250
  $seen += @([WindowProbe3]::Visible() | Where-Object { $before -notcontains $_ })
}
Write-Host ("new visible windows during the escape: {0}" -f @($seen | Select-Object -Unique).Count)
foreach ($w in @($seen | Select-Object -Unique)) { Write-Host ("    {0}" -f $w) }

Start-Sleep -Seconds 45
Write-Host "=== helper.log ==="
Get-Content (Join-Path $dir 'helper.log') -ErrorAction SilentlyContinue
Write-Host "=== result.json ==="
Get-Content (Join-Path $dir 'result.json') -ErrorAction SilentlyContinue
Write-Host ("=== host stub marker: {0} ===" -f (Test-Path $marker))
Get-Content $marker -ErrorAction SilentlyContinue
Write-Host "=== guardian wrapper written? ==="
Test-Path (Join-Path $dir 'guardian.cmd')

Stop-Process -Id $decoy.Id -Force -ErrorAction SilentlyContinue
