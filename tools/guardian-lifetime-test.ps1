# Measures the console window's lifetime for the guardian launch.
#
# The escape starts a wrapper through the WMI provider. Two properties matter
# for the user: no window at all (the headless launcher), and — for any launcher
# that does show one — a window that goes away on its own the moment the restart
# is under way, instead of living as long as the helper.
#
# Each variant is sampled every 200 ms, so both appearance and disappearance are
# observable. Variants:
#   A  cmd /c wrapper with the helper in the foreground   (the old behaviour)
#   B  cmd /c wrapper that `start /b`s the helper and returns
#   C  conhost --headless cmd /c wrapper B

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class WindowProbe4 {
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
$dir = Join-Path $env:TEMP 'dsh-guardian-lifetime-test'
Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$stub = Join-Path $dir 'stub.cjs'
@'
const fs = require('node:fs');
fs.writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, ppid: process.ppid }));
setTimeout(() => process.exit(0), 8000);
'@ | Set-Content -Path $stub -Encoding UTF8

function New-Wrapper([string]$name, [string]$marker, [switch]$Background) {
  $run = Join-Path $dir ("run-{0}.cmd" -f $name)
  $launch = if ($Background) {
    'start "" /b "{0}" "{1}" "{2}"' -f $exe, $stub, $marker
  }
  else {
    '"{0}" "{1}" "{2}"' -f $exe, $stub, $marker
  }
  @('@echo off', 'set "ELECTRON_RUN_AS_NODE=1"', $launch) | Set-Content -Path $run -Encoding ASCII
  return $run
}

function Test-Variant([string]$label, [string]$commandLine, [string]$marker, [int]$samples = 30) {
  $before = [WindowProbe4]::Visible()
  $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine }
  $firstSeen = $null
  $lastSeen = $null
  for ($i = 0; $i -lt $samples; $i++) {
    Start-Sleep -Milliseconds 200
    $new = @([WindowProbe4]::Visible() | Where-Object { $before -notcontains $_ })
    if ($new.Count -gt 0) {
      if ($null -eq $firstSeen) { $firstSeen = $i * 200 }
      $lastSeen = $i * 200
    }
  }
  $windowText = if ($null -eq $firstSeen) { 'never visible' } else { "visible from ~$firstSeen ms to ~$lastSeen ms" }
  Write-Host ("{0}: wmi rv={1} | window {2} | marker={3}" -f $label, $result.ReturnValue, $windowText, (Test-Path $marker))
}

$markerA = Join-Path $dir 'marker-a.json'
$runA = New-Wrapper 'a' $markerA
Test-Variant 'A  cmd /c wrapper (helper in foreground)' ('cmd.exe /c "{0}"' -f $runA) $markerA
Start-Sleep -Seconds 2

$markerB = Join-Path $dir 'marker-b.json'
$runB = New-Wrapper 'b' $markerB -Background
Test-Variant 'B  cmd /c wrapper (start /b, returns)' ('cmd.exe /c "{0}"' -f $runB) $markerB
Start-Sleep -Seconds 2

$markerC = Join-Path $dir 'marker-c.json'
$runC = New-Wrapper 'c' $markerC -Background
Test-Variant 'C  conhost --headless + wrapper B' ('"{0}\System32\conhost.exe" --headless cmd.exe /c "{1}"' -f $env:SystemRoot, $runC) $markerC

Start-Sleep -Seconds 9
Write-Host ("markers: A={0} B={1} C={2}" -f (Test-Path $markerA), (Test-Path $markerB), (Test-Path $markerC))
