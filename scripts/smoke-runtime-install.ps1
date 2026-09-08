$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
. (Join-Path $Root 'native-host\scripts\NativeRpcProtocol.generated.ps1')
$Id = [guid]::NewGuid().ToString('N')
$SmokeRoot = Join-Path $Root ".build-cache\runtime-install-smoke\$Id"
$GamTestHome = Join-Path $SmokeRoot 'home'
$HostName = $CharterionNativeHostName
if ([string]::IsNullOrWhiteSpace($HostName)) { throw 'Generated Native Host name is missing.' }
$RegistryPaths = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
)
$RegistryBackup = @{}
foreach ($RegistryPath in $RegistryPaths) {
  if (Test-Path $RegistryPath) {
    $RegistryBackup[$RegistryPath] = (Get-Item $RegistryPath).GetValue('')
  } else {
    $RegistryBackup[$RegistryPath] = $null
  }
}

try {
  New-Item -ItemType Directory -Force -Path $SmokeRoot | Out-Null
  $Installer = Join-Path $Root 'scripts\install-runtime-windows.ps1'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Installer -GamHome $GamTestHome -NoStart
  if ($LASTEXITCODE) { throw "Runtime installer exited with $LASTEXITCODE" }

  foreach ($Relative in @('runtime.json','GAM.cmd','native-host\GamNativeHost.exe','native-host\gam-native-host.json')) {
    if (-not (Test-Path (Join-Path $GamTestHome $Relative))) { throw "Installed runtime is missing $Relative" }
  }
  $DoctorRaw = & (Join-Path $GamTestHome 'GAM.cmd') doctor --json
  $Doctor = ($DoctorRaw -join "`n") | ConvertFrom-Json
  if ($Doctor.status -ne 'ready') { throw 'Installed GAM doctor did not report ready' }
  $Runtime = Get-Content (Join-Path $GamTestHome 'runtime.json') -Raw | ConvertFrom-Json
  $NativeConfig = Get-Content (Join-Path $GamTestHome 'native-host\gam-native-host.json') -Raw | ConvertFrom-Json
  $ExpectedExtensionId = (& node (Join-Path $Root 'scripts\extension-id.mjs')).Trim()
  if ($Runtime.extensionId -ne $ExpectedExtensionId) { throw 'Installed extension id does not match manifest key' }
  if ($Runtime.instanceId -notmatch '^[0-9a-f]{16}$') { throw 'Installed runtime instance id is invalid' }
  if ($Runtime.instanceId -ne $NativeConfig.instanceId) { throw 'Native Host instance id does not match runtime identity' }
  if ($Runtime.pipeName -ne $NativeConfig.pipeName) { throw 'Native Host pipe does not match runtime identity' }
  if ($Doctor.details.instanceId -ne $Runtime.instanceId -or $Doctor.details.pipeName -ne $Runtime.pipeName) { throw 'Launcher doctor identity does not match installed runtime' }
  [pscustomobject]@{
    ok = $true
    extensionId = $Runtime.extensionId
    instanceId = $Runtime.instanceId
    pipeName = $Runtime.pipeName
    doctorStatus = $Doctor.status
    chromeAvailable = $Doctor.details.chromeAvailable
    nativeHostBytes = (Get-Item (Join-Path $GamTestHome 'native-host\GamNativeHost.exe')).Length
  } | ConvertTo-Json -Depth 4
} finally {
  Set-Location $Root
  foreach ($RegistryPath in $RegistryPaths) {
    if (Test-Path $RegistryPath) { Remove-Item -Recurse -Force $RegistryPath }
    if ($null -ne $RegistryBackup[$RegistryPath]) {
      New-Item -Force -Path $RegistryPath | Out-Null
      Set-Item -Path $RegistryPath -Value $RegistryBackup[$RegistryPath]
    }
  }
  if (Test-Path $SmokeRoot) {
    $CleanupError = $null
    for ($Attempt = 1; $Attempt -le 20; $Attempt++) {
      try {
        Remove-Item -Recurse -Force -ErrorAction Stop $SmokeRoot
        $CleanupError = $null
        break
      } catch {
        $CleanupError = $_
        Start-Sleep -Milliseconds 250
      }
    }
    if (Test-Path $SmokeRoot) { throw $CleanupError }
  }
}
