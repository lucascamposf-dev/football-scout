# Aplica o ELO recalculado em elo_ratings (faz backup em elo_ratings_backup) e marca os jogos do
# historico como "ja contados" em elo_jogos_processados. Pede confirmacao antes (regra 5 do CLAUDE.md).
Set-Location $PSScriptRoot
$env:DATABASE_URL = [Environment]::GetEnvironmentVariable("DATABASE_URL", "User")
$resp = Read-Host "Isto SOBRESCREVE elo_ratings (backup automatico em elo_ratings_backup). Continuar? (s/N)"
if ($resp -ne "s") { Write-Host "Cancelado."; exit 0 }
.\.venv\Scripts\python.exe recalcular_elo.py --aplicar
