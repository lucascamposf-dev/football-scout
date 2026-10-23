// basketballService.js
// Dados de jogos/histórico via FlashLive (rotas /api/sportsdata/flashlive/basquete/*
// do servidor — server/scrapers/flashscoreBasketScraper.js).
// ─────────────────────────────────────────────────────────────

const MODEL    = 'openai/gpt-oss-20b'
const IS_PROD  = typeof window !== 'undefined' && window.location.hostname !== 'localhost'
const API_BASE = IS_PROD ? '' : 'http://localhost:3001'
const GROQ_URL  = `${API_BASE}/api/groq`
const BASQUETE_URL = `${API_BASE}/api/sportsdata/flashlive/basquete`

const sleep = ms => new Promise(r => setTimeout(r, ms))

export const LIGAS_BASQUETE = [
  { value: '132', label: '🏀 NBA (EUA)'    },
  { value: '133', label: '🌍 EuroLeague'   },
  { value: '165', label: '🇧🇷 NBB (Brasil)' },
  { value: '189', label: '🏀 WNBA (EUA)'   },
]

const PONTOS_PRIOR = {
  '132': { marcados: 113.5, sofridos: 113.5 },
  '133': { marcados:  79.5, sofridos:  79.5 },
  '165': { marcados:  84.0, sofridos:  84.0 },
  '189': { marcados:  82.0, sofridos:  82.0 },
}

const TOTALS_PRIOR = {
  '132': [200.5, 210.5, 220.5, 230.5],
  '133': [145.5, 150.5, 155.5, 160.5],
  '165': [155.5, 160.5, 165.5, 170.5],
  '189': [155.5, 160.5, 165.5, 170.5],
}

const SHRINKAGE_K = 5

const _bsCache = {
  _store: {},
  get: (k)    => _bsCache._store[k] ?? null,
  set: (k, v) => { _bsCache._store[k] = v; return v },
}

// ✅ Rotas de basquete e /api/groq exigem login — reaproveita o token salvo pelo LoginSite
function authHeaders(extra = {}) {
  const token = typeof localStorage !== 'undefined' ? localStorage.getItem('scout_token') : null
  return token ? { ...extra, 'x-auth-token': token } : extra
}

// Rotas do servidor respondem { status:'ok', data:{...} } — devolve só o `data`.
async function blFetch(path) {
  const cacheKey = 'bl_' + path
  const cached   = _bsCache.get(cacheKey)
  if (cached) return cached

  const res = await fetch(`${BASQUETE_URL}/${path}`, { headers: authHeaders() })

  if (res.status === 429) {
    console.warn('FlashLive rate limit atingido.')
    throw new Error('Limite de requisições atingido. Aguarde alguns minutos e tente novamente.')
  }
  if (!res.ok) throw new Error(`FlashLive (basquete) erro ${res.status}`)

  const json = await res.json()
  if (json?.status !== 'ok') throw new Error(json?.mensagem ?? 'FlashLive (basquete): resposta inválida')
  return _bsCache.set(cacheKey, json.data)
}

function getTodayBRT() {
  return new Date().toLocaleDateString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    timeZone: 'America/Sao_Paulo',
  })
}

function getTodayISO() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
}

function formatHorario(ts) {
  if (!ts) return 'Indisponível'
  const d = typeof ts === 'number' ? new Date(ts * 1000) : new Date(ts)
  return d.toLocaleTimeString('pt-BR', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
  })
}

function normalizarEvento(e, ligaId) {
  const home = e.homeTeam ?? e.home ?? {}
  const away = e.awayTeam ?? e.away ?? {}
  const scoreHome  = e.homeScore?.current ?? e.homeScore?.display ?? e.scores?.home?.total ?? null
  const scoreAway  = e.awayScore?.current ?? e.awayScore?.display ?? e.scores?.away?.total ?? null
  const statusRaw  = e.status?.type ?? e.status?.short ?? 'notstarted'
  const finalizado = statusRaw === 'finished' || statusRaw === 'FT' || statusRaw === 'AOT'
  const aoVivo     = statusRaw === 'inprogress' || statusRaw === 'LIVE'
  return {
    id:          e.id,
    mandante:    home.name ?? home.shortName ?? 'Time A',
    visitante:   away.name ?? away.shortName ?? 'Time B',
    mandanteId:  home.id,
    visitanteId: away.id,
    horario:     formatHorario(e.startTimestamp ?? e.date ?? null),
    status:      finalizado ? 'FT' : aoVivo ? 'LIVE' : 'NS',
    competicao:  e.tournament?.name ?? e.league?.name ?? 'Basquete',
    ligaId,
    temporada:   String(e.season?.year ?? e.league?.season ?? new Date().getFullYear()),
    scoreHome, scoreAway, finalizado,
  }
}

function processarJogoBasquete(event, teamId) {
  const homeId  = event.homeTeam?.id ?? event.home?.id
  const isHome  = homeId === teamId
  const ptsHome = event.homeScore?.current ?? event.homeScore?.display ?? event.scores?.home?.total ?? null
  const ptsAway = event.awayScore?.current ?? event.awayScore?.display ?? event.scores?.away?.total ?? null
  if (ptsHome === null || ptsAway === null) return null
  const ptsMarcados = isHome ? ptsHome : ptsAway
  const ptsSofridos = isHome ? ptsAway : ptsHome
  const totalPts    = ptsHome + ptsAway
  let resultado
  if (ptsHome === ptsAway) resultado = 'E'
  else if (isHome)         resultado = ptsHome > ptsAway ? 'V' : 'D'
  else                     resultado = ptsAway > ptsHome ? 'V' : 'D'
  return { resultado, ptsMarcados, ptsSofridos, totalPts }
}

// Nomes de torneio vêm em pt_BR da FlashLive (ex.: "EUA: NBA", "EUROPA: Euroliga",
// "BRASIL: NBB"). Comparação sem acento/maiúscula; várias grafias por liga.
const semAcento = t => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')

const LIGA_FILTRO = {
  '132': { incluir: ['nba'],                       excluir: ['wnba', 'g league', 'liga g', '2k', 'summer'] },
  '133': { incluir: ['euroleague', 'euroliga'],    excluir: ['women', 'mulheres', 'feminin'] },
  '165': { incluir: ['nbb'],                       excluir: [] },
  '189': { incluir: ['wnba'],                      excluir: [] },
}

function eventoDaLiga(e, ligaId) {
  const f = LIGA_FILTRO[ligaId]
  if (!f) return true
  const nome = semAcento(e.tournament?.name ?? e.league?.name ?? '')
  return f.incluir.some(t => nome.includes(t)) && !f.excluir.some(t => nome.includes(t))
}

export async function bs_etapa1_buscarJogos(ligaId, incluirAmanha = false) {
  const hoje     = getTodayISO()
  const cacheKey = `bs_etapa1_${ligaId}_${hoje}_${incluirAmanha ? 'amanha' : 'hoje'}`
  const cached   = _bsCache.get(cacheKey)
  if (cached) return cached

  // Jogos da NBA à noite nos EUA caem no dia seguinte no horário de Brasília —
  // por isso o "amanhã" opcional (mesmo toggle do futebol/tênis).
  const dias = incluirAmanha ? [0, 1] : [0]
  const resp = await Promise.all(dias.map(d => blFetch(`jogos-dia/${d}`).catch(e => (d === 0 ? Promise.reject(e) : null))))
  const vistos = new Set()
  const events = resp.flatMap(r => r?.events ?? []).filter(e => !vistos.has(e.id) && vistos.add(e.id))
  const eventosFiltrados = events
    .filter(e => eventoDaLiga(e, ligaId))
    .filter(e => (e.status?.type ?? '') !== 'finished') // análise pré-jogo: não faz sentido listar jogo já encerrado
    .sort((a, b) => (a.startTimestamp ?? 0) - (b.startTimestamp ?? 0))

  if (!eventosFiltrados.length)
    throw new Error(`Nenhum jogo ${incluirAmanha ? 'hoje/amanhã' : `hoje (${getTodayBRT()})`} para esta liga (ainda não encerrado).`)

  const jogos = eventosFiltrados.map(e => normalizarEvento(e, ligaId))
  return _bsCache.set(cacheKey, jogos)
}

// Últimos jogos finalizados do time (1 chamada — rota teams/results da FlashLive)
async function buscarUltimosJogos(teamId, ligaId) {
  const cacheKey = `bs_hist_${teamId}_${ligaId}`
  const cached   = _bsCache.get(cacheKey)
  if (cached) return cached
  if (!teamId) return []

  const resp   = await blFetch(`time/${encodeURIComponent(teamId)}/ultimos?limit=20`)
  const events = resp?.events ?? []

  const finalizados = events
    .filter(e => eventoDaLiga(e, ligaId))
    .filter(e => (e.status?.type ?? '') === 'finished')
    .sort((a, b) => (b.startTimestamp ?? 0) - (a.startTimestamp ?? 0))
    .slice(0, 8)

  return _bsCache.set(cacheKey, finalizados)
}

export async function bs_etapa2_buscarHistoricos(jogos) {
  const resultado = []

  for (const jogo of jogos) {
    if (resultado.length > 0) await sleep(300)
    try {
      const [gamesM, gamesV] = await Promise.all([
        buscarUltimosJogos(jogo.mandanteId, jogo.ligaId),
        buscarUltimosJogos(jogo.visitanteId, jogo.ligaId),
      ])

      const filtrarLocalidade = (games, teamId, localidade) => {
        const filtrado = games.filter(g => {
          const homeId = g.homeTeam?.id ?? g.home?.id
          const awayId = g.awayTeam?.id ?? g.away?.id
          if (localidade === 'home') return homeId === teamId
          if (localidade === 'away') return awayId === teamId
          return true
        }).slice(0, 5)
        return filtrado.length >= 3 ? filtrado : games.slice(0, 5)
      }

      const jogosM  = filtrarLocalidade(gamesM, jogo.mandanteId, 'home')
      const jogosV  = filtrarLocalidade(gamesV, jogo.visitanteId, 'away')
      const ultimos5M = jogosM.map(g => processarJogoBasquete(g, jogo.mandanteId)).filter(Boolean)
      const ultimos5V = jogosV.map(g => processarJogoBasquete(g, jogo.visitanteId)).filter(Boolean)

      resultado.push({ ...jogo, ultimos5_mandante: ultimos5M, ultimos5_visitante: ultimos5V })
    } catch (err) {
      console.warn(`Histórico basquete falhou: ${jogo.mandante}`, err.message)
      resultado.push({ ...jogo, ultimos5_mandante: [], ultimos5_visitante: [] })
    }
  }
  return resultado
}

function normalCDF(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const d = 0.3989423 * Math.exp(-z * z / 2)
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))))
  return z > 0 ? 1 - p : p
}

function probOver(media, desvio, threshold) {
  const z = (threshold - media) / Math.max(desvio, 1)
  return Math.round((1 - normalCDF(z)) * 100)
}

function getDesvio(ligaId) {
  return ligaId === '132' ? 22 : ligaId === '165' ? 18 : 16
}

function aplicarShrinkage(mediaTime, mediaLiga, n) {
  if (mediaTime == null || mediaLiga == null) return mediaTime
  return parseFloat(((n * mediaTime + SHRINKAGE_K * mediaLiga) / (n + SHRINKAGE_K)).toFixed(1))
}

function calcEstatisticasPontos(historico, ligaId) {
  const prior = PONTOS_PRIOR[ligaId] ?? { marcados: 85, sofridos: 85 }
  if (!historico.length) {
    return { mediaPtsMarcados: prior.marcados, mediaPtsSofridos: prior.sofridos, mediaTotalPts: prior.marcados + prior.sofridos, formaSimbolo: [], semDados: true }
  }
  const PESOS     = [1.0, 0.88, 0.76, 0.68, 0.60]
  const n         = historico.length
  const pesoTotal = historico.reduce((s, _, i) => s + (PESOS[i] ?? 0.60), 0)
  if (pesoTotal === 0) return { mediaPtsMarcados: prior.marcados, mediaPtsSofridos: prior.sofridos, mediaTotalPts: prior.marcados + prior.sofridos, formaSimbolo: historico.map(j => j.resultado), semDados: true }
  const somaMarcados = historico.reduce((s, j, i) => s + j.ptsMarcados * (PESOS[i] ?? 0.60), 0)
  const somaSofridos = historico.reduce((s, j, i) => s + j.ptsSofridos * (PESOS[i] ?? 0.60), 0)
  const somaTotal    = historico.reduce((s, j, i) => s + j.totalPts    * (PESOS[i] ?? 0.60), 0)
  const rawMarcados = parseFloat((somaMarcados / pesoTotal).toFixed(1))
  const rawSofridos = parseFloat((somaSofridos / pesoTotal).toFixed(1))
  return {
    mediaPtsMarcados:    rawMarcados,
    mediaPtsSofridos:    rawSofridos,
    mediaPtsMarcadosAdj: aplicarShrinkage(rawMarcados, prior.marcados, n),
    mediaPtsSofridosAdj: aplicarShrinkage(rawSofridos, prior.sofridos, n),
    mediaTotalPts:       parseFloat((somaTotal / pesoTotal).toFixed(1)),
    formaSimbolo:        historico.map(j => j.resultado),
    semDados:            false,
  }
}

function calcMercadoTotais(statsM, statsV, ligaId) {
  const thresholds = TOTALS_PRIOR[ligaId] ?? [155.5, 160.5, 165.5, 170.5]
  const desvio     = getDesvio(ligaId)
  const mM = statsM.mediaPtsMarcadosAdj ?? statsM.mediaPtsMarcados
  const sV = statsV.mediaPtsSofridosAdj ?? statsV.mediaPtsSofridos
  const mV = statsV.mediaPtsMarcadosAdj ?? statsV.mediaPtsMarcados
  const sM = statsM.mediaPtsSofridosAdj ?? statsM.mediaPtsSofridos
  const ptsMandante  = parseFloat(((mM * 0.6) + (sV * 0.4)).toFixed(1))
  const ptsVisitante = parseFloat(((mV * 0.6) + (sM * 0.4)).toFixed(1))
  const mediaTotal   = parseFloat((ptsMandante + ptsVisitante).toFixed(1))
  const mercados = []
  for (const t of thresholds) {
    const pOver  = probOver(mediaTotal, desvio, t)
    const pUnder = 100 - pOver
    const gap    = Math.abs(pOver - pUnder)
    mercados.push(
      { nome: `Over ${t}`,  prob: pOver,  threshold: t, direcao: 'over',  emoji: '⬆️', gap },
      { nome: `Under ${t}`, prob: pUnder, threshold: t, direcao: 'under', emoji: '⬇️', gap },
    )
  }
  const classificar = (prob, gap) => {
    if (prob >= 65 && gap >= 20) return 'Alta'
    if (prob >= 55 && gap >= 12) return 'Média'
    if (prob > 50)               return 'Baixa'
    return 'Descartar'
  }
  mercados.forEach(m => { m.confianca = classificar(m.prob, m.gap) })
  const melhor = mercados.filter(m => m.prob > 50 && m.gap >= 12).sort((a, b) => b.prob !== a.prob ? b.prob - a.prob : b.gap - a.gap)[0]
  return {
    mediaEsperada: mediaTotal, ptsMandante, ptsVisitante,
    mercadoTotais:   melhor ? `${melhor.emoji} ${melhor.nome}` : '⚖️ Sem borda clara',
    confiancaTotais: melhor?.confianca ?? 'Baixa',
    thresholds:      thresholds.map(t => ({ threshold: t, over: probOver(mediaTotal, desvio, t), under: 100 - probOver(mediaTotal, desvio, t) })),
    descricaoTotais: melhor
      ? `Total esperado: ${mediaTotal} pts · ${melhor.nome} com ${melhor.prob}% (gap ${melhor.gap}pp · confiança ${melhor.confianca}).`
      : `Total esperado: ${mediaTotal} pts. Nenhum mercado com borda suficiente.`,
  }
}

function calcResultadoBasquete(statsM, statsV) {
  const PESOS_FORMA = [1.5, 1.3, 1.1, 1.0, 0.9]
  const pontuarForma = forma => {
    if (!forma.length) return 0.5
    let pts = 0, totalPeso = 0
    forma.slice(0, 5).forEach((r, i) => {
      const p = PESOS_FORMA[i] || 0.9
      pts += (r === 'V' ? 3 : r === 'E' ? 1 : 0) * p
      totalPeso += 3 * p
    })
    return pts / totalPeso
  }
  const scoreM = pontuarForma(statsM.formaSimbolo)
  const scoreV = pontuarForma(statsV.formaSimbolo)
  const CASA   = 0.06
  const totalScore = scoreM + scoreV + 0.001
  const fM = (scoreM / totalScore) + CASA
  const fV = (scoreV / totalScore) - CASA * 0.5
  const tF = fM + fV + 0.001
  const pm = Math.round((fM / tF) * 100)
  const pv = 100 - pm
  return { pm, pv, mercadoResultado: pm > pv ? 'Vitória Mandante' : 'Vitória Visitante', confianca: Math.abs(pm - pv) > 18 ? 'Alta' : Math.abs(pm - pv) > 8 ? 'Média' : 'Baixa' }
}

async function callGroq(_apiKey, system, user) {
  for (let t = 1; t <= 3; t++) {
    const res = await fetch(GROQ_URL, {
      method:  'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        model: MODEL, temperature: 0.1, max_tokens: 2400,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    })
    if (res.status === 429) {
      const err  = await res.json().catch(() => ({}))
      const m    = (err?.error?.message || '').match(/try again in ([\d.]+)s/i)
      const wait = m ? Math.ceil(parseFloat(m[1])) * 1000 + 1000 : 15000
      if (t === 3) throw new Error('Rate limit Groq.')
      await sleep(wait)
      continue
    }
    if (!res.ok) throw new Error(`Groq erro ${res.status}`)
    const data  = await res.json()
    const raw   = data.choices?.[0]?.message?.content || '{}'
    const clean = raw.replace(/```json|```/gi, '').trim()
    const hit   = clean.match(/\{[\s\S]*\}/)
    return hit ? JSON.parse(hit[0]) : {}
  }
}

export async function bs_etapa3_calcularProbabilidades(apiKey, jogos) {
  const analisados = []
  for (const jogo of jogos) {
    const statsM = calcEstatisticasPontos(jogo.ultimos5_mandante, jogo.ligaId)
    const statsV = calcEstatisticasPontos(jogo.ultimos5_visitante, jogo.ligaId)
    const { pm, pv, mercadoResultado, confianca } = calcResultadoBasquete(statsM, statsV)
    const totais = calcMercadoTotais(statsM, statsV, jogo.ligaId)
    let analise = ''
    try {
      const prompt =
        `Jogo de basquete: ${jogo.mandante} x ${jogo.visitante} (${jogo.competicao})\n` +
        `[${jogo.mandante}] Forma: ${statsM.formaSimbolo.join(', ') || 'sem dados'} | Pts marcados/jogo: ${statsM.mediaPtsMarcados} | Pts sofridos/jogo: ${statsM.mediaPtsSofridos}\n` +
        `[${jogo.visitante}] Forma: ${statsV.formaSimbolo.join(', ') || 'sem dados'} | Pts marcados/jogo: ${statsV.mediaPtsMarcados} | Pts sofridos/jogo: ${statsV.mediaPtsSofridos}\n` +
        `Total esperado: ${totais.mediaEsperada} pts | Melhor mercado: ${totais.mercadoTotais}\n` +
        `Resultado: ${pm}% mandante / ${pv}% visitante\n` +
        `Retorne: {"analise":"Uma frase objetiva sobre o jogo citando o total esperado e o mercado recomendado"}`
      const a = await callGroq(apiKey, 'Você é analista de basquete especialista em mercados de apostas. Responda APENAS JSON.', prompt)
      analise = a?.analise || ''
    } catch (err) {
      console.warn('Groq basquete falhou:', err.message)
    }
    if (!analise) analise = `Total esperado ${totais.mediaEsperada} pts — ${totais.mercadoTotais} · ${pm}% mandante.`
    analisados.push({
      mandante: jogo.mandante, visitante: jogo.visitante,
      competicao: jogo.competicao, horario: jogo.horario,
      status: jogo.status, ligaId: jogo.ligaId,
      prob_mandante: pm, prob_visitante: pv,
      mercado_resultado: mercadoResultado, confianca,
      ...totais,
      stats_mandante: statsM, stats_visitante: statsV,
      ultimos5_mandante: statsM.formaSimbolo,
      ultimos5_visitante: statsV.formaSimbolo,
      analise,
            score_composto: calcScoreBasquete({
        pm, pv,
        confiancaTotais: totais.confiancaTotais,
        thresholds: totais.thresholds,
        ultimos5_mandante: statsM.formaSimbolo,
        ultimos5_visitante: statsV.formaSimbolo,
      }),
      })
    if (analisados.length < jogos.length) await sleep(1200)
  }

  // ── EV para basquete ──────────────────────────────────────
function calcEVBasquete(probModelo, oddDecimal) {
  if (!probModelo || !oddDecimal || oddDecimal <= 1) return null
  return parseFloat(((probModelo / 100) * oddDecimal - 1).toFixed(3))
}

// ── Score composto para basquete ──────────────────────────
function calcScoreBasquete(jogo) {
  let score = 0

  // Domínio de resultado
  const dominio = Math.abs(jogo.pm - jogo.pv)
  score += Math.max(0, Math.min(25, (dominio / 35) * 25))

  // Gap do melhor mercado de totais
  const melhorGap = jogo.thresholds
    ? Math.max(...jogo.thresholds.map(t => Math.abs(t.over - 50)))
    : 0
  score += Math.min(30, (melhorGap / 30) * 30)

  // Confiança
  const confMap = { 'Alta': 1, 'Média': 0.5, 'Baixa': 0.15 }
  score += (confMap[jogo.confiancaTotais] ?? 0) * 20

  // Qualidade do histórico
  const temHistM = (jogo.ultimos5_mandante?.length ?? 0) >= 3 ? 1 : 0.4
  const temHistV = (jogo.ultimos5_visitante?.length ?? 0) >= 3 ? 1 : 0.4
  score += ((temHistM + temHistV) / 2) * 15

  return Math.round(Math.min(100, Math.max(0, score)))
}
  return {
    jogos: analisados, total: jogos.length,
    resumo: `${jogos.length} jogo(s) de basquete analisado(s) — Modelo Normal · Totais / Resultado.`,
  }
}
// ── Basquete AO VIVO (rota /flashlive/basquete/ao-vivo) — sem cache no front: o servidor já cacheia 20s ──
export async function buscarJogosBasqueteAoVivo() {
  const res = await fetch(`${BASQUETE_URL}/ao-vivo`, { headers: authHeaders() })
  const json = await res.json().catch(() => null)
  if (!res.ok || json?.status !== 'ok') throw new Error(json?.mensagem ?? `FlashLive (basquete ao vivo) erro ${res.status}`)
  return { jogos: json.data?.jogos ?? [], total: json.data?.total ?? 0 }
}
