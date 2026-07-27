$ErrorActionPreference = "Stop"
$Project = "C:\sihirbaz-ai\sihirbaz-ai"
if (-not (Test-Path "$Project\package.json")) { throw "Proje bulunamadi: $Project" }
Set-Location $Project
$env:RADAR_INTERVAL_MS = "30000"
$env:RADAR_BATCH_PER_EXCHANGE = "8"
$env:SCAN_CONCURRENCY = "16"
$env:SCAN_TIMEOUT_MS = "10000"
$env:RADAR_EVENT_TTL_MS = "1200000"
Start-Process powershell -ArgumentList @('-NoExit','-ExecutionPolicy','Bypass','-Command',"Set-Location '$Project'; `$env:RADAR_INTERVAL_MS='30000'; `$env:RADAR_BATCH_PER_EXCHANGE='8'; `$env:SCAN_CONCURRENCY='16'; `$env:SCAN_TIMEOUT_MS='10000'; `$env:RADAR_EVENT_TTL_MS='1200000'; node scripts\radar-loop.mjs")
Start-Sleep -Seconds 2
npm run dev
