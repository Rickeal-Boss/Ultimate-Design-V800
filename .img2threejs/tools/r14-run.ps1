param(
  [string]$Mode = "shots",
  [string]$Out = "",
  [string]$Hash = "#assembled",
  [string]$Shots = "",
  [string]$Closeups = "",
  [string]$HideMat = "",
  [string]$HideComp = "",
  [string]$ProbeIds = "",
  [string]$XS = "0",
  [string]$YS = "1.2:1.86:0.02",
  [string]$FromRear = "1",
  [string]$CDP = "9447",
  [string]$Script = "r14_cdp.mjs",
  [string]$URL = "http://127.0.0.1:5194/preview.html"
)

# 本机约束：从 Git Bash / node 直接 spawn Edge 会 EACCES；必须由 PowerShell Start-Process 起，
# 且 Edge 生命周期必须与探测脚本同处一条 PowerShell 调用内（调用返回即被回收）。
$ErrorActionPreference = "Continue"
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$ud = Join-Path $env:TEMP ("r14edge_" + $CDP)
if (Test-Path $ud) { Remove-Item -Recurse -Force $ud }

$p = Start-Process $edge -PassThru -ArgumentList '--headless=new','--disable-gpu','--enable-unsafe-swiftshader','--disable-features=msStartupBoost',"--remote-debugging-port=$CDP","--user-data-dir=$ud",'--no-first-run','--no-default-browser-check','--window-size=1400,900','about:blank'
for ($i = 0; $i -lt 40; $i++) {
  try { $r = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$CDP/json/version" -TimeoutSec 2; if ($r.StatusCode -eq 200) { break } } catch { Start-Sleep -Milliseconds 500 }
}

$env:CDP = $CDP
$env:MODE = $Mode
if ($env:SCRIPT_NAME) { } 
$env:HASH = $Hash
$env:URL = $URL
$env:FROMREAR = $FromRear
$env:XS = $XS
$env:YS = $YS
if ($Out) { $env:OUT = $Out }
if ($Shots) { $env:SHOTS = $Shots }
if ($Closeups) { $env:CLOSEUPS = $Closeups }
if ($HideMat) { $env:HIDEMAT = $HideMat }
if ($HideComp) { $env:HIDECOMP = $HideComp }
if ($ProbeIds) { $env:PROBE_IDS = $ProbeIds }

Set-Location "C:\Users\16896\WorkBuddy\2026-10-14-13-25-01\brake-v800"
& node ".img2threejs\tools\$Script" 2>&1
$rc = $LASTEXITCODE
Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
exit $rc
