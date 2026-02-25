$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$base = Join-Path $root "kb\laws_xml\downloads\2026-02-01\unzipped"

if (-not (Test-Path $base)) {
  throw "Unzipped laws directory not found: $base"
}

$lawDirs = @(
  "burlg",   # Bundesurlaubsgesetz
  "bgb",     # Bürgerliches Gesetzbuch
  "kschg",   # Kündigungsschutzgesetz
  "arbzg",   # Arbeitszeitgesetz
  "gewo",    # Gewerbeordnung
  "arbgg",   # Arbeitsgerichtsgesetz
  "tzbfg",   # Teilzeit- und Befristungsgesetz
  "nachwg"   # Nachweisgesetz
)

Write-Host "Labor pack ingest start"
Write-Host "Base: $base"

foreach ($law in $lawDirs) {
  $dir = Join-Path $base $law
  if (-not (Test-Path $dir)) {
    Write-Host "SKIP $law (folder not found)"
    continue
  }

  Write-Host ""
  Write-Host "==> Ingesting $law from $dir"
  $env:LAW_XML_DIR = $dir
  node (Join-Path $root "scripts\ingest-laws.js")
  if ($LASTEXITCODE -ne 0) {
    throw "ingest-laws.js failed for $law"
  }
}

Write-Host ""
Write-Host "==> Final DB check"
node (Join-Path $root "check-db.cjs")
if ($LASTEXITCODE -ne 0) {
  throw "check-db.cjs failed"
}

Write-Host "Labor pack ingest completed"
