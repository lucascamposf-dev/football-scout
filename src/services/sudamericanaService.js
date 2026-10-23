// sudamericanaService.js — REESCRITO com API-Football (api-sports.io)
// Usa APIFOOTBALL_KEY — plano gratuito (100 req/dia)
// Copa Sul-Americana ID: 11 (CONMEBOL Sudamericana)
// ─────────────────────────────────────────────────────────────

import { calcMercadoGols, calcMercadoCartoesEscanteios } from './groqService.js'
import { fetchCartoeseEscanteios } from './flashliveService.js'

const IS_PROD         = typeof window !== 'undefined' && window.location.hostname !== 'localhost'
const API_BASE        = IS_PROD ? '' : 'http://localhost:3001'
const APIFOOTBALL_URL = `${API_BASE}/api/apifootball`

const LEAGUE_ID       = 11      // CONMEBOL Sudamericana
// ✅ Fix: temporada calculada dinamicamente em vez de fixa — evita quebra
// silenciosa quando o ano virar (a Sudamericana roda dentro do mesmo ano civil).
const SEASON          = new Date().getFullYear()
const GOLS_MEDIA_LIGA = { marcados: 1.28, sofridos: 1.28 }
const SHRINKAGE_K     = 5
const PESOS_TEMPORAIS = [1.0, 0.85, 0.72, 0.62, 0.52]

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── Cache ─────────────────────────────────────────────────────
const _csaCache = {
  _store: {},
  get: k      => _csaCache._store[k] ?? null,
  set: (k, v) => { _csaCache._store[k] = v; return v },
}

// ✅ Rota /api/apifootball agora exige login — reaproveita o token salvo pelo LoginSite
function authHeaders() {
  const token = typeof localStorage !== 'undefined' ? localStorage.getItem('scout_token') : null
  return token ? { 'x-auth-token': token } : {}
}

// ── Fetch via proxy ───────────────────────────────────────────
async function apiFetch(endpoint, params = {}) {
  const query    = new URLSearchParams(params).toString()
  const cacheKey = `csa_${endpoint}_${query}`
  const cached   = _csaCache.get(cacheKey)
  if (cached) return cached

  const url = `${APIFOOTBALL_URL}/${endpoint}${query ? '?' + query : ''}`
  const res = await fetch(url, { headers: authHeaders() })

  if (res.status === 429)
    throw new Error('Limite de requisições atingido. Aguarde e tente novamente.')
  if (!res.ok)
    throw new Error(`API-Football erro ${res.status}`)

  const data = await res.json()
  if (data?.errors && Object.keys(data.errors).length > 0)
    throw new Error(`API-Football: ${JSON.stringify(data.errors)}`)

  return _csaCache.set(cacheKey, data)
}

// ── Helpers de data ───────────────────────────────────────────
function getTodayISO() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
}

function getTodayBRT() {
  return new Date().toLocaleDateString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    timeZone: 'America/Sao_Paulo',
  })
}

function getDateOffset(days) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
}

function formatHorario(dateStr) {
  if (!dateStr) return 'Indisponível'
  return new Date(dateStr).toLocaleTimeString('pt-BR', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
  })
}

// ── Normalizar fixture API-Football ──────────────────────────
function normalizarFixture(f, usandoAmanha = false) {
  const statusShort = f.fixture?.status?.short ?? 'NS'
  const finalizado  = statusShort === 'FT' || statusShort === 'AET' || statusShort === 'PEN'
  const aoVivo      = ['1H','HT','2H','ET','BT','P','LIVE'].includes(statusShort)

  return {
    id:          f.fixture?.id,
    mandante:    f.teams?.home?.name  ?? 'Time A',
    visitante:   f.teams?.away?.name  ?? 'Time B',
    mandanteId:  f.teams?.home?.id,
    visitanteId: f.teams?.away?.id,
    horario:     formatHorario(f.fixture?.date),
    dataJogo:    new Date(f.fixture?.date).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
    status:      finalizado ? 'FT' : aoVivo ? 'LIVE' : 'NS',
    competicao:  'Copa Sul-Americana',
    ligaCode:    'CSA',
    scoreHome:   f.goals?.home ?? null,
    scoreAway:   f.goals?.away ?? null,
    finalizado,
    usandoAmanha,
  }
}

// ════════════════════════════════════════════════════════
// ETAPA 1 — Jogos do dia (ou amanhã)
// ════════════════════════════════════════════════════════
// incluirAmanha: quando true, busca e mostra os jogos de amanhã JUNTO com os de hoje.
export async function csa_etapa1_buscarJogos(incluirAmanha = false) {
  const hoje     = getTodayISO()
  const cacheKey = `csa_etapa1_${hoje}_${incluirAmanha ? 'comAmanha' : 'soHoje'}`
  const cached   = _csaCache.get(cacheKey)
  if (cached) return cached

  const data         = await apiFetch('fixtures', { league: LEAGUE_ID, season: SEASON, date: hoje })
  const fixturesHoje  = data?.response ?? []

  let fixturesAmanha = []
  // Busca amanhã se pedido explicitamente OU se não há jogos hoje (fallback antigo)
  if (incluirAmanha || fixturesHoje.length === 0) {
    const amanha     = getDateOffset(1)
    const dataAmanha = await apiFetch('fixtures', { league: LEAGUE_ID, season: SEASON, date: amanha })
    fixturesAmanha   = dataAmanha?.response ?? []
  }

  if (!fixturesHoje.length && !fixturesAmanha.length)
    throw new Error(`Nenhum jogo da Copa Sul-Americana hoje (${getTodayBRT()}) nem amanhã.`)

  // ✅ Mostra TODOS os jogos encontrados (hoje + amanhã, se pedido) — não só um recorte
  const jogos = [
    ...fixturesHoje.map(f => normalizarFixture(f, false)),
    ...fixturesAmanha.map(f => normalizarFixture(f, true)),
  ]
  return _csaCache.set(cacheKey, jogos)
}

// ════════════════════════════════════════════════════════
// ETAPA 2 — Histórico + H2H + Cartões + Escanteios
// ════════════════════════════════════════════════════════
async function buscarUltimosJogosTime(teamId) {
  const cacheKey = `csa_hist_${teamId}`
  const cached   = _csaCache.get(cacheKey)
  if (cached) return cached

  const data = await apiFetch('fixtures', {
    team:   teamId,
    season: SEASON,
    last:   8,
    status: 'FT',
  })

  const fixtures = data?.response ?? []
  return _csaCache.set(cacheKey, fixtures)
}

async function buscarH2H(mandanteId, visitanteId) {
  const cacheKey = `csa_h2h_${mandanteId}_${visitanteId}`
  const cached   = _csaCache.get(cacheKey)
  if (cached) return cached

  try {
    const data = await apiFetch('fixtures/headtohead', {
      h2h:  `${mandanteId}-${visitanteId}`,
      last: 5,
    })
    const fixtures = (data?.response ?? []).filter(f =>
      f.fixture?.status?.short === 'FT'
    )
    return _csaCache.set(cacheKey, fixtures)
  } catch { return [] }
}

async function buscarEstatisticasTime(teamId, fixtureIds) {
  // Busca estatísticas dos últimos jogos (cartões + escanteios)
  const cacheKey = `csa_stats_${teamId}`
  const cached   = _csaCache.get(cacheKey)
  if (cached) return cached

  const statsAcumuladas = {
    cartoes_amarelos: [], cartoes_vermelhos: [], escanteios: []
  }

  // Busca stats dos últimos 5 fixtures
  for (const fixtureId of fixtureIds.slice(0, 5)) {
    try {
      await sleep(300)
      const data = await apiFetch('fixtures/statistics', {
        fixture: fixtureId,
        team:    teamId,
      })
      const stats = data?.response?.[0]?.statistics ?? []

      const getStat = (type) => {
        const s = stats.find(s => s.type?.toLowerCase().includes(type.toLowerCase()))
        return parseInt(s?.value ?? 0) || 0
      }

      statsAcumuladas.cartoes_amarelos.push(getStat('Yellow Cards'))
      statsAcumuladas.cartoes_vermelhos.push(getStat('Red Cards'))
      statsAcumuladas.escanteios.push(getStat('Corner Kicks'))
    } catch { /* ignora falhas individuais */ }
  }

  const media = arr => arr.length > 0
    ? parseFloat((arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(1))
    : null

  const resultado = {
    mediaCartoesAmarelos:  media(statsAcumuladas.cartoes_amarelos),
    mediaCartoesVermelhos: media(statsAcumuladas.cartoes_vermelhos),
    mediaCartoesTotais:    media(statsAcumuladas.cartoes_amarelos.map((v, i) => v + (statsAcumuladas.cartoes_vermelhos[i] ?? 0))),
    mediaEscanteios:       media(statsAcumuladas.escanteios),
  }

  return _csaCache.set(cacheKey, resultado)
}

function processarJogoHistorico(fixture, teamId) {
  const hGoals = fixture.goals?.home ?? null
  const aGoals = fixture.goals?.away ?? null
  if (hGoals === null || aGoals === null) return null

  const isHome       = fixture.teams?.home?.id === teamId
  const golsMarcados = isHome ? hGoals : aGoals
  const golsSofridos = isHome ? aGoals : hGoals
  const totalGols    = hGoals + aGoals

  let resultado
  if (hGoals === aGoals) resultado = 'E'
  else if (isHome)       resultado = hGoals > aGoals ? 'V' : 'D'
  else                   resultado = aGoals > hGoals ? 'V' : 'D'

  return { resultado, golsMarcados, golsSofridos, totalGols, fixtureId: fixture.fixture?.id }
}

export async function csa_etapa2_buscarHistoricos(jogos) {
  const resultado = []
  // ✅ Regra de negócio: no máximo 3 jogos analisados por vez
  const jogosParaProcessar = jogos.slice(0, 3)

  for (const jogo of jogosParaProcessar) {
    if (resultado.length > 0) await sleep(800)
    try {
      const [fixturesM, fixturesV, h2hFixtures] = await Promise.all([
        buscarUltimosJogosTime(jogo.mandanteId),
        buscarUltimosJogosTime(jogo.visitanteId),
        buscarH2H(jogo.mandanteId, jogo.visitanteId),
      ])

      const processar = (fixtures, teamId) =>
        fixtures.slice(0, 5).map(f => processarJogoHistorico(f, teamId)).filter(Boolean)

      const ultimos5M = processar(fixturesM, jogo.mandanteId)
      const ultimos5V = processar(fixturesV, jogo.visitanteId)

      // IDs dos fixtures para buscar estatísticas
      const idsM = ultimos5M.map(j => j.fixtureId).filter(Boolean)
      const idsV = ultimos5V.map(j => j.fixtureId).filter(Boolean)

      await sleep(400)
      // Tenta a FlashLive primeiro (api-sports.io está travado na season antiga)
      let cartoesEscanteiosFL = null
      try {
        cartoesEscanteiosFL = await fetchCartoeseEscanteios(jogo.mandante, jogo.visitante, 'CSA', jogo.dataJogo)
      } catch { /* segue pro fallback abaixo */ }

      const [statsM, statsV] = cartoesEscanteiosFL
        ? [cartoesEscanteiosFL.mandante, cartoesEscanteiosFL.visitante]
        : await Promise.all([
            buscarEstatisticasTime(jogo.mandanteId, idsM),
            buscarEstatisticasTime(jogo.visitanteId, idsV),
          ])

      // Processar H2H
      const h2hProcessado = processarH2H(h2hFixtures, jogo.mandanteId, jogo.visitanteId)

      resultado.push({
        ...jogo,
        ultimos5_mandante:  ultimos5M,
        ultimos5_visitante: ultimos5V,
        stats_cartoes_escanteios: {
          mandante:  statsM,
          visitante: statsV,
          mediaCartoesJogo:    parseFloat((((statsM?.mediaCartoesTotais ?? 0) + (statsV?.mediaCartoesTotais ?? 0))).toFixed(1)),
          mediaEscanteiosJogo: parseFloat((((statsM?.mediaEscanteios ?? 0) + (statsV?.mediaEscanteios ?? 0))).toFixed(1)),
        },
        h2h: h2hProcessado,
      })
    } catch (err) {
      console.warn(`Histórico CSA falhou: ${jogo.mandante}`, err.message)
      resultado.push({
        ...jogo,
        ultimos5_mandante: [], ultimos5_visitante: [],
        stats_cartoes_escanteios: null,
        h2h: { confrontos: [], totalJogos: 0, semDados: true },
      })
    }
  }

  return resultado
}

function processarH2H(fixtures, mandanteId, visitanteId) {
  if (!fixtures.length) return { confrontos: [], totalJogos: 0, semDados: true }

  const confrontos = fixtures.map(f => {
    const hScore = f.goals?.home ?? 0
    const aScore = f.goals?.away ?? 0
    const isNormalOrder = f.teams?.home?.id === mandanteId
    const golsA = isNormalOrder ? hScore : aScore
    const golsB = isNormalOrder ? aScore : hScore

    let resultadoPerspectiva
    if (hScore === aScore)   resultadoPerspectiva = 'E'
    else if (isNormalOrder)  resultadoPerspectiva = hScore > aScore ? 'M' : 'V'
    else                     resultadoPerspectiva = aScore > hScore ? 'M' : 'V'

    return {
      data:          new Date(f.fixture?.date).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
      mandanteNome:  f.teams?.home?.name ?? '?',
      visitanteNome: f.teams?.away?.name ?? '?',
      homeScore: hScore, awayScore: aScore,
      golsTimeA: golsA, golsTimeB: golsB,
      totalGols: hScore + aScore,
      resultado: resultadoPerspectiva,
    }
  })

  const totalJogos        = confrontos.length
  const vitoriasMandante  = confrontos.filter(c => c.resultado === 'M').length
  const vitoriasVisitante = confrontos.filter(c => c.resultado === 'V').length
  const empates           = confrontos.filter(c => c.resultado === 'E').length
  const totalGolsH2H      = confrontos.reduce((s, c) => s + c.totalGols, 0)
  const mediaGolsTotais   = parseFloat((totalGolsH2H / totalJogos).toFixed(2))
  const bttsH2H           = confrontos.filter(c => c.golsTimeA > 0 && c.golsTimeB > 0).length
  const over25H2H         = confrontos.filter(c => c.totalGols >= 3).length

  return {
    confrontos, totalJogos, semDados: false,
    vitoriasMandante, vitoriasVisitante, empates,
    probMH2H:    Math.round((vitoriasMandante  / totalJogos) * 100),
    probEH2H:    Math.round((empates           / totalJogos) * 100),
    probVH2H:    Math.round((vitoriasVisitante / totalJogos) * 100),
    mediaGolsTotais,
    bttsRateH2H:   Math.round((bttsH2H  / totalJogos) * 100),
    over25RateH2H: Math.round((over25H2H / totalJogos) * 100),
  }
}

// ════════════════════════════════════════════════════════
// ETAPA 3 — Probabilidades
// ════════════════════════════════════════════════════════
function aplicarShrinkage(media, mediaLiga, n) {
  if (media == null) return media
  return parseFloat(((n * media + SHRINKAGE_K * mediaLiga) / (n + SHRINKAGE_K)).toFixed(3))
}

function calcEstatisticasGols(historico) {
  if (!historico.length)
    return {
      mediaGolsMarcados: null, mediaGolsSofridos: null, mediaTotalGols: null,
      bttsRate: null, over15Rate: null, under15Rate: null,
      over25Rate: null, under25Rate: null, over35Rate: null, under35Rate: null,
      formaSimbolo: [], semDados: true,
    }

  const n         = historico.length
  const pesoTotal = historico.reduce((s, _, i) => s + (PESOS_TEMPORAIS[i] ?? 0.50), 0)
  const rawM = parseFloat((historico.reduce((s, j, i) => s + j.golsMarcados * (PESOS_TEMPORAIS[i] ?? 0.50), 0) / pesoTotal).toFixed(2))
  const rawS = parseFloat((historico.reduce((s, j, i) => s + j.golsSofridos * (PESOS_TEMPORAIS[i] ?? 0.50), 0) / pesoTotal).toFixed(2))
  const rawT = parseFloat((historico.reduce((s, j, i) => s + j.totalGols    * (PESOS_TEMPORAIS[i] ?? 0.50), 0) / pesoTotal).toFixed(2))

  return {
    mediaGolsMarcados:    rawM,
    mediaGolsSofridos:    rawS,
    mediaGolsMarcadosAdj: aplicarShrinkage(rawM, GOLS_MEDIA_LIGA.marcados, n),
    mediaGolsSofridosAdj: aplicarShrinkage(rawS, GOLS_MEDIA_LIGA.sofridos, n),
    mediaTotalGols: rawT,
    bttsRate:    Math.round((historico.filter(j => j.golsMarcados > 0 && j.golsSofridos > 0).length / n) * 100),
    over15Rate:  Math.round((historico.filter(j => j.totalGols >= 2).length / n) * 100),
    under15Rate: Math.round((historico.filter(j => j.totalGols <  2).length / n) * 100),
    over25Rate:  Math.round((historico.filter(j => j.totalGols >= 3).length / n) * 100),
    under25Rate: Math.round((historico.filter(j => j.totalGols <  3).length / n) * 100),
    over35Rate:  Math.round((historico.filter(j => j.totalGols >= 4).length / n) * 100),
    under35Rate: Math.round((historico.filter(j => j.totalGols <  4).length / n) * 100),
    formaSimbolo: historico.map(j => j.resultado),
    semDados: false,
  }
}

export async function csa_etapa3_calcularProbabilidades(jogos) {
  const analisados = []

  for (const jogo of jogos) {
    const statsM = calcEstatisticasGols(jogo.ultimos5_mandante)
    const statsV = calcEstatisticasGols(jogo.ultimos5_visitante)

    const {
      mercadoGols, mercadoGolsLimpo, mediaEsperada,
      lambdaM, lambdaV, confiancaGols,
      over15, under15, over25, under25, over35, under35,
      btts, descricaoMercado, rankingMercados,
      melhorOverGols, melhorUnderGols,
    } = calcMercadoGols(statsM, statsV, jogo.h2h ?? { semDados: true })

    const peso    = [1.5, 1.3, 1.1, 1.0, 0.9]
    const pontuar = forma => {
      if (!forma.length) return 0.5
      let pts = 0, total = 0
      forma.slice(0, 5).forEach((r, i) => {
        const p = peso[i] || 0.9
        pts   += (r === 'V' ? 3 : r === 'E' ? 1 : 0) * p
        total += 3 * p
      })
      return pts / total
    }
    const sM    = pontuar(statsM.formaSimbolo)
    const sV    = pontuar(statsV.formaSimbolo)
    const CASA  = 0.12
    const tot   = sM + sV + 0.001
    const fM    = (sM / tot) + CASA
    const fV    = (sV / tot) - CASA * 0.5
    const eq    = 1 - Math.abs(sM - sV)
    const baseE = 0.22 + eq * 0.08
    const rest  = 1 - baseE
    const tF    = fM + fV + 0.001
    let pm = Math.round((fM / tF) * rest * 100)
    let pe = Math.round(baseE * 100)
    let pv = 100 - pm - pe

    const mercadoResultado =
      pm > pe && pm > pv ? 'Vitória Mandante' :
      pv > pe && pv > pm ? 'Vitória Visitante' : 'Empate'

    const confianca = Math.abs(pm - pv) > 18 ? 'Alta' : Math.abs(pm - pv) > 8 ? 'Média' : 'Baixa'

    // Dados de cartões e escanteios
    const ce = jogo.stats_cartoes_escanteios
    const mediaCartoesJogo    = ce?.mediaCartoesJogo    ?? null
    const mediaEscanteiosJogo = ce?.mediaEscanteiosJogo ?? null

    // ✅ NOVO — mercado real de cartões/escanteios (Over/Under por linha)
    const mercadoCartoesEscanteios = ce
      ? calcMercadoCartoesEscanteios(ce, null, { mandante: jogo.mandante, visitante: jogo.visitante })
      : null

    analisados.push({
      mandante: jogo.mandante, visitante: jogo.visitante,
      competicao: 'Copa Sul-Americana', horario: jogo.horario,
      dataJogo: jogo.dataJogo, status: jogo.status, usandoAmanha: jogo.usandoAmanha,
      prob_mandante: pm, prob_empate: pe, prob_visitante: pv,
      mercado_resultado: mercadoResultado, confianca,
      mercado_gols: mercadoGols, mercado_gols_limpo: mercadoGolsLimpo,
      media_gols_esperada: mediaEsperada,
      lambda_mandante: lambdaM, lambda_visitante: lambdaV,
      confianca_gols: confiancaGols, descricao_mercado: descricaoMercado,
      over15_gols: over15, under15_gols: under15,
      over25_gols: over25, under25_gols: under25,
      over35_gols: over35, under35_gols: under35,
      btts, ranking_mercados: rankingMercados,

      // ✅ NOVO — melhor entrada de Over e de Under (gols), separadas
      melhor_entrada_over_gols: melhorOverGols ? {
        nome: melhorOverGols.nome, prob: melhorOverGols.prob, confianca: melhorOverGols.confianca,
      } : null,
      melhor_entrada_under_gols: melhorUnderGols ? {
        nome: melhorUnderGols.nome, prob: melhorUnderGols.prob, confianca: melhorUnderGols.confianca,
      } : null,

      ultimos5_mandante: statsM.formaSimbolo,
      ultimos5_visitante: statsV.formaSimbolo,
      stats_mandante: statsM, stats_visitante: statsV,
      h2h: jogo.h2h ?? { confrontos: [], totalJogos: 0, semDados: true },

      // ✅ Cartões e escanteios
      cartoes_media:         mediaCartoesJogo,
      escanteios_media:      mediaEscanteiosJogo,
      cartoes_mandante:      ce?.mandante?.mediaCartoesTotais  ?? null,
      cartoes_visitante:     ce?.visitante?.mediaCartoesTotais ?? null,
      escanteios_mandante:   ce?.mandante?.mediaEscanteios     ?? null,
      escanteios_visitante:  ce?.visitante?.mediaEscanteios    ?? null,
      // ✅ NOVO — linhas Over/Under de cartões e escanteios + melhores entradas
      mercado_cartoes_escanteios: mercadoCartoesEscanteios,

      analise: `Total esperado ${mediaEsperada} gols — ${mercadoGolsLimpo} · ${pm}% mandante / ${pv}% visitante.${mediaCartoesJogo ? ` Cartões/jogo: ${mediaCartoesJogo}.` : ''}${mediaEscanteiosJogo ? ` Escanteios/jogo: ${mediaEscanteiosJogo}.` : ''}`,
    })
  }

  return {
    jogos: analisados,
    total: analisados.length,
    resumo: `${analisados.length} jogo(s) da Copa Sul-Americana analisado(s) — API-Football.`,
  }
}