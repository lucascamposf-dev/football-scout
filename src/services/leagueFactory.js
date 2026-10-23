// leagueFactory.js — gera um serviço de liga (etapa1/2/3) completo
// a partir da FlashLive, com a MESMA lógica usada em europaLeagueService.js.
// Usado para ligas que não têm regras específicas (Nations League, Amistosos, etc).
// ─────────────────────────────────────────────────────────────

import { calcMercadoGols, calcMercadoCartoesEscanteios } from './groqService.js'

const IS_PROD  = typeof window !== 'undefined' && window.location.hostname !== 'localhost'
const API_BASE = IS_PROD ? '' : 'http://localhost:3001'
const SPORTS_URL = `${API_BASE}/api/sportsdata`

const SHRINKAGE_K     = 5
const PESOS_TEMPORAIS = [1.0, 0.85, 0.72, 0.62, 0.52]

const sleep = ms => new Promise(r => setTimeout(r, ms))

function formatHorario(startTimestamp) {
  if (!startTimestamp) return 'Indisponível'
  return new Date(startTimestamp * 1000).toLocaleTimeString('pt-BR', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
  })
}

function formatDataJogo(startTimestamp) {
  if (!startTimestamp) return ''
  return new Date(startTimestamp * 1000).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
}

/**
 * @param {Object} cfg
 * @param {string} cfg.liga         slug de liga do backend (LIGA_MAP / resolveLiga) (ex: 'nations_league')
 * @param {string} cfg.nomeCompeticao nome exibido (ex: 'UEFA Nations League')
 * @param {string} cfg.ligaCode     código curto pra exibição (ex: 'NL')
 * @param {{marcados:number, sofridos:number}} cfg.mediaGolsLiga  média histórica de gols na competição
 */
export function createLeagueService({ liga, nomeCompeticao, ligaCode, mediaGolsLiga }) {
  const _cache = {
    _store: {},
    get: k      => _cache._store[k] ?? null,
    set: (k, v) => { _cache._store[k] = v; return v },
  }

  async function sbFetch(path) {
    const res = await fetch(`${SPORTS_URL}${path}`)
    const body = await res.json().catch(() => null)
    if (!res.ok || body?.status === 'erro') {
      throw new Error(body?.mensagem || `Erro ${res.status} em ${path}`)
    }
    return body.data
  }

  // ════════════════════════════════════════════════════════
  // ETAPA 1 — Jogos do dia (ou próxima rodada, via FlashLive)
  // ════════════════════════════════════════════════════════
  async function etapa1_buscarJogos(incluirAmanha = false) {
    const cacheKey = `${liga}_etapa1_${new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })}_${incluirAmanha ? 'comAmanha' : 'soHoje'}`
    const cached   = _cache.get(cacheKey)
    if (cached) return cached

    const data = await sbFetch(`/jogos/jogos-hoje/${liga}${incluirAmanha ? '?incluirAmanha=1' : ''}`)
    const jogosBrutos = data?.jogos ?? []

    if (!jogosBrutos.length) {
      throw new Error(`Nenhum jogo de "${nomeCompeticao}" encontrado nos próximos dias.`)
    }

    const jogos = jogosBrutos.map(j => ({
      id:          j.id,
      mandante:    j.mandante,
      visitante:   j.visitante,
      mandanteId:  j.mandanteId,
      visitanteId: j.visitanteId,
      horario:     formatHorario(j.startTimestamp),
      dataJogo:    formatDataJogo(j.startTimestamp),
      status:      'NS',
      competicao:  nomeCompeticao,
      ligaCode,
      usandoAmanha: j.usandoAmanha,
    }))

    return _cache.set(cacheKey, jogos)
  }

  // ════════════════════════════════════════════════════════
  // ETAPA 2 — Histórico + H2H + Cartões/Escanteios (se disponíveis)
  // ════════════════════════════════════════════════════════
  async function buscarUltimosJogosTime(teamId) {
    const cacheKey = `${liga}_hist_${teamId}`
    const cached   = _cache.get(cacheKey)
    if (cached) return cached

    try {
      const data = await sbFetch(`/jogos/time/${teamId}/ultimos?limit=8`)
      return _cache.set(cacheKey, data?.jogos ?? [])
    } catch (err) {
      console.warn(`[${nomeCompeticao}] histórico do time ${teamId} falhou:`, err.message)
      return []
    }
  }

  async function buscarH2H(eventId, mandanteId, visitanteId) {
    const cacheKey = `${liga}_h2h_${eventId}`
    const cached   = _cache.get(cacheKey)
    if (cached) return cached

    try {
      const h2h = await sbFetch(`/jogos/h2h/${eventId}?mandanteId=${mandanteId}&visitanteId=${visitanteId}`)
      return _cache.set(cacheKey, h2h)
    } catch (err) {
      console.warn(`[${nomeCompeticao}] H2H do evento ${eventId} falhou:`, err.message)
      return { confrontos: [], totalJogos: 0, semDados: true }
    }
  }

  async function buscarCartoesEscanteios(eventId) {
    try {
      const data = await sbFetch(`/jogos/partida/${eventId}`)
      if (!data?.escanteios_total && !data?.cartoes_amarelos_casa) return null

      const cartoesTotal = (data.cartoes_amarelos_casa ?? 0) + (data.cartoes_amarelos_fora ?? 0) +
                            (data.cartoes_vermelhos_casa ?? 0) + (data.cartoes_vermelhos_fora ?? 0)

      return {
        mediaCartoesJogo:    cartoesTotal || null,
        mediaEscanteiosJogo: data.escanteios_total ?? null,
        mandante:  { mediaCartoesTotais: (data.cartoes_amarelos_casa ?? 0) + (data.cartoes_vermelhos_casa ?? 0), mediaEscanteios: data.escanteios_casa ?? null },
        visitante: { mediaCartoesTotais: (data.cartoes_amarelos_fora ?? 0) + (data.cartoes_vermelhos_fora ?? 0), mediaEscanteios: data.escanteios_fora ?? null },
      }
    } catch {
      return null
    }
  }

  async function buscarXgJogo(eventId) {
    if (!eventId) return null
    try {
      const data = await sbFetch(`/jogos/partida/${eventId}`)
      if (data?.xg_casa == null && data?.xg_fora == null) return null
      return { xgCasa: data.xg_casa ?? null, xgFora: data.xg_fora ?? null }
    } catch {
      return null
    }
  }

  async function enriquecerComXg(historico) {
    return Promise.all(
      historico.map(async (jogo) => {
        const xg = await buscarXgJogo(jogo.eventId)
        if (!xg) return jogo
        const isHome = jogo.golsMarcados != null && xg.xgCasa != null
        return {
          ...jogo,
          xgMarcado:  isHome ? xg.xgCasa : xg.xgFora,
          xgSofrido:  isHome ? xg.xgFora : xg.xgCasa,
        }
      })
    )
  }

  async function etapa2_buscarHistoricos(jogos) {
    const resultado = []
    // ✅ Regra de negócio: no máximo 3 jogos analisados por vez
    const jogosParaProcessar = jogos.slice(0, 3)

    for (const jogo of jogosParaProcessar) {
      if (resultado.length > 0) await sleep(500)
      try {
        const [histM, histV] = await Promise.all([
          buscarUltimosJogosTime(jogo.mandanteId),
          buscarUltimosJogosTime(jogo.visitanteId),
        ])

        const ultimos5M = histM.slice(0, 5)
        const ultimos5V = histV.slice(0, 5)

        const [ultimos5M_xg, ultimos5V_xg] = await Promise.all([
          enriquecerComXg(ultimos5M),
          enriquecerComXg(ultimos5V),
        ])

        await sleep(300)
        const [h2h, cartoesEscanteios] = await Promise.all([
          buscarH2H(jogo.id, jogo.mandanteId, jogo.visitanteId),
          buscarCartoesEscanteios(jogo.id),
        ])

        resultado.push({
          ...jogo,
          ultimos5_mandante:  ultimos5M_xg,
          ultimos5_visitante: ultimos5V_xg,
          stats_cartoes_escanteios: cartoesEscanteios,
          h2h,
        })
      } catch (err) {
        console.warn(`Histórico ${nomeCompeticao} falhou: ${jogo.mandante}`, err.message)
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

  // ════════════════════════════════════════════════════════
  // ETAPA 3 — Probabilidades (mesma lógica das outras ligas)
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

    const comXg = historico.filter(j => j.xgMarcado != null && j.xgSofrido != null)
    let mMarcadosFinal = rawM
    let mSofridosFinal = rawS
    if (comXg.length >= 3) {
      const pesoTotalXg = comXg.reduce((s, _, i) => s + (PESOS_TEMPORAIS[i] ?? 0.50), 0)
      const xgM = parseFloat((comXg.reduce((s, j, i) => s + j.xgMarcado * (PESOS_TEMPORAIS[i] ?? 0.50), 0) / pesoTotalXg).toFixed(2))
      const xgS = parseFloat((comXg.reduce((s, j, i) => s + j.xgSofrido * (PESOS_TEMPORAIS[i] ?? 0.50), 0) / pesoTotalXg).toFixed(2))
      mMarcadosFinal = parseFloat(((rawM + xgM) / 2).toFixed(2))
      mSofridosFinal = parseFloat(((rawS + xgS) / 2).toFixed(2))
    }

    return {
      mediaGolsMarcados:    rawM,
      mediaGolsSofridos:    rawS,
      mediaGolsMarcadosAdj: aplicarShrinkage(mMarcadosFinal, mediaGolsLiga.marcados, n),
      mediaGolsSofridosAdj: aplicarShrinkage(mSofridosFinal, mediaGolsLiga.sofridos, n),
      usouXg: comXg.length >= 3,
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

  async function etapa3_calcularProbabilidades(jogos) {
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

      const confianca = Math.abs(pm - pv) > 20 ? 'Alta' : Math.abs(pm - pv) > 10 ? 'Média' : 'Baixa'

      const ce = jogo.stats_cartoes_escanteios
      const mediaCartoesJogo    = ce?.mediaCartoesJogo    ?? null
      const mediaEscanteiosJogo = ce?.mediaEscanteiosJogo ?? null

      const mercadoCartoesEscanteios = ce
        ? calcMercadoCartoesEscanteios(ce, null, { mandante: jogo.mandante, visitante: jogo.visitante })
        : null

      analisados.push({
        mandante: jogo.mandante, visitante: jogo.visitante,
        competicao: nomeCompeticao, horario: jogo.horario,
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

        cartoes_media:         mediaCartoesJogo,
        escanteios_media:      mediaEscanteiosJogo,
        cartoes_mandante:      ce?.mandante?.mediaCartoesTotais  ?? null,
        cartoes_visitante:     ce?.visitante?.mediaCartoesTotais ?? null,
        escanteios_mandante:   ce?.mandante?.mediaEscanteios     ?? null,
        escanteios_visitante:  ce?.visitante?.mediaEscanteios    ?? null,
        mercado_cartoes_escanteios: mercadoCartoesEscanteios,

        analise: `Total esperado ${mediaEsperada} gols — ${mercadoGolsLimpo} · ${pm}% mandante / ${pv}% visitante.${mediaCartoesJogo ? ` Cartões/jogo: ${mediaCartoesJogo}.` : ''}${mediaEscanteiosJogo ? ` Escanteios/jogo: ${mediaEscanteiosJogo}.` : ''}`,
      })
    }

    return {
      jogos: analisados,
      total: analisados.length,
      resumo: `${analisados.length} jogo(s) de ${nomeCompeticao} analisado(s) — FlashLive.`,
    }
  }

  return { etapa1_buscarJogos, etapa2_buscarHistoricos, etapa3_calcularProbabilidades }
}
