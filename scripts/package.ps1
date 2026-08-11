# Package Noodlr Hooks 5.5e for a GitHub release: validate, clean-build, zip, then verify the zip.
#
# Run from the repo root as `npm run package`.
#
# The assertions here are inherited from noodlr, where two packaging faults shipped in a row: a release
# created with no assets at all — which Foundry reports as "No module manifest found", and which BLOCKS
# updating because the manifest URL resolves to releases/latest — and an asset missing a required
# runtime file, which only breaks for people installing by manifest and so cannot be noticed from a dev
# install. Both are assertions rather than things to remember.

$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

function Fail([string]$message) {
  Write-Host "FAIL: $message" -ForegroundColor Red
  exit 1
}

# --- versions must agree, and the download URL must point at the tag we are about to cut ------------
$pkg = Get-Content package.json -Raw | ConvertFrom-Json
$mod = Get-Content module.json -Raw | ConvertFrom-Json
$version = $mod.version
if ($pkg.version -ne $version) {
  Fail "package.json ($($pkg.version)) and module.json ($version) disagree on the version"
}
if ($mod.download -notlike "*v$version/module.zip") {
  Fail "module.json download URL does not point at v$version : $($mod.download)"
}

# --- validate and build fresh ----------------------------------------------------------------------
npm run check
if ($LASTEXITCODE) { Fail "tsc reported errors" }
npm run lint
if ($LASTEXITCODE) { Fail "eslint reported errors" }
npm run build
if ($LASTEXITCODE) { Fail "build failed" }

# --- the payload -----------------------------------------------------------------------------------
$paths = @("dist", "lang", "styles", "templates", "changelog.md", "LICENSE", "module.json", "README.md")
foreach ($p in $paths) {
  if (-not (Test-Path $p)) { Fail "missing from the working tree: $p" }
}

Remove-Item module.zip -Force -ErrorAction SilentlyContinue
Compress-Archive -Path $paths -DestinationPath module.zip -CompressionLevel Optimal

# --- verify the archive itself, not the intent ------------------------------------------------------
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path module.zip))
try {
  $required = @(
    "module.json",
    "dist/noodlr-hooks-55e.js",
    "lang/en.json",
    "styles/noodlr-hooks.css",
    # Fetched by path at render time, so a missing template is a 404 in the console rather than a
    # build error. Asserted here for the same reason noodlr asserts its own partials.
    "templates/capability-sheet.hbs"
  )
  foreach ($r in $required) {
    if (-not ($zip.Entries | Where-Object { $_.FullName -like "$r*" })) { Fail "zip is missing $r" }
  }
  $entries = $zip.Entries.Count
}
finally {
  $zip.Dispose()
}

$kb = [math]::Round((Get-Item module.zip).Length / 1KB, 1)
Write-Host ""
Write-Host "packaged v$version - module.zip, $entries entries, $kb KB" -ForegroundColor Green
Write-Host "next:"
Write-Host "  git add -A; git commit; git tag -a v$version; git push origin HEAD --tags"
Write-Host "  gh release create v$version module.zip module.json --title ... --notes-file ..."
Write-Host "  gh release view v$version --json assets   # must list BOTH module.json and module.zip"
