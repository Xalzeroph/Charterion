param(
  [Parameter(Mandatory = $true)][string]$ExtensionId,
  [Parameter(Mandatory = $true)][string]$PipeName,
  [Parameter(Mandatory = $true)][string]$InstanceId,
  [string]$GamHome = (Join-Path $env:USERPROFILE '.charterion'),
  [string]$PublishDir = (Join-Path (Split-Path $PSScriptRoot -Parent | Split-Path -Parent) 'dist-native-host')
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'NativeRpcProtocol.generated.ps1')
$HostName = $CharterionNativeHostName
if ([string]::IsNullOrWhiteSpace($HostName)) { throw 'Generated Native Host name is missing.' }
if ($ExtensionId -notmatch '^[a-p]{32}$') { throw 'ExtensionId must be a 32-character Chromium extension id.' }
if ($InstanceId -notmatch '^[0-9a-f]{16}$') { throw 'InstanceId must be a 16-character lowercase hex id.' }
if ([string]::IsNullOrWhiteSpace($PipeName)) { throw 'PipeName is required.' }
$sourceExe = Join-Path $PublishDir 'GamNativeHost.exe'
if (-not (Test-Path $sourceExe)) { throw "Native host executable not found at $sourceExe. Run npm run publish:native first." }
$installDir = Join-Path $GamHome 'native-host'
New-Item -ItemType Directory -Force -Path $GamHome, $installDir | Out-Null
$browserTokenPath = Join-Path $GamHome 'browser.token'
if (-not (Test-Path $browserTokenPath)) {
  $bytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  $token = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
  [IO.File]::WriteAllText($browserTokenPath, $token + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}
$installedExe = Join-Path $installDir 'GamNativeHost.exe'
Copy-Item -Force $sourceExe $installedExe
$allowedOrigin = "chrome-extension://$ExtensionId/"
$configPath = Join-Path $installDir 'gam-native-host.json'
$config = [ordered]@{
  pipeName = $PipeName
  instanceId = $InstanceId
  browserTokenPath = $browserTokenPath
  allowedOrigin = $allowedOrigin
}
[IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
$manifestPath = Join-Path $installDir "$HostName.json"
$manifest = [ordered]@{
  name = $HostName
  description = 'Charterion local control-plane bridge'
  path = $installedExe
  type = 'stdio'
  allowed_origins = @($allowedOrigin)
}
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
$registryPaths = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
)
foreach ($registryPath in $registryPaths) {
  New-Item -Force -Path $registryPath | Out-Null
  Set-Item -Path $registryPath -Value $manifestPath
}
Write-Host "Registered $HostName for Chrome and Edge: $allowedOrigin"
Write-Host "Manifest: $manifestPath"
Write-Host "Control home: $GamHome"
Write-Host "Instance id: $InstanceId"
Write-Host "Pipe: $PipeName"
