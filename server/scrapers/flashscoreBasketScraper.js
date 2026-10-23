// server/scrapers/flashscoreBasketScraper.js
// ─────────────────────────────────────────────────────────────
// BASQUETE via FlashLive Sports (RapidAPI) — substitui o SportAPI
// (sportapi7) que o basketballService.js usava.
//
// Endpoints (mesmos já usados em produção para futebol/tênis):
//   - /v1/events/list   sport_id=3 (Basketball)  → jogos de um dia
//   - /v1/teams/results sport_id=3 + team_id     → últimos jogos de um time
//
// Os eventos saem NORMALIZADOS no formato que o basketballService.js (front)
// já entende — { id, homeTeam:{id,name}, awayTeam:{id,name},
// homeScore:{current}, awayScore:{current}, status:{type}, startTimestamp,
// tournament:{name} } — assim a lógica de previsão do front não muda.
//
// ⚠️ NÃO CONFIRMADO (por isso getDiagnosticoBasquete existe): os nomes reais
// de torneio que a API devolve em pt_BR (ex.: "EUA: NBA", "EUROPA: Euroliga",
// "BRASIL: NBB") e se HOME_SCORE_CURRENT já inclui prorrogação. Se alguma liga
// nunca achar jogos, abra GET /api/sportsdata/flashlive/basquete/diagnostico
// e ajuste LIGA_FILTRO no basketballService.js.
// ─────────────────────────────────────────────────────────────

const FLASHLIVE_HOST = 'flashlive-sports.p.rapidapi.com'
const FLASHLIVE_KEY  = process.env.FLASHLIVE_KEY || process.env.SPORT_KEY || ''
const SPORT_BASQUETE = 3

async function flFetch(endpoint, params = {}) {
  if (!FLASHLIVE_KEY) return null
  const query = new URLSearchParams({ locale: 'pt_BR', ...params }).toString()
  try {
    const res = await fetch(`https://${FLASHLIVE_HOST}/v1/${endpoint}?${query}`, {
      headers: { 'x-rapidapi-host': FLASHLIVE_HOST, 'x-rapidapi-key': FLASHLIVE_KEY },
    })
    if (!res.ok) {
      console.warn(`[FlashLive Basquete] HTTP ${res.status} em ${endpoint}`)
      return null
    }
    const data = await res.json()
    return data?.DATA ?? null
  } catch (err) {
    console.warn('[FlashLive Basquete] fetch falhou:', err.message)
    return null
  }
}

function extrairStartTimestamp(ev) {
  const bruto = ev.START_TIME ?? ev.START_UTC_TIME ?? ev.START_TIMESTAMP ?? null
  if (bruto == null) return null
  const n = Number(bruto)
  if (!Number.isFinite(n)) return null
  return n > 1e12 ? Math.floor(n / 1000) : n
}

// Mesmo vocabulário de status do resto do projeto (finished / postponed /
// canceled / notstarted / inprogress).
function mapearStatus(ev) {
  const t = String(ev.STAGE_TYPE ?? '').toUpperCase()
  const s = String(ev.STAGE ?? '').toUpperCase()
  const txt = `${t} ${s}`
  if (/POSTPONED|ADIADO/.test(txt)) return 'postponed'
  if (/CANCEL/.test(txt))           return 'canceled'
  if (t === 'FINISHED')             return 'finished'
  if (['NOT_STARTED', 'SCHEDULED', 'FIXTURE'].includes(t)) return 'notstarted'
  return 'inprogress'
}

function placar(v) {
  const n = parseInt(v ?? '')
  return Number.isFinite(n) ? n : null
}

function normalizarEvento(ev, torneio) {
  return {
    id: ev.EVENT_ID,
    homeTeam: { id: ev.HOME_PARTICIPANT_IDS?.[0] ?? null, name: ev.HOME_NAME ?? 'Time A' },
    awayTeam: { id: ev.AWAY_PARTICIPANT_IDS?.[0] ?? null, name: ev.AWAY_NAME ?? 'Time B' },
    homeScore: { current: placar(ev.HOME_SCORE_CURRENT ?? ev.HOME_SCORE_FULL) },
    awayScore: { current: placar(ev.AWAY_SCORE_CURRENT ?? ev.AWAY_SCORE_FULL) },
    status: { type: mapearStatus(ev), descricao: ev.STAGE ?? '' },
    startTimestamp: extrairStartTimestamp(ev),
    tournament: { name: torneio },
  }
}

function achatar(dados) {
  const eventos = []
  for (const grupo of Array.isArray(dados) ? dados : []) {
    const torneio = grupo.NAME ?? grupo.TOURNAMENT_NAME ?? grupo.CATEGORY_NAME ?? 'Basquete'
    for (const ev of grupo.EVENTS ?? []) eventos.push(normalizarEvento(ev, torneio))
  }
  return eventos
}

// ── Jogos de um dia (indentDays: 0 = hoje, 1 = amanhã, -1 = ontem...) ──
export async function getJogosBasqueteDia(indentDays = 0) {
  const n = Math.max(-7, Math.min(7, parseInt(indentDays) || 0))
  const dados = await flFetch('events/list', { sport_id: SPORT_BASQUETE, timezone: -3, indent_days: n })
  if (!dados) return { erro: 'FlashLive não respondeu (verifique FLASHLIVE_KEY)' }
  return { fonte: 'flashlive', events: achatar(dados) }
}

// ── Últimos jogos FINALIZADOS de um time ──
export async function getUltimosJogosBasquete(teamId, limit = 8) {
  if (!teamId) return { erro: 'teamId obrigatório' }
  const id = String(teamId)
  const dados = await flFetch('teams/results', { sport_id: SPORT_BASQUETE, team_id: id, page: 1 })
  if (!dados) return { erro: 'FlashLive não respondeu (verifique FLASHLIVE_KEY)' }

  const events = achatar(dados)
    .filter(e => e.status.type === 'finished')
    .filter(e => String(e.homeTeam.id) === id || String(e.awayTeam.id) === id)
    .sort((a, b) => (b.startTimestamp ?? 0) - (a.startTimestamp ?? 0))
    .slice(0, Math.max(1, Math.min(20, parseInt(limit) || 8)))

  return { fonte: 'flashlive', events }
}

// ── Diagnóstico: nomes de torneio crus de hoje + 1 evento cru ──
export async function getDiagnosticoBasquete() {
  const dados = await flFetch('events/list', { sport_id: SPORT_BASQUETE, timezone: -3, indent_days: 0 })
  if (!dados) return { erro: 'FlashLive não respondeu (verifique FLASHLIVE_KEY)' }
  const grupos = Array.isArray(dados) ? dados : []
  return {
    totalTorneios: grupos.length,
    torneios: grupos.map(g => ({
      nome: g.NAME ?? g.TOURNAMENT_NAME ?? g.CATEGORY_NAME ?? null,
      jogos: g.EVENTS?.length ?? 0,
    })),
    exemploEventoCru: grupos.find(g => g.EVENTS?.length)?.EVENTS?.[0] ?? null,
  }
}

// ── Basquete AO VIVO agora (events/live-list) ──
// Mesmo formato normalizado dos jogos do dia, + pontos por período quando vierem
// (HOME_SCORE_PART_1..5 — mesmo padrão dos sets do tênis; se não vierem, só some o detalhe).
export async function getJogosBasqueteAoVivo() {
  const dados = await flFetch('events/live-list', { sport_id: SPORT_BASQUETE, timezone: -3 })
  if (!dados) return { erro: 'FlashLive não respondeu (verifique FLASHLIVE_KEY)', jogos: [] }

  const grupos = Array.isArray(dados) && dados[0]?.EVENTS ? dados : [{ NAME: 'Basquete', EVENTS: Array.isArray(dados) ? dados : [] }]
  const jogos = []
  for (const g of grupos) {
    const torneio = g.NAME ?? g.TOURNAMENT_NAME ?? g.CATEGORY_NAME ?? 'Basquete'
    for (const ev of g.EVENTS ?? []) {
      const base = normalizarEvento(ev, torneio)
      if (base.status.type === 'finished') continue // live-list às vezes traz encerrados recentes
      const periodos = [1, 2, 3, 4, 5, 6, 7].map(n => ({
        casa: placar(ev[`HOME_SCORE_PART_${n}`]), fora: placar(ev[`AWAY_SCORE_PART_${n}`]),
      })).filter(p => p.casa != null || p.fora != null)
      jogos.push({
        id: base.id,
        competicao: torneio,
        mandante: base.homeTeam.name, visitante: base.awayTeam.name,
        mandanteId: base.homeTeam.id, visitanteId: base.awayTeam.id,
        pontosMandante: base.homeScore.current ?? 0,
        pontosVisitante: base.awayScore.current ?? 0,
        status: base.status.type,
        statusDescricao: base.status.descricao,
        periodos,
        startTimestamp: base.startTimestamp,
      })
    }
  }
  jogos.sort((a, b) => String(a.competicao).localeCompare(String(b.competicao)))
  return { fonte: 'flashlive', jogos, total: jogos.length }
}
