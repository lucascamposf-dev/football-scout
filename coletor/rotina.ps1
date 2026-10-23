# Rotina semanal: COLETA a temporada atual e RECALCULA o ELO em elo_historico (tabela nova).
# NAO aplica em elo_ratings (regra 5 do CLAUDE.md). Para aplicar, rode: .\aplicar_elo.ps1
Set-Location $PSScriptRoot
$env:DATABASE_URL = [Environment]::GetEnvironmentVariable("DATABASE_URL", "User")
$env:FD_KEY = [Environment]::GetEnvironmentVariable("FD_KEY", "User")
.\.venv\Scripts\python.exe coletor.py --temporadas 2026-27
.\.venv\Scripts\python.exe recalcular_elo.py
Write-Host ""
Write-Host "Coleta e recalculo concluidos. elo_ratings NAO foi alterado. Para aplicar: .\aplicar_elo.ps1"
