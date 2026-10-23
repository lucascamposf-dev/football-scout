// server/scrapers/allSportsTennisEnrich.js
// Camada OPCIONAL de enriquecimento do modelo de tênis usando o AllSportsAPI.
// Adiciona: ranking oficial ATP/WTA + taxa de vitória por superfície.
// Filosofia: se qualquer coisa aqui falhar (chave inválida, rate limit,
// jogador não encontrado por nome), retorna null silenciosamente e o
// calcularProbabilidadesTenis() volta a usar só sets+H2H — nunca quebra o fluxo.

const BASE = 'https://apiv2.allsportsapi.com/tennis/'
const APIKEY = process.env.ALLSPORTS_KEY

// Cache em memória (processo do servidor) — evita bater no AllSports
// toda hora só pra pegar o ranking, que muda 1x/semana.
let cacheStandings = null
let cacheStandingsExpira = 0
const TTL_STANDINGS = 12 * 60 * 60 * 1000 // 12h

async function allSportsFetch(params) {
  if (!APIKEY) return null
  try {
    const qs = new URLSearchParams({ APIkey: APIKEY, ...params }).toString()
    const res = await fetch(`${BASE}?${qs}`)
    if (!res.ok) return null
    const json = await res.json()
    if (json?.success !== 1) return null
    return json.result
  } catch (e) {
    console.warn('[AllSportsTennis] fetch erro:', e.message)
    return null
  }
}

function normalizarNome(nome = '') {
  return nome.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
}

function extrairSobrenome(nomeCompleto = '') {
  const partes = normalizarNome(nomeCompleto).split(/\s+/).filter(Boolean)
  return partes[partes.length - 1] ?? ''
}

// nomeAllSports vem tipo "N. Djokovic" — compara sobrenome + inicial
function nomesCombinam(nomeJogador, nomeAllSports) {
  const sobreA = extrairSobrenome(nomeJogador)
  const sobreB = extrairSobrenome(nomeAllSports)
  if (!sobreA || sobreA !== sobreB) return false
  const iniA = normalizarNome(nomeJogador)[0]
  const iniB = normalizarNome(nomeAllSports)[0]
  return !iniB || iniA === iniB
}

async function getStandingsIndex() {
  if (cacheStandings && Date.now() < cacheStandingsExpira) return cacheStandings

  const [atp, wta] = await Promise.all([
    allSportsFetch({ met: 'Standings', league: 'ATP' }),
    allSportsFetch({ met: 'Standings', league: 'WTP' }), // sim, o AllSports usa 'WTP' pra WTA
  ])

  const indice = [...(atp ?? []), ...(wta ?? [])].map(p => ({
    playerKey: p.player_key,
    nome: p.player,
    ranking: parseInt(p.place) || null,
    pontos: parseInt(p.points) || null,
    liga: p.league,
  }))

  if (indice.length) {
    cacheStandings = indice
    cacheStandingsExpira = Date.now() + TTL_STANDINGS
  }
  return indice
}

// mapeia o piso do jogo — FlashLive ("saibro", "duro", "grama") ou em inglês
// ("Clay", "Hard", "Grass", "Hard (indoor)") — pras chaves usadas no Players
// do AllSports (hard/clay/grass)
function normalizarPiso(piso) {
  if (!piso) return null
  const p = piso.toLowerCase()
  if (p.includes('clay') || p.includes('saibro')) return 'clay'
  if (p.includes('grass') || p.includes('grama')) return 'grass'
  if (p.includes('hard') || p.includes('duro')) return 'hard'
  return null
}

// Agrega os últimos 2 anos de stats "singles" do jogador pra superfície pedida
function taxaSuperficie(statsArray, piso) {
  const chave = normalizarPiso(piso)
  if (!chave || !statsArray?.length) return null

  const anoAtual = new Date().getFullYear()
  const relevantes = statsArray.filter(s =>
    s.type === 'singles' && parseInt(s.season) >= anoAtual - 1
  )
  if (!relevantes.length) return null

  let ganhos = 0, perdidos = 0
  for (const s of relevantes) {
    ganhos   += parseInt(s[`${chave}_won`])  || 0
    perdidos += parseInt(s[`${chave}_lost`]) || 0
  }
  const total = ganhos + perdidos
  if (total < 3) return null // amostra pequena demais pra confiar

  return { taxa: ganhos / total, amostra: total, piso: chave }
}

// ─────────────────────────────────────────────────────────────
// FUNÇÃO PRINCIPAL — busca ranking + stats de superfície de 1 jogador
// Retorna null se não achar (nome não bate, sem chave, API fora do ar) —
// o chamador SEMPRE precisa tratar esse null com fallback.
// ─────────────────────────────────────────────────────────────
export async function buscarEnriquecimentoJogador(nomeJogador, piso) {
  if (!APIKEY || !nomeJogador) return null

  try {
    const standings = await getStandingsIndex()
    const match = standings.find(p => nomesCombinam(nomeJogador, p.nome))
    if (!match) return null

    const players = await allSportsFetch({ met: 'Players', playerId: match.playerKey })
    const dadosJogador = players?.[0]

    return {
      ranking: match.ranking,
      pontos: match.pontos,
      liga: match.liga,
      superficie: dadosJogador ? taxaSuperficie(dadosJogador.stats, piso) : null,
    }
  } catch (e) {
    console.warn('[AllSportsTennis] enriquecimento falhou:', e.message)
    return null
  }
}

// Busca pros dois jogadores de um jogo em paralelo — nunca lança erro
export async function enriquecerJogoTenis(jogo) {
  try {
    const [mandante, visitante] = await Promise.all([
      buscarEnriquecimentoJogador(jogo.mandante, jogo.piso),
      buscarEnriquecimentoJogador(jogo.visitante, jogo.piso),
    ])
    return { ...jogo, enriquecimentoMandante: mandante, enriquecimentoVisitante: visitante }
  } catch (e) {
    // Nunca deixa o enriquecimento derrubar o fluxo principal
    return jogo
  }
}