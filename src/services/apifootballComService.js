// apifootballComService.js — usa apifootball.com (NÃO api-sports.io)
// Plano gratuito cobre: Brasileirão (99), Libertadores (18),
// Sudamericana (385), Copa do Brasil (349), Bundesliga (175), etc.
// Retorna: cartões, escanteios, escalações, árbitro, stats 1º tempo
// ─────────────────────────────────────────────────────────────

const IS_PROD  = typeof window !== 'undefined' && window.location.hostname !== 'localhost'
const API_BASE = IS_PROD ? '' : 'http://localhost:3001'
const BASE_URL = `${API_BASE}/api/apifootballcom`

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── Mapa liga → league_id da apifootball.com ─────────────────
export const APIFOOTBALLCOM_LEAGUE_IDS = {
  'BSA': 99,   // Brasileirão Série A
  'CLI': 18,   // CONMEBOL Libertadores
  'CSA': 385,  // CONMEBOL Sudamericana
  'CDB': 349,  // Copa do Brasil
  'CL':  3,    // UEFA Champions League
  'EL':  4,    // UEFA Europa League
  'PL':  1,    // Premier League
  'PD':  302,  // La Liga
  'SA':  207,  // Serie A Itália
  'BL1': 175,  // Bundesliga
  'FL1': 168,  // Ligue 1
  'WC':   1,    // Copa do Mundo FIFA
  'WCQ':  32,   // Eliminatórias Copa do Mundo
  'CA':   9,    // Copa América
  'NL':   5,    // UEFA Nations League
  'EURO': 6,    // Eurocopa
}

// ── Cache diário ──────────────────────────────────────────────
const _cache = {
  _store: {},
  _dia: new Date().toISOString().slice(0, 10),
  _check() {
    const hoje = new Date().toISOString().slice(0, 10)
    if (hoje !== this._dia) { this._store = {}; this._dia = hoje }
  },
  get(k)    { this._check(); return this._store[k] ?? null },
  set(k, v) { this._check(); this._store[k] = v; return v },
}

// ✅ Rota /api/apifootballcom agora exige login — reaproveita o token salvo pelo LoginSite
function authHeaders() {
  const token = typeof localStorage !== 'undefined' ? localStorage.getItem('scout_token') : null
  return token ? { 'x-auth-token': token } : {}
}

// ── Fetch via proxy ───────────────────────────────────────────
async function apiFetch(params = {}) {
  const query    = new URLSearchParams(params).toString()
  const cacheKey = `apifbcom_${query}`
  const cached   = _cache.get(cacheKey)
  if (cached) return cached

  try {
    const res = await fetch(`${BASE_URL}?${query}`, { headers: authHeaders() })
    if (!res.ok) { console.warn(`[ApifootballCom] erro ${res.status}`); return null }
    const data = await res.json()
    if (data?.error) { console.warn('[ApifootballCom] erro API:', data.message); return null }
    return _cache.set(cacheKey, data)
  } catch (err) {
    console.warn('[ApifootballCom] falhou:', err.message)
    return null
  }
}

// ── Helpers ───────────────────────────────────────────────────
function norm(s) {
  return (s ?? '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '')
}

function getStat(statistics, tipo) {
  const s = statistics?.find(x => x.type?.toLowerCase().includes(tipo.toLowerCase()))
  return { home: parseInt(s?.home ?? 0) || 0, away: parseInt(s?.away ?? 0) || 0 }
}

function contarCartoes(cards, lado) {
  // lado: 'home' = home_fault preenchido, 'away' = away_fault preenchido
  if (!Array.isArray(cards)) return { amarelos: 0, vermelhos: 0, total: 0 }
  let amarelos = 0, vermelhos = 0
  for (const c of cards) {
    const temFalta = lado === 'home' ? !!c.home_fault : !!c.away_fault
    if (!temFalta) continue
    if (c.card === 'yellow card') amarelos++
    if (c.card === 'red card' || c.card === 'yellow red card') vermelhos++
  }
  return { amarelos, vermelhos, total: amarelos + vermelhos }
}

// ─────────────────────────────────────────────────────────────
// BUSCA JOGOS DO DIA/AMANHÃ POR LIGA
// ─────────────────────────────────────────────────────────────
export async function buscarJogosLiga(ligaCode) {
  const leagueId = APIFOOTBALLCOM_LEAGUE_IDS[ligaCode]
  if (!leagueId) return []

  const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
  const amanha = new Date()
  amanha.setDate(amanha.getDate() + 1)
  const amanhaStr = amanha.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })

  const [resHoje, resAmanha] = await Promise.all([
    apiFetch({ action: 'get_events', from: hoje,      to: hoje,      league_id: leagueId }),
    apiFetch({ action: 'get_events', from: amanhaStr, to: amanhaStr, league_id: leagueId }),
  ])

  const jogosHoje   = Array.isArray(resHoje)   ? resHoje   : []
  const jogosAmanha = Array.isArray(resAmanha) ? resAmanha : []

  return [...jogosHoje.map(j => ({ ...j, _usandoAmanha: false })),
          ...jogosAmanha.map(j => ({ ...j, _usandoAmanha: true }))]
}

// ─────────────────────────────────────────────────────────────
// BUSCA HISTÓRICO DE UM TIME (últimos N jogos)
// ─────────────────────────────────────────────────────────────
export async function buscarHistoricoTime(ligaCode, teamId, last = 5) {
  const leagueId = APIFOOTBALLCOM_LEAGUE_IDS[ligaCode]
  if (!leagueId || !teamId) return []

  const anoAtual = new Date().getFullYear()
  const dataFim  = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
  const dataIni  = `${anoAtual}-01-01`

  const data = await apiFetch({
    action:    'get_events',
    from:      dataIni,
    to:        dataFim,
    league_id: leagueId,
    team_id:   teamId,
  })

  if (!Array.isArray(data)) return []

  return data
    .filter(j => j.match_status === 'Finished' &&
                 j.match_hometeam_score !== '' &&
                 j.match_awayteam_score !== '')
    .sort((a, b) => new Date(b.match_date) - new Date(a.match_date))
    .slice(0, last)
    .map(j => processarJogo(j, teamId))
}

// ─────────────────────────────────────────────────────────────
// BUSCA ESTATÍSTICAS COMPLETAS DE CARTÕES E ESCANTEIOS
// Para um confronto específico (últimos 5 jogos de cada time)
// ─────────────────────────────────────────────────────────────
export async function fetchCartoeseEscanteiosApifootballCom(
  mandanteNome, visitanteNome, ligaCode, dataJogo,
  mandanteTeamId = null, visitanteTeamId = null
) {
  const cacheKey = `ce_${mandanteNome}_${visitanteNome}_${dataJogo}`
  const cached   = _cache.get(cacheKey)
  if (cached) return cached

  try {
    const leagueId = APIFOOTBALLCOM_LEAGUE_IDS[ligaCode]
    if (!leagueId) return null

    const anoAtual = new Date().getFullYear()
    const dataFim  = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
    const dataIni  = `${anoAtual}-01-01`

    // Busca todos os jogos da liga na temporada
    const todosJogos = await apiFetch({
      action:    'get_events',
      from:      dataIni,
      to:        dataFim,
      league_id: leagueId,
    })

    if (!Array.isArray(todosJogos)) return null

    const jogosFinalizados = todosJogos.filter(j =>
      j.match_status === 'Finished' &&
      j.match_hometeam_score !== '' &&
      j.match_awayteam_score !== ''
    )

    const nM = norm(mandanteNome)
    const nV = norm(visitanteNome)

    // Últimos 5 jogos de cada time (qualquer posição: casa ou fora)
    const jogosM = jogosFinalizados
      .filter(j => norm(j.match_hometeam_name).includes(nM.slice(0,5)) ||
                   nM.includes(norm(j.match_hometeam_name).slice(0,5)) ||
                   norm(j.match_awayteam_name).includes(nM.slice(0,5)) ||
                   nM.includes(norm(j.match_awayteam_name).slice(0,5)))
      .sort((a, b) => new Date(b.match_date) - new Date(a.match_date))
      .slice(0, 5)

    const jogosV = jogosFinalizados
      .filter(j => norm(j.match_hometeam_name).includes(nV.slice(0,5)) ||
                   nV.includes(norm(j.match_hometeam_name).slice(0,5)) ||
                   norm(j.match_awayteam_name).includes(nV.slice(0,5)) ||
                   nV.includes(norm(j.match_awayteam_name).slice(0,5)))
      .sort((a, b) => new Date(b.match_date) - new Date(a.match_date))
      .slice(0, 5)

    const calcMediasTime = (jogos, nomeTime) => {
      if (!jogos.length) return null
      const nT = norm(nomeTime)
      const stats = jogos.map(j => {
        const isHome = norm(j.match_hometeam_name).includes(nT.slice(0,5)) ||
                       nT.includes(norm(j.match_hometeam_name).slice(0,5))
        const lado   = isHome ? 'home' : 'away'
        const cartoes = contarCartoes(j.cards, lado)
        const escanteios = getStat(j.statistics, 'corners')
        return {
          cartoes_amarelos:  cartoes.amarelos,
          cartoes_vermelhos: cartoes.vermelhos,
          cartoes_total:     cartoes.total,
          escanteios:        isHome ? escanteios.home : escanteios.away,
          cartoes_jogo:      (j.cards ?? []).length,
          escanteios_jogo:   escanteios.home + escanteios.away,
        }
      })

      const media = campo => parseFloat(
        (stats.reduce((s, v) => s + (v[campo] ?? 0), 0) / stats.length).toFixed(1)
      )

      return {
        mediaCartoesAmarelos:  media('cartoes_amarelos'),
        mediaCartoesVermelhos: media('cartoes_vermelhos'),
        mediaCartoesTotais:    media('cartoes_total'),
        mediaEscanteios:       media('escanteios'),
        mediaCartoesJogo:      media('cartoes_jogo'),
        mediaEscanteiosJogo:   media('escanteios_jogo'),
        amostras:              stats.length,
      }
    }

    const mediasM = calcMediasTime(jogosM, mandanteNome)
    const mediasV = calcMediasTime(jogosV, visitanteNome)

    if (!mediasM && !mediasV) return null

    // Estatísticas do confronto direto se existir na lista
    const confrontoDireto = jogosFinalizados.find(j => {
      const h = norm(j.match_hometeam_name)
      const a = norm(j.match_awayteam_name)
      return (h.includes(nM.slice(0,5)) || nM.includes(h.slice(0,5))) &&
             (a.includes(nV.slice(0,5)) || nV.includes(a.slice(0,5)))
    })

    // Over cartões e escanteios
    const totalCartoesPrevisto = (mediasM?.mediaCartoesJogo ?? 0) + (mediasV?.mediaCartoesJogo ?? 0)
    const totalEscantPrevisto  = (mediasM?.mediaEscanteiosJogo ?? 0) + (mediasV?.mediaEscanteiosJogo ?? 0)

    const resultado = {
      mandante:  mediasM ?? { mediaCartoesTotais: null, mediaEscanteios: null },
      visitante: mediasV ?? { mediaCartoesTotais: null, mediaEscanteios: null },
      fonte: 'apifootballcom_2026',
      mediaCartoesJogo:    parseFloat(((mediasM?.mediaCartoesJogo ?? 0) + (mediasV?.mediaCartoesJogo ?? 0)).toFixed(1)),
      mediaEscanteiosJogo: parseFloat(((mediasM?.mediaEscanteiosJogo ?? 0) + (mediasV?.mediaEscanteiosJogo ?? 0)).toFixed(1)),
      over35Cartoes:    totalCartoesPrevisto >= 3.5 ? true : false,
      over85Escanteios: totalEscantPrevisto  >= 8.5 ? true : false,
      confrontoDireto: confrontoDireto ? {
        data:       confrontoDireto.match_date,
        placar:     `${confrontoDireto.match_hometeam_score}-${confrontoDireto.match_awayteam_score}`,
        arbitro:    confrontoDireto.match_referee ?? null,
        estadio:    confrontoDireto.match_stadium ?? null,
        escanteios: (() => {
          const e = getStat(confrontoDireto.statistics, 'corners')
          return e.home + e.away
        })(),
        cartoes: confrontoDireto.cards?.length ?? 0,
      } : null,
    }

    return _cache.set(cacheKey, resultado)
  } catch (err) {
    console.warn('[ApifootballCom] cartões/escanteios falhou:', err.message)
    return null
  }
}

// ─────────────────────────────────────────────────────────────
// BUSCA ESCALAÇÃO E ÁRBITRO DO JOGO
// ─────────────────────────────────────────────────────────────
export async function buscarEscalacaoArbitro(mandanteNome, visitanteNome, ligaCode, dataJogo) {
  const cacheKey = `escal_${mandanteNome}_${visitanteNome}_${dataJogo}`
  const cached   = _cache.get(cacheKey)
  if (cached) return cached

  try {
    const leagueId = APIFOOTBALLCOM_LEAGUE_IDS[ligaCode]
    if (!leagueId) return null

    const data = await apiFetch({
      action:    'get_events',
      from:      dataJogo,
      to:        dataJogo,
      league_id: leagueId,
    })

    if (!Array.isArray(data)) return null

    const nM = norm(mandanteNome)
    const nV = norm(visitanteNome)

    const jogo = data.find(j => {
      const h = norm(j.match_hometeam_name)
      const a = norm(j.match_awayteam_name)
      return (h.includes(nM.slice(0,5)) || nM.includes(h.slice(0,5))) &&
             (a.includes(nV.slice(0,5)) || nV.includes(a.slice(0,5)))
    })

    if (!jogo) return null

    const resultado = {
      arbitro:   jogo.match_referee ?? null,
      estadio:   jogo.match_stadium ?? null,
      formacaoM: jogo.match_hometeam_system ?? null,
      formacaoV: jogo.match_awayteam_system ?? null,
      escalacaoM: {
        titulares:   jogo.lineup?.home?.starting_lineups?.map(p => p.lineup_player) ?? [],
        reservas:    jogo.lineup?.home?.substitutes?.map(p => p.lineup_player) ?? [],
        tecnico:     jogo.lineup?.home?.coach?.[0]?.lineup_player ?? null,
        ausentes:    jogo.lineup?.home?.missing_players?.map(p => p.lineup_player) ?? [],
      },
      escalacaoV: {
        titulares:   jogo.lineup?.away?.starting_lineups?.map(p => p.lineup_player) ?? [],
        reservas:    jogo.lineup?.away?.substitutes?.map(p => p.lineup_player) ?? [],
        tecnico:     jogo.lineup?.away?.coach?.[0]?.lineup_player ?? null,
        ausentes:    jogo.lineup?.away?.missing_players?.map(p => p.lineup_player) ?? [],
      },
    }

    return _cache.set(cacheKey, resultado)
  } catch (err) {
    console.warn('[ApifootballCom] escalação falhou:', err.message)
    return null
  }
}

// ─────────────────────────────────────────────────────────────
// ESTATÍSTICAS HISTÓRICAS DO ÁRBITRO NA TEMPORADA (mesma liga)
// Média de cartões/jogo, pênaltis marcados e % de vitória do mandante
// nos jogos que ele apitou — ajuda a calibrar mercados de Cartões e
// entender se é um juiz "rígido" (mais amarelos) ou "deixa jogar".
// ─────────────────────────────────────────────────────────────
export async function buscarEstatisticasArbitro(ligaCode, nomeArbitro) {
  if (!nomeArbitro) return null
  const cacheKey = `arb_stats_${ligaCode}_${nomeArbitro}`
  const cached   = _cache.get(cacheKey)
  if (cached) return cached

  try {
    const leagueId = APIFOOTBALLCOM_LEAGUE_IDS[ligaCode]
    if (!leagueId) return null

    const anoAtual = new Date().getFullYear()
    const dataFim  = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
    const dataIni  = `${anoAtual}-01-01`

    const todosJogos = await apiFetch({
      action:    'get_events',
      from:      dataIni,
      to:        dataFim,
      league_id: leagueId,
    })

    if (!Array.isArray(todosJogos)) return null

    const nArb = norm(nomeArbitro)
    const jogosDoArbitro = todosJogos.filter(j =>
      j.match_status === 'Finished' &&
      j.match_hometeam_score !== '' &&
      j.match_awayteam_score !== '' &&
      norm(j.match_referee) === nArb
    )

    if (!jogosDoArbitro.length) return null

    let amarelos = 0, vermelhos = 0, penaltis = 0, vitoriasMandante = 0, empates = 0

    for (const j of jogosDoArbitro) {
      const cartoesHome = contarCartoes(j.cards, 'home')
      const cartoesAway = contarCartoes(j.cards, 'away')
      amarelos  += cartoesHome.amarelos  + cartoesAway.amarelos
      vermelhos += cartoesHome.vermelhos + cartoesAway.vermelhos

      const gols = [...(j.goalscorer ?? [])]
      penaltis += gols.filter(g => /penalty|pen\.?\)/i.test(g?.info ?? '')).length

      const golsM = parseInt(j.match_hometeam_score) || 0
      const golsV = parseInt(j.match_awayteam_score) || 0
      if (golsM > golsV) vitoriasMandante++
      else if (golsM === golsV) empates++
    }

    const n = jogosDoArbitro.length
    const resultado = {
      nome: nomeArbitro,
      jogosAnalisados:        n,
      mediaCartoesAmarelos:   parseFloat((amarelos / n).toFixed(2)),
      mediaCartoesVermelhos:  parseFloat((vermelhos / n).toFixed(2)),
      mediaCartoesTotais:     parseFloat(((amarelos + vermelhos) / n).toFixed(2)),
      mediaPenaltisPorJogo:   parseFloat((penaltis / n).toFixed(2)),
      pctVitoriaMandante:     parseFloat(((vitoriasMandante / n) * 100).toFixed(1)),
      pctEmpates:             parseFloat(((empates / n) * 100).toFixed(1)),
      perfil: (amarelos + vermelhos) / n >= 5 ? 'rígido (muitos cartões)'
            : (amarelos + vermelhos) / n <= 3 ? 'deixa jogar (poucos cartões)'
            : 'moderado',
    }

    return _cache.set(cacheKey, resultado)
  } catch (err) {
    console.warn('[ApifootballCom] estatísticas de árbitro falharam:', err.message)
    return null
  }
}

// ─────────────────────────────────────────────────────────────
// HELPERS INTERNOS
// ─────────────────────────────────────────────────────────────
function processarJogo(j, teamId) {
  const isHome      = String(j.match_hometeam_id) === String(teamId)
  const hScore      = parseInt(j.match_hometeam_score) || 0
  const aScore      = parseInt(j.match_awayteam_score) || 0
  const golsMarcados = isHome ? hScore : aScore
  const golsSofridos = isHome ? aScore : hScore
  const totalGols    = hScore + aScore

  let resultado
  if (hScore === aScore)  resultado = 'E'
  else if (isHome)        resultado = hScore > aScore ? 'V' : 'D'
  else                    resultado = aScore > hScore ? 'V' : 'D'

  const cartoes    = contarCartoes(j.cards, isHome ? 'home' : 'away')
  const escanteios = getStat(j.statistics, 'corners')
  const chutes     = getStat(j.statistics, 'shots total')
  const posse      = j.statistics?.find(x => x.type === 'Ball Possession')
  const posseVal   = isHome
    ? parseInt(posse?.home ?? '0')
    : parseInt(posse?.away ?? '0')

  return {
    resultado, golsMarcados, golsSofridos, totalGols, isHome,
    data:       j.match_date,
    competicao: j.league_name,
    adversario: isHome ? j.match_awayteam_name : j.match_hometeam_name,
    arbitro:    j.match_referee ?? null,
    estadio:    j.match_stadium ?? null,
    formacao:   isHome ? j.match_hometeam_system : j.match_awayteam_system,
    cartoes: {
      amarelos:  cartoes.amarelos,
      vermelhos: cartoes.vermelhos,
      total:     cartoes.total,
    },
    escanteios: {
      time:  isHome ? escanteios.home : escanteios.away,
      total: escanteios.home + escanteios.away,
    },
    chutes: isHome ? chutes.home : chutes.away,
    posse:  posseVal,
  }
}