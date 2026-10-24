# webos-vibehack Windows 安裝腳本（取代只支援 macOS 的 install.sh）
# 用法（在 PowerShell 執行）：
#   powershell -ExecutionPolicy Bypass -File install-windows.ps1 -TvHost 192.168.1.50
# 之後在電視上增減 App 時，再跑一次同樣的指令即可。

param(
    [Parameter(Mandatory = $true)][string]$TvHost,
    [string]$Dir = "$HOME\webos-vibehack",
    [string]$Device = "lgtv"
)

$ErrorActionPreference = "Stop"
$AppId = "com.gathin.tvhome"
$ZipUrl = "https://github.com/jammy912/webos-vibehack/archive/refs/heads/main.zip"

function Step($msg) { Write-Host "`n== $msg ==" -ForegroundColor Cyan }
function Check($what) {
    if ($LASTEXITCODE -ne 0) { throw "$what 失敗（結束代碼 $LASTEXITCODE）" }
}

# ---------- 1. 檢查 Node.js 與 Python ----------
Step "1/7 檢查 Node.js 與 Python"
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "找不到 Node.js。請先執行：winget install OpenJS.NodeJS.LTS，然後重開 PowerShell。" -ForegroundColor Yellow
    exit 1
}
$Py = $null
if (Get-Command py -ErrorAction SilentlyContinue) { $Py = @("py", "-3") }
elseif (Get-Command python -ErrorAction SilentlyContinue) { $Py = @("python") }
if (-not $Py) {
    Write-Host "找不到 Python。請先執行：winget install Python.Python.3.12，然後重開 PowerShell。" -ForegroundColor Yellow
    exit 1
}
Write-Host "Node.js $(node --version)，Python 啟動指令：$($Py -join ' ')"

# ---------- 2. 安裝 LG 的 ares CLI ----------
Step "2/7 安裝 LG webOS CLI（ares）"
$NpmBin = Join-Path $env:APPDATA "npm"
if ($env:Path -notlike "*$NpmBin*") { $env:Path = "$NpmBin;$env:Path" }
if (-not (Get-Command ares-package -ErrorAction SilentlyContinue)) {
    npm install -g @webos-tools/cli
    Check "npm install @webos-tools/cli"
} else {
    Write-Host "ares CLI 已安裝。"
}

# ---------- 3. 下載專案 ----------
Step "3/7 下載 webos-vibehack"
if (-not (Test-Path "$Dir\app\appinfo.json")) {
    $zip = Join-Path $env:TEMP "webos-vibehack.zip"
    $tmp = Join-Path $env:TEMP "webos-vibehack-src"
    Invoke-WebRequest -Uri $ZipUrl -OutFile $zip -UseBasicParsing
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    Copy-Item -Path "$tmp\webos-vibehack-main\*" -Destination $Dir -Recurse -Force
    Remove-Item $zip, $tmp -Recurse -Force
    Write-Host "已下載到 $Dir"
} else {
    Write-Host "專案已在 $Dir，略過下載（設定檔 app\config.js 保留不動）。"
}
Set-Location $Dir

# ---------- 4. Python 虛擬環境 ----------
Step "4/7 建立 Python 環境（websockets、Pillow）"
$VPy = "$Dir\venv\Scripts\python.exe"
if (-not (Test-Path $VPy)) {
    $PyExe = $Py[0]
    $PyArgs = @($Py | Select-Object -Skip 1) + @("-m", "venv", "$Dir\venv")
    & $PyExe @PyArgs
    Check "建立 venv"
}
& $VPy -m pip install --quiet --upgrade websockets pillow
Check "pip install"

# ---------- 5. 綁定電視（只需一次） ----------
Step "5/7 綁定電視的 Developer Mode"
# 依「設定裡有沒有 privatekey、金鑰檔在不在」判斷，上次 getkey 失敗時重跑會自動補做
$KeyName = "${Device}_webos"
$KeyFile = Join-Path $HOME ".ssh\$KeyName"
$dev = (ares-setup-device --listfull | Out-String | ConvertFrom-Json) | Where-Object { $_.name -eq $Device }
if (-not $dev) {
    ares-setup-device -a $Device -i "{'host':'$TvHost','port':'9922','username':'prisoner'}"
    Check "ares-setup-device -a"
} elseif ($dev.deviceinfo.ip -ne $TvHost) {
    Write-Host "裝置 $Device 的 IP 是 $($dev.deviceinfo.ip)，改成 $TvHost。"
    ares-setup-device -m $Device -i "{'host':'$TvHost'}"
    Check "ares-setup-device -m host"
}
if (-not $dev -or -not $dev.details.privatekey -or -not (Test-Path $KeyFile)) {
    $tcp = New-Object Net.Sockets.TcpClient
    try { $tcp.Connect($TvHost, 9991) } catch { }
    $keyServerUp = $tcp.Connected
    $tcp.Close()
    if (-not $keyServerUp) {
        throw "連不到 ${TvHost}:9991：電視上的 Key Server 沒開。到 Developer Mode App 打開 Key Server 後重跑本腳本。"
    }
    Write-Host "接下來會要求輸入 Developer Mode App 上顯示的 Passphrase。"
    ares-novacom --device $Device --getkey
    Check "ares-novacom --getkey"
    $pass = Read-Host "請再輸入一次 Passphrase（寫入裝置設定用）"
    ares-setup-device -m $Device -i "{'privatekey':'$KeyName','passphrase':'$pass'}"
    Check "ares-setup-device -m"
} else {
    Write-Host "裝置 $Device 已綁定（金鑰 $KeyFile），略過。"
}

# ---------- 6. 讀取電視上的 App 與圖示 ----------
Step "6/7 讀取電視上的 App（第一次會在電視上跳出「允許此裝置？」，請按允許）"
& $VPy "$Dir\sync-apps.py" $TvHost
Check "sync-apps.py"

if (-not (Test-Path "$Dir\app\icon.png") -or -not (Test-Path "$Dir\app\largeIcon.png")) {
    & $VPy -c @"
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB')
im.resize((80, 80), Image.LANCZOS).save(sys.argv[2])
im.resize((130, 130), Image.LANCZOS).save(sys.argv[3])
"@ "$Dir\assets\icon.jpg" "$Dir\app\icon.png" "$Dir\app\largeIcon.png"
    Check "產生 App 圖示"
    Write-Host "已產生 icon.png（80px）與 largeIcon.png（130px）。"
}

# ---------- 7. 打包、安裝、啟動 ----------
Step "7/7 打包並安裝到電視"
if (Test-Path "$Dir\build") { Remove-Item "$Dir\build" -Recurse -Force }
New-Item -ItemType Directory -Force -Path "$Dir\build" | Out-Null
ares-package "$Dir\app" -o "$Dir\build"
Check "ares-package"
$ipk = Get-ChildItem "$Dir\build\${AppId}_*.ipk" | Select-Object -First 1
if (-not $ipk) { throw "找不到打包出來的 .ipk" }
ares-install -d $Device $ipk.FullName
Check "ares-install"
ares-launch -d $Device $AppId
Check "ares-launch"

Write-Host "`n完成！launcher 已安裝並在電視上開啟。" -ForegroundColor Green
Write-Host "Home 鍵導向交給 XR30：在路由器上執行 sh setup-home-watch.sh $TvHost"
Write-Host "要移除 launcher：ares-install -d $Device --remove $AppId"
