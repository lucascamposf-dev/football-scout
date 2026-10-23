# Football Scout IA

App de análise de apostas esportivas (futebol principal; tênis e basquete secundários). Gera previsões
(Poisson + Dixon-Coles + ELO + blend com odds de mercado), salva no Tracker, calibra automaticamente
e liquida os resultados. Uso informativo/educacional.

## Stack
- **Front**: React 18 + Vite 5 (`src/`). Duas entradas: `index.html` (site) e `admin.html` (painel admin).
- **Back**: Node 20 + Express, ESM (`server/`). Postgres via `pg`. Deploy no Railway (NIXPACKS).
- **Coletor/estatística**: Python em `coletor/` (soccerdata, pandas, requests) — roda localmente com venv.
- **IA**: Groq (e Gemini) chamados *pelo servidor* (`/api/groq`, `/api/gemini`).

## Comandos
- Instalar: `npm install` (raiz) e `cd server && npm install`
- Front (dev): `npm run dev` → http://localhost:5173
- Servidor (dev): `cd server && node index.js` → porta 3001 (o front usa `http://localhost:3001` quando hostname é localhost)
- Build: `npm run build` (gera `dist/`, servido pelo Express em produção)
- Produção: `npm start` (= `cd server && node index.js`)
- Teste de calibração: `node testeCalibracao.mjs` (na raiz; usa dados sintéticos e stubs de browser)
- Python (dentro de `coletor/`, venv ativo, `DATABASE_URL` no ambiente):
  `python coletor.py --dry` · `python mapa_nomes.py` · `python recalcular_elo.py` · `python backtest_mercado.py`

## Mapa do código
- `src/services/groqService.js` — motor de previsão de futebol (~3000 linhas). Núcleo do modelo.
- `src/services/calibrationService.js` — calibração automática a partir do Tracker.
- `src/services/eloService.js` — ELO (K=32, início 1500), persistido via `/api/elo`. Limites do fator ELO (`ELO_FATOR_BRUTO`, `ELO_LIMITES_1X2`, `ELO_LIMITES_GOLS`) vivem só aqui; `coletor/backtest_mercado.py` espelha os de gols (`python backtest_mercado.py --grid` compara faixas).
- `src/services/modelVersion.js` e `server/modelVersion.js` — versão do motor (ver regra abaixo).
- `src/tracker/ScoutTracker.jsx`, `src/App.jsx` (~3200 linhas), `src/components/` — UI.
- `server/index.js` — rotas, auth (sessions + roles), Tracker, liquidação automática, Telegram, alertas.
- `server/scrapers/` — FlashLive/Flashscore, tênis, basquete, clima, cache. (SofaScore foi removido; não reintroduzir.)
- `coletor/` — histórico 2021-26 em `jogos_historico`, `times_mapa` (nome → id football-data.org), `elo_historico`.

## Regras importantes
1. **Versão do motor**: ao mudar a lógica de previsão, suba a versão em `src/services/modelVersion.js`
   E em `server/modelVersion.js` (sincronia manual) e acrescente entrada em `HISTORICO_VERSOES`.
   Nunca apague entradas antigas. MAJOR = fórmula central, MINOR = novo mercado/fator/fonte, PATCH = constante/bug.
2. **Segredos**: chaves só no `.env` / variáveis do Railway, lidas no servidor. NUNCA usar prefixo `VITE_`
   (publica no navegador) e nunca commitar chaves. Ver `.env.example`.
3. **Rotas novas** em `server/index.js` devem usar `authMiddleware` (e `adminMiddleware` se alterarem dados globais).
4. **Mudanças no modelo** só valem com evidência: rodar `backtest_mercado.py` (log-loss 1X2 vs. mercado)
   antes/depois e registrar o resultado na entrada de `HISTORICO_VERSOES`.
5. **Banco**: `coletor/*.py` e o DDL do Node espelham as mesmas colunas (`SPEC` em `coletor.py`). Alterar um exige alterar o outro.
   `recalcular_elo.py --aplicar` sobrescreve `elo_ratings` (faz backup antes) — não rodar sem pedir confirmação.
   A rotina semanal (`coletor/rotina.ps1`) só coleta e recalcula em `elo_historico`; quem aplica é `coletor/aplicar_elo.ps1` (pede confirmação).
   O `--aplicar` também grava os jogos do histórico em `elo_jogos_processados` (chave `idCasa|idFora|AAAA-MM-DD`, datas em UTC, ±1 dia) para o servidor não contar o mesmo jogo duas vezes.
6. Arquivos gigantes (`App.jsx`, `groqService.js`, `server/index.js`): ler por trechos (`grep -n` + intervalo de linhas), não inteiros.

## Convenções
- Código e comentários em português; mensagens de commit curtas, em português.
- Datas em UTC no armazenamento, conversão só na exibição.
- Nomes de times variam por fonte: sempre passar pelo mapa (`times_mapa`) em vez de comparar strings cruas.

## Pendências conhecidas (não "consertar" sem pedir)
- Usuário `admin` é criado no primeiro boot com a senha de `ADMIN_PASSWORD` (ou uma aleatória exibida no log).
