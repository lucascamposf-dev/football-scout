// eloService.js — VERSÃO COM PERSISTÊNCIA POSTGRESQL
// Migrado de localStorage → /api/elo (backend PostgreSQL)
// Lógica de cálculo idêntica — só a camada de persistência mudou.
// ─────────────────────────────────────────────────────────────

const ELO_INICIAL = 1500
const K_FACTOR    = 32

// ── Limites do fator ELO — FONTE ÚNICA (CLAUDE.md, item 6) ──────────────────
// Antes cada arquivo tinha o seu clamp. Agora todos importam daqui; o backtest
// (coletor/backtest_mercado.py, constantes LIM_*) espelha estes mesmos valores.
// Mudar um valor aqui = mudar o motor → seguir as regras 1 e 4 do CLAUDE.md.
export const ELO_FATOR_BRUTO  = { min: 0.80, max: 1.25 }  // saída de fatorAdversario()
export const ELO_LIMITES_1X2  = { min: 0.88, max: 1.12 }  // fração ELO do blend 1X2 (groqService)
export const ELO_LIMITES_GOLS = { min: 0.90, max: 1.12 }  // multiplicador do λ de gols (groqService)

export function limitarFatorElo(fator, { min, max }) {
  const f = Number(fator)
  return Math.min(max, Math.max(min, Number.isFinite(f) ? f : 1))
}

const IS_PROD  = window.location.hostname !== 'localhost'
const API_BASE = IS_PROD ? '' : 'http://localhost:3001'
const ELO_URL  = `${API_BASE}/api/elo`

// ── Cache em memória para evitar chamadas repetidas na mesma sessão ──────────
let _cacheRatings = null        // null = não carregado ainda
let _cacheDirty   = false       // true = tem alterações não salvas

async function carregarRatings() {
  if (_cacheRatings !== null) return _cacheRatings
  try {
    const res = await fetch(ELO_URL, { headers: authHeaders() })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    _cacheRatings = await res.json()   // { "42": 1523.5, "87": 1488.0, ... }
  } catch (err) {
    console.warn('[ELO] Falha ao carregar do servidor — usando cache vazio:', err.message)
    _cacheRatings = {}
  }
  return _cacheRatings
}

async function salvarRatings(ratings) {
  try {
    const res = await fetch(ELO_URL, {
      method:  'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body:    JSON.stringify(ratings),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    _cacheDirty = false
  } catch (err) {
    console.warn('[ELO] Falha ao salvar no servidor:', err.message)
  }
}

// ── Cálculo ELO padrão (sem mudança) ────────────────────────────────────────
function expectedScore(eloA, eloB) {
  return 1 / (1 + Math.pow(10, (eloB - eloA) / 400))
}

function novoElo(eloAtual, resultado, expected) {
  return parseFloat((eloAtual + K_FACTOR * (resultado - expected)).toFixed(1))
}

// ── Atualiza ELO a partir de uma lista de partidas ───────────────────────────
export async function atualizarElo(matches) {
  const ratings = await carregarRatings()

  let houveMudanca = false

  for (const m of matches) {
    const { homeId, awayId, homeScore, awayScore } = m
    if (homeId == null || awayId == null) continue
    if (homeScore == null || awayScore == null) continue

    const eloH = ratings[homeId] ?? ELO_INICIAL
    const eloA = ratings[awayId] ?? ELO_INICIAL

    const expH = expectedScore(eloH, eloA)
    const expA = 1 - expH

    let resH, resA
    if (homeScore > awayScore)      { resH = 1;   resA = 0   }
    else if (homeScore < awayScore) { resH = 0;   resA = 1   }
    else                            { resH = 0.5; resA = 0.5 }

    const novoH = novoElo(eloH, resH, expH)
    const novoA = novoElo(eloA, resA, expA)

    // Só marca dirty se o valor realmente mudou
    if (novoH !== eloH || novoA !== eloA) {
      ratings[homeId] = novoH
      ratings[awayId] = novoA
      houveMudanca = true
    }
  }

  if (houveMudanca) {
    _cacheDirty = true
    await salvarRatings(ratings)
  }

  return ratings
}

// ── Retorna rating de um time ────────────────────────────────────────────────
export async function getElo(teamId) {
  const ratings = await carregarRatings()
  return ratings[teamId] ?? ELO_INICIAL
}

// ── Fator de qualidade do adversário ────────────────────────────────────────
// Retorna multiplicador entre ELO_FATOR_BRUTO.min e .max (hoje 0.80 e 1.25);
// quem consome ainda aplica ELO_LIMITES_1X2 / ELO_LIMITES_GOLS por cima.
export async function fatorAdversario(teamIdAtacante, teamIdDefensor) {
  const [eloAtacante, eloDefensor] = await Promise.all([
    getElo(teamIdAtacante),
    getElo(teamIdDefensor),
  ])

  const diff  = eloAtacante - eloDefensor
  const fator = 1 + (diff / 1000)
  return parseFloat(limitarFatorElo(fator, ELO_FATOR_BRUTO).toFixed(3))
}
// ── Token de login (as rotas /api/elo exigem login) ─────────────────────────
function authHeaders(extra = {}) {
  const token = typeof localStorage !== 'undefined' ? localStorage.getItem('scout_token') : null
  return token ? { ...extra, 'x-auth-token': token } : extra
}

// ── Alimenta o ELO com os jogos recentes — o SERVIDOR aplica cada jogo uma única vez ──
export async function alimentarEloComHistorico(jogos) {
  const partidas = []

  for (const jogo of jogos) {
    for (const lista of [jogo.ultimos5_mandante_raw, jogo.ultimos5_visitante_raw]) {
      if (!Array.isArray(lista)) continue
      for (const m of lista) {
        const hId  = m.homeTeam?.id
        const aId  = m.awayTeam?.id
        const hS   = m.score?.fullTime?.home
        const aS   = m.score?.fullTime?.away
        const data = String(m.utcDate || '').slice(0, 10)
        if (hId && aId && hS != null && aS != null && data) {
          partidas.push({ homeId: hId, awayId: aId, homeScore: hS, awayScore: aS, data })
        }
      }
    }
  }
  if (!partidas.length) return

  try {
    const res = await fetch(`${ELO_URL}/jogos`, {
      method:  'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body:    JSON.stringify({ partidas }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const { aplicados } = await res.json()
    if (aplicados > 0) _cacheRatings = null     // há ratings novos → recarrega na próxima leitura
  } catch (err) {
    console.warn('[ELO] Falha ao enviar jogos ao servidor:', err.message)
  }
}


// ── Utilitário: retorna todos os ratings (para debug/admin) ─────────────────
export async function todosOsRatings() {
  return carregarRatings()
}

// ── Utilitário: invalida o cache (use após deploy ou reset manual) ───────────
export function invalidarCacheElo() {
  _cacheRatings = null
  _cacheDirty   = false
}