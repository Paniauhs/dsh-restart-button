param(
  [int]$TargetPid,
  [string]$OutDir,
  [string]$Name = 'window'
)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinCap {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
}
"@
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$proc = Get-Process -Id $TargetPid -ErrorAction Stop
$hwnd = [IntPtr]$proc.MainWindowHandle
if ($hwnd -eq [IntPtr]::Zero) { "no main window for pid $TargetPid"; exit 2 }
$rect = New-Object WinCap+RECT
[void][WinCap]::GetWindowRect($hwnd, [ref]$rect)
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top
"hwnd=$hwnd rect=$($rect.Left),$($rect.Top) ${w}x${h} minimized=$([WinCap]::IsIconic($hwnd)) visible=$([WinCap]::IsWindowVisible($hwnd))"
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
# PW_RENDERFULLCONTENT = 2: lets a composited (Chromium) window render while occluded.
$ok = [WinCap]::PrintWindow($hwnd, $hdc, 2)
$g.ReleaseHdc($hdc)
$path = Join-Path $OutDir "$Name.png"
$bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
"PrintWindow=$ok saved=$path"
