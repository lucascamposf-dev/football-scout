// flashliveService.js
// Substitui apifootballService.js — usa FlashLive Sports (RapidAPI)
// Fornece: cartões, escanteios, histórico, escalações, lesões — temporada ATUAL
// Chave: fica só no servidor (FLASHLIVE_KEY no .env) — nunca colocar aqui.
// ─────────────────────────────────────────────────────────────

const IS_PROD        = typeof window !== 'undefined' && window.location.hostname !== 'localhost'
const API_BASE       = IS_PROD ? '' : 'http://localhost:3001'
const FLASHLIVE_URL  = `${API_BASE}/api/flashlive`
const LOCALE         = 'pt_BR'
const SPORT_SOCCER   = 1

const sleep = ms => new Promise(r => setTimeout(r, ms))

const norm = s => String(s || '').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]/g, '')

// ── Cache diário ──────────────────────────────────────────────
const _flCache = {
  _store: {},
  _dia: new Date().toISOString().slice(0, 10),
  _checkDia() {
    const hoje = new Date().toISOString().slice(0, 10)
    if (hoje !== this._dia) { this._store = {}; this._dia = hoje }
  },
  get(k)    { this._checkDia(); return this._store[k] ?? null },
  set(k, v) { this._checkDia(); this._store[k] = v; return v },
}

// ✅ Rota /api/flashlive agora exige login — reaproveita o token salvo pelo LoginSite
function authHeaders() {
  const token = typeof localStorage !== 'undefined' ? localStorage.getItem('scout_token') : null
  return token ? { 'x-auth-token': token } : {}
}

// ── Fetch via proxy ───────────────────────────────────────────
async function flFetch(endpoint, params = {}) {
  const query    = new URLSearchParams({ locale: LOCALE, ...params }).toString()
  const cacheKey = `fl_${endpoint}_${query}`
  const cached   = _flCache.get(cacheKey)
  if (cached) return cached

  const url = `${FLASHLIVE_URL}/${endpoint}?${query}`
  try {
    const res = await fetch(url, { headers: authHeaders() })
    if (!res.ok) {
      console.warn(`[FlashLive] ${endpoint} erro ${res.status}`)
      return null
    }
    const data = await res.json()
    if (!data?.DATA) return null
    return _flCache.set(cacheKey, data.DATA)
  } catch (err) {
    console.warn(`[FlashLive] ${endpoint} falhou:`, err.message)
    return null
  }
}

// ─────────────────────────────────────────────────────────────
// Busca EVENT_ID do FlashLive pelo nome dos times + data
// Usa /v1/events/list com indent_days calculado
// ─────────────────────────────────────────────────────────────
async function buscarEventId(mandante, visitante, dataJogo) {
  const cacheKey = `fl_eventid_${mandante}_${visitante}_${dataJogo}`
  const cached   = _flCache.get(cacheKey)
  if (cached) return cached

  // Calcula indent_days (0 = hoje, -1 = ontem, 1 = amanhã)
  const hoje    = new Date()
  const alvo    = new Date(dataJogo)
  const diffMs  = alvo.setHours(12) - hoje.setHours(12)
  const indentDays = Math.round(diffMs / (1000 * 60 * 60 * 24))

  // Só busca no range -7 a +7
  if (Math.abs(indentDays) > 7) return null

  const eventos = await flFetch('events/list', {
    sport_id:    SPORT_SOCCER,
    timezone:    -3, // horário de Brasília
    indent_days: indentDays,
  })

  if (!eventos) return null

  const nM = norm(mandante)
  const nV = norm(visitante)

  for (const torneio of eventos) {
    for (const ev of torneio.EVENTS ?? []) {
      const h = norm(ev.HOME_NAME ?? '')
      const a = norm(ev.AWAY_NAME ?? '')
      if (
        (h.includes(nM.slice(0, 5)) || nM.includes(h.slice(0, 5))) &&
        (a.includes(nV.slice(0, 5)) || nV.includes(a.slice(0, 5)))
      ) {
        return _flCache.set(cacheKey, ev.EVENT_ID)
      }
    }
  }

  return null
}

// ─────────────────────────────────────────────────────────────
// Busca TEAM_ID do FlashLive pelo nome do time
// ─────────────────────────────────────────────────────────────
async function buscarTeamId(nomeTime) {
  const cacheKey = `fl_teamid_${nomeTime}`
  const cached   = _flCache.get(cacheKey)
  if (cached) return cached

  const results = await flFetch('search/multi-search', { query: nomeTime.slice(0, 20) })
  if (!results) return null 

  const nN = norm(nomeTime)
  const time = (Array.isArray(results) ? results : []).find(r =>
    r.SPORT_ID === SPORT_SOCCER &&
    (r.TYPE === 'team' || r.TYPE === 'teams') &&
    norm(r.NAME ?? '').includes(nN.slice(0, 6))
  )

  if (!time?.ID) return null
  return _flCache.set(cacheKey, time.ID)
}

// ─────────────────────────────────────────────────────────────
// Busca últimos N resultados de um time via /v1/teams/results
// Extrai: golsMarcados, golsSofridos, cartões, escanteios
// ─────────────────────────────────────────────────────────────
async function buscarResultadosTime(teamId, last = 5) {
  const cacheKey = `fl_resultados_${teamId}`
  const cached   = _flCache.get(cacheKey)
  if (cached) return cached

  const data = await flFetch('teams/results', {
    sport_id: SPORT_SOCCER,
    team_id:  teamId,
    page:     1,
  })

  if (!data) return []

  // A resposta é uma lista de torneios, cada um com EVENTS
  const partidas = []
  const eventos  = Array.isArray(data) ? data : []

  for (const grupo of eventos) {
    for (const ev of grupo.EVENTS ?? []) {
      if (partidas.length >= last) break
      if (ev.STAGE_TYPE !== 'FINISHED') continue

      const hScore = parseInt(ev.HOME_SCORE_CURRENT ?? '')
      const aScore = parseInt(ev.AWAY_SCORE_CURRENT ?? '')
      if (isNaN(hScore) || isNaN(aScore)) continue

      const isHome      = ev.HOME_PARTICIPANT_IDS?.includes(teamId) ?? false
      const golsMarcados = isHome ? hScore : aScore
      const golsSofridos = isHome ? aScore : hScore
      const totalGols    = hScore + aScore

      let resultado
      if (hScore === aScore)       resultado = 'E'
      else if (isHome)             resultado = hScore > aScore ? 'V' : 'D'
      else                         resultado = aScore > hScore ? 'V' : 'D'

      partidas.push({
        eventId:      ev.EVENT_ID,
        resultado,
        golsMarcados,
        golsSofridos,
        totalGols,
        isHome,
      })
    }
    if (partidas.length >= last) break
  }

  return _flCache.set(cacheKey, partidas)
}

// ─────────────────────────────────────────────────────────────
// Busca estatísticas de cartões e escanteios de um evento
// via /v1/events/statistics
// ─────────────────────────────────────────────────────────────
async function buscarStatsEvento(eventId) {
  const cacheKey = `fl_stats_${eventId}`
  const cached   = _flCache.get(cacheKey)
  if (cached) return cached

  const data = await flFetch('events/statistics', { event_id: eventId })
  if (!data) return null

  // Estrutura: DATA = [ { STAGE_NAME, GROUPS: [ { ITEMS: [ { INCIDENT_NAME, VALUE_HOME, VALUE_AWAY } ] } ] } ]
  const getStat = (...nomes) => {
    for (const stage of (Array.isArray(data) ? data : [])) {
      for (const group of stage.GROUPS ?? []) {
        for (const item of group.ITEMS ?? []) {
          if (nomes.some(n => item.INCIDENT_NAME?.toLowerCase().includes(n.toLowerCase()))) {
            return {
              home: parseFloat(item.VALUE_HOME ?? 0) || 0,
              away: parseFloat(item.VALUE_AWAY ?? 0) || 0,
            }
          }
        }
      }
    }
    return { home: 0, away: 0 }
  }

  // Busca via summary (incidents) para cartões — mais preciso
  const summary = await flFetch('events/summary', { event_id: eventId })
  let cartoesAmarelos = { home: 0, away: 0 }
  let cartoesVermelhos = { home: 0, away: 0 }
  let escanteios = getStat('escanteio', 'corner')

  if (summary) {
    for (const stage of (Array.isArray(summary) ? summary : [])) {
      for (const item of stage.ITEMS ?? []) {
        for (const inc of item.INCIDENT_PARTICIPANTS ?? []) {
          const team = item.INCIDENT_TEAM === 1 ? 'home' : 'away'
          if (inc.INCIDENT_TYPE === 'YELLOW_CARD') cartoesAmarelos[team]++
          if (inc.INCIDENT_TYPE === 'RED_CARD')    cartoesVermelhos[team]++
        }
      }
    }
  }

  const resultado = {
    cartoes_amarelos_home:  cartoesAmarelos.home,
    cartoes_amarelos_away:  cartoesAmarelos.away,
    cartoes_vermelhos_home: cartoesVermelhos.home,
    cartoes_vermelhos_away: cartoesVermelhos.away,
    cartoes_total_home:     cartoesAmarelos.home + cartoesVermelhos.home,
    cartoes_total_away:     cartoesAmarelos.away + cartoesVermelhos.away,
    cartoes_total_jogo:     cartoesAmarelos.home + cartoesVermelhos.home +
                            cartoesAmarelos.away + cartoesVermelhos.away,
    escanteios_home:  escanteios.home,
    escanteios_away:  escanteios.away,
    escanteios_total: escanteios.home + escanteios.away,
  }

  return _flCache.set(cacheKey, resultado)
}

// ─────────────────────────────────────────────────────────────
// Busca médias de cartões e escanteios de um time
// nos últimos 5 jogos (via results + statistics)
// ─────────────────────────────────────────────────────────────
async function buscarMediasTime(teamId, isHome) {
  const cacheKey = `fl_medias_${teamId}_${isHome}`
  const cached   = _flCache.get(cacheKey)
  if (cached) return cached

  try {
    const resultados = await buscarResultadosTime(teamId, 5)
    if (!resultados.length) return null

    const statsArr = []
    for (const r of resultados) {
      await sleep(300)
      const stats = await buscarStatsEvento(r.eventId)
      if (!stats) continue

      const lado = r.isHome ? 'home' : 'away'
      statsArr.push({
        cartoes_amarelos:  stats[`cartoes_amarelos_${lado}`],
        cartoes_vermelhos: stats[`cartoes_vermelhos_${lado}`],
        cartoes_total:     stats[`cartoes_total_${lado}`],
        escanteios:        stats[`escanteios_${lado}`],
        cartoes_jogo:      stats.cartoes_total_jogo,
        escanteios_jogo:   stats.escanteios_total,
      })
    }

    if (!statsArr.length) return null

    const media = campo => parseFloat(
      (statsArr.reduce((s, v) => s + (v[campo] ?? 0), 0) / statsArr.length).toFixed(1)
    )

    const resultado = {
      mediaCartoesAmarelos:  media('cartoes_amarelos'),
      mediaCartoesVermelhos: media('cartoes_vermelhos'),
      mediaCartoesTotais:    media('cartoes_total'),
      mediaEscanteios:       media('escanteios'),
      mediaCartoesJogo:      media('cartoes_jogo'),
      mediaEscanteiosJogo:   media('escanteios_jogo'),
      amostras:              statsArr.length,
    }

    return _flCache.set(cacheKey, resultado)
  } catch (err) {
    console.warn(`[FlashLive] medias falhou time ${teamId}:`, err.message)
    return null
  }
}

// ─────────────────────────────────────────────────────────────
// Busca escalação + jogadores ausentes (lesões/suspensões)
// Retorna informações extras para enriquecer análise
// ─────────────────────────────────────────────────────────────
// ✅ NOVO — item 10: gate de confiança da escalação. "Provável" (vazada
// pela imprensa) e "oficial" (confirmada pelo clube, normalmente ~1h antes
// do jogo) não deveriam pesar igual — a provável ainda pode mudar até o
// apito. O FlashLive costuma marcar isso via CONFIRMED em cada grupo de
// lineup; como esse campo pode variar de nome por liga/temporada, também
// caímos numa janela de tempo (<=75min pro jogo) como sinal auxiliar.
function calcularConfiancaEscalacao(lineups, dataJogo) {
  const grupos = Array.isArray(lineups) ? lineups : []
  const flags  = grupos.map(g => g?.CONFIRMED ?? g?.IS_CONFIRMED ?? g?.LINEUP_CONFIRMED ?? null)
  const temFlagExplicita = flags.some(f => f !== null)

  let minutosParaJogo = null
  if (dataJogo) {
    minutosParaJogo = Math.round((new Date(dataJogo).getTime() - Date.now()) / 60000)
  }

  if (temFlagExplicita) {
    return flags.every(f => f === true) ? 'oficial' : 'provavel'
  }
  // Sem flag explícita: dentro da janela usual de anúncio oficial (75min
  // antes até o início do jogo) tratamos como "quase certa", mas nunca como
  // 100% oficial sem a confirmação da API.
  if (minutosParaJogo != null && minutosParaJogo <= 75 && minutosParaJogo >= -120) {
    return 'provavel_oficial'
  }
  return 'provavel'
}

export async function buscarEscalacaoEAusentes(mandante, visitante, dataJogo) {
  const cacheKey = `fl_escalacao_${mandante}_${visitante}_${dataJogo}`
  const cached   = _flCache.get(cacheKey)
  if (cached) return cached

  try {
    const eventId = await buscarEventId(mandante, visitante, dataJogo)
    if (!eventId) return null

    const [lineups, missing] = await Promise.all([
      flFetch('events/lineups',         { event_id: eventId }),
      flFetch('events/missing-players', { event_id: eventId }),
    ])

    const resultado = {
      eventId,
      escalacoes: lineups  ? extrairFormacoes(lineups)  : null,
      ausentes:   missing  ? extrairAusentes(missing)   : null,
      // ✅ NOVO — 'oficial' | 'provavel_oficial' | 'provavel' | null
      confiancaEscalacao: lineups ? calcularConfiancaEscalacao(lineups, dataJogo) : null,
    }

    return _flCache.set(cacheKey, resultado)
  } catch (err) {
    console.warn('[FlashLive] escalação falhou:', err.message)
    return null
  }
}

function extrairFormacoes(lineups) {
  const result = { mandante: null, visitante: null }
  const grupos = Array.isArray(lineups) ? lineups : []
  grupos.forEach((g, i) => {
    const formacoes = g.FORMATIONS ?? []
    const primeiro  = formacoes[0]
    const chave     = i === 0 ? 'mandante' : 'visitante'
    if (primeiro) {
      result[chave] = {
        formacao: primeiro.FORMATION_DISPOSTION,
        titulares: (primeiro.MEMBERS ?? []).map(m => m.PLAYER_FULL_NAME),
      }
    }
  })
  return result
}

// ✅ NOVO — item 8: peso por posição. Um goleiro reserva fora do banco não
// deveria pesar igual a um artilheiro fora — mapeia a posição (quando a API
// informa) pra uma categoria e um peso relativo.
// ⚠️ O nome exato do campo de posição na resposta da RapidAPI pode variar
// (não é 100% documentado) — cobrimos os nomes mais comuns e caem pra
// 'desconhecida' sem quebrar nada se o campo não vier. Se depois de rodar
// em produção você perceber que a posição está sempre vindo 'desconhecida',
// dá um console.log(JSON.stringify(grupo.ITEMS[0])) uma vez pra ver o nome
// real do campo na sua conta da API e ajustar a lista abaixo.
const PESO_POSICAO = {
  goleiro:      1.0,
  zagueiro:     1.0,
  lateral:      1.1,
  volante:      1.2,
  meia:         1.3,
  atacante:     1.6,
  desconhecida: 1.0,
}

function normalizarPosicao(raw) {
  const p = String(raw ?? '').toLowerCase()
  if (!p) return 'desconhecida'
  if (/\b(g|gk)\b|goalkeeper|goleiro/.test(p)) return 'goleiro'
  if (/(centre|center)?[\s-]*back|zagueiro|\bdef\b|defender/.test(p)) return 'zagueiro'
  if (/lateral|full[\s-]*back|wing[\s-]*back/.test(p)) return 'lateral'
  if (/volante|defensive midfield|\bdm\b/.test(p)) return 'volante'
  if (/meia|midfield(?!.*(defensive|forward))|\bmid\b/.test(p)) return 'meia'
  if (/atacante|forward|striker|winger|ponta/.test(p)) return 'atacante'
  return 'desconhecida'
}

// ✅ NOVO — item 3/24: transforma a lista de ausentes (já com posição+peso,
// ver extrairAusentes) num fator multiplicativo de ataque/defesa, pra pesar
// de verdade no Poisson — não só no texto da IA. Cap de ±15%: um desfalque
// isolado ajusta o modelo, não domina ele.
export function calcularImpactoDesfalques(ausentesTime) {
  const lista = ausentesTime || []
  const pesoAtaque = lista
    .filter(a => a.posicao === 'atacante' || a.posicao === 'meia')
    .reduce((s, a) => s + a.peso, 0)
  const pesoDefesa = lista
    .filter(a => a.posicao === 'goleiro' || a.posicao === 'zagueiro' || a.posicao === 'lateral')
    .reduce((s, a) => s + a.peso, 0)

  return {
    fatorAtaque: parseFloat(Math.max(0.85, 1 - pesoAtaque * 0.05).toFixed(3)),
    fatorDefesa: parseFloat(Math.min(1.15, 1 + pesoDefesa * 0.05).toFixed(3)),
  }
}



function extrairAusentes(missing) {
  const result = { mandante: [], visitante: [] }
  const items  = Array.isArray(missing) ? missing : []
  items.forEach((grupo, i) => {
    const chave = i === 0 ? 'mandante' : 'visitante'
    result[chave] = (grupo.ITEMS ?? []).map(p => {
      const posicaoRaw = p.POSITION ?? p.PLAYER_POSITION ?? p.POS ?? p.ROLE ?? null
      const posicao     = normalizarPosicao(posicaoRaw)
      // Nem toda API de "missing players" informa se o cara é titular fixo
      // ou reserva — quando vier (IS_STARTER/IS_KEY_PLAYER), usamos pra
      // reduzir o peso de quem nem jogaria; senão o peso fica só na posição.
      const eraTitular = p.IS_STARTER ?? p.IS_KEY_PLAYER ?? null
      const multiplicadorTitular = eraTitular === false ? 0.5 : 1.0
      const peso = parseFloat(((PESO_POSICAO[posicao] ?? 1.0) * multiplicadorTitular).toFixed(2))
      return {
        nome:       p.PLAYER_NAME,
        motivo:     p.REASON ?? 'Ausente',
        posicao,          // ✅ NOVO
        eraTitular,       // ✅ NOVO — true/false/null (null = API não informou)
        peso,             // ✅ NOVO — quanto maior, mais decisivo o desfalque
      }
    }).sort((a, b) => b.peso - a.peso) // ausentes mais importantes primeiro
  })
  return result
}

async function fetchCartoeseEscanteiosFlashLive(mandanteNome, visitanteNome, dataJogo) {
  try {
    const [mandanteId, visitanteId] = await Promise.all([
      buscarTeamId(mandanteNome),
      buscarTeamId(visitanteNome),
    ])
    if (!mandanteId || !visitanteId) return null

    const [mediasM, mediasV] = await Promise.all([
      buscarMediasTime(mandanteId, true),
      buscarMediasTime(visitanteId, false),
    ])
    if (!mediasM && !mediasV) return null

    const totalCartoes    = parseFloat(((mediasM?.mediaCartoesTotais ?? 0) + (mediasV?.mediaCartoesTotais ?? 0)).toFixed(1))
const totalEscanteios = parseFloat(((mediasM?.mediaEscanteios   ?? 0) + (mediasV?.mediaEscanteios   ?? 0)).toFixed(1))

return {
  mandante:  { mediaCartoesTotais: mediasM?.mediaCartoesTotais ?? null, mediaEscanteios: mediasM?.mediaEscanteios ?? null },
  visitante: { mediaCartoesTotais: mediasV?.mediaCartoesTotais ?? null, mediaEscanteios: mediasV?.mediaEscanteios ?? null },
  fonte: 'flashlive_fallback',
  mediaCartoesJogo:    totalCartoes    || null,
  mediaEscanteiosJogo: totalEscanteios || null,
  over35Cartoes:    totalCartoes    > 0 ? totalCartoes    >= 3.5 : null,
  over85Escanteios: totalEscanteios > 0 ? totalEscanteios >= 8.5 : null,
}
  } catch (err) {
    console.warn('[FlashLive fallback] falhou:', err.message)
    return null
  }
}

// ─────────────────────────────────────────────────────────────
// EXPORT PRINCIPAL — chamado pela etapa2 do groqService
//
// ✅ CORRIGIDO: a versão antiga buscava as ESTATÍSTICAS DA PRÓPRIA PARTIDA
// futura (/jogos/partida/:matchId) achando que isso era "a média de
// cartões/escanteios do confronto". Só que essa rota só tem dados DEPOIS
// que o jogo acontece — para uma partida ainda não disputada ela sempre
// voltava nulo/zero, silenciosamente, sem cair no fallback do FlashLive
// (o catch só disparava em erro de rede, não quando os dados vinham vazios
// com status "ok"). Na prática, cartões/escanteios quase nunca tinham dado
// real chegando na análise.
//
// Agora chama a rota /api/sportsdata/jogos/cartoes-escanteios/:liga/
// :casa/:fora, que calcula a média real dos ÚLTIMOS JOGOS FINALIZADOS de
// cada time (histórico de verdade) e já devolve o árbitro da partida junto.
// O fallback pro FlashLive continua existindo caso essa rota falhe.
// ─────────────────────────────────────────────────────────────
export async function fetchCartoeseEscanteios(mandanteNome, visitanteNome, ligaCode, dataJogo) {
  const cacheKey = `ce_v2_${mandanteNome}_${visitanteNome}_${dataJogo}`
  const cached   = _flCache.get(cacheKey)
  if (cached) return cached

  const ligaMap = {
    'BSA': 'brasileirao', 'BRA': 'brasileirao',
    'BSB': 'serie_b', 'serie_b': 'serie_b',
    'CSA': 'sudamericana', 'sudamericana': 'sudamericana',
    'CLI': 'libertadores', 'CL': 'champions_league',
    'EL':  'europa_league', 'europa_league': 'europa_league',
    'PL':  'premier_league', 'PD': 'la_liga',
    'SA':  'serie_a', 'BL1': 'bundesliga', 'FL1': 'ligue_1',
  }
  const liga = ligaMap[ligaCode] ?? 'brasileirao'

  try {
    const url = `${API_BASE}/api/sportsdata/jogos/cartoes-escanteios/${liga}` +
      `/${encodeURIComponent(mandanteNome)}/${encodeURIComponent(visitanteNome)}`
    const res = await fetch(url, { headers: authHeaders() })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    if (data?.status !== 'ok' || !data.data) throw new Error(data?.mensagem || 'sem dados')

    return _flCache.set(cacheKey, data.data)
  } catch (err) {
    console.warn('[Cartões/Escanteios] rota principal falhou, tentando rota alternativa FlashLive:', err.message)
    return await fetchCartoeseEscanteiosFlashLive(mandanteNome, visitanteNome, dataJogo)
  }
}

// ─────────────────────────────────────────────────────────────
// ✅ NOVO — Histórico completo de H2H (últimos confrontos reais, com
// placar) via FlashLive. Usado como fallback quando o football-data.org
// não tem confronto na janela de 2 anos (ex: time recém-promovido).
// ─────────────────────────────────────────────────────────────
export async function fetchH2HCompleto(mandanteNome, visitanteNome, ligaCode) {
  const cacheKey = `h2h_completo_${mandanteNome}_${visitanteNome}`
  const cached   = _flCache.get(cacheKey)
  if (cached) return cached

  // o servidor já resolve todos os códigos (BSA, PL, CLI, EL, WC, CA...) via LIGA_MAP
  const liga = ligaCode || 'brasileirao'

  try {
    const url = `${API_BASE}/api/sportsdata/jogos/h2h-completo/${liga}` +
      `/${encodeURIComponent(mandanteNome)}/${encodeURIComponent(visitanteNome)}`
    const res = await fetch(url, { headers: authHeaders() })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    if (data?.status !== 'ok' || !data.data) throw new Error(data?.mensagem || 'sem dados')

    return _flCache.set(cacheKey, data.data)
  } catch (err) {
    console.warn('[H2H completo] falhou:', err.message)
    return null
  }
}

export { _flCache as flCache }