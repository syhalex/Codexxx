#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = Split-Path -Parent $PSScriptRoot
$output = Join-Path $root 'output'
$dependencies = New-Item -ItemType Directory -Path (Join-Path $output 'dependencies') -Force
$webviewVersion = '1.0.4314.35'
$nodeVersion = '24.22.1'
$nodeHash = 'd702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5'

function Get-Dependency($Path, $Uri, $Hash) {
    if (!(Test-Path -LiteralPath $Path) -or (Get-FileHash -LiteralPath $Path).Hash -ne $Hash) {
        Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $Path
        if ((Get-FileHash -LiteralPath $Path).Hash -ne $Hash) { throw "Checksum mismatch for $Uri" }
    }
}

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (!(Test-Path -LiteralPath $vswhere)) { throw 'Install Visual Studio Build Tools with Desktop development with C++.' }
$toolchain = & $vswhere -all -prerelease -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath |
    ForEach-Object { Join-Path $_ 'VC\Auxiliary\Build\vcvars64.bat' } |
    Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (!$toolchain) { throw 'Install the MSVC x64 build tools and a Windows SDK.' }

$sdkPackage = Join-Path $dependencies.FullName "webview2-$webviewVersion.zip"
$sdk = Join-Path $dependencies.FullName "webview2-$webviewVersion"
Get-Dependency $sdkPackage "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$webviewVersion/microsoft.web.webview2.$webviewVersion.nupkg" `
    '90778deb1b77e36292828b4b5833c9255c27533f40e0ddd55891ae718944edc4'
Expand-Archive -LiteralPath $sdkPackage -DestinationPath $sdk -Force

$installed = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($installed -and (Get-FileHash -LiteralPath $installed.Source).Hash -eq $nodeHash) {
    $node = $installed.Source
} else {
    $node = Join-Path $dependencies.FullName "node-v$nodeVersion-win-x64.exe"
    Get-Dependency $node "https://nodejs.org/dist/v$nodeVersion/win-x64/node.exe" $nodeHash
}
$nodeLicense = Join-Path $dependencies.FullName "node-v$nodeVersion-LICENSE"
Get-Dependency $nodeLicense "https://raw.githubusercontent.com/nodejs/node/v$nodeVersion/LICENSE" `
    '5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace'

$build = New-Item -ItemType Directory -Path (Join-Path $output ('build-' + [guid]::NewGuid().ToString('N')))
$stage = New-Item -ItemType Directory -Path (Join-Path $build.FullName 'LocalWorkspace')
$runtime = New-Item -ItemType Directory -Path (Join-Path $stage.FullName 'runtime')
$licenses = New-Item -ItemType Directory -Path (Join-Path $stage.FullName 'licenses')

try {
    $env:LOCAL_WORKSPACE_TOOLCHAIN = $toolchain
    $env:LOCAL_WORKSPACE_WEBVIEW_SDK = Join-Path $sdk 'build\native'
    $env:LOCAL_WORKSPACE_DESKTOP_SOURCE = $PSScriptRoot
    $env:LOCAL_WORKSPACE_PACKAGE = $stage.FullName
    Push-Location -LiteralPath $build.FullName
    try {
        cmd.exe /d /v:off /c 'call "%LOCAL_WORKSPACE_TOOLCHAIN%" && cl /nologo /std:c++20 /utf-8 /O2 /MT /EHsc /W4 /DUNICODE /D_UNICODE /DNOMINMAX "%LOCAL_WORKSPACE_DESKTOP_SOURCE%\windows.cpp" /Fe:"%LOCAL_WORKSPACE_PACKAGE%\runtime\LocalWorkspace.Windows.exe" /link crypt32.lib advapi32.lib version.lib'
        if ($LASTEXITCODE -ne 0) { throw 'Windows helper compilation failed.' }
        cmd.exe /d /v:off /c 'call "%LOCAL_WORKSPACE_TOOLCHAIN%" && cl /nologo /std:c++20 /utf-8 /O2 /MT /EHsc /W4 /DUNICODE /D_UNICODE /DNOMINMAX /I"%LOCAL_WORKSPACE_WEBVIEW_SDK%\include" "%LOCAL_WORKSPACE_DESKTOP_SOURCE%\main.cpp" /Fe:"%LOCAL_WORKSPACE_PACKAGE%\LocalWorkspace.exe" /link /SUBSYSTEM:WINDOWS /MANIFEST:EMBED /MANIFESTINPUT:"%LOCAL_WORKSPACE_DESKTOP_SOURCE%\LocalWorkspace.manifest" "%LOCAL_WORKSPACE_WEBVIEW_SDK%\x64\WebView2LoaderStatic.lib" ole32.lib oleaut32.lib user32.lib shell32.lib shlwapi.lib gdi32.lib version.lib uuid.lib advapi32.lib'
        if ($LASTEXITCODE -ne 0) { throw 'Desktop launcher compilation failed.' }
    } finally {
        Pop-Location
        Remove-Item Env:LOCAL_WORKSPACE_TOOLCHAIN, Env:LOCAL_WORKSPACE_WEBVIEW_SDK, Env:LOCAL_WORKSPACE_DESKTOP_SOURCE, Env:LOCAL_WORKSPACE_PACKAGE
    }

    Copy-Item -LiteralPath $node -Destination (Join-Path $runtime.FullName 'node.exe')
    Copy-Item -LiteralPath $nodeLicense -Destination (Join-Path $licenses.FullName 'Node.js-LICENSE.txt')
    Copy-Item -LiteralPath (Join-Path $sdk 'LICENSE.txt') -Destination (Join-Path $licenses.FullName 'WebView2-LICENSE.txt')
    Copy-Item -LiteralPath (Join-Path $sdk 'NOTICE.txt') -Destination (Join-Path $licenses.FullName 'WebView2-NOTICE.txt')
    foreach ($file in @('server.mjs', 'README.md', 'Start.cmd', 'package.json')) {
        Copy-Item -LiteralPath (Join-Path $root $file) -Destination $stage.FullName
    }
    $lib = New-Item -ItemType Directory -Path (Join-Path $stage.FullName 'lib')
    Get-ChildItem -LiteralPath (Join-Path $root 'lib') -File -Filter '*.mjs' | Copy-Item -Destination $lib.FullName
    $public = New-Item -ItemType Directory -Path (Join-Path $stage.FullName 'public')
    $platforms = New-Item -ItemType Directory -Path (Join-Path $public.FullName 'platforms')
    foreach ($file in @('index.html', 'app.js', 'styles.css', 'platforms\antigravity.svg', 'platforms\codex-desktop.png')) {
        Copy-Item -LiteralPath (Join-Path $root "public\$file") -Destination (Join-Path $public.FullName $file)
    }

    $archiveName = 'LocalWorkspace-win-x64.zip'
    $archive = Join-Path $build.FullName $archiveName
    Compress-Archive -LiteralPath $stage.FullName -DestinationPath $archive
    Move-Item -LiteralPath $archive -Destination (Join-Path $output $archiveName) -Force
    $sourceRuntime = New-Item -ItemType Directory -Path (Join-Path $root 'runtime') -Force
    Copy-Item -LiteralPath (Join-Path $runtime.FullName 'LocalWorkspace.Windows.exe') -Destination $sourceRuntime.FullName
    Get-Item -LiteralPath (Join-Path $output $archiveName)
} finally {
    $resolvedOutput = (Resolve-Path -LiteralPath $output).Path + '\'
    $resolvedBuild = (Resolve-Path -LiteralPath $build.FullName).Path
    if (!$resolvedBuild.StartsWith($resolvedOutput, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected build directory.' }
    Remove-Item -LiteralPath $resolvedBuild -Recurse -Force
}
