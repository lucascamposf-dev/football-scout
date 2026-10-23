// groqService.js — VERSÃO SEGURA (sem chaves no frontend)
// Todas as chamadas externas passam pelo servidor proxy:
//   Groq  → POST /api/groq
//   Odds  → GET  /api/odds?sportKey=...
//   FD    → GET  /api/fd/... (já era assim em prod)
// ─────────────────────────────────────────────────────────────

// Em produção usa rotas relativas (mesmo domínio do servidor).
// Em dev usa o servidor local na porta 3001.
import { fetchCartoeseEscanteios, buscarEscalacaoEAusentes, fetchH2HCompleto, calcularImpactoDesfalques } from './flashliveService.js'
import { buscarEstatisticasArbitro } from './apifootballComService.js'
import { edgeMinimoPara, EDGE_MINIMO_BASE, EV_MINIMO, calcKellyFracionario, DIVERGENCIA_FORTE_EDGE_PP } from './valueConfig.js'
import { calcFatoresCalibration, aplicarCalibration, aplicarMelhorCalibracao, escolherMelhorMercadoCalibrado, normalizarParesOverUnder, aplicarFatorLinha, getCapsCategoria } from './calibrationService.js'
import { alimentarEloComHistorico, fatorAdversario, limitarFatorElo, ELO_LIMITES_1X2, ELO_LIMITES_GOLS } from './eloService.js'
import { obterPesosStackingGols, obterPesosStacking1x2 } from './calibrationService.js'
import { getMediaLiga, registrarJogo, getMediaLigaCartoes, getMediaLigaEscanteios, getHomeAdvantage, registrarJogoLocalidade } from './ligaStatsService.js'
// ✅ NOVO — Fase 1, item 4 do roadmap: versionamento do motor
import { MOTOR_FUTEBOL, versaoAtual, DATASET_VERSAO } from './modelVersion.js'
const IS_PROD   = window.location.hostname !== 'localhost'
const API_BASE  = IS_PROD ? '' : 'http://localhost:3001'
const FD_BASE   = `${API_BASE}/api/fd`
const GROQ_URL  = `${API_BASE}/api/groq`
const ODDS_URL  = `${API_BASE}/api/odds`
const GEMINI_URL = `${API_BASE}/api/gemini`
const ALLSPORTS_URL = `${API_BASE}/api/allsports`


// ✅ As rotas de proxy no servidor agora exigem login (authMiddleware) para
// evitar que qualquer pessoa de fora use suas chaves pagas (Groq, Odds, etc.).
// Esse helper reaproveita o token salvo pelo LoginSite/App.jsx no localStorage.
function authHeaders(extra = {}) {
  const token = typeof localStorage !== 'undefined' ? localStorage.getItem('scout_token') : null
  return token ? { ...extra, 'x-auth-token': token } : extra
}

async function allsportsFetch(params = {}) {
  const query = new URLSearchParams(params).toString()
  const res = await fetch(`${ALLSPORTS_URL}?${query}`, { headers: authHeaders() })
  if (!res.ok) return null
  return res.json()
}

const MODEL = 'openai/gpt-oss-120b'

// ── Mapa liga → sport_key da Odds API ────────────────────────
const ODDS_SPORT_KEY = {
  'BSA': 'soccer_brazil_campeonato',
  'CLI': 'soccer_conmebol_copa_libertadores',
  'CL':  'soccer_uefa_champs_league',
  'EL':  'soccer_uefa_europa_league',
  'PL':  'soccer_epl',
  'PD':  'soccer_spain_la_liga',
  'SA':  'soccer_italy_serie_a',
  'BL1': 'soccer_germany_bundesliga',
  'WC':   'soccer_fifa_world_cup',
  'WCQ':  'soccer_fifa_world_cup_qualification_concacaf',
  'CA':   'soccer_conmebol_copa_america',
  'NL':   'soccer_uefa_nations_league',
  'EURO': 'soccer_uefa_european_championship',
}

const LIGA_CODES = {
  'Campeonato Brasileiro Serie A': 'BSA',
  'Copa Libertadores':             'CLI',
  'UEFA Champions League':         'CL',
  'UEFA Europa League':            'EL',
  'Premier League Inglaterra':     'PL',
  'La Liga Espanha':               'PD',
  'Serie A Italia':                'SA',
  'Bundesliga Alemanha':           'BL1',
  'Copa do Mundo':       'WC',
  'Eliminatórias Copa':  'WCQ',
  'Copa América':        'CA',
  'UEFA Nations League': 'NL',
  'Eurocopa':            'EURO',
}

const GOLS_MEDIA_LIGA = {
  'BSA': { marcados: 1.35, sofridos: 1.35 },
  'CLI': { marcados: 1.28, sofridos: 1.28 },
  'CL':  { marcados: 1.42, sofridos: 1.42 },
  'EL':  { marcados: 1.38, sofridos: 1.38 },
  'PL':  { marcados: 1.44, sofridos: 1.44 },
  'PD':  { marcados: 1.32, sofridos: 1.32 },
  'SA':  { marcados: 1.29, sofridos: 1.29 },
  'BL1': { marcados: 1.60, sofridos: 1.60 },
  'WC':   { marcados: 1.38, sofridos: 1.38 },
  'WCQ':  { marcados: 1.52, sofridos: 1.52 },
  'CA':   { marcados: 1.31, sofridos: 1.31 },
  'NL':   { marcados: 1.25, sofridos: 1.25 },
  'EURO': { marcados: 1.35, sofridos: 1.35 },
}

// ── Fator casa por competição (multiplicador sobre o CASA_BASE) ─────
// Libertadores/Sul-Americana/Eliminatórias: mando mais forte (viagem, altitude)
// Champions/Europa/Nations League: mando mais fraco (times acostumados a viajar)
const CASA_POR_LIGA = {
  'BSA':  1.00,
  'CLI':  1.25,
  'CL':   0.90,
  'EL':   0.95,
  'PL':   0.95,
  'PD':   1.00,
  'SA':   1.00,
  'BL1':  0.95,
  'WC':   0.85,
  'WCQ':  1.10,
  'CA':   1.15,
  'NL':   0.90,
  'EURO': 0.85,
}

// Pesos para até 10 jogos (decay suave) — amostra maior = λ mais estável
const PESOS_TEMPORAIS = [1.00, 0.92, 0.85, 0.78, 0.72, 0.66, 0.60, 0.55, 0.50, 0.45]
// ✅ AJUSTE DE PESO: K subiu de 6 para 7,5. Esse K controla o quanto a média
// de um time é "puxada" de volta para a média da liga quando a amostra é
// pequena/instável (poucos jogos ou CV alto). Com K mais alto, times com
// histórico curto ou irregular ficam mais perto da média da liga em vez de
// confiarem demais numa sequência recente que pode ser ruído — reduz picks
// baseados em 2-3 jogos fora da curva.
const SHRINKAGE_K_BASE = 7.5   // mais conservador: puxa mais para a média da liga (era 6)

// ρ Dixon-Coles por liga (valores típicos da literatura / calibração empírica)
const RHO_POR_LIGA = {
  'BSA': -0.11, 'BL1': -0.10, 'PL': -0.09, 'PD': -0.12, 'SA': -0.13,
  'FL1': -0.10, 'DED': -0.09, 'PPL': -0.10, 'CLI': -0.11, 'CL': -0.08,
  'EL': -0.09, 'WC': -0.07, 'DEFAULT': -0.10,
}

// Média de gols por jogo (por equipe, aproximada) — fallback de liga
const MEDIA_GOLS_LIGA = {
  'BSA': 1.22, 'PL': 1.42, 'PD': 1.28, 'SA': 1.30, 'BL1': 1.48,
  'FL1': 1.35, 'DED': 1.40, 'CLI': 1.20, 'CL': 1.38, 'EL': 1.32,
  'DEFAULT': 1.30,
}
// ── Ranking de relevância dos times ──────────────────────────

  

  // Tier 2 — grandes da América do Sul (90)
  const TIMES_RELEVANCIA = {
  // Brasileirão — nomes exatos da API football-data.org
  'CR Flamengo':             90,
  'SE Palmeiras':            90,
  'CA Mineiro':              82,
  'Fluminense FC':           80,
  'Botafogo FR':             78,
  'SC Corinthians Paulista': 85,
  'São Paulo FC':            85,
  'Grêmio FBPA':             80,
  'SC Internacional':        80,
  'CA Paranaense':           75,
  'Cruzeiro EC':             75,
  'CR Vasco da Gama':        75,
  'Santos FC':               72,
  'EC Bahia':                70,
  'RB Bragantino':           68,
  'EC Vitória':              62,
  'Mirassol FC':             55,
  'Coritiba FBC':            55,
  'Clube do Remo':           50,
  'Chapecoense AF':          50,
  // Europa — mantém igual
  'Real Madrid':             100,
  'Barcelona':               100,
  'Manchester City':         100,
  'Bayern Munich':           100,
  'Paris Saint-Germain':     100,
  'Liverpool':               100,
  'Chelsea':                 100,
  'Arsenal':                 100,
  'Juventus':                100,
  'Inter Milan':             100,
  'AC Milan':                100,
  'Atlético de Madrid':      100,
  'Borussia Dortmund':       100,
  'Manchester United':       100,
  'Tottenham Hotspur':       100,
  // Libertadores
  'Boca Juniors':  90, 'River Plate':  90,
  'Nacional':      75, 'Peñarol':      75,
  'Olimpia':       70, 'LDU Quito':    72,
  'Racing Club':   78, 'San Lorenzo':  72,
  'Talleres':      70, 'Vélez Sársfield': 70,
  'Estudiantes':   75, 'Independiente': 75,

}

function getRelevancia(nomeTime) {
  // Busca exata primeiro
  if (TIMES_RELEVANCIA[nomeTime]) return TIMES_RELEVANCIA[nomeTime]
  
  // Busca parcial (ex: "FC Barcelona" → "Barcelona")
  const nomeLower = nomeTime.toLowerCase()
  for (const [key, val] of Object.entries(TIMES_RELEVANCIA)) {
    if (nomeLower.includes(key.toLowerCase()) || key.toLowerCase().includes(nomeLower.split(' ')[0].toLowerCase())) {
      return val
    }
  }
  
  return 50 // padrão para times desconhecidos
}

export function ordenarJogosPorRelevancia(jogos) {
  return [...jogos].sort((a, b) => {
    const relA = Math.max(getRelevancia(a.mandante), getRelevancia(a.visitante))
    const relB = Math.max(getRelevancia(b.mandante), getRelevancia(b.visitante))
    
    // Ordena por relevância decrescente
    if (relB !== relA) return relB - relA
    
    // Desempate: soma das relevâncias (jogo entre dois grandes > um grande e um pequeno)
    const somaA = getRelevancia(a.mandante) + getRelevancia(a.visitante)
    const somaB = getRelevancia(b.mandante) + getRelevancia(b.visitante)
    return somaB - somaA
  })
}

// ═════════════════════════════════════════════════════════════
// CACHE DE SESSÃO
// ═════════════════════════════════════════════════════════════
const _cache = {
  _store: {},
  _dia: new Date().toISOString().slice(0, 10),

  _checkDia() {
    const hoje = new Date().toISOString().slice(0, 10)
    if (hoje !== this._dia) {
      this._store = {}
      this._dia   = hoje
      console.info('[Cache] Novo dia — cache zerado.')
    }
  },

  get(key) {
    this._checkDia()
    const hit = this._store[key]
    if (hit) { console.info(`[Cache] HIT: ${key}`); return hit }
    return null
  },

  set(key, value) {
    this._checkDia()
    this._store[key] = value
    console.info(`[Cache] SET: ${key}`)
    return value
  },

  clear() { this._store = {}; console.info('[Cache] Limpo manualmente.') },

  stats() {
    return { entradas: Object.keys(this._store).length, chaves: Object.keys(this._store), dia: this._dia }
  },
}

function aplicarShrinkage(mediaTime, mediaLiga, n, cv = null) {
  if (mediaTime == null || mediaLiga == null) return mediaTime
  // K dinâmico: cv alto (time inconsistente) → mais peso pra média da liga.
  // cv=0 → K=K_BASE; K limitado entre 2 e 10 pra não explodir.
  const k = cv !== null && !isNaN(cv)
    ? Math.max(2, Math.min(10, SHRINKAGE_K_BASE * (1 + cv)))
    : SHRINKAGE_K_BASE
  return parseFloat(((n * mediaTime + k * mediaLiga) / (n + k)).toFixed(3))
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))


// ✅ NOVO — Fase 6: DETECÇÃO DE ARBITRAGEM (surebet).
// Pega a MELHOR odd de cada resultado (mandante/empate/visitante) entre
// TODAS as casas do array (não só as preferidas usadas no EV/Kelly) —
// arbitragem não depende de qual casa você usa, só da odd mais alta
// disponível em cada perna. Se a soma das probabilidades implícitas das
// melhores odds for < 100%, há lucro garantido cobrindo os 3 resultados.
function detectarArbitragem(bookmakers, homeTeam, awayTeam) {
  if (!bookmakers?.length) return null
  const norm = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')

  const melhorOdd = (filtro) => {
    let melhor = null
    for (const book of bookmakers) {
      const market = book.markets?.find(m => m.key === 'h2h')
      const preco = market?.outcomes?.find(filtro)?.price
      if (preco != null && preco > 1 && (melhor == null || preco > melhor.preco)) {
        melhor = { preco, casa: book.title }
      }
    }
    return melhor
  }

  const oM = melhorOdd(o => norm(o.name) === norm(homeTeam))
  const oE = melhorOdd(o => o.name === 'Draw')
  const oV = melhorOdd(o => norm(o.name) === norm(awayTeam))
  if (!oM || !oE || !oV) return null

  const somaImplicita = 1 / oM.preco + 1 / oE.preco + 1 / oV.preco
  if (somaImplicita >= 1) return { existe: false }

  return {
    existe: true,
    lucroPct: parseFloat(((1 / somaImplicita - 1) * 100).toFixed(2)),
    pernas: [
      { resultado: 'Mandante',  odd: oM.preco, casa: oM.casa },
      { resultado: 'Empate',    odd: oE.preco, casa: oE.casa },
      { resultado: 'Visitante', odd: oV.preco, casa: oV.casa },
    ],
  }
}
// ─────────────────────────────────────────────────────────────
// ODDS API — via proxy servidor
// ─────────────────────────────────────────────────────────────
async function fetchOddsJogo(ligaCode, mandante, visitante) {
  const sportKey = ODDS_SPORT_KEY[ligaCode]
  if (!sportKey) return null

  const cacheKeyOdds = `odds_${sportKey}_${ligaCode}`
  const cachedOdds   = _cache.get(cacheKeyOdds)

  const jogosOdds = cachedOdds ?? await (async () => {
    const res = await fetch(`${ODDS_URL}?sportKey=${sportKey}`, { headers: authHeaders() }) // ✅ regiões: env ODDS_REGIONS no server
    if (!res.ok) return null
    const data = await res.json()
    if (data?.error) { console.warn('Odds API:', data.error); return null }
    _cache.set(cacheKeyOdds, data)
    return data
  })()

  if (!jogosOdds) return null

  try {
    const norm = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '')
    const nM = norm(mandante)
    const nV = norm(visitante)

    const jogo = jogosOdds?.find(j => {
      const h = norm(j.home_team || '')
      const a = norm(j.away_team || '')
      return (h.includes(nM.slice(0,5)) || nM.includes(h.slice(0,5))) &&
             (a.includes(nV.slice(0,5)) || nV.includes(a.slice(0,5)))
    })

    if (!jogo) return null

    const bookmakers = jogo.bookmakers ?? []
    if (!bookmakers.length) return null

    // Odd REAL pra apostar (a que entra no EV/Kelly) — continua priorizando
    // Bet365/Betano; cai pra primeira casa disponível se nenhuma vier.
    const PREFERIDAS = ['bet365', 'betano']
    const encontradas = PREFERIDAS.map(key => bookmakers.find(b => b.key === key)).filter(Boolean)
    const booksUsados = encontradas.length ? encontradas : [bookmakers[0]]

    const pegarPreco = (book, marketKey, filtro) => {
      const market = book.markets?.find(m => m.key === marketKey)
      return market?.outcomes?.find(filtro)?.price ?? null
    }
    const media = (valores) => {
      const validos = valores.filter(v => v != null)
      if (!validos.length) return null
      return parseFloat((validos.reduce((s, v) => s + v, 0) / validos.length).toFixed(2))
    }

    const oddsM       = media(booksUsados.map(b => pegarPreco(b, 'h2h',    o => norm(o.name) === norm(jogo.home_team))))
    const oddsE       = media(booksUsados.map(b => pegarPreco(b, 'h2h',    o => o.name === 'Draw')))
    const oddsV       = media(booksUsados.map(b => pegarPreco(b, 'h2h',    o => norm(o.name) === norm(jogo.away_team))))
    const oddsOver25  = media(booksUsados.map(b => pegarPreco(b, 'totals', o => o.name === 'Over'  && o.point === 2.5)))
    const oddsUnder25 = media(booksUsados.map(b => pegarPreco(b, 'totals', o => o.name === 'Under' && o.point === 2.5)))
    const oddsOver15  = media(booksUsados.map(b => pegarPreco(b, 'totals', o => o.name === 'Over'  && o.point === 1.5)))
    const oddsOver35  = media(booksUsados.map(b => pegarPreco(b, 'totals', o => o.name === 'Over'  && o.point === 3.5)))

    // ✅ NOVO (item 38) — prob. JUSTA (no-vig) usando até 8 casas: devinga
    // CADA casa separadamente (cada uma tem sua própria margem) e só DEPOIS
    // tira a média das probabilidades — mais correto do que devingar a
    // média das odds cruas de 2 casas só.
    const todasBooks = ordenarBooksParaNoVig(bookmakers).slice(0, NO_VIG_MAX_BOOKS)
    const [implM, implE, implV] = devigMultiBook(todasBooks, 'h2h', [
      o => norm(o.name) === norm(jogo.home_team), o => o.name === 'Draw', o => norm(o.name) === norm(jogo.away_team),
    ])
    const [implOver25, implUnder25] = devigMultiBook(todasBooks, 'totals', [
      o => o.name === 'Over' && o.point === 2.5, o => o.name === 'Under' && o.point === 2.5,
    ])

    return {
      oddsM, oddsE, oddsV, oddsOver25, oddsUnder25, oddsOver15, oddsOver35,
      bookmaker: booksUsados.map(b => b.title).join(' + '),
      implM, implE, implV, implOver25, implUnder25, // ✅ NOVO — no-vig multi-book (%)
      nBooksNoVig: todasBooks.length,
      arbitragem: detectarArbitragem(bookmakers, jogo.home_team, jogo.away_team), // ✅ NOVO — Fase 6
    }
  } catch {
    return null
  }
}

// ✅ NOVO — com mais regiões o array de casas cresce e o slice(0, 8) antigo pegava as
// 8 primeiras na ordem da API. Agora: sem duplicadas, casas "sharp"/exchanges primeiro
// (margem menor → no-vig mais fiel) e teto de 12 casas. Chave que a API não devolver é ignorada.
const NO_VIG_MAX_BOOKS = 12
const BOOKS_SHARP = ['pinnacle', 'betfair_ex_eu', 'betfair_ex_uk', 'matchbook', 'smarkets']
function ordenarBooksParaNoVig(bookmakers) {
  const vistos = new Set()
  const unicos = bookmakers.filter(b => {
    if (!b?.key || vistos.has(b.key)) return false
    vistos.add(b.key); return true
  })
  const rank = b => { const i = BOOKS_SHARP.indexOf(b.key); return i === -1 ? BOOKS_SHARP.length : i }
  return unicos.map((b, i) => ({ b, i })).sort((x, y) => rank(x.b) - rank(y.b) || x.i - y.i).map(x => x.b)
}


/** ✅ NOVO (item 38) — devinga cada casa separadamente pro mercado/pernas
 *  dados e devolve a MÉDIA das probabilidades justas (%) só entre as casas
 *  que tinham TODAS as pernas daquele mercado com preço. */
function devigMultiBook(books, marketKey, filtros) {
  const porPerna = filtros.map(() => [])
  for (const book of books) {
    const market = book.markets?.find(m => m.key === marketKey)
    if (!market) continue
    const precos = filtros.map(f => market.outcomes?.find(f)?.price ?? null)
    if (precos.some(p => p == null)) continue
    const brutas = precos.map(p => 1 / p)
    const soma = brutas.reduce((s, p) => s + p, 0)
    if (soma <= 0) continue
    brutas.forEach((p, i) => porPerna[i].push((p / soma) * 100))
  }
  return porPerna.map(vals => vals.length ? parseFloat((vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(1)) : null)
}

function oddParaProb(odd) {
  if (!odd || odd <= 1) return null
  return parseFloat((1 / odd * 100).toFixed(1))
}

function calcEV(probModelo, oddDecimal) {
  if (!probModelo || !oddDecimal || oddDecimal <= 1) return null
  return parseFloat(((probModelo / 100) * oddDecimal - 1).toFixed(3))
}

/** Probabilidade implícita da odd (sem tirar overround — edge bruto vs casa) */
function oddParaProbImpl(oddDecimal) {
  if (!oddDecimal || oddDecimal <= 1) return null
  return parseFloat((100 / oddDecimal).toFixed(1))
}

/**
 * Edge em pontos percentuais: modelo − implícito da odd.
 * O mínimo exigido NÃO é mais fixo: depende da categoria (gols / 1X2 / ...) e da
 * faixa de odd — ver edgeMinimoPara() em valueConfig.js.
 */
function calcEdge(probModelo, oddDecimal) {
  const impl = oddParaProbImpl(oddDecimal)
  if (impl == null || probModelo == null) return null
  return parseFloat((probModelo - impl).toFixed(1))
}

// ✅ EDGE_MINIMO_VALUE fixo (5pp) foi substituído por edgeMinimoPara(categoria, odd) — valueConfig.js.
// `edgeMinimo` no retorno de montarValuePick continua existindo (= mínimo base de Gols) por compatibilidade.

/**
 * Avalia value nos mercados de gols (e 1X2) e monta o pick recomendado.
 */
function montarValuePick({
  over15, under15, over25, under25, over35, under35, btts,
  pm, pv,
  oddsData,
  mercadoGolsLimpo,
  incertezaOver25 = null, // ✅ FIX — item 8: banda de incerteza pra gatear o Kelly
}) {
  if (!oddsData) {
    return {
      temValue: false,
      motivo: 'Sem odds disponíveis',
      candidatos: [],
      melhorValue: null,
      edgeMercadoSugerido: null,
    }
  }

  const candidatos = [
    { nome: 'Over 1.5 Gols',  prob: over15,  odd: oddsData.oddsOver15,  tipo: 'gols' },
    { nome: 'Over 2.5 Gols',  prob: over25,  odd: oddsData.oddsOver25,  tipo: 'gols' },
    { nome: 'Under 2.5 Gols', prob: under25, odd: oddsData.oddsUnder25, tipo: 'gols' },
    { nome: 'Over 3.5 Gols',  prob: over35,  odd: oddsData.oddsOver35,  tipo: 'gols' },
    { nome: 'BTTS Sim',       prob: btts,    odd: null,                tipo: 'gols' }, // odd BTTS nem sempre vem
    { nome: 'Mandante',       prob: pm,      odd: oddsData.oddsM,      tipo: '1x2' },
    { nome: 'Visitante',      prob: pv,      odd: oddsData.oddsV,      tipo: '1x2' },
  ]
    .filter(c => c.odd && c.odd > 1 && c.prob != null)
    .map(c => {
      const edge = calcEdge(c.prob, c.odd)
      const ev = calcEV(c.prob, c.odd)
      const impl = oddParaProbImpl(c.odd)
      const edgeMin = edgeMinimoPara(c.tipo, c.odd) // mínimo da CATEGORIA + faixa de odd
      const temValue = edge != null && edge >= edgeMin && ev != null && ev > EV_MINIMO
      // ✅ NOVO — item 38: Kelly só faz sentido pra quem já passou no filtro de value
      // ✅ FIX — item 8: além de passar no edge/EV do ponto médio, o PIOR CASO
      // plausível (banda de incerteza, hoje só existe pra Over/Under 2.5 Gols)
      // ainda precisa bater a odd. Sem isso, o Kelly aposta tamanho de banca
      // em cima de uma probabilidade que pode estar otimista demais.
      let stakeKellyPct = temValue ? calcKellyFracionario(c.prob, c.odd) : 0
      if (stakeKellyPct > 0 && incertezaOver25 && (c.nome === 'Over 2.5 Gols' || c.nome === 'Under 2.5 Gols')) {
        const piorCaso = c.nome === 'Over 2.5 Gols' ? incertezaOver25.low : 100 - incertezaOver25.high
        if (piorCaso <= impl) stakeKellyPct = 0
      }
      return { ...c, edge, edgeMin, ev, impl, temValue, stakeKellyPct }
    })
    // ordena pela FOLGA sobre o mínimo da própria categoria (não pelo edge bruto),
    // senão um 1X2 de azarão com mínimo mais alto ganharia de um total de gols mais "folgado".
    .sort((a, b) => ((b.edge ?? -999) - (b.edgeMin ?? 0)) - ((a.edge ?? -999) - (a.edgeMin ?? 0)))

  const comValue = candidatos.filter(c => c.temValue)
  const melhorValue = comValue[0] || null

  // Edge do mercado de gols que o modelo sugeriu
  const nomeSug = String(mercadoGolsLimpo || '')
  const matchSug = candidatos.find(c =>
    nomeSug.toLowerCase().includes(c.nome.toLowerCase().replace(' gols', '')) ||
    c.nome.toLowerCase().includes(nomeSug.toLowerCase().replace(' gols', ''))
  )
  const edgeMercadoSugerido = matchSug
    ? {
        nome: matchSug.nome,
        edge: matchSug.edge,
        ev: matchSug.ev,
        odd: matchSug.odd,
        impl: matchSug.impl,
        prob: matchSug.prob,
        edgeMin: matchSug.edgeMin,
        temValue: matchSug.temValue,
      }
    : null

  return {
    temValue: comValue.length > 0,
    motivo: comValue.length
      ? `${comValue.length} mercado(s) com edge acima do mínimo da categoria (gols ≥${EDGE_MINIMO_BASE.gols}pp, 1X2 ≥${EDGE_MINIMO_BASE['1x2']}pp; +1/+2pp em odds ≥2.0/≥3.0)`
      : `Nenhum mercado com edge acima do mínimo da categoria (gols ≥${EDGE_MINIMO_BASE.gols}pp, 1X2 ≥${EDGE_MINIMO_BASE['1x2']}pp)`,
    candidatos: candidatos.slice(0, 6),
    melhorValue: melhorValue
      ? {
          nome: melhorValue.nome,
          edge: melhorValue.edge,
          ev: melhorValue.ev,
          odd: melhorValue.odd,
          impl: melhorValue.impl,
          prob: melhorValue.prob,
          edgeMin: melhorValue.edgeMin,
          stakeKellyPct: melhorValue.stakeKellyPct, // ✅ NOVO — item 38
        }
      : null,
    edgeMercadoSugerido,
    edgeMinimo: EDGE_MINIMO_BASE.gols,
    edgeMinimoPorTipo: EDGE_MINIMO_BASE,
  }
}

// ── Remove overround: normaliza probabilidades implícitas de um mercado
//    fechado (soma sempre >100% por causa da margem da casa) para somarem 100%.
//    Recebe odds decimais do mesmo mercado (ex: [oddsM, oddsE, oddsV] ou [oddsOver25, oddsUnder25]).
function normalizarOverround(...odds) {
  const brutas = odds.map(o => (o && o > 1) ? 1 / o : null)
  const soma = brutas.reduce((s, p) => s + (p ?? 0), 0)
  if (soma === 0) return brutas.map(() => null)
  return brutas.map(p => p === null ? null : parseFloat((p / soma * 100).toFixed(1)))
}

// ── Blend probabilidade do modelo com probabilidade implícita do mercado
//    (só quando há odds disponíveis; peso de mercado default 25%)
// ✅ AJUSTE DE PESO: peso do mercado (odds) subiu de 0.25 para 0.32. Odds de
// casas de apostas embutem informação que o nosso modelo não tem (lesões de
// última hora, escalação vazada, dinheiro de apostadores profissionais).
// Dar mais peso ao consenso do mercado quando ele está disponível tende a
// reduzir a variância do palpite final — o modelo próprio continua pesando
// mais (68%), mas o mercado passa a corrigir com mais força quando diverge muito.
function blendComMercado(probModelo, probMercadoNormalizada, pesoMercado = 0.32) {
  if (probModelo == null || probMercadoNormalizada == null) return probModelo
  return Math.round(probModelo * (1 - pesoMercado) + probMercadoNormalizada * pesoMercado)
}

// ─────────────────────────────────────────────────────────────
// HELPERS DE DATA
// ─────────────────────────────────────────────────────────────
function getBrazilDayRange() {
  const now  = new Date()
  const utcH = now.getUTCHours()
  const start = new Date(now)
  start.setUTCMinutes(0, 0, 0)
  if (utcH >= 3) { start.setUTCHours(3) }
  else { start.setUTCDate(start.getUTCDate() - 1); start.setUTCHours(3) }
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000)
  const fmt = d =>
    d.getUTCFullYear() + '-' +
    String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(d.getUTCDate()).padStart(2, '0')
  return { dateFrom: fmt(start), dateTo: fmt(end) }
}

function getBrazilToday() {
  return new Date().toLocaleDateString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    timeZone: 'America/Sao_Paulo',
  })
}

function formatHorario(utcDate) {
  if (!utcDate) return 'Indisponível'
  return new Date(utcDate).toLocaleTimeString('pt-BR', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
  })
}

// ─────────────────────────────────────────────────────────────
// FOOTBALL-DATA FETCH — via proxy servidor
// ─────────────────────────────────────────────────────────────
async function fdFetch(path, tentativa = 1) {
  const url = `${FD_BASE}${path}`
  const res = await fetch(url, { headers: authHeaders() })

  if (res.status === 401) {
    throw new Error('Sessão expirada. Faça login novamente para continuar.')
  }
  if (res.status === 429) {
    if (tentativa <= 3) {
      const espera = tentativa * 20000
      console.warn(`[FD] 429 — aguardando ${espera/1000}s antes de retry ${tentativa}...`)
      await sleep(espera)
      return fdFetch(path, tentativa + 1)
    }
    throw new Error('Limite da football-data.org atingido. Aguarde 1 minuto e tente novamente.')
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err?.message || `football-data.org erro ${res.status}`)
  }

  return res.json()
}

async function fdFetchMatchDetail(matchId) {
  try { return await fdFetch(`/matches/${matchId}`) }
  catch (err) { console.warn(`Detalhe do match ${matchId} falhou:`, err.message); return null }
}

// ─────────────────────────────────────────────────────────────
// calcResultado
// ─────────────────────────────────────────────────────────────
function calcResultado(match, teamId) {
  const isHome   = match.homeTeam?.id === teamId
  const hScore   = match.score?.fullTime?.home ?? null
  const aScore   = match.score?.fullTime?.away ?? null
  if (hScore === null || aScore === null) return null

  const golsMarcados = isHome ? hScore : aScore
  const golsSofridos = isHome ? aScore : hScore
  const totalGols    = hScore + aScore

  let resultado
  if (hScore === aScore)  resultado = 'E'
  else if (isHome)        resultado = hScore > aScore ? 'V' : 'D'
  else                    resultado = aScore > hScore ? 'V' : 'D'

  return { resultado, golsMarcados, golsSofridos, totalGols }
}

// ✅ NOVO — item 21/22 (Fase 5): fadiga/calendário congestionado. Recebe
// TODOS os jogos já finalizados do time nessa temporada (o mesmo payload
// cru de /teams/:id/matches que já buscamos pro histórico de gols — não
// precisa de nenhuma chamada de API nova) e a data (ISO) do próximo jogo.
// Calcula dias de descanso, jogos nos últimos 7 dias, e se o compromisso
// mais recente foi de OUTRA competição pouco antes deste (sinal de risco
// de poupar titulares — ex.: jogou Champions/Libertadores na quarta e
// agora joga a liga no fim de semana).
function calcularFadiga(todosJogosTemporada, dataProximoJogoISO, ligaCodeAtual) {
  if (!dataProximoJogoISO || !Array.isArray(todosJogosTemporada) || !todosJogosTemporada.length) return null

  const alvo = new Date(dataProximoJogoISO)
  if (isNaN(alvo)) return null

  const anteriores = todosJogosTemporada
    .filter(m => m.utcDate && new Date(m.utcDate) < alvo)
    .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate))

  if (!anteriores.length) return null

  const ultimo         = anteriores[0]
  const diasDescanso   = Math.round((alvo - new Date(ultimo.utcDate)) / (1000 * 60 * 60 * 24))
  const seteDiasAntes  = new Date(alvo.getTime() - 7 * 24 * 60 * 60 * 1000)
  const jogosUltimos7Dias = anteriores.filter(m => new Date(m.utcDate) >= seteDiasAntes).length

  // .competition.code é o mesmo código que já usamos em jogo.ligaCode (ex.:
  // 'BSA', 'PL') — comparar por código, não por nome, evita falso positivo
  // por diferença de rotulagem da própria football-data.org.
  const competicaoAnterior = ultimo.competition?.name ?? null
  const riscoRotacao = !!(
    ultimo.competition?.code &&
    ligaCodeAtual &&
    ultimo.competition.code !== ligaCodeAtual &&
    diasDescanso <= 4
  )

  return { diasDescanso, jogosUltimos7Dias, riscoRotacao, competicaoAnterior }
}


// ✅ NOVO — item 22 (Fase 5): contexto de motivação. Busca a tabela da liga
// UMA vez por jogo (não por time) e extrai, pra cada lado, se está brigando
// rebaixamento, brigando vaga continental/título, ou já "sem nada em jogo"
// perto do fim da temporada. É uma estimativa por posição — a API não
// marca explicitamente "zona de rebaixamento"/"vaga europeia" pra toda
// liga, então usamos as últimas 4 posições e o top 4-6 como aproximação
// (ajuste os números abaixo se sua liga tiver zonas diferentes).
async function buscarContextoMotivacional(ligaCode) {
  try {
    const data = await fdFetch(`/competitions/${ligaCode}/standings`)
    return data?.standings?.find(s => s.type === 'TOTAL')?.table ?? null
  } catch {
    return null // liga sem tabela na football-data (ex.: mata-mata) — segue sem esse dado
  }
}

function extrairMotivacao(tabela, teamId) {
  if (!tabela || !teamId) return null
  const linha = tabela.find(t => t.team?.id === teamId)
  if (!linha) return null

  const totalTimes       = tabela.length
  const posicao          = linha.position
  const jogos            = linha.playedGames
  const totalRodadas     = (totalTimes - 1) * 2  // turno + returno
  const jogosRestantes   = Math.max(0, totalRodadas - jogos)
  const zonaRebaixamento = totalTimes - 4        // últimas 4 posições
  const zonaContinental  = totalTimes >= 18 ? 6 : 4

  let texto = null
  if (posicao > zonaRebaixamento) {
    texto = jogosRestantes <= 10
      ? 'na zona de rebaixamento com poucos jogos restantes — motivação máxima, tende a jogar mais aberto/pressionado'
      : 'na zona de rebaixamento, mas ainda com bastante campeonato pela frente'
  } else if (posicao <= zonaContinental) {
    texto = jogosRestantes <= 10
      ? 'brigando por vaga continental/título com poucos jogos restantes — motivação máxima'
      : 'na briga por vaga continental/título'
  } else if (jogosRestantes <= 8) {
    texto = 'posição de tabela já consolidada, sem risco nem disputa direta perto do fim da temporada — possível jogo sem grande importância'
  }

  return texto ? { posicao, totalTimes, jogosRestantes, texto } : null
}


// ═════════════════════════════════════════════════════════════
// H2H
// ═════════════════════════════════════════════════════════════

// ✅ NOVO — Estatísticas avançadas de H2H: separa o confronto por mando de
// campo (como o mandante de hoje se saiu quando jogou EM CASA contra esse
// rival vs quando jogou FORA), calcula a sequência atual (streak) e a
// tendência de gols recente. Espera `confrontos` do mais recente pro mais
// antigo, cada item com { resultado: 'M'|'E'|'V', totalGols, golsTimeA,
// golsTimeB } e `isNormalOrder` OU `mandanteJogouEmCasa` (mesmo conceito,
// nomes diferentes conforme a fonte de dados).
function analisarH2HAvancado(confrontos) {
  if (!confrontos.length) return {}

  const jogouEmCasa = c => c.isNormalOrder ?? c.mandanteJogouEmCasa ?? true

  const emCasa = confrontos.filter(jogouEmCasa)
  const fora   = confrontos.filter(c => !jogouEmCasa(c))

  const resumoPorMando = (lista) => {
    if (!lista.length) return null
    const n = lista.length
    return {
      jogos: n,
      vitorias: lista.filter(c => c.resultado === 'M').length,
      empates:  lista.filter(c => c.resultado === 'E').length,
      derrotas: lista.filter(c => c.resultado === 'V').length,
      mediaGolsMarcados: parseFloat((lista.reduce((s, c) => s + c.golsTimeA, 0) / n).toFixed(2)),
      mediaGolsSofridos: parseFloat((lista.reduce((s, c) => s + c.golsTimeB, 0) / n).toFixed(2)),
    }
  }

  // Sequência atual (streak) a partir do confronto mais recente
  let sequenciaResultado = confrontos[0].resultado
  let sequenciaTamanho = 1
  for (let i = 1; i < confrontos.length; i++) {
    if (confrontos[i].resultado === sequenciaResultado) sequenciaTamanho++
    else break
  }

  // Tendência de gols: média dos 3 confrontos mais recentes vs os demais
  let tendenciaGols = 'estavel'
  if (confrontos.length >= 4) {
    const recentes = confrontos.slice(0, 3)
    const antigos  = confrontos.slice(3)
    const mediaRecente = recentes.reduce((s, c) => s + c.totalGols, 0) / recentes.length
    const mediaAntiga  = antigos.reduce((s, c) => s + c.totalGols, 0) / antigos.length
    if (mediaRecente - mediaAntiga >= 0.75)      tendenciaGols = 'subindo'
    else if (mediaAntiga - mediaRecente >= 0.75) tendenciaGols = 'caindo'
  }

  // % de confrontos decididos por só 1 gol de diferença (indicador de jogo parelho)
  const decididosPorUmGol = confrontos.filter(c => Math.abs(c.golsTimeA - c.golsTimeB) === 1).length
  const pctDecididoPorUmGol = Math.round((decididosPorUmGol / confrontos.length) * 100)

  return {
    quandoMandanteJogaEmCasa: resumoPorMando(emCasa),
    quandoMandanteJogaFora:   resumoPorMando(fora),
    sequenciaAtual: { resultado: sequenciaResultado, tamanho: sequenciaTamanho },
    tendenciaGols,
    pctDecididoPorUmGol,
  }
}

export async function fetchH2H(mandanteId, visitanteId, ligaCode) {
  const cacheKey = `h2h_${mandanteId}_${visitanteId}`
  const cached = _cache.get(cacheKey)
  if (cached) return cached

  try {
    const hoje = new Date()
    const doisAnosAtras = new Date(hoje)
    doisAnosAtras.setFullYear(hoje.getFullYear() - 2)
    const fmt = d =>
      d.getUTCFullYear() + '-' +
      String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(d.getUTCDate()).padStart(2, '0')
    const dateFrom = fmt(doisAnosAtras)
    const dateTo   = fmt(hoje)

    //✅ CORRETO: busca por time, não par de times
    const [r1, r2] = await Promise.allSettled([
      fdFetch(`/teams/${mandanteId}/matches?status=FINISHED&dateFrom=${dateFrom}&dateTo=${dateTo}`),
      fdFetch(`/teams/${visitanteId}/matches?status=FINISHED&dateFrom=${dateFrom}&dateTo=${dateTo}`),
    ])

    const matchesMandante  = r1.status === 'fulfilled' ? (r1.value?.matches ?? []) : []
    const matchesVisitante = r2.status === 'fulfilled' ? (r2.value?.matches ?? []) : []

    // Interseção local: jogos onde os dois times se enfrentaram
    const idsMandante = new Set(matchesMandante.map(m => m.id))
    const todos = matchesVisitante
      .filter(m => idsMandante.has(m.id))
      .filter(m =>
        typeof m.score?.fullTime?.home === 'number' &&
        typeof m.score?.fullTime?.away === 'number'
      )
      .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate))
      .slice(0, 8) // ✅ era 5 — mais amostra pra sequência/tendência ficarem confiáveis

    if (todos.length === 0) {
      return _cache.set(cacheKey, { confrontos: [], totalJogos: 0, semDados: true })
    }

    // --- resto da função igual ao original ---
    const confrontos = todos.map(m => {
      const hScore = m.score.fullTime.home
      const aScore = m.score.fullTime.away
      const isNormalOrder = m.homeTeam?.id === mandanteId
      const golsA = isNormalOrder ? hScore : aScore
      const golsB = isNormalOrder ? aScore : hScore

      let resultadoPerspectiva
      if (hScore === aScore)   resultadoPerspectiva = 'E'
      else if (isNormalOrder)  resultadoPerspectiva = hScore > aScore ? 'M' : 'V'
      else                     resultadoPerspectiva = aScore > hScore ? 'M' : 'V'

      const dataBRT = new Date(m.utcDate).toLocaleDateString('pt-BR', {
        day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Sao_Paulo',
      })

      return {
        data: dataBRT, utcDate: m.utcDate,
        competicao:    m.competition?.name ?? 'Desconhecida',
        mandanteNome:  m.homeTeam?.name ?? '?',
        visitanteNome: m.awayTeam?.name ?? '?',
        homeScore: hScore, awayScore: aScore,
        golsTimeA: golsA, golsTimeB: golsB,
        totalGols: hScore + aScore,
        resultado: resultadoPerspectiva,
        isNormalOrder,
      }
    })

    const totalJogos        = confrontos.length
    const vitoriasMandante  = confrontos.filter(c => c.resultado === 'M').length
    const vitoriasVisitante = confrontos.filter(c => c.resultado === 'V').length
    const empates           = confrontos.filter(c => c.resultado === 'E').length
    const totalGolsH2H      = confrontos.reduce((s, c) => s + c.totalGols, 0)
    const mediaGolsTotais   = parseFloat((totalGolsH2H / totalJogos).toFixed(2))
    const mediaGolsMandanteH2H  = parseFloat((confrontos.reduce((s, c) => s + c.golsTimeA, 0) / totalJogos).toFixed(2))
    const mediaGolsVisitanteH2H = parseFloat((confrontos.reduce((s, c) => s + c.golsTimeB, 0) / totalJogos).toFixed(2))

    const bttsH2H       = confrontos.filter(c => c.golsTimeA > 0 && c.golsTimeB > 0).length
    const bttsRateH2H   = Math.round((bttsH2H / totalJogos) * 100)
    const over25H2H     = confrontos.filter(c => c.totalGols >= 3).length
    const over25RateH2H = Math.round((over25H2H / totalJogos) * 100)
    const over15H2H     = confrontos.filter(c => c.totalGols >= 2).length
    const over15RateH2H = Math.round((over15H2H / totalJogos) * 100)
    // ✅ NOVO — faltava a taxa de Over 3.5 no H2H. Sem ela, um confronto
    // historicamente goleador (2-2, 3-2, 4-1...) não tinha como influenciar
    // a linha de 3.5 — o modelo usava só Poisson + histórico geral dos times.
    const over35H2H     = confrontos.filter(c => c.totalGols >= 4).length
    const over35RateH2H = Math.round((over35H2H / totalJogos) * 100)

    const resultado = {
      confrontos, totalJogos, semDados: false,
      vitoriasMandante, vitoriasVisitante, empates,
      probMH2H: Math.round((vitoriasMandante  / totalJogos) * 100),
      probEH2H: Math.round((empates           / totalJogos) * 100),
      probVH2H: Math.round((vitoriasVisitante / totalJogos) * 100),
      mediaGolsTotais, mediaGolsMandanteH2H, mediaGolsVisitanteH2H,
      bttsRateH2H, over25RateH2H, over15RateH2H, over35RateH2H,
      ...analisarH2HAvancado(confrontos), // ✅ NOVO — mando, sequência, tendência
    }

    return _cache.set(cacheKey, resultado)
  } catch (err) {
    console.warn(`H2H falhou: ${mandanteId} vs ${visitanteId}:`, err.message)
    return { confrontos: [], totalJogos: 0, semDados: true, erro: err.message }
  }
}

export async function fetchEstatisticasAllSports(mandante, visitante, matchId) {
  try {
    const cacheKey = `allsports_stats_${matchId}`
    const cached   = _cache.get(cacheKey)
    if (cached) return cached

    // Busca estatísticas do jogo (cartões, escanteios)
    const data = await allsportsFetch({ matchId })
    if (!data?.result) return null

    const match = data.result[0]
    if (!match) return null

    const stats = match.statistics ?? []
    const getStat = (type, team) => {
      const s = stats.find(s => s.type?.toLowerCase().includes(type))
      return team === 'home' ? parseInt(s?.home ?? 0) : parseInt(s?.away ?? 0)
    }

    const resultado = {
      cartoes: {
        mandante: getStat('yellow card', 'home') + getStat('red card', 'home'),
        visitante: getStat('yellow card', 'away') + getStat('red card', 'away'),
        total: getStat('yellow card', 'home') + getStat('red card', 'home') +
               getStat('yellow card', 'away') + getStat('red card', 'away'),
      },
      escanteios: {
        mandante:  getStat('corner', 'home'),
        visitante: getStat('corner', 'away'),
        total:     getStat('corner', 'home') + getStat('corner', 'away'),
      },
    }

    return _cache.set(cacheKey, resultado)
  } catch (err) {
    console.warn('AllSports stats falhou:', err.message)
    return null
  }
}

export async function fetchH2HAllSports(mandante, visitante, mandanteIdAllSports = null, visitanteIdAllSports = null) {
  // Sem IDs numéricos da AllSports não é possível fazer H2H — degrada silenciosamente
  if (!mandanteIdAllSports || !visitanteIdAllSports) {
    return null
  }
 
  try {
    const cacheKey = `allsports_h2h_${mandanteIdAllSports}_${visitanteIdAllSports}`
    const cached   = _cache.get(cacheKey)
    if (cached) return cached
 
    const data = await allsportsFetch({
      met:            'H2H',
      firstTeamId:    mandanteIdAllSports,   // ← IDs numéricos obrigatórios
      secondTeamId:   visitanteIdAllSports,
    })
 
    if (!data?.result?.H2H?.length) return null
 
    const confrontos = data.result.H2H.slice(0, 5)
    const totalJogos = confrontos.length
 
    const mediaCartoes = parseFloat((
      confrontos.reduce((s, m) => {
        const stats = m.statistics ?? []
        const getStat = (type) => {
          const st = stats.find(s => s.type?.toLowerCase().includes(type))
          return parseInt(st?.home ?? 0) + parseInt(st?.away ?? 0)
        }
        return s + getStat('yellow card') + getStat('red card')
      }, 0) / totalJogos
    ).toFixed(1))
 
    const mediaEscanteios = parseFloat((
      confrontos.reduce((s, m) => {
        const stats = m.statistics ?? []
        const st = stats.find(s => s.type?.toLowerCase().includes('corner'))
        return s + (parseInt(st?.home ?? 0) + parseInt(st?.away ?? 0))
      }, 0) / totalJogos
    ).toFixed(1))
 
    const resultado = { mediaCartoes, mediaEscanteios, totalJogos, semDados: false }
    return _cache.set(cacheKey, resultado)
  } catch (err) {
    console.warn('AllSports H2H falhou:', err.message)
    return null
  }
}

// ─────────────────────────────────────────────────────────────
// GROQ — via proxy servidor (apiKey ignorada aqui, usada no servidor)
// ─────────────────────────────────────────────────────────────
async function callGroq(_apiKey, system, user, maxTokens = 400) {
  for (let t = 1; t <= 3; t++) {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        model: MODEL, temperature: 0.1, max_tokens: maxTokens + 2000,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user',   content: user   },
        ],
      }),
    })

    if (res.status === 429) {
      const err  = await res.json().catch(() => ({}))
      const m    = (err?.error?.message || '').match(/try again in ([\d.]+)s/i)
      const wait = m ? Math.ceil(parseFloat(m[1])) * 1000 + 2000 : 30000
      if (t === 3) throw new Error(`Rate limit Groq. Aguarde ${Math.ceil(wait / 1000)}s.`)
      console.warn(`Rate limit Groq — aguardando ${wait}ms antes de retry ${t}…`)
      await sleep(wait)
      continue
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err?.error?.message || `Groq erro HTTP ${res.status}`)
    }

    const data  = await res.json()
    const raw   = data.choices?.[0]?.message?.content || '{}'
    const clean = raw.replace(/```json|```/gi, '').trim()
    const hit   = clean.match(/\{[\s\S]*\}/)
    return hit ? JSON.parse(hit[0]) : {}
  }
}

export async function callGroqComWebSearch(_apiKey, prompt, maxTokens = 1500) {
  for (let t = 1; t <= 3; t++) {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        temperature: 0.2,
        max_tokens: maxTokens + 2000,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'Você é um analista esportivo especialista em mercados de gols. ' +
              'Use os dados estatísticos fornecidos E seu conhecimento atualizado sobre os times ' +
              'para fazer uma análise precisa e detalhada. ' +
              'Considere: forma recente real, lesões conhecidas, motivação na competição, ' +
              'estilo de jogo de cada time. Retorne APENAS JSON válido.',
          },
          { role: 'user', content: prompt },
        ],
      }),
    })

    if (res.status === 429) {
      const err  = await res.json().catch(() => ({}))
      const m    = (err?.error?.message || '').match(/try again in ([\d.]+)s/i)
      const wait = m ? Math.ceil(parseFloat(m[1])) * 1000 + 1000 : 15000
      if (t === 3) throw new Error(`Rate limit Groq. Aguarde ${Math.ceil(wait / 1000)}s.`)
      await sleep(wait)
      continue
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err?.error?.message || `Groq erro HTTP ${res.status}`)
    }

    const data  = await res.json()
    const raw   = data.choices?.[0]?.message?.content || '{}'
    const clean = raw.replace(/```json|```/gi, '').trim()
    const hit   = clean.match(/\{[\s\S]*\}/)
    return hit ? JSON.parse(hit[0]) : {}
  }
}

async function callGemini(prompt) {
  // Gemini desativado — usando Groq diretamente
  return null
}

// ─────────────────────────────────────────────────────────────
// ✅ NOVO — Clima do estádio do mandante (via servidor → Open-Meteo)
// ─────────────────────────────────────────────────────────────
async function fetchClima(mandanteNome, dataJogo) {
  try {
    const dataISO = converterDataParaISO(dataJogo) // dd/mm/aaaa → aaaa-mm-dd
    if (!dataISO) return null
    const res = await fetch(
      `${API_BASE}/api/sportsdata/weather/${encodeURIComponent(mandanteNome)}/${dataISO}`,
      { headers: authHeaders() }
    )
    if (!res.ok) return null
    const data = await res.json()
    return data?.status === 'ok' ? data.data : null
  } catch (err) {
    console.warn('[Clima] falhou:', err.message)
    return null
  }
}

function converterDataParaISO(dataBR) {
  // aceita 'dd/mm/aaaa' (formato usado no resto do sistema) ou já ISO
  if (!dataBR) return null
  if (/^\d{4}-\d{2}-\d{2}/.test(dataBR)) return dataBR.slice(0, 10)
  const m = String(dataBR).match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
  if (!m) return null
  return `${m[3]}-${m[2]}-${m[1]}`
}

// ─────────────────────────────────────────────────────────────
// ✅ NOVO — Mercado de cartões e escanteios via Poisson, usando as médias
// REAIS dos últimos jogos de cada time (corrigidas no flashliveService/
// flashscoreScraper), ajustadas pelo árbitro (quando disponível) e pelo
// clima previsto. Antes, cartões/escanteios eram só números exibidos —
// nunca viravam uma probabilidade Over/Under de verdade.
// ─────────────────────────────────────────────────────────────
function poissonProbSobre(lambda, linha) {
  if (lambda == null || Number.isNaN(lambda)) return null
  let cdf = 0, fat = 1
  const kMax = Math.floor(linha)
  for (let k = 0; k <= kMax; k++) {
    if (k > 0) fat *= k
    cdf += Math.pow(lambda, k) * Math.exp(-lambda) / fat
  }
  return Math.round(Math.min(97, Math.max(3, (1 - cdf) * 100)))
}

// ─────────────────────────────────────────────────────────────
// ✅ NOVO — Clássicos/rivalidades conhecidas. Jogo de rivalidade tem mais
// tensão, mais falta tática, historicamente mais cartão. Lista não
// exaustiva — cobre os clássicos mais notórios das ligas já suportadas.
// Pra adicionar um novo, só incluir o par de nomes (sem acento/espaço).
// ─────────────────────────────────────────────────────────────
function normRivalidade(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '')
}

const RIVALIDADES = [
  // Brasileirão
  ['flamengo', 'fluminense'], ['flamengo', 'vasco'], ['flamengo', 'botafogo'],
  ['corinthians', 'palmeiras'], ['corinthians', 'saopaulo'], ['saopaulo', 'palmeiras'],
  ['gremio', 'internacional'], ['atleticomineiro', 'cruzeiro'], ['bahia', 'vitoria'],
  // Premier League
  ['arsenal', 'tottenham'], ['arsenal', 'chelsea'], ['manchesterunited', 'liverpool'],
  ['manchesterunited', 'manchestercity'], ['everton', 'liverpool'], ['chelsea', 'tottenham'],
  // La Liga
  ['realmadrid', 'barcelona'], ['atleticomadrid', 'realmadrid'], ['sevilla', 'realbetis'],
  // Serie A (Itália)
  ['acmilan', 'internazionale'], ['roma', 'lazio'], ['juventus', 'torino'],
  // Libertadores / CONMEBOL
  ['bocajuniors', 'riverplate'],
]

function ehClassico(mandante, visitante) {
  const m = normRivalidade(mandante)
  const v = normRivalidade(visitante)
  return RIVALIDADES.some(([a, b]) =>
    (m.includes(a) && v.includes(b)) || (m.includes(b) && v.includes(a))
  )
}

// Competições em formato mata-mata — jogo eliminatório tende a ser mais
// físico/tenso que jogo de pontos corridos.
const LIGAS_MATA_MATA = ['CLI', 'CSA', 'CL', 'EL', 'WC', 'CA']

// ─────────────────────────────────────────────────────────────
// ✅ NOVO — Escolhe a melhor entrada entre TODAS as linhas de cartões e
// escanteios, no mesmo espírito de escolherMelhorMercadoCalibrado (gols).
// Zona útil 55–75%: abaixo disso a entrada não tem confiança suficiente,
// acima disso a odd tende a ficar baixa demais (pouco value).
// ─────────────────────────────────────────────────────────────
function escolherMelhorLinhaCartaoEscanteio(linhas, tipo, direcao) {
  if (!linhas?.length) return null
  const candidatos = linhas.map(l => ({
    tipo,
    linha: l.linha,
    direcao,
    prob: direcao === 'over' ? l.overPct : l.underPct,
    // ✅ FIX — mesma linha/direção, mas sem o fator de calibração aplicado
    probBruta: l.overPctBruto == null ? null : (direcao === 'over' ? l.overPctBruto : 100 - l.overPctBruto),
    // ✅ NOVO — essa direção específica bateu no teto/piso da categoria (ver
    // getCapsCategoria)? Se sim, a probabilidade real é ainda mais extrema do
    // que o número mostra, e na casa de apostas isso vira uma odd baixa
    // demais pra compensar o risco (ex: 1.009) — não deve ser escolhida como
    // "melhor entrada" mesmo tendo o % mais alto.
    travada: direcao === 'over' ? (l.travado === 'teto') : (l.travado === 'piso'),
  }))

  // ✅ NOVO — faixa preferida vai de 80% até (teto da categoria - 1), sem
  // estar travada. Cartões e Escanteios têm tetos diferentes de Gols (ver
  // getCapsCategoria) — em Cartões, por ex., prob. real de 90%+ em Over 1.5
  // ainda costuma valer a entrada (odd 1.25-1.30), então o teto é mais alto
  // e essa faixa acompanha.
  const { teto: tetoCategoria } = getCapsCategoria(tipo)
  const altaConfianca = candidatos.filter(c => c.prob >= 80 && c.prob <= tetoCategoria - 1 && !c.travada)
  const naZonaUtil     = candidatos.filter(c => c.prob >= 55 && c.prob <= 75)
  const semTravada      = candidatos.filter(c => !c.travada)

  // Ordem de preferência: 80–87% (sem travar) → zona útil 55–75% → qualquer
  // linha sem travar → por último, mesmo travada (só se não sobrar mais nada)
  const pool = altaConfianca.length ? altaConfianca
    : naZonaUtil.length ? naZonaUtil
    : semTravada.length ? semTravada
    : candidatos

  const melhor = pool.reduce((a, b) => (b.prob > a.prob ? b : a))

  let confianca = 'Baixa'
  if (melhor.prob >= 65) confianca = 'Alta'
  else if (melhor.prob >= 55) confianca = 'Média'

  return {
    nome: `${direcao === 'over' ? 'Over' : 'Under'} ${melhor.linha} ${tipo}`,
    linha: melhor.linha,
    direcao,
    prob: melhor.prob,
    probBruta: melhor.probBruta ?? null,   // ✅ FIX — prob. antes da calibração
    confianca,
    naZonaUtil: naZonaUtil.length > 0,
    melhorEntrada80: melhor.prob >= 80 && melhor.prob <= 87 && !melhor.travada,
    travada: melhor.travada,
  }
}

// ✅ Agora retorna as 4 melhores entradas (Over/Under de Cartões e de
// Escanteios), em vez de uma única mistura das duas categorias.
function escolherMelhorEntradaCartoesEscanteios(mercado) {
  return {
    cartoesOver:     escolherMelhorLinhaCartaoEscanteio(mercado.cartoesLinhas,    'Cartões',    'over'),
    cartoesUnder:    escolherMelhorLinhaCartaoEscanteio(mercado.cartoesLinhas,    'Cartões',    'under'),
    escanteiosOver:  escolherMelhorLinhaCartaoEscanteio(mercado.escanteiosLinhas, 'Escanteios', 'over'),
    escanteiosUnder: escolherMelhorLinhaCartaoEscanteio(mercado.escanteiosLinhas, 'Escanteios', 'under'),
  }
}

export async function calcMercadoCartoesEscanteios(ce, clima, contexto = {}) {
  if (!ce) return null

  // ✅ NOVO — shrinkage bayesiano nas médias de cartões/escanteios, mesmo
  // padrão já usado em calcEstatisticasGols: regressão à média da liga,
  // ponderada pelo tamanho da amostra (últimos 6 jogos = amostra pequena,
  // um jogo com expulsão dupla distorce a média inteira) e pelo CV do time.
  const [mediaLigaCartoes, mediaLigaEscanteios] = await Promise.all([
    getMediaLigaCartoes(contexto.ligaCode),
    getMediaLigaEscanteios(contexto.ligaCode),
  ])

  const cMraw = ce.mandante?.mediaCartoesTotais ?? null
  const cVraw = ce.visitante?.mediaCartoesTotais ?? null
  const cM = cMraw != null
    ? aplicarShrinkage(cMraw, mediaLigaCartoes.total, ce.mandante?.amostras ?? 0, ce.mandante?.cvCartoes ?? null)
    : null
  const cV = cVraw != null
    ? aplicarShrinkage(cVraw, mediaLigaCartoes.total, ce.visitante?.amostras ?? 0, ce.visitante?.cvCartoes ?? null)
    : null
  let lambdaCartoes = (cM != null && cV != null) ? cM + cV : (ce.mediaCartoesJogo ?? null)
  if (lambdaCartoes == null) return null

  // ✅ NOVO — H2H de cartões/escanteios entrando no cálculo, mesma filosofia
  // do blend de H2H em gols (calcMercadoGols): só entra se houver amostra
  // mínima confiável, e com peso menor que o modelo baseado nos times (a
  // amostra de H2H específica pra cartões/escanteios costuma ser pequena
  // e ruidosa — cada confronto é 1 árbitro, 1 clima, 1 contexto diferentes).
  const confrontosComCartoes = (contexto.h2h?.confrontos ?? [])
    .filter(c => c.cartoesTotal != null && c.escanteiosTotal != null)
  const h2hCartoesConfiavel = confrontosComCartoes.length >= 3
  const PESO_H2H_CARTOES    = 0.18
  const PESO_H2H_ESCANTEIOS = 0.15
  let mediaH2HCartoes = null, mediaH2HEscanteios = null
  if (h2hCartoesConfiavel) {
    mediaH2HCartoes    = confrontosComCartoes.reduce((s, c) => s + c.cartoesTotal, 0)    / confrontosComCartoes.length
    mediaH2HEscanteios = confrontosComCartoes.reduce((s, c) => s + c.escanteiosTotal, 0) / confrontosComCartoes.length
    lambdaCartoes = parseFloat((lambdaCartoes * (1 - PESO_H2H_CARTOES) + mediaH2HCartoes * PESO_H2H_CARTOES).toFixed(2))
  }

  const arbitro = ce.arbitro
  const arbitroUsado = !!(arbitro?.mediaCartoesPorJogo != null && (arbitro.jogosApitados ?? 0) >= 10)
  if (arbitroUsado) {
    // Blend 75% histórico dos times / 25% média do árbitro — o árbitro
    // influencia, mas não domina (amostra do time ainda é a base principal).
    lambdaCartoes = parseFloat((lambdaCartoes * 0.75 + arbitro.mediaCartoesPorJogo * 0.25).toFixed(2))
  }

  const climaUsado = !!(clima?.probabilidadeChuva != null)
  if (climaUsado && clima.probabilidadeChuva >= 60) {
    // Chuva forte → campo mais pesado, mais faltas → leve alta nos cartões
    lambdaCartoes = parseFloat((lambdaCartoes * 1.05).toFixed(2))
  }

  // ✅ NOVO — clássico/rivalidade: jogo mais tenso, mais falta tática
  const classicoUsado = !!(contexto.mandante && contexto.visitante && ehClassico(contexto.mandante, contexto.visitante))
  if (classicoUsado) {
    lambdaCartoes = parseFloat((lambdaCartoes * 1.15).toFixed(2))
  }

  // ✅ NOVO — mata-mata: jogo eliminatório, mais físico
  const mataMataUsado = !!(contexto.ligaCode && LIGAS_MATA_MATA.includes(contexto.ligaCode))
  if (mataMataUsado) {
    lambdaCartoes = parseFloat((lambdaCartoes * 1.08).toFixed(2))
  }

  // ✅ NOVO — equilíbrio do jogo: probabilidades de resultado parelhas =
  // jogo mais disputado = mais cartão. Jogo já "resolvido" (favoritismo
  // grande de um lado) tende a ter menos intensidade/cartão.
  let equilibrioUsado = false
  if (typeof contexto.gapResultado === 'number') {
    if (contexto.gapResultado <= 15) {
      lambdaCartoes = parseFloat((lambdaCartoes * 1.06).toFixed(2))
      equilibrioUsado = true
    } else if (contexto.gapResultado >= 45) {
      lambdaCartoes = parseFloat((lambdaCartoes * 0.93).toFixed(2))
      equilibrioUsado = true
    }
  }

  const eMraw = ce.mandante?.mediaEscanteios ?? null
  const eVraw = ce.visitante?.mediaEscanteios ?? null
  const eM = eMraw != null
    ? aplicarShrinkage(eMraw, mediaLigaEscanteios.total, ce.mandante?.amostras ?? 0, ce.mandante?.cvEscanteios ?? null)
    : null
  const eV = eVraw != null
    ? aplicarShrinkage(eVraw, mediaLigaEscanteios.total, ce.visitante?.amostras ?? 0, ce.visitante?.cvEscanteios ?? null)
    : null
  let lambdaEscanteios = (eM != null && eV != null) ? eM + eV : (ce.mediaEscanteiosJogo ?? null)
  // ✅ NOVO — mesmo blend de H2H aplicado em cartões, com peso um pouco
  // menor (escanteios variam mais por estilo tático do jogo específico).
  if (lambdaEscanteios != null && h2hCartoesConfiavel) {
    lambdaEscanteios = parseFloat((lambdaEscanteios * (1 - PESO_H2H_ESCANTEIOS) + mediaH2HEscanteios * PESO_H2H_ESCANTEIOS).toFixed(2))
  }
  if (lambdaEscanteios != null && clima?.ventoKmh != null && clima.ventoKmh >= 30) {
    // Vento forte → menos escanteios "limpos" cobrados/gerados — leve queda
    lambdaEscanteios = parseFloat((lambdaEscanteios * 0.97).toFixed(2))
  }
  // Clássico afeta escanteios bem menos que cartões (times fecham o jogo
  // por tensão, não necessariamente atacam mais)
  if (lambdaEscanteios != null && classicoUsado) {
    lambdaEscanteios = parseFloat((lambdaEscanteios * 1.04).toFixed(2))
  }

  const linhasCartoes    = [1.5, 2.5, 3.5, 4.5, 5.5, 6.5]
  const linhasEscanteios = [3.5, 4.5, 5.5, 6.5, 7.5, 8.5, 9.5, 10.5, 11.5, 12.5, 13.5, 14.5, 15.5]

  const cartoesLinhas = linhasCartoes
    .map(linha => {
      let overPct = poissonProbSobre(lambdaCartoes, linha)
      if (overPct == null) return null
      const overPctBruto = overPct   // ✅ FIX — prob. ANTES da calibração (é ela que o Tracker deve guardar p/ calibrar)
      // ✅ NOVO — aplica calibração automática (Tracker) igual já existe pra gols
      // ✅ item 7: passa liga + árbitro pra usar o fator segmentado quando disponível
      // ✅ FIX — item 7: o 5º argumento acima nunca fazia nada — aplicarFatorLinha
      // só aceita 4 parâmetros — e ainda usava contexto.liga, que este caller nunca
      // define (só existe contexto.ligaCode). A segmentação de verdade agora vem
      // de fábrica em contexto.fatoresCalib (ver correção acima), então basta ler
      // o fator normalmente.
      overPct = aplicarFatorLinha(overPct, 'Cartões', linha, contexto.fatoresCalib)
      // ✅ NOVO — sinaliza quando o teto/piso da categoria foi atingido, pra UI
      // poder explicar por que várias linhas mostram o mesmo %. Teto de Cartões
      // é mais alto que o de Gols (ver getCapsCategoria) — em cartões, prob.
      // real 90%+ ainda pode ter odd com valor, diferente de gols.
      const capsCartoes = getCapsCategoria('Cartões')
      const travado = overPct >= capsCartoes.teto ? 'teto' : overPct <= capsCartoes.piso ? 'piso' : null
      return { linha, overPct, overPctBruto, underPct: 100 - overPct, travado }
    })
    .filter(Boolean)

  const escanteiosLinhas = lambdaEscanteios != null
    ? linhasEscanteios
        .map(linha => {
          let overPct = poissonProbSobre(lambdaEscanteios, linha)
          if (overPct == null) return null
          const overPctBruto = overPct   // ✅ FIX — prob. ANTES da calibração
          // ✅ NOVO — aplica calibração automática (Tracker) igual já existe pra gols
          overPct = aplicarFatorLinha(overPct, 'Escanteios', linha, contexto.fatoresCalib)
          const capsEscanteios = getCapsCategoria('Escanteios')
          const travado = overPct >= capsEscanteios.teto ? 'teto' : overPct <= capsEscanteios.piso ? 'piso' : null
          return { linha, overPct, overPctBruto, underPct: 100 - overPct, travado }
        })
        .filter(Boolean)
    : []

  // Amostra mínima combinada dos dois times pra considerar o mercado confiável
  const amostraTotal = (ce.mandante?.amostras ?? 0) + (ce.visitante?.amostras ?? 0)

  const resultado = {
    lambdaCartoes,
    lambdaEscanteios: lambdaEscanteios ?? null,
    cartoesLinhas,
    escanteiosLinhas,
    amostraSuficiente: amostraTotal >= 6,
    amostraTotal,
    arbitroUsado,
    arbitroNome: arbitro?.nome ?? null,
    climaUsado,
    classicoUsado,
    mataMataUsado,
    equilibrioUsado,
    h2hCartoesEscanteiosUsado: h2hCartoesConfiavel,
    h2hAmostraCartoesEscanteios: confrontosComCartoes.length,
  }

  resultado.melhorEntrada = escolherMelhorEntradaCartoesEscanteios(resultado)
  return resultado
}

// ─────────────────────────────────────────────────────────────
// ✅ NOVO — Camada de IA (Groq) como VALIDAÇÃO QUALITATIVA do pick
// estatístico, não como substituto dele. A IA olha desfalques, árbitro e
// clima (dados que o modelo Poisson não "entende" de forma qualitativa) e
// aponta riscos que podem invalidar a entrada — sem poder alterar as
// probabilidades numéricas calculadas. Se a chamada falhar, o sistema
// segue funcionando normalmente só sem esse comentário extra.
// ─────────────────────────────────────────────────────────────
async function gerarAnaliseIA(jogo, resumoQuantitativo) {
  // ✅ NOVO — o bot do Telegram roda só com números (mais rápido, sem gastar chamada
  // na Groq). server/telegramAnalise.js liga essa flag; no site ela nunca existe.
  if (globalThis.__SCOUT_SEM_IA__) return null
  try {
    let desfalques = 'Sem dados de desfalques disponíveis.'
    try {
      // ✅ CORRIGIDO — usa dataJogoISO (novo campo) quando existe. `jogo.dataJogo`
      // é "dd/mm/yyyy" e `new Date()` não interpreta esse formato de forma
      // confiável (o parser do JS espera mm/dd/yyyy com barra) — isso deixava
      // o gate de confiança da escalação (item 10) e a busca de eventId do
      // FlashLive um pouco às cegas na data certa.
      const ausentes = await buscarEscalacaoEAusentes(jogo.mandante, jogo.visitante, jogo.dataJogoISO || jogo.dataJogo)
      if (ausentes?.ausentes) {
        // ✅ NOVO — cada ausente já vem com posição + peso do flashliveService,
        // então a IA vê "Fulano (atacante, titular, peso 1.6)" em vez de só
        // o nome solto, e consegue diferenciar quem realmente pesa no jogo.
        const formatarAusentes = (lista) =>
          (lista || []).length
            ? lista.map(a => {
                const status = a.eraTitular === true ? ', titular' : a.eraTitular === false ? ', reserva' : ''
                return `${a.nome} (${a.posicao}${status}, peso ${a.peso})`
              }).join(', ')
            : 'nenhum informado'

        const m = formatarAusentes(ausentes.ausentes.mandante)
        const v = formatarAusentes(ausentes.ausentes.visitante)

        // ✅ NOVO — gate de confiança (item 10): escalação "provável" ainda
        // pode mudar até a bola rolar, então isso vai explícito pra IA não
        // superreagir a um desfalque que talvez nem se confirme.
        const confianca = ausentes.confiancaEscalacao
        const avisoConfianca =
          confianca === 'oficial' ? '' :
          confianca === 'provavel_oficial'
            ? ' (escalação dentro da janela oficial, mas sem confirmação explícita — trate como quase certa)'
            : ' (escalação/desfalques ainda PROVÁVEIS — pode mudar até a bola rolar, não superreaja)'

        desfalques = `Desfalques ${jogo.mandante}: ${m}. Desfalques ${jogo.visitante}: ${v}.${avisoConfianca}`
      }
    } catch { /* segue sem desfalques */ }

    const arbitroTxt = jogo.cartoes_escanteios?.arbitro?.nome
      ? `Árbitro: ${jogo.cartoes_escanteios.arbitro.nome} (média ${jogo.cartoes_escanteios.arbitro.mediaCartoesPorJogo ?? '?'} cartões/jogo em ${jogo.cartoes_escanteios.arbitro.jogosApitados ?? '?'} jogos apitados).`
      : 'Árbitro não identificado.'

    const climaTxt = jogo.clima
      ? `Clima previsto no ${jogo.clima.estadio}: ${jogo.clima.temperaturaC ?? '?'}°C, ${jogo.clima.probabilidadeChuva ?? '?'}% chance de chuva, vento ${jogo.clima.ventoKmh ?? '?'}km/h.`
      : 'Sem dados de clima para este jogo.'

    // ✅ NOVO — Fase 5, itens 21 e 22
    const fadigaTxt = [jogo.fadiga_mandante, jogo.fadiga_visitante]
      .map((f, i) => {
        const nome = i === 0 ? jogo.mandante : jogo.visitante
        if (!f?.diasDescanso && f?.diasDescanso !== 0) return null
        const rotacao = f.riscoRotacao ? ` ⚠️ jogou ${f.competicaoAnterior} no meio da semana — risco de poupar titulares.` : ''
        return `${nome}: ${f.diasDescanso}d de descanso, ${f.jogosUltimos7Dias} jogo(s) nos últimos 7 dias.${rotacao}`
      })
      .filter(Boolean)
      .join(' ') || 'Sem dados de fadiga/calendário.'

    // ✅ NOVO — item 22
    const motivacaoTxt = [jogo.motivacao_mandante, jogo.motivacao_visitante]
      .map((m, i) => (m ? `${i === 0 ? jogo.mandante : jogo.visitante}: ${m.texto} (${m.posicao}º de ${m.totalTimes}, ~${m.jogosRestantes} jogos restantes).` : null))
      .filter(Boolean)
      .join(' ') || 'Sem dados de posição na tabela.'

    const prompt =
      `Jogo: ${jogo.mandante} x ${jogo.visitante} (${jogo.competicao}).\n` +
      `Modelo estatístico aponta: ${resumoQuantitativo.mercadoGolsLimpoFinal} ` +
      `(${resumoQuantitativo.probMercadoFinal}% de probabilidade), resultado mais provável: ` +
      `${resumoQuantitativo.mercadoResultadoFinal}.\n` +
      `${desfalques}\n${arbitroTxt}\n${climaTxt}\n${fadigaTxt}\n${motivacaoTxt}\n\n` +
      `Com base SOMENTE nesses dados e no que você sabe sobre esses times, responda em JSON puro:\n` +
      `{"alertas": ["fator de risco 1", "fator de risco 2"], "nivel_risco": "baixo|medio|alto", "comentario": "1-2 frases"}\n` +
      `"alertas" = fatores que podem invalidar essa entrada estatística (desfalque decisivo, árbitro rigoroso/permissivo, ` +
      `clima ruim, mando de campo atípico, jogo sem importância/já decidido na tabela, viagem longa recente, etc). ` +
      `Se não houver risco relevante que você conheça, devolva alertas vazio e nivel_risco "baixo". Não invente dados que não tem.`

    const resultado = await callGroqComWebSearch(null, prompt, 350)
    return {
      alertas:      Array.isArray(resultado?.alertas) ? resultado.alertas.slice(0, 5) : [],
      nivel_risco:  ['baixo', 'medio', 'alto'].includes(resultado?.nivel_risco) ? resultado.nivel_risco : 'baixo',
      comentario:   resultado?.comentario ?? null,
    }
  } catch (err) {
    console.warn('[IA] análise qualitativa falhou (seguindo sem ela):', err.message)
    return null
  }
}

// ═════════════════════════════════════════════════════════════
// ETAPA 1 — Jogos do dia
// ═════════════════════════════════════════════════════════════
function getAmanhaBRT() {
  const amanhaBRT = new Date(
    new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })
  )
  amanhaBRT.setDate(amanhaBRT.getDate() + 1)
  const amanhaStr = amanhaBRT.toLocaleDateString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
  })
  const pad = n => String(n).padStart(2, '0')
  const dateFrom = `${amanhaBRT.getFullYear()}-${pad(amanhaBRT.getMonth()+1)}-${pad(amanhaBRT.getDate())}`
  const depoisDeAmanha = new Date(amanhaBRT)
  depoisDeAmanha.setDate(depoisDeAmanha.getDate() + 1)
  const dateTo = `${depoisDeAmanha.getFullYear()}-${pad(depoisDeAmanha.getMonth()+1)}-${pad(depoisDeAmanha.getDate())}`
  return { amanhaStr, dateFrom, dateTo }
}

function filtrarPorDiaBRT(matches, diaBRT) {
  return matches.filter(m => {
    if (!m.utcDate) return false
    const dataBRT = new Date(m.utcDate).toLocaleDateString('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Sao_Paulo',
    })
    return dataBRT === diaBRT
  })
}

// incluirAmanha: quando true, busca e mostra os jogos de amanhã JUNTO com
// os de hoje (não apenas como fallback quando não há jogos hoje).
export async function etapa1_buscarJogos(apiKey, campeonato, incluirAmanha = false) {
  const code = LIGA_CODES[campeonato]
  if (!code)
    throw new Error(
      `"${campeonato}" não está disponível.\n` +
      `Disponíveis: Brasileirão A, Libertadores, Champions League, Europa League, ` +
      `Premier League, La Liga, Serie A Itália.`
    )

  const { dateFrom, dateTo } = getBrazilDayRange()
  const cacheKey1 = `etapa1_${code}_${dateFrom}_${incluirAmanha ? 'comAmanha' : 'soHoje'}`
  const cached1   = _cache.get(cacheKey1)
  if (cached1) return cached1

  const data    = await fdFetch(`/competitions/${code}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`)
  const matches = data?.matches || []
  const hoje    = getBrazilToday()

  const jogosHoje = filtrarPorDiaBRT(matches, hoje)

  let jogosAmanha = []
  let amanhaStr   = null
  // Busca amanhã se: o usuário pediu explicitamente, OU não há nenhum jogo hoje (fallback antigo)
  if (incluirAmanha || jogosHoje.length === 0) {
    const infoAmanha = getAmanhaBRT()
    amanhaStr = infoAmanha.amanhaStr
    const dataAmanha = await fdFetch(
      `/competitions/${code}/matches?dateFrom=${infoAmanha.dateFrom}&dateTo=${infoAmanha.dateTo}`
    )
    const matchesAmanha = dataAmanha?.matches || []
    jogosAmanha = filtrarPorDiaBRT(matchesAmanha, amanhaStr)
  }

  if (jogosHoje.length === 0 && jogosAmanha.length === 0) {
    throw new Error(
      `Nenhum jogo de "${campeonato}" hoje (${hoje})` +
      (amanhaStr ? ` nem amanhã (${amanhaStr}).` : '.')
    )
  }

  if (jogosHoje.length === 0 && jogosAmanha.length > 0) {
    console.info(`[Etapa1] Sem jogos hoje — usando amanhã (${amanhaStr}): ${jogosAmanha.length} jogo(s)`)
  }

  const mapJogo = (m, usandoAmanha) => ({
    mandante:    m.homeTeam?.name  || 'Time A',
    visitante:   m.awayTeam?.name  || 'Time B',
    horario:     formatHorario(m.utcDate),
    dataJogo:    new Date(m.utcDate).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
    // ✅ NOVO — data crua em ISO. `dataJogo` acima é "dd/mm/yyyy" (pt-BR), e
    // `new Date("23/09/2026")` não é confiável (o parser do JS espera
    // mm/dd/yyyy nesse formato com barra) — qualquer cálculo de data feito
    // em cima de `dataJogo` até aqui podia estar sutilmente errado. Isso
    // afeta tanto a fadiga (item 21) quanto o gate de confiança da escalação.
    dataJogoISO: m.utcDate,
    status:      m.status || 'SCHEDULED',
    competicao:  campeonato,
    ligaCode:    code,
    mandanteId:  m.homeTeam?.id,
    visitanteId: m.awayTeam?.id,
    usandoAmanha,
  })

  // ✅ Mostra TODOS os jogos encontrados do campeonato (hoje + amanhã, se pedido).
  // A relevância dos times não é mais usada para descartar jogos — só para
  // ordenar a exibição (times maiores aparecem primeiro na lista).
  const listaJogos = [
    ...jogosHoje.map(m => mapJogo(m, false)),
    ...jogosAmanha.map(m => mapJogo(m, true)),
  ]

  const listaOrdenada = ordenarJogosPorRelevancia(listaJogos)
  return _cache.set(cacheKey1, listaOrdenada)
}

// ═════════════════════════════════════════════════════════════
// ✅ NOVO — ETAPA 1 MÚLTIPLA: busca jogos de vários campeonatos de uma vez.
//
// Não há risco de "misturar a lógica" dos campeonatos: cada jogo carrega seu
// próprio `ligaCode`, e todo parâmetro específico de liga (ρ do Dixon-Coles,
// fator mando, média de gols/cartões/escanteios da liga, mata-mata, sport_key
// da Odds API) é lido a partir desse código no momento do cálculo. Um jogo da
// Premier no meio de uma lista com Libertadores continua usando os parâmetros
// da Premier.
//
// `extraFetchers` permite plugar campeonatos que não vêm da football-data
// (ex.: Série B e Sul-Americana, que têm serviços próprios). Formato:
//   { 'Copa Sul-Americana': (incluirAmanha) => Promise<jogos[]> }
// Fica como parâmetro pra evitar import circular entre os services.
//
// Falha de um campeonato NÃO derruba os outros — ela é registrada em `erros`
// e a busca segue. Só lança se nenhum campeonato retornar jogo nenhum.
// ═════════════════════════════════════════════════════════════
export async function etapa1_buscarJogosMultiplos(apiKey, campeonatos, incluirAmanha = false, extraFetchers = {}) {
  const lista = Array.isArray(campeonatos) ? campeonatos.filter(Boolean) : [campeonatos]
  if (!lista.length) throw new Error('Selecione pelo menos um campeonato.')

  const resultados = await Promise.allSettled(
    lista.map(async (campeonato) => {
      const fetcherProprio = extraFetchers[campeonato]
      const jogos = fetcherProprio
        ? await fetcherProprio(incluirAmanha)
        : await etapa1_buscarJogos(apiKey, campeonato, incluirAmanha)
      // Garante que o nome do campeonato está no jogo mesmo vindo de fetcher
      // externo — a UI usa esse campo pra agrupar/etiquetar.
      return (jogos || []).map(j => ({ ...j, competicao: j.competicao || campeonato }))
    })
  )

  const jogos = []
  const erros = []
  resultados.forEach((r, i) => {
    if (r.status === 'fulfilled') jogos.push(...r.value)
    else erros.push({ campeonato: lista[i], motivo: r.reason?.message || String(r.reason) })
  })

  if (!jogos.length) {
    const detalhe = erros.map(e => `• ${e.campeonato}: ${e.motivo}`).join('\n')
    throw new Error(`Nenhum jogo encontrado nos campeonatos selecionados.\n${detalhe}`)
  }

  if (erros.length) {
    console.warn('[Etapa1Multi] Campeonatos sem jogos/com erro:', erros)
  }

  // Deduplica (mesmo confronto pode aparecer em copa + liga em casos raros)
  const vistos = new Set()
  const unicos = jogos.filter(j => {
    const chave = `${j.mandante}|${j.visitante}|${j.dataJogo}`
    if (vistos.has(chave)) return false
    vistos.add(chave)
    return true
  })

  const ordenada = ordenarJogosPorRelevancia(unicos)
  // Anexa os erros na própria lista (propriedade não-enumerável não sobrevive
  // a spread na UI, então vai como campo normal num objeto irmão).
  ordenada._errosCampeonatos = erros
  return ordenada
}

// ═════════════════════════════════════════════════════════════
// ETAPA 2 — Históricos + H2H
// ═════════════════════════════════════════════════════════════
export async function etapa2_buscarHistoricos(apiKey, jogos, maxJogos = 3) {
  const resultado = []
  // ✅ Regra de negócio: no máximo `maxJogos` são processados/analisados por
  // vez, mesmo que a lista de jogos encontrados (etapa1) seja maior.
  // Virou parâmetro por causa da busca multi-campeonato: com 3 ligas
  // selecionadas, um teto fixo de 3 faria você analisar praticamente só um
  // campeonato. Cuidado ao subir: cada jogo custa ~20s de espera (rate limit
  // da football-data) + chamadas de H2H/cartões/clima.
  const jogosParaProcessar = jogos.slice(0, maxJogos)

  const hoje = new Date()
  const fmt = d =>
  d.getUTCFullYear() + '-' +
  String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
  String(d.getUTCDate()).padStart(2, '0')
  const anoAtual = hoje.getFullYear()
  const dateFrom = `${anoAtual}-01-01`
  const dateTo   = fmt(hoje)

  for (const jogo of jogosParaProcessar) {
    if (resultado.length > 0) await sleep(20000)

    const cacheKey2 = `etapa2_${jogo.mandanteId}_${jogo.visitanteId}_${dateFrom}`
    const cached2   = _cache.get(cacheKey2)
    if (cached2) { resultado.push(cached2); continue }

    try {
      const dataMandante = await fdFetch(`/teams/${jogo.mandanteId}/matches?status=FINISHED&dateFrom=${dateFrom}&dateTo=${dateTo}`)
      await sleep(7000)
      const dataVisitante = await fdFetch(`/teams/${jogo.visitanteId}/matches?status=FINISHED&dateFrom=${dateFrom}&dateTo=${dateTo}`)
      await sleep(7000)

      const filtrarOrdenar = (matches, teamId, apenasLocalidade) =>
        [...(matches || [])]
          .filter(m => {
            const h = m.score?.fullTime?.home
            const a = m.score?.fullTime?.away
            if (typeof h !== 'number' || typeof a !== 'number') return false
            if (apenasLocalidade === 'home') return m.homeTeam?.id === teamId
            if (apenasLocalidade === 'away') return m.awayTeam?.id === teamId
            return true
          })
          .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate))
          .slice(0, 5)

      const top5Mandante  = filtrarOrdenar(dataMandante?.matches,  jogo.mandanteId,  'home')
      const top5Visitante = filtrarOrdenar(dataVisitante?.matches, jogo.visitanteId, 'away')
      const top5MandanteFull  = top5Mandante.length  >= 3 ? top5Mandante  : filtrarOrdenar(dataMandante?.matches,  jogo.mandanteId)
      const top5VisitanteFull = top5Visitante.length >= 3 ? top5Visitante : filtrarOrdenar(dataVisitante?.matches, jogo.visitanteId)
      // Fallback para seleções: se FD retornou vazio, complementa via selecaoService
const ligasSelecao = ['WC', 'WCQ', 'CA', 'NL', 'EURO']
if (ligasSelecao.includes(jogo.ligaCode)) {
  if (top5MandanteFull.length < 3 || top5VisitanteFull.length < 3) {
    try {
      const { buscarHistoricoSelecao } = await import('./selecaoService.js')
      if (top5MandanteFull.length < 3) {
        const histSel = await buscarHistoricoSelecao(jogo.mandanteId, 10)
        // Converte para formato football-data.org que filtrarOrdenar espera
        const synth = histSel.slice(0, 5).map(j => ({
          score: { fullTime: { home: j.isHome ? j.golsMarcados : j.golsSofridos, away: j.isHome ? j.golsSofridos : j.golsMarcados } },
          homeTeam: { id: j.isHome ? jogo.mandanteId : 0 },
          awayTeam: { id: j.isHome ? 0 : jogo.mandanteId },
          utcDate: j.data,
          _sintetico: true,
        }))
        top5MandanteFull.push(...synth.filter(() => top5MandanteFull.length < 5))
        console.info(`[Etapa2] Complementou mandante ${jogo.mandante} com ${synth.length} jogos do selecaoService`)
      }
      if (top5VisitanteFull.length < 3) {
        const histSel = await buscarHistoricoSelecao(jogo.visitanteId, 10)
        const synth = histSel.slice(0, 5).map(j => ({
          score: { fullTime: { home: j.isHome ? j.golsMarcados : j.golsSofridos, away: j.isHome ? j.golsSofridos : j.golsMarcados } },
          homeTeam: { id: j.isHome ? jogo.visitanteId : 0 },
          awayTeam: { id: j.isHome ? 0 : jogo.visitanteId },
          utcDate: j.data,
          _sintetico: true,
        }))
        top5VisitanteFull.push(...synth.filter(() => top5VisitanteFull.length < 5))
        console.info(`[Etapa2] Complementou visitante ${jogo.visitante} com ${synth.length} jogos do selecaoService`)
      }
    } catch (errSel) {
      console.warn('[Etapa2] selecaoService complemento falhou:', errSel.message)
    }
  }
}
      for (const m of [...top5MandanteFull, ...top5VisitanteFull]) {
      const hS = m.score?.fullTime?.home
      const aS = m.score?.fullTime?.away
      if (hS != null && aS != null) {
        registrarJogo(jogo.ligaCode, hS, aS)
        registrarJogoLocalidade(jogo.ligaCode, hS, aS) // ✅ NOVO — Fase 7: alimenta o home advantage por liga
      }
    }
      const processarJogos = (matches, teamId) =>
        matches.map(m => calcResultado(m, teamId)).filter(Boolean)

      await sleep(400)
      let h2h = await fetchH2H(jogo.mandanteId, jogo.visitanteId, jogo.ligaCode)
      // ✅ NOVO — se o football-data.org não achou confronto (janela de 2
      // anos, ou time recém-promovido sem histórico recente na competição),
      // tenta o histórico completo real (FlashLive) antes de desistir.
      if (h2h.semDados) {
        try {
          const h2hCompleto = await fetchH2HCompleto(jogo.mandante, jogo.visitante, jogo.ligaCode)
          if (h2hCompleto && !h2hCompleto.semDados) h2h = h2hCompleto
        } catch { /* mantém h2h vazio, segue normalmente */ }
      }
      
      // ✅ Corrigido: agora vem de histórico REAL dos últimos jogos de cada
      // time (ver flashliveService.js / flashscoreScraper.js), já vem com o
      // árbitro da partida quando disponível.
      const ceData = await fetchCartoeseEscanteios(
      jogo.mandante, jogo.visitante, jogo.ligaCode, jogo.dataJogo
      )

      // ✅ NOVO — estatísticas SAZONAIS do árbitro nesta liga específica
      // (pênaltis/jogo e % de vitória do mandante sob ele). Complementa a
      // média de cartões de carreira que já vem da FlashLive em ceData.arbitro.
      // Best-effort: só roda se já sabemos o nome do árbitro.
      let arbitroSazonal = null
      if (ceData?.arbitro?.nome) {
        try {
          arbitroSazonal = await buscarEstatisticasArbitro(jogo.ligaCode, ceData.arbitro.nome)
        } catch { /* não crítico — segue sem o dado sazonal */ }
      }
      const ceDataComArbitro = ceData ? { ...ceData, arbitroSazonal } : null

      // ✅ NOVO — clima previsto no estádio do mandante (cobertura limitada
      // aos principais clubes; retorna null com segurança fora do mapa)
      const climaData = await fetchClima(jogo.mandante, jogo.dataJogo)

      // ✅ NOVO — item 21/22: fadiga real, calculada em cima dos jogos crus
      // que já buscamos acima (dataMandante/dataVisitante) — sem chamada de
      // API extra. Só funciona quando `jogo.dataJogoISO` existe (jogos vindos
      // de etapa1_buscarJogos); pra fontes que ainda não passam essa data em
      // ISO (Série B/Sul-Americana via extraFetchers), cai em null com
      // segurança e o texto da IA volta a mostrar "sem dados", como hoje.
      const fadigaMandante  = calcularFadiga(dataMandante?.matches,  jogo.dataJogoISO, jogo.ligaCode)
      const fadigaVisitante = calcularFadiga(dataVisitante?.matches, jogo.dataJogoISO, jogo.ligaCode)

      // ✅ NOVO — item 22: uma chamada só de tabela por jogo (não por time).
      // Best-effort: mata-mata/seleções não têm tabela de pontos corridos,
      // então cai em null e o texto de motivação vira "sem dados", sem erro.
      const tabelaLiga        = await buscarContextoMotivacional(jogo.ligaCode)
      const motivacaoMandante  = extrairMotivacao(tabelaLiga, jogo.mandanteId)
      const motivacaoVisitante = extrairMotivacao(tabelaLiga, jogo.visitanteId)

      const jogoProcessado = {
      ...jogo,
      ultimos5_mandante:  processarJogos(top5MandanteFull,  jogo.mandanteId),
      ultimos5_visitante: processarJogos(top5VisitanteFull, jogo.visitanteId),
      // ✅ Correção: guarda os jogos "crus" (com homeTeam/awayTeam/score) para
      // o eloService conseguir alimentar o ELO na etapa 3. Antes esse campo
      // não existia e alimentarEloComHistorico() nunca atualizava nada.
      ultimos5_mandante_raw:  top5MandanteFull,
      ultimos5_visitante_raw: top5VisitanteFull,
      usou_localidade_mandante:  top5Mandante.length  >= 3,
      usou_localidade_visitante: top5Visitante.length >= 3,
      h2h,
      
      cartoes_escanteios: ceDataComArbitro,  // ✅ agora com dado real + árbitro (carreira + sazonal)
      clima: climaData,            // ✅ NOVO
      fadiga_mandante:  fadigaMandante,   // ✅ NOVO — item 21/22, antes sempre undefined
      fadiga_visitante: fadigaVisitante,  // ✅ NOVO
      motivacao_mandante:  motivacaoMandante,   // ✅ NOVO — item 22
      motivacao_visitante: motivacaoVisitante,  // ✅ NOVO
      
      }
      

      _cache.set(cacheKey2, jogoProcessado)
      resultado.push(jogoProcessado)

    // DEPOIS:
} catch (err) {
  console.warn(`Histórico falhou: ${jogo.mandante}`, err.message)
  // Para ligas de seleções, tenta buscar via selecaoService como fallback
  const ligasSelecao = ['WC', 'WCQ', 'CA', 'NL', 'EURO']
  if (ligasSelecao.includes(jogo.ligaCode) && jogo.mandanteId && jogo.visitanteId) {
    try {
      const { buscarHistoricoSelecao } = await import('./selecaoService.js')
      const [hist5M, hist5V] = await Promise.all([
        buscarHistoricoSelecao(jogo.mandanteId, 10),
        buscarHistoricoSelecao(jogo.visitanteId, 10),
      ])
      resultado.push({
        ...jogo,
        ultimos5_mandante:  hist5M.slice(0, 5).map(j => ({ resultado: j.resultado, golsMarcados: j.golsMarcados, golsSofridos: j.golsSofridos, totalGols: j.totalGols })),
        ultimos5_visitante: hist5V.slice(0, 5).map(j => ({ resultado: j.resultado, golsMarcados: j.golsMarcados, golsSofridos: j.golsSofridos, totalGols: j.totalGols })),
        usou_localidade_mandante: false,
        usou_localidade_visitante: false,
        h2h: { confrontos: [], totalJogos: 0, semDados: true },
        h2h_allsports: null,
        cartoes_escanteios: null,
        clima: null,
        _fonte_historico: 'selecaoService_fallback',
      })
      console.info(`[Etapa2] Fallback selecaoService: ${jogo.mandante}(${hist5M.length}) | ${jogo.visitante}(${hist5V.length})`)
    } catch (errSel) {
      console.warn('[Etapa2] Fallback selecaoService também falhou:', errSel.message)
      resultado.push({ ...jogo, ultimos5_mandante: [], ultimos5_visitante: [], h2h: { confrontos: [], totalJogos: 0, semDados: true }, h2h_allsports: null, cartoes_escanteios: null, clima: null })
    }
  } else {
    resultado.push({ ...jogo, ultimos5_mandante: [], ultimos5_visitante: [], h2h: { confrontos: [], totalJogos: 0, semDados: true }, h2h_allsports: null, cartoes_escanteios: null, clima: null })
  }
}
  }

  return resultado
}

// ═════════════════════════════════════════════════════════════
// NÚCLEO ATUARIAL — Poisson
// ═════════════════════════════════════════════════════════════
function poissonPMF(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0
  let logP = -lambda + k * Math.log(lambda)
  for (let i = 1; i <= k; i++) logP -= Math.log(i)
  return Math.exp(logP)
}

function poissonCDF(lambda, maxK) {
  let acc = 0
  for (let k = 0; k <= maxK; k++) acc += poissonPMF(lambda, k)
  return Math.min(acc, 1)
}

function calcPoissonBtts(lambdaM, lambdaV) {
  const pM = 1 - Math.exp(-lambdaM)
  const pV = 1 - Math.exp(-lambdaV)
  return Math.round(pM * pV * 100)
}
// ── Dixon-Coles: correção para placares baixos ─────────────
function dixonColesRho(lambdaM, lambdaV, ligaCode = null) {
  // ρ por liga; clamp de segurança
  const base = RHO_POR_LIGA[ligaCode] ?? RHO_POR_LIGA.DEFAULT
  // jogos com λ muito baixo tendem a mais empates 0-0 → ρ um pouco mais negativo
  const total = (Number(lambdaM) || 0) + (Number(lambdaV) || 0)
  const ajuste = total < 2.0 ? -0.02 : total > 3.2 ? 0.02 : 0
  return Math.max(-0.15, Math.min(-0.05, base + ajuste))
}

function dixonColesTau(x, y, lambdaM, lambdaV, rho) {
  if (x === 0 && y === 0) return 1 - lambdaM * lambdaV * rho
  if (x === 0 && y === 1) return 1 + lambdaM * rho
  if (x === 1 && y === 0) return 1 + lambdaV * rho
  if (x === 1 && y === 1) return 1 - rho
  return 1
}

function calcPoissonMatriz(lambdaM, lambdaV, maxGols = 8, ligaCode = null) {
  const rho  = dixonColesRho(lambdaM, lambdaV, ligaCode)
  const mat  = []
  let mass = 0
  for (let i = 0; i <= maxGols; i++) {
    mat[i] = []
    for (let j = 0; j <= maxGols; j++) {
      const p = poissonPMF(lambdaM, i) * poissonPMF(lambdaV, j)
      const adj = p * dixonColesTau(i, j, lambdaM, lambdaV, rho)
      mat[i][j] = Math.max(0, adj) // tau nunca deve gerar negativo
      mass += mat[i][j]
    }
  }
  // Renormaliza: Dixon-Coles + truncamento em maxGols distorcem a massa total
  if (mass > 0) {
    for (let i = 0; i <= maxGols; i++) {
      for (let j = 0; j <= maxGols; j++) mat[i][j] /= mass
    }
  }
  return mat
}

function calcMercadosViaMatriz(lambdaM, lambdaV, ligaCode = null) {
  // Proteção: lambdas absurdos quebram o modelo (ex.: 99% Over 1.5)
  const lm = Math.min(2.6, Math.max(0.30, Number(lambdaM) || 0.9))
  const lv = Math.min(2.6, Math.max(0.30, Number(lambdaV) || 0.9))

  const mat = calcPoissonMatriz(lm, lv, 8, ligaCode)
  const maxGols = mat.length - 1

  let over15 = 0, over25 = 0, over35 = 0
  let btts   = 0

  for (let i = 0; i <= maxGols; i++) {
    for (let j = 0; j <= maxGols; j++) {
      const p     = mat[i][j]
      const total = i + j
      if (total >= 2) over15 += p
      if (total >= 3) over25 += p
      if (total >= 4) over35 += p
      if (i > 0 && j > 0) btts += p
    }
  }

  // Arredonda e garante over+under = 100
  const o15 = Math.round(over15 * 100)
  const o25 = Math.round(over25 * 100)
  const o35 = Math.round(over35 * 100)
  const bt  = Math.round(btts   * 100)

  return {
    over15: o15, under15: 100 - o15,
    over25: o25, under25: 100 - o25,
    over35: o35, under35: 100 - o35,
    btts: bt,
  }
}

const CONF = {
  ALTA_PROB:  67, ALTA_GAP:   22,   // era 65/20 — mais exigente para "Alta"
  MEDIA_PROB: 56, MEDIA_GAP:  13,   // era 55/12 — um pouco mais exigente
  GAP_MINIMO: 13,                   // era 12
}

function classificarConfianca(prob, gap) {
  if (prob >= CONF.ALTA_PROB  && gap >= CONF.ALTA_GAP)  return 'Alta'
  if (prob >= CONF.MEDIA_PROB && gap >= CONF.MEDIA_GAP) return 'Média'
  if (prob > 50)                                         return 'Baixa'
  return 'Descartar'
}

function blendSafe(poisson, hist, wPoisson = 0.6) {
  if (hist == null || isNaN(hist)) return Math.round(poisson)
  return Math.round(poisson * wPoisson + hist * (1 - wPoisson))
}

/**
 * Intervalo de incerteza simples (regra empírica).
 * nJogos baixo → banda larga; modelo não deve gritar "Alta" com 3 jogos.
 */
function bandaIncerteza(prob, nJogosM, nJogosV) {
  const n = Math.min(nJogosM || 0, nJogosV || 0)
  // SE ≈ sqrt(p(1-p)/n) * 100, com n efetivo
  const p = Math.min(0.95, Math.max(0.05, (prob || 50) / 100))
  const nEff = Math.max(3, n)
  const se = Math.sqrt(p * (1 - p) / nEff) * 100
  const margem = Math.min(18, Math.max(4, se * 1.64)) // ~90% approx
  return {
    low:  Math.round(Math.max(1, prob - margem)),
    high: Math.round(Math.min(99, prob + margem)),
    margem: Math.round(margem),
    nEfetivo: nEff,
  }
}

/** Peso do Poisson no blend cai quando amostra é pequena */
function pesoPoissonPorAmostra(nM, nV) {
  const n = Math.min(nM || 0, nV || 0)
  if (n >= 8) return 0.58
  if (n >= 5) return 0.50
  if (n >= 3) return 0.42
  return 0.35 // quase só histórico / prior
}

function calcEstatisticasGols(historico, localidade = null, mediaLigaGols = 1.35, xgStats = null) {
  if (!historico.length) {
    return {
      mediaGolsMarcados: null, mediaGolsSofridos: null, mediaTotalGols: null,
      bttsRate: null,
      over15Rate: null, under15Rate: null,
      over25Rate: null, under25Rate: null,
      over35Rate: null, under35Rate: null,
      formaSimbolo: [], semDados: true,
      cv: null, perfil: null,
    }
  }

  const n = historico.length
  const pesoTotal     = historico.reduce((s, _, i) => s + (PESOS_TEMPORAIS[i] ?? 0.50), 0)
  const somaMarcados  = historico.reduce((s, j, i) => s + j.golsMarcados * (PESOS_TEMPORAIS[i] ?? 0.50), 0)
  const somaSofridos  = historico.reduce((s, j, i) => s + j.golsSofridos * (PESOS_TEMPORAIS[i] ?? 0.50), 0)
  const somaTotalGols = historico.reduce((s, j, i) => s + j.totalGols    * (PESOS_TEMPORAIS[i] ?? 0.50), 0)

  const bttsCount   = historico.filter(j => j.golsMarcados > 0 && j.golsSofridos > 0).length
  const over15Count = historico.filter(j => j.totalGols >= 2).length
  const over25Count = historico.filter(j => j.totalGols >= 3).length
  const over35Count = historico.filter(j => j.totalGols >= 4).length

  const rawMarcados = parseFloat((somaMarcados / pesoTotal).toFixed(2))
  const rawSofridos = parseFloat((somaSofridos / pesoTotal).toFixed(2))

  // ✅ NOVO — item 9: mistura com xG/xGA rolling (mesma lógica que já existe
  // em europaLeagueService.js/serieBService.js, peso 50/50 com os gols
  // reais). Só entra se tiver amostra mínima de 3 jogos com xG — senão fica
  // só no gol real mesmo, igual antes.
  let mMarcadosFinal = rawMarcados
  let mSofridosFinal = rawSofridos
  const usouXg = (xgStats?.amostrasXg ?? 0) >= 3 && xgStats?.mediaXgFeito != null && xgStats?.mediaXgSofrido != null
  if (usouXg) {
    mMarcadosFinal = parseFloat(((rawMarcados + xgStats.mediaXgFeito)   / 2).toFixed(2))
    mSofridosFinal = parseFloat(((rawSofridos + xgStats.mediaXgSofrido) / 2).toFixed(2))
  }

  // ── Coeficiente de variação (melhoria 2) ─────────────────
  const mediaMarcados = historico.reduce((s, j) => s + j.golsMarcados, 0) / n
  const variancia     = historico.reduce((s, j) => s + Math.pow(j.golsMarcados - mediaMarcados, 2), 0) / n
  const desvio        = Math.sqrt(variancia)
  const cv            = mediaMarcados > 0 ? parseFloat((desvio / mediaMarcados).toFixed(2)) : null

  // ── Tendência recente: últimos 3 vs histórico total ───────
  const ultimos3      = historico.slice(0, 3)
  const mediaRecente  = ultimos3.length
    ? parseFloat((ultimos3.reduce((s, j) => s + j.golsMarcados, 0) / ultimos3.length).toFixed(2))
    : rawMarcados
  const fatorTendencia = rawMarcados > 0
    ? parseFloat((mediaRecente / rawMarcados).toFixed(2))
    : 1.0

  // ── Perfil do time ────────────────────────────────────────
  const bttsRate   = Math.round((bttsCount   / n) * 100)
  const over25Rate = Math.round((over25Count / n) * 100)
  const over15Rate = Math.round((over15Count / n) * 100)
  const cleanSheet = historico.filter(j => j.golsSofridos === 0).length
  const cleanRate  = Math.round((cleanSheet / n) * 100)

  let perfil = 'neutro'
  if (over25Rate >= 70)  perfil = 'over_team'
  else if (over25Rate <= 30) perfil = 'under_team'
  else if (bttsRate >= 70)   perfil = 'btts_team'
  else if (cleanRate >= 50)  perfil = 'clean_sheet'

  // Tendência mais suave (evita λ explodir com 3 jogos loucos)
  const fatorTendenciaSuave = parseFloat(
    (1 + 0.5 * ((fatorTendencia || 1) - 1)).toFixed(3)
  )

  return {
    mediaGolsMarcados: rawMarcados,
    mediaGolsSofridos: rawSofridos,
    mediaGolsMarcadosAdj: aplicarShrinkage(mMarcadosFinal, mediaLigaGols, n, cv),
    mediaGolsSofridosAdj: aplicarShrinkage(mSofridosFinal, mediaLigaGols, n, cv),
    usouXg,             // ✅ NOVO — pra você conseguir ver na análise se o xG entrou ou não
    mediaTotalGols: parseFloat((somaTotalGols / pesoTotal).toFixed(2)),
    bttsRate,
    over15Rate,  under15Rate: Math.round(((n - over15Count) / n) * 100),
    over25Rate,  under25Rate: Math.round(((n - over25Count) / n) * 100),
    over35Rate:  Math.round((over35Count / n) * 100),
    under35Rate: Math.round(((n - over35Count) / n) * 100),
    formaSimbolo: historico.map(j => j.resultado),
    semDados: false,
    cv,
    fatorTendencia: fatorTendenciaSuave,
    fatorTendenciaBruto: fatorTendencia,
    mediaRecente,
    perfil,
    localidade,
    nJogos: n,
  }
}

function calcularProbabilidadesResultado(statsM, statsV, h2h = null, eloFatorM = 1.0, eloFatorV = 1.0, ligaCode = null, pesos1x2 = null) {
  // ── 1. Score de forma recente (igual ao original) ──────────
  const peso = [1.5, 1.3, 1.1, 1.0, 0.9]
  const pontuarForma = forma => {
    if (!forma.length) return 0.5
    let pts = 0, totalPeso = 0
    forma.slice(0, 5).forEach((r, i) => {
      const p = peso[i] || 0.9
      pts       += (r === 'V' ? 3 : r === 'E' ? 1 : 0) * p
      totalPeso += 3 * p
    })
    return pts / totalPeso
  }
 
  const formaM = statsM.semDados ? [] : statsM.formaSimbolo
  const formaV = statsV.semDados ? [] : statsV.formaSimbolo
  const scoreM = pontuarForma(formaM)
  const scoreV = pontuarForma(formaV)
 
  // ── 2. Fator casa dinâmico ─────────────────────────────────
  // Base pelo nível de ataque do mandante
  const mediaAtaqueM = statsM.mediaGolsMarcados ?? 1.2
  const CASA_BASE = mediaAtaqueM > 1.6 ? 0.16 : mediaAtaqueM > 1.2 ? 0.13 : 0.10
  // Multiplicador por competição (Libertadores mais forte, Champions mais fraco)
  const CASA = parseFloat((CASA_BASE * (CASA_POR_LIGA[ligaCode] ?? 1.0)).toFixed(4))
 
  // ── 3. Score base (forma + casa) ───────────────────────────
  const totalScore = scoreM + scoreV + 0.001
  const fM = (scoreM / totalScore) + CASA
  const fV = (scoreV / totalScore) - CASA * 0.5
  const equil  = 1 - Math.abs(scoreM - scoreV)
  const base_e = 0.22 + equil * 0.08
  const restante = 1 - base_e
  const tF = fM + fV + 0.001
 
  let pm_forma = (fM / tF) * restante
  let pv_forma = (fV / tF) * restante
 
  // ── 4. Fator H2H recente ───────────────────────────────────
  // Se há H2H com pelo menos 3 jogos, inclui no blend com peso 20%
  let h2hFatorM = 0.5, h2hFatorV = 0.5
  let temH2HValido = false
 
  if (h2h && !h2h.semDados && h2h.totalJogos >= 3) {
    temH2HValido = true
    const totalH2H = h2h.totalJogos
    // Normaliza para probabilidades (0 a 1)
    h2hFatorM = h2h.vitoriasMandante / totalH2H
    h2hFatorV = h2h.vitoriasVisitante / totalH2H
    // Se PSG venceu os últimos 2, os recentes têm mais peso
    if (h2h.confrontos && h2h.confrontos.length >= 2) {
      const ultimos2 = h2h.confrontos.slice(0, 2)
      const vitoriasMrecentes = ultimos2.filter(c => c.resultado === 'M').length
      const vitoriasVrecentes = ultimos2.filter(c => c.resultado === 'V').length
      // Bônus por vencer os 2 mais recentes
      if (vitoriasMrecentes === 2) h2hFatorM += 0.10
      if (vitoriasVrecentes === 2) h2hFatorV += 0.10
    }
  }
 
  // ── 5. Fator ELO ──────────────────────────────────────────
  // eloFatorM/V vêm de fatorAdversario() — já é ratio de força
  // Limites vêm de ELO_LIMITES_1X2 (eloService.js) — fonte única
  const eloM = limitarFatorElo(eloFatorM, ELO_LIMITES_1X2)
  const eloV = limitarFatorElo(eloFatorV, ELO_LIMITES_1X2)
  const eloNormTotal = eloM + eloV + 0.001
  const eloFracM = eloM / eloNormTotal
  const eloFracV = eloV / eloNormTotal
 
  // ── 6. Blend final: Forma 55% + H2H 20% + ELO 25% ─────────
  // (sem H2H: Forma 65% + ELO 35%)
  let fracM, fracV
  if (temH2HValido) {
    const h2hNormTotal = h2hFatorM + h2hFatorV + 0.001
    const h2hFracM = h2hFatorM / h2hNormTotal
    const h2hFracV = h2hFatorV / h2hNormTotal
 
    fracM = pm_forma * 0.55 + h2hFracM * 0.20 + eloFracM * 0.25
    fracV = pv_forma * 0.55 + h2hFracV * 0.20 + eloFracV * 0.25
  } else {
    fracM = pm_forma * 0.65 + eloFracM * 0.35
    fracV = pv_forma * 0.65 + eloFracV * 0.35
  }

    // ✅ NOVO — stacking do 1X2: probabilidade 3-vias de CADA sub-modelo isolado
  // (mesma transformação do passo 7). Serve pra (a) gravar no tracker e
  // (b) misturar com os pesos aprendidos no walk-forward.
  const tresVias = (fM, fV) => {
    const pe_s = Math.max(0.20, Math.min(0.32, base_e - Math.abs(fM - fV) * 0.15))
    const tot  = fM + fV + pe_s
    return { m: (fM / tot) * 100, e: (pe_s / tot) * 100, v: (fV / tot) * 100 }
  }
  const h2hTot   = h2hFatorM + h2hFatorV + 0.001
  const subForma = tresVias(pm_forma, pv_forma)
  const subElo   = tresVias(eloFracM, eloFracV)
  const subH2H   = temH2HValido ? tresVias(h2hFatorM / h2hTot, h2hFatorV / h2hTot) : null
  const arred1   = v => Math.round(v * 10) / 10
  const subModelos1x2 = {
    mandante:  { forma: arred1(subForma.m), h2h: subH2H ? arred1(subH2H.m) : null, elo: arred1(subElo.m) },
    visitante: { forma: arred1(subForma.v), h2h: subH2H ? arred1(subH2H.v) : null, elo: arred1(subElo.v) },
  }

 
  // ── 7. Recalcula empate e normaliza ────────────────────────
  // Empate varia entre 0.20 e 0.32 dependendo do equilíbrio
  const diferencaForca = Math.abs(fracM - fracV)
  const pe_ajustado = Math.max(0.20, Math.min(0.32, base_e - diferencaForca * 0.15))
 
  // Renormaliza para somar 100%
  const totalFrac = fracM + fracV + pe_ajustado
  let pm = Math.round((fracM / totalFrac) * 100)
  let pe = Math.round((pe_ajustado / totalFrac) * 100)
  let pv = Math.round((fracV / totalFrac) * 100)
 
  // Garante soma = 100
  pm += 100 - (pm + pe + pv)

  // ✅ NOVO — se o stacking já aprendeu pesos confiáveis (bateu o heurístico no
  // walk-forward), mistura os 3 sub-modelos com eles em vez do blend fixo
  // 55/20/25. Sem H2H válido, forma/elo são renormalizados. Sem pesos → nada muda.
  let pesoUsado1x2 = null
  if (pesos1x2) {
    let wF = pesos1x2.forma, wH = temH2HValido ? pesos1x2.h2h : 0, wE = pesos1x2.elo
    const somaW = wF + wH + wE
    if (somaW > 0) {
      wF /= somaW; wH /= somaW; wE /= somaW
      const mix = k => wF * subForma[k] + wH * (subH2H ? subH2H[k] : 0) + wE * subElo[k]
      pm = Math.round(mix('m')); pe = Math.round(mix('e')); pv = Math.round(mix('v'))
      pm += 100 - (pm + pe + pv)
      pesoUsado1x2 = { forma: +wF.toFixed(2), h2h: +wH.toFixed(2), elo: +wE.toFixed(2) }
    }
  }
 
  let mercadoResultado = 'Empate'
  if (pm > pe && pm > pv)      mercadoResultado = 'Vitória Mandante'
  else if (pv > pe && pv > pm) mercadoResultado = 'Vitória Visitante'
 
  const dominio   = Math.max(pm, pv) - Math.min(pm, pv)
  // Confiança mais exigente: precisa de gap maior para "Alta"
  const confianca = dominio > 20 ? 'Alta' : dominio > 10 ? 'Média' : 'Baixa'
 
  return { pm, pe, pv, mercadoResultado, confianca, subModelos1x2, pesoUsado1x2 }
}

export function calcMercadoGols(statsM, statsV, h2h, fatorQualM = 1, fatorQualV = 1, ligaCode = null, pesosStacking = null, homeAdvantage = null, clima = null) {
  if (statsM.semDados || statsV.semDados) {
    return {
      mercadoGols: 'Dados insuficientes', mercadoGolsLimpo: 'Dados insuficientes',
      mediaEsperada: null, lambdaM: null, lambdaV: null, confiancaGols: 'Baixa',
      over15: 50, under15: 50, over25: 50, under25: 50, over35: 50, under35: 50, btts: 50,
      descricaoMercado: 'Sem histórico suficiente para análise de gols.', rankingMercados: [],
      incerteza: null, qualidadeDados: 'insuficiente',
    }
  }

  const mM = statsM.mediaGolsMarcadosAdj ?? statsM.mediaGolsMarcados
  const sV = statsV.mediaGolsSofridosAdj ?? statsV.mediaGolsSofridos
  const mV = statsV.mediaGolsMarcadosAdj ?? statsV.mediaGolsMarcados
  const sM = statsM.mediaGolsSofridosAdj ?? statsM.mediaGolsSofridos

  // Fator de qualidade ELO limitado (não pode dominar o modelo)
  // Limites vêm de ELO_LIMITES_GOLS (eloService.js) — fonte única
  const fqM = limitarFatorElo(fatorQualM, ELO_LIMITES_GOLS)
  const fqV = limitarFatorElo(fatorQualV, ELO_LIMITES_GOLS)

  // λ base: 55% ataque próprio + 45% defesa adversária (equilíbrio clássico)
  const lambdaM_poisson = parseFloat(((mM * 0.55) + (sV * 0.45)).toFixed(3)) * fqM
  const lambdaV_poisson = parseFloat(((mV * 0.55) + (sM * 0.45)).toFixed(3)) * fqV

  // Tendência já vem suavizada de calcEstatisticasGols
  const ftM = statsM.fatorTendencia ?? 1.0
  const ftV = statsV.fatorTendencia ?? 1.0
  const ajusteM = Math.min(1.10, Math.max(0.90, ftM))
  const ajusteV = Math.min(1.10, Math.max(0.90, ftV))
  const lambdaM_poisson_adj = parseFloat((lambdaM_poisson * ajusteM).toFixed(3))
  const lambdaV_poisson_adj = parseFloat((lambdaV_poisson * ajusteV).toFixed(3))

  // ✅ Ajuste por perfil (bonus menor)
  let perfilBonus = 0
  if (statsM.perfil === 'over_team'   && statsV.perfil === 'over_team')   perfilBonus =  0.06
  if (statsM.perfil === 'under_team'  && statsV.perfil === 'under_team')  perfilBonus = -0.06
  if (statsM.perfil === 'clean_sheet' || statsV.perfil === 'clean_sheet') perfilBonus -= 0.04

  let lambdaM_poisson_final = parseFloat((lambdaM_poisson_adj + perfilBonus * 0.5).toFixed(3))
  let lambdaV_poisson_final = parseFloat((lambdaV_poisson_adj + perfilBonus * 0.5).toFixed(3))
  // Teto por time: futebol real raramente passa de ~2.2 gols esperados por lado
  lambdaM_poisson_final = Math.min(2.40, Math.max(0.30, lambdaM_poisson_final))
  lambdaV_poisson_final = Math.min(2.40, Math.max(0.30, lambdaV_poisson_final))

  // ✅ NOVO — Fase 7: home advantage calibrado por liga. Só entra quando o
  // caller sinalizou que NENHUM lado tem estatística filtrada por
  // localidade (homeAdvantage.aplicar) — do contrário o mando de campo já
  // está implícito nos dados reais de jogos em casa/fora usados acima, e
  // aplicar de novo aqui distorceria pra cima. Blend de 50% com o que o
  // Poisson já calculou, pra corrigir na direção certa sem substituir o
  // cálculo por completo.
  if (homeAdvantage?.aplicar && homeAdvantage.razao) {
    const total = lambdaM_poisson_final + lambdaV_poisson_final
    const proporcaoAlvo  = homeAdvantage.razao / (homeAdvantage.razao + 1)
    const proporcaoAtual = total > 0 ? lambdaM_poisson_final / total : 0.5
    const proporcaoFinal = proporcaoAtual * 0.5 + proporcaoAlvo * 0.5
    lambdaM_poisson_final = parseFloat((total * proporcaoFinal).toFixed(3))
    lambdaV_poisson_final = parseFloat((total * (1 - proporcaoFinal)).toFixed(3))
  }

  // ✅ lambda_poisson agora usa _final (definidos acima)
  const lambda_poisson = lambdaM_poisson_final + lambdaV_poisson_final
  const lambda_hist    = parseFloat(((statsM.mediaTotalGols + statsV.mediaTotalGols) / 2).toFixed(2))

  const temH2H     = h2h && !h2h.semDados && h2h.totalJogos >= 3
  const lambda_h2h = temH2H ? h2h.mediaGolsTotais : null

  // H2H só entra com peso se tiver amostra mínima decente
  const h2hConfiavel = temH2H && h2h.totalJogos >= 4
  let lambda
  if (h2hConfiavel) {
    lambda = parseFloat((lambda_poisson * 0.55 + lambda_hist * 0.30 + lambda_h2h * 0.15).toFixed(2))
  } else {
    lambda = parseFloat((lambda_poisson * 0.62 + lambda_hist * 0.38).toFixed(2))
  }
  // Clamp λ total realista
  lambda = Math.min(3.40, Math.max(1.50, lambda))

  // ✅ FIX — item 12: clima já entrava em Cartões/Escanteios (mesmos limiares
  // abaixo: chuva ≥60%, vento ≥30km/h) mas nunca em Gols. Efeito pequeno e
  // conservador de propósito — são pontos de partida, ajuste com o Tracker.
  let fatorClima = 1.0
  if (clima?.probabilidadeChuva != null && clima.probabilidadeChuva >= 60) fatorClima *= 0.94
  if (clima?.ventoKmh != null && clima.ventoKmh >= 30) fatorClima *= 0.96
  if (clima?.temperaturaC != null && clima.temperaturaC <= 5) fatorClima *= 0.98
  lambda = parseFloat((lambda * fatorClima).toFixed(2))
  lambda = Math.min(3.40, Math.max(1.50, lambda))

  const ratio   = lambda_poisson > 0 ? lambda / lambda_poisson : 1
  let lambdaM = parseFloat((lambdaM_poisson_final * ratio).toFixed(3))
  let lambdaV = parseFloat((lambdaV_poisson_final * ratio).toFixed(3))
  lambdaM = Math.min(2.30, Math.max(0.35, lambdaM))
  lambdaV = Math.min(2.30, Math.max(0.35, lambdaV))

  const dc = calcMercadosViaMatriz(lambdaM, lambdaV, ligaCode)

  const poissonOver15 = dc.over15
  const poissonOver25 = dc.over25
  const poissonOver35 = dc.over35
  const poissonBtts   = dc.btts

  const histBtts    = Math.round((statsM.bttsRate   + statsV.bttsRate)   / 2)
  const histOver15  = Math.round((statsM.over15Rate + statsV.over15Rate) / 2)
  const histOver25  = Math.round((statsM.over25Rate  + statsV.over25Rate) / 2)
  const histUnder25 = Math.round((statsM.under25Rate + statsV.under25Rate) / 2)
  const histOver35  = Math.round((statsM.over35Rate  + statsV.over35Rate) / 2)

  const nM = statsM.nJogos || 0
  const nV = statsV.nJogos || 0
  const wP = pesoPoissonPorAmostra(nM, nV)

  // ✅ NOVO (item 40): pesos aprendidos por stacking (walk-forward Log Loss),
  // um por mercado — cada um cai no heurístico wP de sempre se ainda não
  // houver amostra suficiente/confiável pra esse mercado específico.
  const wPoissonOver15 = pesosStacking?.['Gols:Over 1.5'] ?? Math.min(wP, 0.48)
  const wPoissonOver25 = pesosStacking?.['Gols:Over 2.5'] ?? wP
  const wPoissonOver35 = pesosStacking?.['Gols:Over 3.5'] ?? wP
  const wPoissonBtts   = pesosStacking?.['BTTS'] ?? wP

  // BTTS
  let probBtts
  if (h2hConfiavel) {
    probBtts = Math.round(poissonBtts * (wPoissonBtts * 0.85) + histBtts * 0.30 + (h2h.bttsRateH2H ?? histBtts) * 0.15)
  } else {
    probBtts = blendSafe(poissonBtts, histBtts, wPoissonBtts)
  }
  probBtts = Math.min(78, Math.max(22, probBtts))

  // Over 2.5
  let probOver25_final = blendSafe(poissonOver25, histOver25, wPoissonOver25)
  if (h2hConfiavel && h2h.over25RateH2H != null) {
    const pesoH2H = h2h.totalJogos >= 6 ? 0.18 : 0.12
    probOver25_final = Math.round(probOver25_final * (1 - pesoH2H) + h2h.over25RateH2H * pesoH2H)
  }
  probOver25_final = Math.min(78, Math.max(22, probOver25_final))

  // Over 1.5 — teto depende do λ (com λ=2.75 não pode sair 92%)
  let probOver15_final = blendSafe(poissonOver15, histOver15 ?? 72, wPoissonOver15)
  if (h2hConfiavel && h2h.over15RateH2H != null) {
    const pesoH2H15 = h2h.totalJogos >= 6 ? 0.12 : 0.08
    probOver15_final = Math.round(probOver15_final * (1 - pesoH2H15) + h2h.over15RateH2H * pesoH2H15)
  }
  // Teto empírico: P(O1.5) ≈ 1 - e^{-λ}*(1+λ) → com margem; clamp duro por λ
  const tetoO15 = lambda <= 2.2 ? 72 : lambda <= 2.6 ? 78 : lambda <= 3.0 ? 82 : lambda <= 3.4 ? 85 : 86
  probOver15_final = Math.min(tetoO15, Math.max(50, probOver15_final))

  // Over 3.5
  let probOver35_final = blendSafe(poissonOver35, histOver35, wPoissonOver35)
  // ✅ NOVO — H2H entrando no Over 3.5, que antes era a ÚNICA linha de gols
  // sem ajuste de confronto direto (Over 1.5, Over 2.5 e BTTS já tinham).
  // Era por isso que um H2H recheado de jogos +3.5 não mexia nada no
  // Under 3.5 — ele saía direto do Poisson e ainda batia no teto abaixo.
  // Peso um pouco maior que o do Over 2.5: justamente porque essa linha
  // depende muito do estilo do confronto, não só da força dos times.
  let h2hPuxouOver35 = false
  if (h2hConfiavel && h2h.over35RateH2H != null) {
    const pesoH2H35 = h2h.totalJogos >= 6 ? 0.22 : 0.15
    const antes = probOver35_final
    probOver35_final = Math.round(probOver35_final * (1 - pesoH2H35) + h2h.over35RateH2H * pesoH2H35)
    h2hPuxouOver35 = probOver35_final > antes
  }
  // Piso/teto coerentes com λ
  let tetoO35 = lambda <= 2.2 ? 22 : lambda <= 2.6 ? 28 : lambda <= 3.0 ? 35 : 42
  // ✅ NOVO — se o H2H mostra um confronto claramente goleador (metade ou
  // mais dos jogos com +3.5), o teto ganha folga. Sem isso, o clamp
  // anulava o ajuste de H2H que acabou de ser aplicado logo acima — o
  // modelo "ouvia" o H2H e jogava fora no passo seguinte.
  if (h2hConfiavel && (h2h.over35RateH2H ?? 0) >= 50) {
    tetoO35 = Math.min(50, tetoO35 + 10)
  }
  const pisoO35 = lambda >= 3.2 ? 22 : 10
  probOver35_final = Math.min(tetoO35, Math.max(pisoO35, probOver35_final))

  // SEMPRE espelho — over + under = 100
  const probOver35 = probOver35_final
  const probUnder35 = 100 - probOver35_final
  const probUnder15 = 100 - probOver15_final

  // Qualidade dos dados e incerteza do mercado principal (Over 2.5)
  const qualidadeDados = (nM >= 6 && nV >= 6) ? 'boa' : (nM >= 3 && nV >= 3) ? 'média' : 'baixa'
  const incertezaOver25 = bandaIncerteza(probOver25_final, nM, nV)

  // Ranking: prioriza mercados com valor de apostas (zona 52–78%),
  // evita eleger Over 1.5 só porque chega a 85%+ (odd ~1.15, pouco edge).
  const mercados = [
    { nome: 'Over 1.5 Gols',  prob: probOver15_final,     oposto: 100-probOver15_final,  threshold: 1.5, direcao: 'over',  emoji: '⬆️', pesoUtil: 0.40 },
    { nome: 'Under 1.5 Gols', prob: 100-probOver15_final, oposto: probOver15_final,       threshold: 1.5, direcao: 'under', emoji: '⬇️', pesoUtil: 0.75 },
    { nome: 'Over 2.5 Gols',  prob: probOver25_final,     oposto: 100-probOver25_final,   threshold: 2.5, direcao: 'over',  emoji: '⬆️', pesoUtil: 1.00 },
    { nome: 'Under 2.5 Gols', prob: 100-probOver25_final, oposto: probOver25_final,       threshold: 2.5, direcao: 'under', emoji: '⬇️', pesoUtil: 1.00 },
    { nome: 'Over 3.5 Gols',  prob: probOver35,           oposto: probUnder35,            threshold: 3.5, direcao: 'over',  emoji: '⬆️', pesoUtil: 0.95 },
    { nome: 'Under 3.5 Gols', prob: probUnder35,          oposto: probOver35,             threshold: 3.5, direcao: 'under', emoji: '⬇️', pesoUtil: 0.50 },
  ].map(m => {
    const gap = m.prob - m.oposto
    let fatorZona = 1.0
    if (m.prob >= 80) fatorZona = 0.25
    else if (m.prob >= 72) fatorZona = 0.45
    else if (m.prob >= 52) fatorZona = 1.0
    else fatorZona = 0.55
    let confianca = classificarConfianca(m.prob, gap)
    // ✅ NOVO — rebaixamento por CONTRADIÇÃO DO H2H. Antes, o rótulo de
    // confiança olhava só a probabilidade e o gap: dava pra marcar
    // "Under 3.5 — Alta" num confronto cujos últimos jogos diretos saíram
    // todos +3.5. Agora, se o histórico do confronto aponta para o lado
    // oposto do mercado, a confiança cai um degrau.
    let h2hContradiz = false
    if (h2hConfiavel) {
      const taxaH2H = m.threshold === 1.5 ? h2h.over15RateH2H
        : m.threshold === 2.5 ? h2h.over25RateH2H
        : m.threshold === 3.5 ? h2h.over35RateH2H
        : null
      if (taxaH2H != null) {
        // taxaH2H é sempre a taxa de OVER. Para um mercado under, o H2H
        // "concorda" quando a taxa de over é baixa.
        const taxaNaDirecao = m.direcao === 'over' ? taxaH2H : 100 - taxaH2H
        // Contradiz quando o confronto direto aponta para o lado contrário
        // com folga (≥55% na direção oposta ao mercado escolhido).
        h2hContradiz = taxaNaDirecao <= 45
      }
    }
    if (h2hContradiz && confianca === 'Alta') confianca = 'Média'
    else if (h2hContradiz && confianca === 'Média') confianca = 'Baixa'
    // Mesmo rebaixamento por qualidade de dados/incerteza aplicado ao
    // "melhor mercado" (mais abaixo), agora consistente em TODO o ranking —
    // evita um mercado #1 aparecer com confiança menor que o #2.
    if (qualidadeDados === 'baixa' && confianca === 'Alta') confianca = 'Média'
    else if (qualidadeDados === 'baixa' && confianca === 'Média') confianca = 'Baixa'
    if (incertezaOver25.margem >= 12 && confianca === 'Alta') confianca = 'Média'
    return {
      ...m,
      gap,
      edge: m.prob - 50,
      confianca,
      h2hContradiz,
      scoreUtil: gap * m.pesoUtil * fatorZona,
    }
  })

  const rankingMercados = mercados
    .filter(m => m.prob > 50)
    .sort((a, b) => b.prob !== a.prob ? b.prob - a.prob : b.scoreUtil - a.scoreUtil)

  // ✅ NOVO — melhor entrada separada por direção (Over / Under), usada
  // também por Série B e Sudamericana (que não passam pela calibração)
  const melhorOverGols  = rankingMercados.find(m => m.direcao === 'over')  || null
  const melhorUnderGols = rankingMercados.find(m => m.direcao === 'under') || null

  let melhor = rankingMercados.find(m => m.gap >= CONF.GAP_MINIMO) || null

  let mercadoGols, mercadoGolsLimpo, descricaoMercado, confiancaGols
  if (!melhor) {
    mercadoGols = '⚖️ Mercado sem borda clara'; mercadoGolsLimpo = 'Mercado sem borda clara'
    confiancaGols = 'Baixa'
    descricaoMercado = `Com λ=${Number(lambda).toFixed(2)} gols esperados${temH2H ? ` (H2H: ${lambda_h2h})` : ''}, nenhum mercado atingiu a probabilidade mínima de entrada.`
  } else {
    mercadoGolsLimpo = melhor.nome
    mercadoGols      = `${melhor.emoji} ${melhor.nome}`
    confiancaGols    = melhor.confianca
    const ctx = []
    if (temH2H) ctx.push(`H2H confirma: ${h2h.over25RateH2H}% de Over 2.5 nos últimos ${h2h.totalJogos} confrontos`)
    if (melhor.direcao === 'over'  && melhor.threshold === 1.5) ctx.push(`apenas ${probUnder15}% de chance de acabar 0×0 ou 1×0`)
    if (melhor.direcao === 'over'  && melhor.threshold === 2.5) ctx.push(`λ=${Number(lambda).toFixed(2)} gols esperados · histórico Over 2.5 de ${histOver25}%`)
    if (melhor.direcao === 'under' && melhor.threshold === 2.5) ctx.push(`jogo fechado — λ=${Number(lambda).toFixed(2)} · histórico Under 2.5 de ${histUnder25}%`)
    if (melhor.direcao === 'over'  && melhor.threshold === 3.5) ctx.push(`jogo muito aberto — λ=${Number(lambda).toFixed(2)} · histórico Over 3.5 de ${histOver35}%`)
    if (probBtts >= 60) ctx.push(`ambos marcam em ${probBtts}% dos jogos recentes`)
    descricaoMercado = `Melhor mercado: ${melhor.nome} · ${melhor.prob}% de probabilidade · confiança ${melhor.confianca}. ${ctx.join(' · ')}.`
  }

  // Rebaixa confiança se dados fracos
  if (qualidadeDados === 'baixa' && confiancaGols === 'Alta') confiancaGols = 'Média'
  else if (qualidadeDados === 'baixa' && confiancaGols === 'Média') confiancaGols = 'Baixa'
  if (incertezaOver25.margem >= 12 && confiancaGols === 'Alta') confiancaGols = 'Média'

  return {
    mercadoGols, mercadoGolsLimpo, mediaEsperada: lambda,
    lambdaPoisson: lambda_poisson, lambdaH2H: lambda_h2h,
    lambdaM, lambdaV, confiancaGols,
    over15: probOver15_final, under15: probUnder15,
    over25: probOver25_final, under25: 100-probOver25_final,
    // ✅ NOVO — item 36: componentes brutos do Over 2.5, pra alimentar o
    // stacking (calibrationService.calcPesoStackingGols) com dado real.
    over25_subModelos: { poisson: poissonOver25, hist: histOver25, pesoUsado: wPoissonOver25 },
    // ✅ NOVO — item 40: mesmo padrão do Over 2.5, agora pros outros 3 mercados
    over15_subModelos: { poisson: poissonOver15, hist: histOver15 ?? 72, pesoUsado: wPoissonOver15 },
    over35_subModelos: { poisson: poissonOver35, hist: histOver35, pesoUsado: wPoissonOver35 },
    btts_subModelos:   { poisson: poissonBtts,   hist: histBtts,   pesoUsado: wPoissonBtts },
    over35: probOver35, under35: probUnder35,
    btts: probBtts, descricaoMercado,
    rankingMercados: rankingMercados.map(m => ({
      nome: m.nome, prob: m.prob, gap: m.gap, confianca: m.confianca, scoreUtil: m.scoreUtil,
    })),
    temH2HNoCalculo: h2hConfiavel,
    qualidadeDados,
    incerteza: incertezaOver25,
    nJogosUsados: { mandante: nM, visitante: nV },
    melhorOverGols,
    melhorUnderGols,
  }
}

export function calcScoreComposto(jogo) {
  let score = 0

  const dominio = Math.max(jogo.prob_mandante, jogo.prob_visitante) - jogo.prob_empate
  score += Math.max(0, Math.min(25, (dominio / 35) * 25))

  const melhorGap = jogo.ranking_mercados?.[0]?.gap ?? 0
  score += Math.min(30, (melhorGap / 30) * 30)

  const confMap = { 'Alta': 1, 'Média': 0.5, 'Baixa': 0.15, 'Descartar': 0 }
  score += (confMap[jogo.confianca_gols] ?? 0) * 20

  const temHistM = (jogo.ultimos5_mandante?.length  ?? 0) >= 3 ? 1 : 0.4
  const temHistV = (jogo.ultimos5_visitante?.length ?? 0) >= 3 ? 1 : 0.4
  score += ((temHistM + temHistV) / 2) * 15

  const h2h = jogo.h2h
  if (h2h && !h2h.semDados && h2h.totalJogos >= 3 && jogo.temH2HNoCalculo) {
    const melhorMercado = jogo.ranking_mercados?.[0]
    if (melhorMercado) {
      const over25H2H = h2h.over25RateH2H ?? 50
      if (melhorMercado.direcao === 'over' && melhorMercado.threshold <= 2.5 && over25H2H >= 60)
        score += 10
      else if (melhorMercado.direcao === 'under' && melhorMercado.threshold >= 2.5 && over25H2H <= 40)
        score += 10
      else
        score += 5
    } else {
      score += 4
    }
  }

  const melhorEV = jogo.odds_mercado?.melhorEV?.ev ?? null
  if (melhorEV !== null && melhorEV > 0) {
    score += Math.min(10, melhorEV * 50)
  }

  // ── Bônus por alinhamento H2H + modelo (NOVO) ────────────
  const h2hJogo = jogo.h2h
  if (h2hJogo && !h2hJogo.semDados && h2hJogo.totalJogos >= 3) {
    const probModeloVencedor = Math.max(jogo.prob_mandante, jogo.prob_visitante)
    const ehMandante = jogo.prob_mandante >= jogo.prob_visitante
    const probH2H = ehMandante
      ? (h2hJogo.probMH2H ?? 50)
      : (h2hJogo.probVH2H ?? 50)
 
    // Se modelo e H2H concordam no favorito: bônus de alinhamento
    if (probH2H >= 50 && probModeloVencedor >= 50) {
      score += Math.min(8, (probH2H - 50) * 0.16)  // até +8 pts
    }
    // Se discordam: penaliza levemente (sinal de incerteza)
    if (probH2H < 40 && probModeloVencedor > 55) {
      score -= 4
    }
  }
 
  // ── Bônus por domínio claro de resultado ─────────────────
  const dominioResultado = Math.max(jogo.prob_mandante, jogo.prob_visitante) - jogo.prob_empate
  if (dominioResultado > 25) score += 5   // favorito muito claro
  if (dominioResultado < 5)  score -= 5   // jogo muito equilibrado
  // ── Penalidade por inconsistência (CV alto = menos confiança) ──
const cvM = jogo.stats_mandante?.cv ?? null
const cvV = jogo.stats_visitante?.cv ?? null
if (cvM !== null && cvV !== null) {
  const cvMedio = (cvM + cvV) / 2
  // CV > 1.0 = muito instável, penaliza até -8 pts
  const penalidade = Math.min(8, Math.max(0, (cvMedio - 0.5) * 10))
  score -= penalidade
}

// ── Bônus por tendência recente favorável ─────────────────
const ftM = jogo.stats_mandante?.fatorTendencia ?? 1
const ftV = jogo.stats_visitante?.fatorTendencia ?? 1
if (ftM > 1.25 || ftV > 1.25) score += 3   // time em alta
if (ftM < 0.75 || ftV < 0.75) score -= 3   // time em queda

  return {
    score:     Math.round(Math.min(100, Math.max(0, score))),
    breakdown: {
      dominio:  Math.round(Math.max(0, Math.min(25, (dominio / 35) * 25))),
      gapGols:  Math.round(Math.min(30, (melhorGap / 30) * 30)),
      confGols: Math.round((confMap[jogo.confianca_gols] ?? 0) * 20),
      histQual: Math.round(((temHistM + temHistV) / 2) * 15),
      ev:       melhorEV !== null && melhorEV > 0 ? Math.round(Math.min(10, melhorEV * 50)) : 0,
    }
  }
}

// ═════════════════════════════════════════════════════════════
// ETAPA 3 — Calcula probabilidades
// ═════════════════════════════════════════════════════════════
export async function etapa3_calcularProbabilidades(apiKey, jogos) {
  const analisados = []
  // ✅ Mesmo limite de 3 jogos da etapa2 (antes estava inconsistente: 6 aqui vs 4 na etapa2)
  const jogosParaProcessar = jogos.slice(0, 3)
 
  for (const jogo of jogosParaProcessar) {
 
    // ✅ NOVO: busca média real da liga (cai no fallback se < 30 jogos)
    const mediaLiga = await getMediaLiga(jogo.ligaCode)
    // ✅ NOVO — Fase 7: home advantage calibrado por liga
    const homeAdvantage = await getHomeAdvantage(jogo.ligaCode)
 
    // ✅ MUDANÇA: passa mediaLiga.marcados como 3º parâmetro
    const statsM = calcEstatisticasGols(
      jogo.ultimos5_mandante,
      jogo.usou_localidade_mandante ? 'home' : null,
      mediaLiga.marcados,   // era implícito 1.35
      jogo.cartoes_escanteios?.mandante  // ✅ NOVO — item 9: xG/xGA rolling já vem junto do cartões/escanteios
    )
    const statsV = calcEstatisticasGols(
      jogo.ultimos5_visitante,
      jogo.usou_localidade_visitante ? 'away' : null,
      mediaLiga.marcados,   // era implícito 1.35
      jogo.cartoes_escanteios?.visitante  // ✅ NOVO — item 9
    )

    // ✅ NOVO — item 3/24: desfalque agora pesa no NÚMERO, não só no texto da
    // IA — e só quando a escalação já está confiável (oficial ou dentro da
    // janela pré-jogo/item 10), pra não reagir a lineup vazada que ainda
    // pode mudar. Essa chamada fica em cache (mesma chave que gerarAnaliseIA
    // usa mais adiante), então não dobra o custo de API.
    try {
      const ausentesJogo = await buscarEscalacaoEAusentes(jogo.mandante, jogo.visitante, jogo.dataJogoISO || jogo.dataJogo)
      const confiavel = ausentesJogo?.confiancaEscalacao === 'oficial' || ausentesJogo?.confiancaEscalacao === 'provavel_oficial'
      if (confiavel && ausentesJogo?.ausentes) {
        if (!statsM.semDados) {
          const impactoM = calcularImpactoDesfalques(ausentesJogo.ausentes.mandante)
          statsM.mediaGolsMarcadosAdj = parseFloat((statsM.mediaGolsMarcadosAdj * impactoM.fatorAtaque).toFixed(2))
          statsM.mediaGolsSofridosAdj = parseFloat((statsM.mediaGolsSofridosAdj * impactoM.fatorDefesa).toFixed(2))
          statsM.impactoDesfalques = impactoM  // ✅ rastreável, se quiser exibir depois
        }
        if (!statsV.semDados) {
          const impactoV = calcularImpactoDesfalques(ausentesJogo.ausentes.visitante)
          statsV.mediaGolsMarcadosAdj = parseFloat((statsV.mediaGolsMarcadosAdj * impactoV.fatorAtaque).toFixed(2))
          statsV.mediaGolsSofridosAdj = parseFloat((statsV.mediaGolsSofridosAdj * impactoV.fatorDefesa).toFixed(2))
          statsV.impactoDesfalques = impactoV
        }
      }
    } catch { /* segue sem ajuste por desfalque, mesma regra defensiva do resto do arquivo */ }
 
    // ✅ TROCA 1: await adicionado
    await alimentarEloComHistorico([jogo])
 
    // ✅ TROCA 2: Promise.all para rodar em paralelo
    const [fatorQualM, fatorQualV] = await Promise.all([
      fatorAdversario(jogo.mandanteId, jogo.visitanteId),
      fatorAdversario(jogo.visitanteId, jogo.mandanteId),
    ])
 
        const oddsData = await fetchOddsJogo(jogo.ligaCode, jogo.mandante, jogo.visitante)

    // ✅ REVISADO — item 40: agora aprende peso pros 4 mercados de Gols
    // (Over 1.5/2.5/3.5 e BTTS), não só Over 2.5.
    const pesosStacking = await obterPesosStackingGols()

    const pesos1x2 = await obterPesosStacking1x2() // ✅ NOVO — null até o walk-forward confiar
    const { pm, pe, pv, mercadoResultado, confianca, subModelos1x2, pesoUsado1x2 } =
      calcularProbabilidadesResultado(statsM, statsV, jogo.h2h, fatorQualM, fatorQualV, jogo.ligaCode, pesos1x2)

    const {
      mercadoGols, mercadoGolsLimpo, mediaEsperada,
      lambdaPoisson, lambdaH2H, lambdaM, lambdaV,
      confiancaGols, over15, under15, over25, under25, over35, under35,
      btts, descricaoMercado, rankingMercados, temH2HNoCalculo,
      qualidadeDados, incerteza, nJogosUsados,
      over15_subModelos, over25_subModelos, over35_subModelos, btts_subModelos,
    } = calcMercadoGols(
      statsM, statsV, jogo.h2h, fatorQualM, fatorQualV, jogo.ligaCode, pesosStacking,
      // ✅ NOVO — Fase 7: só aplica a correção quando NENHUM dos dois lados
      // conseguiu estatística filtrada por localidade — nesse caso o mando
      // de campo não foi capturado em nenhum outro lugar do cálculo.
      { razao: homeAdvantage.razao, aplicar: !jogo.usou_localidade_mandante && !jogo.usou_localidade_visitante },
      jogo.clima // ✅ FIX — item 12
    )
 
    // ── Blend com mercado (remove overround + puxa a prob final em direção
    //    ao consenso do mercado quando há odds disponíveis) ─────────────
    let pmFinal = pm, peFinal = pe, pvFinal = pv
    let mercadoResultadoFinal = mercadoResultado
    let over25Final = over25
    // ✅ REVISADO (item 38) — implM/implE/implV/implOver25/implUnder25 agora
    // vêm prontos de fetchOddsJogo (no-vig MULTI-bookmaker); normalizarOverround
    // fica sem uso aqui (mantida no arquivo, sem risco, caso precise no futuro).
    let implM = null, implE = null, implV = null
    let implOver25 = null, implUnder25 = null

    if (oddsData) {
      implM = oddsData.implM; implE = oddsData.implE; implV = oddsData.implV
      implOver25 = oddsData.implOver25; implUnder25 = oddsData.implUnder25

      pmFinal = blendComMercado(pm, implM)
      peFinal = blendComMercado(pe, implE)
      pvFinal = blendComMercado(pv, implV)
      const totalBlend = pmFinal + peFinal + pvFinal
      if (totalBlend > 0 && totalBlend !== 100) {
        pmFinal = Math.round((pmFinal / totalBlend) * 100)
        peFinal = Math.round((peFinal / totalBlend) * 100)
        pvFinal = 100 - pmFinal - peFinal
      }

      mercadoResultadoFinal = 'Empate'
      if (pmFinal > peFinal && pmFinal > pvFinal)      mercadoResultadoFinal = 'Vitória Mandante'
      else if (pvFinal > peFinal && pvFinal > pmFinal) mercadoResultadoFinal = 'Vitória Visitante'

      over25Final = blendComMercado(over25, implOver25)
    }
 
    // Calibração automática a partir do histórico green/red do Tracker.
    // ✅ NOVO — item 39: aplicarMelhorCalibracao troca sozinha pro isotonic/Platt
    // quando o walk-forward (item 35) já confirmou que generaliza melhor;
    // senão cai no fator multiplicativo de sempre. fatoresCalib continua
    // calculado — ainda alimenta o ranking, o texto de notaCalib e o tracker.
    // ✅ FIX — probabilidades de gols ANTES de qualquer calibração (fator/isotonic/Platt).
    // O Tracker passa a gravar ESTAS em `probBruta`; gravar só a calibrada fazia o
    // calibrationService corrigir em cima do já corrigido (oscilação do fator).
    const probsBrutasGols = { over15, under15, over25: over25Final, under25: 100 - over25Final, over35, under35, btts }
    // ✅ FIX — item 7: calcFatoresCalibration() nunca recebia liga/árbitro
    // do jogo, então aplicarSegmentacao() (que já existia) nunca tinha o
    // que ajustar — o fator usado era sempre só o global.
    const fatoresCalib = await calcFatoresCalibration({
      liga: jogo.competicao || null,
      arbitro: jogo.cartoes_escanteios?.arbitro?.nome || null,
    })
    const probsCalibradas = await aplicarMelhorCalibracao({
      over15, under15, over25: over25Final, under25: 100 - over25Final, over35, under35, btts
    }, fatoresCalib)

    // Reavalia melhor mercado com probs já calibradas E com pesoUtil ajustado
    // pela taxa de acerto real de cada mercado (Scout Tracker)
    // ✅ gapMinimo=16 explícito (era implícito 13) — ver nota em calibrationService.js
    const escolhido = escolherMelhorMercadoCalibrado(probsCalibradas, fatoresCalib, 16)
    // Normaliza pares após calibração (over+under=100 sempre)
    const probsFinais = normalizarParesOverUnder(probsCalibradas)

    const mercadoGolsFinal      = escolhido.melhor ? escolhido.mercadoGols      : mercadoGols
    const mercadoGolsLimpoFinal = escolhido.melhor ? escolhido.mercadoGolsLimpo : mercadoGolsLimpo
    let confiancaGolsFinal      = escolhido.melhor ? escolhido.confiancaGols    : confiancaGols
    const rankingFinal          = escolhido.ranking?.length ? escolhido.ranking : rankingMercados

    // Descrição SEMPRE alinhada com o % final do mercado escolhido (evita 75% no texto e 82% na grade)
    const probMercadoFinal = escolhido.melhor?.prob != null
      ? escolhido.melhor.prob
      : (probsFinais.over25 ?? over25Final)
    const fatorCalibMercado = fatoresCalib?.[escolhido.melhor?.chave] ?? null
    const notaAssertividade = fatorCalibMercado != null && fatorCalibMercado !== 1.0
      ? (fatorCalibMercado > 1
          ? ` Histórico do Tracker mostra que este mercado tem acertado ACIMA do previsto (fator ×${fatorCalibMercado}).`
          : ` Histórico do Tracker mostra que este mercado tem acertado ABAIXO do previsto (fator ×${fatorCalibMercado}).`)
      : ''
    const descricaoMercadoFinal = escolhido.melhor
      ? `Melhor mercado: ${mercadoGolsLimpoFinal} · ${probMercadoFinal}% de probabilidade · confiança ${confiancaGolsFinal}. λ=${Number(mediaEsperada).toFixed(2)} gols esperados.${notaAssertividade}`
      : descricaoMercado

    const fatoresAtivos = Object.entries(fatoresCalib).filter(([, f]) => f !== 1).map(([k, v]) => `${k}×${v}`)
    const notaCalib = fatoresAtivos.length
      ? ` Calibração ativa: ${fatoresAtivos.join(', ')}.`
      : ' Calibração neutra (poucos greens/reds ainda).'

    // Value score vs odd (edge mínimo por categoria/odd — valueConfig.js) usando probs já calibradas
    const valuePick = montarValuePick({
      over15:  probsFinais.over15,
      under15: probsFinais.under15,
      over25:  probsFinais.over25,
      under25: probsFinais.under25,
      over35:  probsFinais.over35,
      under35: probsFinais.under35,
      btts:    probsFinais.btts,
      pm: pmFinal,
      pv: pvFinal,
      oddsData,
      mercadoGolsLimpo: mercadoGolsLimpoFinal,
      incertezaOver25: incerteza, // ✅ FIX — item 8
    })

    // ✅ NOVO — Fase 7, item 30: alerta proativo quando o edge é forte
    // demais pra ser só mais um value bet normal. Fire-and-forget — nunca
    // deve travar nem atrasar a análise se o servidor estiver fora do ar.
    if (valuePick.melhorValue && valuePick.melhorValue.edge >= DIVERGENCIA_FORTE_EDGE_PP) {
      fetch(`${API_BASE}/api/alertas/divergencia`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          mandante: jogo.mandante,
          visitante: jogo.visitante,
          liga: jogo.ligaCode,
          mercado: valuePick.melhorValue.nome,
          edge: valuePick.melhorValue.edge,
          prob: valuePick.melhorValue.prob,
          odd: valuePick.melhorValue.odd,
        }),
      }).catch(() => {}) // best-effort — não bloqueia a análise
    }

    const notaValue = valuePick.melhorValue
      ? ` VALUE: ${valuePick.melhorValue.nome} edge +${valuePick.melhorValue.edge}pp @${valuePick.melhorValue.odd}.`
      : valuePick.edgeMercadoSugerido && valuePick.edgeMercadoSugerido.edge != null
        ? ` Edge do mercado sugerido: ${valuePick.edgeMercadoSugerido.edge >= 0 ? '+' : ''}${valuePick.edgeMercadoSugerido.edge}pp (mín. value: +${valuePick.edgeMercadoSugerido.edgeMin ?? EDGE_MINIMO_BASE.gols}pp).`
        : ' Sem odds ou sem edge mensurável.'

    // ✅ NOVO — mercado de cartões/escanteios de verdade (Poisson sobre
    // histórico real + árbitro + clima), não só números exibidos.
    const mercadoCartoesEscanteios = await calcMercadoCartoesEscanteios(jogo.cartoes_escanteios, jogo.clima, {
      mandante:     jogo.mandante,
      visitante:    jogo.visitante,
      ligaCode:     jogo.ligaCode,
      gapResultado: Math.abs(pmFinal - pvFinal),
      fatoresCalib, // ✅ NOVO — reaproveita o mesmo fatoresCalib já buscado pra gols (linha ~2101), sem chamada extra
      h2h: jogo.h2h, // ✅ NOVO — mesmo H2H já buscado pra gols; usado agora pra blend de cartões/escanteios
    })

    // ✅ NOVO — camada de IA (validação qualitativa, não substitui o cálculo)
    const analiseIA = await gerarAnaliseIA(jogo, { mercadoGolsLimpoFinal, probMercadoFinal, mercadoResultadoFinal })
    const notaIA = analiseIA?.alertas?.length
      ? ` ⚠️ IA aponta risco (${analiseIA.nivel_risco}): ${analiseIA.alertas.join('; ')}.`
      : ''

    const meCE = mercadoCartoesEscanteios?.melhorEntrada
    const notaCartoesEsc = meCE
      ? ` Cartões — melhor Over: ${meCE.cartoesOver?.nome ?? '—'} (${meCE.cartoesOver?.prob ?? '—'}%) · melhor Under: ${meCE.cartoesUnder?.nome ?? '—'} (${meCE.cartoesUnder?.prob ?? '—'}%). Escanteios — melhor Over: ${meCE.escanteiosOver?.nome ?? '—'} (${meCE.escanteiosOver?.prob ?? '—'}%) · melhor Under: ${meCE.escanteiosUnder?.nome ?? '—'} (${meCE.escanteiosUnder?.prob ?? '—'}%).`
      : ''

    const analise = `Modelo aponta ${mercadoGolsLimpoFinal} como melhor entrada, com ${escolhido.melhor?.prob ?? over25Final}% de probabilidade — a maior % disponível entre os mercados de gols analisados.${notaAssertividade} Lambda total: ${Number(mediaEsperada).toFixed(2)} gols esperados — ${jogo.mandante} ${lambdaM} | ${jogo.visitante} ${lambdaV}. Resultado mais provável: ${mercadoResultadoFinal} (${Math.max(pmFinal, pvFinal)}%). Liga: média real ${mediaLiga.marcados.toFixed(2)} gols/jogo (${mediaLiga.totalJogos} jogos coletados).${notaCalib}${notaIA}${notaCartoesEsc}`

     analisados.push({
      id: jogo.id, // id do evento (FlashLive) — necessário pro auto-save do Tracker
      mandante: jogo.mandante, visitante: jogo.visitante,
      competicao: jogo.competicao, horario: jogo.horario,
      dataJogo: jogo.dataJogo, status: jogo.status,
      // ✅ NOVO — Fase 1, item 4: qual versão do motor gerou esta previsão
      // (vai junto pro Tracker e entra no relatório de calibração por versão)
      motor_versao: versaoAtual(MOTOR_FUTEBOL),
      dataset_versao: DATASET_VERSAO, // ✅ NOVO — item 29
 
      prob_mandante: pmFinal, prob_empate: peFinal, prob_visitante: pvFinal,
      // ✅ NOVO — item 40: sub-modelos dos 4 mercados de Gols (alimenta o stacking)
      over15_subModelos, over25_subModelos, over35_subModelos, btts_subModelos,
      // ✅ NOVO — stacking do 1X2: sub-modelos (Forma/H2H/ELO) por lado + pesos usados
      resultado_subModelos: subModelos1x2, resultado_pesoUsado: pesoUsado1x2,
      mercado_resultado: mercadoResultadoFinal, confianca, analise,
 
      mercado_gols: mercadoGolsFinal, mercado_gols_limpo: mercadoGolsLimpoFinal,
      media_gols_esperada: mediaEsperada,
      lambda_poisson: lambdaPoisson, lambda_h2h: lambdaH2H,
      lambda_mandante: lambdaM, lambda_visitante: lambdaV,
      confianca_gols: confiancaGolsFinal, descricao_mercado: descricaoMercadoFinal,
      calibracao_fatores: fatoresCalib,
      probs_brutas_gols: probsBrutasGols, // ✅ FIX — antes da calibração (vai pro Tracker como probBruta)
      qualidade_dados: qualidadeDados,
      incerteza_over25: incerteza,
      n_jogos_usados: nJogosUsados,
      ranking_mercados: rankingFinal.map(m => ({
        nome: m.nome, prob: m.prob, gap: m.gap, confianca: m.confianca,
      })),
      over15_gols:  probsFinais.over15,
      under15_gols: probsFinais.under15,
      over25_gols:  probsFinais.over25,
      under25_gols: probsFinais.under25,
      over35_gols:  probsFinais.over35,
      under35_gols: probsFinais.under35,
      btts:         probsFinais.btts,

      // ✅ NOVO — melhor entrada de Over e de Under (gols), separadas
      melhor_entrada_over_gols: escolhido.melhorOver ? {
        nome: escolhido.melhorOver.nome, prob: escolhido.melhorOver.prob, confianca: escolhido.melhorOver.confianca,
      } : null,
      melhor_entrada_under_gols: escolhido.melhorUnder ? {
        nome: escolhido.melhorUnder.nome, prob: escolhido.melhorUnder.prob, confianca: escolhido.melhorUnder.confianca,
      } : null,
 
      
 
      ultimos5_mandante:  statsM.formaSimbolo,
      ultimos5_visitante: statsV.formaSimbolo,
      stats_mandante: statsM, stats_visitante: statsV,
      h2h: jogo.h2h ?? { confrontos: [], totalJogos: 0, semDados: true },
 
      cartoes_media:         jogo.cartoes_escanteios?.mediaCartoesJogo    ?? null,
      escanteios_media:      jogo.cartoes_escanteios?.mediaEscanteiosJogo ?? null,
      cartoes_mandante:      jogo.cartoes_escanteios?.mandante?.mediaCartoesTotais  ?? null,
      cartoes_visitante:     jogo.cartoes_escanteios?.visitante?.mediaCartoesTotais ?? null,
      escanteios_mandante:   jogo.cartoes_escanteios?.mandante?.mediaEscanteios     ?? null,
      escanteios_visitante:  jogo.cartoes_escanteios?.visitante?.mediaEscanteios    ?? null,
      // ✅ NOVO — mercado real de cartões/escanteios (linhas Over/Under + probabilidade)
      mercado_cartoes_escanteios: mercadoCartoesEscanteios,
      arbitro: jogo.cartoes_escanteios?.arbitro
        ? { ...jogo.cartoes_escanteios.arbitro, sazonal: jogo.cartoes_escanteios.arbitroSazonal ?? null }
        : null,
      clima:   jogo.clima ?? null,

      // ✅ NOVO — Fase 8, item 37: consolida TODOS os fatores que entraram
      // nessa previsão específica, pra exibir "por que o modelo disse isso"
      // na interface (não é um cálculo novo — só reaproveita valores que já
      // existiam soltos em variáveis locais desta função).
      fatores_explicabilidade: {
        poisson: {
          lambdaM, lambdaV, lambdaTotal: mediaEsperada,
          dixonColesRho: dixonColesRho(lambdaM, lambdaV, jogo.ligaCode),
        },
        // ✅ NOVO — Fase 5, itens 21 e 22
        fadiga: { mandante: jogo.fadiga_mandante ?? null, visitante: jogo.fadiga_visitante ?? null },
        h2h: {
          lambda: lambdaH2H,
          usado: !!(jogo.h2h && !jogo.h2h.semDados && jogo.h2h.totalJogos >= 3),
        },
        elo: { fatorMandante: fatorQualM, fatorVisitante: fatorQualV },
        clima: { usado: !!(jogo.clima?.probabilidadeChuva != null), resumo: jogo.clima ?? null },
        arbitro: jogo.cartoes_escanteios?.arbitro
          ? { nome: jogo.cartoes_escanteios.arbitro.nome, sazonal: jogo.cartoes_escanteios.arbitroSazonal ?? null }
          : null,
        calibracao: { fatores: fatoresCalib, pesoStackingOver25: over25_subModelos?.pesoUsado ?? null },
        blendMercado: { pesoMercado: 0.32, aplicado: !!oddsData },
      },
      // ✅ NOVO — validação qualitativa da IA (alertas, não substitui o número)
      analise_ia: analiseIA,
 
      value_pick: valuePick,
      tem_value: valuePick.temValue,
      odds_mercado: oddsData ? {
        mandante: oddsData.oddsM, empate: oddsData.oddsE, visitante: oddsData.oddsV,
        over25: oddsData.oddsOver25, under25: oddsData.oddsUnder25,
        over15: oddsData.oddsOver15, over35: oddsData.oddsOver35,
        bookmaker: oddsData.bookmaker,
        nBooksNoVig: oddsData.nBooksNoVig, // ✅ NOVO — item 40: quantas casas entraram no no-vig (liquidez)
        arbitragem: oddsData.arbitragem, // ✅ NOVO — Fase 6
        implM: implM,
        implE: implE,
        implV: implV,
        implOver25: implOver25,
        implUnder25: implUnder25,
        evM:      calcEV(pmFinal,                 oddsData.oddsM),
        evV:      calcEV(pvFinal,                 oddsData.oddsV),
        evOver15: calcEV(probsFinais.over15,  oddsData.oddsOver15),
        evOver25: calcEV(probsFinais.over25,  oddsData.oddsOver25),
        evUnder25: calcEV(probsFinais.under25, oddsData.oddsUnder25),
        evOver35: calcEV(probsFinais.over35,  oddsData.oddsOver35),
        edgeOver15: calcEdge(probsFinais.over15,  oddsData.oddsOver15),
        edgeOver25: calcEdge(probsFinais.over25,  oddsData.oddsOver25),
        edgeUnder25: calcEdge(probsFinais.under25, oddsData.oddsUnder25),
        edgeOver35: calcEdge(probsFinais.over35,  oddsData.oddsOver35),
        melhorEV: valuePick.melhorValue
          ? { nome: valuePick.melhorValue.nome, ev: valuePick.melhorValue.ev, odd: valuePick.melhorValue.odd, edge: valuePick.melhorValue.edge, edgeMin: valuePick.melhorValue.edgeMin, stakeKellyPct: valuePick.melhorValue.stakeKellyPct }
          : null,
      } : null,
    })
 
    if (analisados.length < jogosParaProcessar.length) await sleep(12000)
  }
 
  const jogosComScore = analisados.map(j => {
    const { score, breakdown } = calcScoreComposto(j)
    const relevancia = Math.max(getRelevancia(j.mandante), getRelevancia(j.visitante))
    return { ...j, score_composto: score, score_breakdown: breakdown, relevancia }
  }).sort((a, b) => {
    if (b.relevancia !== a.relevancia) return b.relevancia - a.relevancia
    return b.score_composto - a.score_composto
  })
 
  return {
    jogos: jogosComScore,
    total: jogosParaProcessar.length,
    resumo: `${jogosParaProcessar.length} jogo(s) analisado(s) — Poisson + H2H blend · ELO persistente · calibração do tracker · médias reais por liga · cartões/escanteios reais + árbitro · clima · camada de IA.`,
  }
}

export async function validarChave(_apiKey) {
  // Com proxy, a chave não está no frontend — sempre retorna true
  // O erro aparecerá na Etapa 1 se a GROQ_KEY do servidor estiver errada
  return true
}

export { _cache as sessionCache }