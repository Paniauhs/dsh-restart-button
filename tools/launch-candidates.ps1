# Compares window-free launch candidates for the restart helper's escape.
#
# The helper re-creates itself outside the app's process tree so it survives the
# app being killed. Whatever primitive is used must (a) actually start the
# wrapper and (b) never show a window. Each candidate is sampled repeatedly
# right after creation, so a brief flash is caught too.

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class WindowProbe2 {
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

$exe = 'D:\Ai\Deepseek Harness\DeepSeek Harness.exe'
$dir = Join-Path $env:TEMP 'dsh-guardian-window-test'
Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$stub = Join-Path $dir 'stub.cjs'
@'
const fs = require('node:fs');
fs.writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, ppid: process.ppid }));
setTimeout(() => process.exit(0), 5000);
'@ | Set-Content -Path $stub -Encoding UTF8

function New-Wrapper([string]$name, [string]$marker) {
  $run = Join-Path $dir ("run-{0}.cmd" -f $name)
  @('@echo off', 'set "ELECTRON_RUN_AS_NODE=1"', ('"{0}" "{1}" "{2}"' -f $exe, $stub, $marker)) |
    Set-Content -Path $run -Encoding ASCII
  return $run
}

function Test-Candidate([string]$label, [string]$commandLine, [string]$marker, [switch]$PlainSpawn) {
  $before = [WindowProbe2]::Visible()
  if ($PlainSpawn) {
    # Exactly how the Host starts the helper: detached, no window, no console.
    $process = Start-Process -FilePath $commandLine -PassThru -WindowStyle Hidden
    $created = "spawned pid $($process.Id)"
  }
  else {
    $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine }
    $created = "wmi rv=$($result.ReturnValue) pid=$($result.ProcessId)"
  }
  $flashes = @()
  for ($i = 0; $i -lt 14; $i++) {
    Start-Sleep -Milliseconds 120
    $new = @([WindowProbe2]::Visible() | Where-Object { $before -notcontains $_ })
    if ($new.Count -gt 0) { $flashes += $new }
  }
  Start-Sleep -Seconds 6
  Write-Host ("{0}: {1} | marker={2} | visible windows seen: {3}" -f $label, $created, (Test-Path $marker), (@($flashes | Select-Object -Unique) -join ' '))
}

$markerHeadless = Join-Path $dir 'marker-headless.json'
$runHeadless = New-Wrapper 'headless' $markerHeadless
Test-Candidate 'conhost --headless' ('conhost.exe --headless cmd.exe /c "{0}"' -f $runHeadless) $markerHeadless

$markerHidden = Join-Path $dir 'marker-hidden.json'
$runHidden = New-Wrapper 'hiddenpwsh' $markerHidden
Test-Candidate 'powershell -WindowStyle Hidden' ('powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command "& ''{0}''"' -f $runHidden) $markerHidden

$markerWscript = Join-Path $dir 'marker-wscript.json'
$runWscript = New-Wrapper 'wscript' $markerWscript
$vbs = Join-Path $dir 'launch.vbs'
@('Set shell = CreateObject("WScript.Shell")', ('shell.Run """{0}""", 0, False' -f $runWscript)) | Set-Content -Path $vbs -Encoding ASCII
Test-Candidate 'wscript + Run(hidden)' ('wscript.exe //B //Nologo "{0}"' -f $vbs) $markerWscript

$markerPlain = Join-Path $dir 'marker-plain.json'
$runPlain = New-Wrapper 'plain' $markerPlain
Test-Candidate 'host-style hidden spawn' $runPlain $markerPlain -PlainSpawn
