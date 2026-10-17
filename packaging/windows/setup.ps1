# Scriptwright for Windows: fetches the Electron runtime once (official release, checked by
# SHA-256), puts the app into it and starts it. Later updates only replace the "app" folder.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$version = '39.2.7'
$sha256 = '3464537fa4be6b7b073f1c9b694ac2eb1f632d6ec36f6eeac9e00d8a279f188c'
$root = $PSScriptRoot
$runtime = Join-Path $root 'runtime'
$exe = Join-Path $runtime 'Scriptwright.exe'

if (-not (Test-Path $exe)) {
  Write-Host "== First start: downloading the Electron runtime $version (about 130 MB) ..."
  $zip = Join-Path $env:TEMP "electron-v$version-win32-x64.zip"
  $url = "https://github.com/electron/electron/releases/download/v$version/electron-v$version-win32-x64.zip"
  Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
  $hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
  if ($hash -ne $sha256) { Remove-Item $zip; throw "The download did not match the official checksum; nothing was installed." }
  Write-Host "== Unpacking ..."
  if (Test-Path $runtime) { Remove-Item $runtime -Recurse -Force }
  New-Item -ItemType Directory -Path $runtime | Out-Null
  $unpacked = $false
  try {
    $tar = 'C:\Windows\System32\tar.exe'; if ($env:SystemRoot) { $tar = Join-Path $env:SystemRoot 'System32\tar.exe' }
    & $tar -xf $zip -C $runtime
    $unpacked = ($LASTEXITCODE -eq 0) -and (Test-Path (Join-Path $runtime 'electron.exe'))
  } catch { $unpacked = $false }
  if (-not $unpacked) { Expand-Archive -Path $zip -DestinationPath $runtime -Force }
  Rename-Item (Join-Path $runtime 'electron.exe') 'Scriptwright.exe'
  $defaultApp = Join-Path $runtime 'resources\default_app.asar'
  if (Test-Path $defaultApp) { Remove-Item $defaultApp }
  Remove-Item $zip
}

# Courier Prime (SIL Open Font License) from Google Fonts, once. The marker tells a real download
# apart from older packages that carried a stand-in font under the same names.
$fonts = Join-Path $root 'fonts'
if (-not (Test-Path (Join-Path $fonts 'courier-prime.ok'))) {
  Write-Host "== Downloading the Courier Prime font ..."
  New-Item -ItemType Directory -Path $fonts -Force | Out-Null
  $base = 'https://raw.githubusercontent.com/google/fonts/main/ofl/courierprime/'
  try {
    foreach ($f in 'CourierPrime-Regular.ttf', 'CourierPrime-Bold.ttf', 'CourierPrime-Italic.ttf', 'CourierPrime-BoldItalic.ttf', 'OFL.txt') {
      Invoke-WebRequest -Uri ($base + $f) -OutFile (Join-Path $fonts $f) -UseBasicParsing
    }
    Set-Content (Join-Path $fonts 'courier-prime.ok') 'Courier Prime from github.com/google/fonts'
  } catch {
    Write-Host "   Could not download it now; Scriptwright uses Courier until the next start."
    Get-ChildItem $fonts -Filter 'CourierPrime-*.ttf' | Remove-Item
  }
}

Write-Host "== Installing the current version of Scriptwright ..."
$res = Join-Path $runtime 'resources'
foreach ($d in 'app', 'fonts') {
  $dest = Join-Path $res $d
  if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
  Copy-Item (Join-Path $root $d) $dest -Recurse
}
# The app's own copies of the font (used by the editor's stylesheet) are the real ones too.
if (Test-Path (Join-Path $fonts 'courier-prime.ok')) {
  $appFonts = Join-Path $res 'app\dist\renderer\fonts'
  New-Item -ItemType Directory -Path $appFonts -Force | Out-Null
  Copy-Item (Join-Path $fonts 'CourierPrime-*.ttf') $appFonts -Force
}
Write-Host "== Starting"
Start-Process $exe
