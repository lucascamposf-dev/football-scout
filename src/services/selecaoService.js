// selecaoService.js — Histórico de seleções para Copa do Mundo 2026
// Busca dados em múltiplas competições (WC, WCQ, CA, EURO, NL, amistosos)
// para resolver o problema de "dados insuficientes" em jogos de seleções
// ─────────────────────────────────────────────────────────────

import { APIFOOTBALLCOM_LEAGUE_IDS } from './apifootballComService.js'

const IS_PROD  = typeof window !== 'undefined' && window.location.hostname !== 'localhost'
const API_BASE = IS_PROD ? '' : 'http://localhost:3001'
const BASE_URL = `${API_BASE}/api/apifootballcom`

// Ligas de seleções para buscar histórico
const LIGAS_SELECAO = [
  { code: 'WC',    id: 1   },  // Copa do Mundo
  { code: 'WCQ',   id: 32  },  // Eliminatórias
  { code: 'CA',    id: 9   },  // Copa América
  { code: 'EURO',  id: 6   },  // Eurocopa
  { code: 'NL',    id: 5   },  // Nations League
  { code: 'FRIENDLY', id: 834 }, // Amistosos FIFA
]

// Anos para buscar (últimos 4 anos = 1 ciclo de Copa)
const ANOS_HISTORICO = [
  new Date().getFullYear(),
  new Date().getFullYear() - 1,
  new Date().getFullYear() - 2,
  new Date().getFullYear() - 3,
]

// Cache em memória por sessão
const _cache = {}

async function apiFetch(params = {}) {
  const query    = new URLSearchParams(params).toString()
  if (_cache[query]) return _cache[query]

  try {
    const res = await fetch(`${BASE_URL}?${query}`)
    if (!res.ok) return null
    const data = await res.json()
    if (data?.error) return null
    _cache[query] = data
    return data
  } catch {
    return null
  }
}

function norm(s) {
  return (s ?? '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '')
}

// ─────────────────────────────────────────────────────────────
// BUSCA HISTÓRICO COMPLETO DE UMA SELEÇÃO
// Varre múltiplas ligas e múltiplos anos
// ─────────────────────────────────────────────────────────────
export async function buscarHistoricoSelecao(teamId, last = 15) {
  const todosJogos = []

  // Busca em paralelo por liga+ano (limita a 6 chamadas simultâneas)
  const chamadas = []
  for (const liga of LIGAS_SELECAO) {
    for (const ano of ANOS_HISTORICO) {
      chamadas.push({ liga, ano })
    }
  }

  // Executa em lotes de 4 para não sobrecarregar a API
  for (let i = 0; i < chamadas.length; i += 4) {
    const lote = chamadas.slice(i, i + 4)
    const resultados = await Promise.all(
      lote.map(({ liga, ano }) =>
        apiFetch({
          action:    'get_events',
          from:      `${ano}-01-01`,
          to:        `${ano}-12-31`,
          league_id: liga.id,
          team_id:   teamId,
        })
      )
    )

    for (const data of resultados) {
      if (!Array.isArray(data)) continue
      const finalizados = data.filter(j =>
        j.match_status === 'Finished' &&
        j.match_hometeam_score !== '' &&
        j.match_awayteam_score !== ''
      )
      todosJogos.push(...finalizados)
    }
  }

  if (!todosJogos.length) return []

  // Remove duplicatas pelo match_id e ordena por data desc
  const unicos = Object.values(
    Object.fromEntries(todosJogos.map(j => [j.match_id, j]))
  ).sort((a, b) => new Date(b.match_date) - new Date(a.match_date))

  return unicos.slice(0, last).map(j => {
    const isHome   = String(j.match_hometeam_id) === String(teamId)
    const hScore   = parseInt(j.match_hometeam_score) || 0
    const aScore   = parseInt(j.match_awayteam_score) || 0
    const marcados = isHome ? hScore : aScore
    const sofridos = isHome ? aScore : hScore

    let resultado
    if (hScore === aScore) resultado = 'E'
    else if (isHome)       resultado = hScore > aScore ? 'V' : 'D'
    else                   resultado = aScore > hScore ? 'V' : 'D'

    return {
      resultado,
      golsMarcados: marcados,
      golsSofridos: sofridos,
      totalGols:    hScore + aScore,
      isHome,
      data:         j.match_date,
      competicao:   j.league_name,
      adversario:   isHome ? j.match_awayteam_name : j.match_hometeam_name,
    }
  })
}

// ─────────────────────────────────────────────────────────────
// CALCULA ESTATÍSTICAS DE GOLS DE UMA SELEÇÃO
// Retorna no mesmo formato que ligaStatsService espera
// ─────────────────────────────────────────────────────────────
export async function getStatsSelecao(teamId) {
  const jogos = await buscarHistoricoSelecao(teamId, 15)
  if (!jogos.length) return null

  const totalGols   = jogos.reduce((s, j) => s + j.golsMarcados, 0)
  const totalSof    = jogos.reduce((s, j) => s + j.golsSofridos, 0)
  const totalJogos  = jogos.length
  const mediaMarc   = parseFloat((totalGols / totalJogos).toFixed(3))
  const mediaSof    = parseFloat((totalSof  / totalJogos).toFixed(3))

  const vitorias = jogos.filter(j => j.resultado === 'V').length
  const empates  = jogos.filter(j => j.resultado === 'E').length
  const derrotas = jogos.filter(j => j.resultado === 'D').length

  const btts = jogos.filter(j => j.golsMarcados > 0 && j.golsSofridos > 0).length
  const over15 = jogos.filter(j => j.totalGols > 1.5).length
  const over25 = jogos.filter(j => j.totalGols > 2.5).length

  return {
    marcados:      mediaMarc,
    sofridos:      mediaSof,
    totalJogos,
    vitorias,
    empates,
    derrotas,
    btts_pct:      parseFloat((btts  / totalJogos * 100).toFixed(1)),
    over15_pct:    parseFloat((over15 / totalJogos * 100).toFixed(1)),
    over25_pct:    parseFloat((over25 / totalJogos * 100).toFixed(1)),
    jogos,         // array completo para debug
    fonte: 'selecaoService_multiligas',
  }
}

// ─────────────────────────────────────────────────────────────
// BUSCA H2H ENTRE DUAS SELEÇÕES (sem depender de liga específica)
// ─────────────────────────────────────────────────────────────
export async function buscarH2HSelecoes(teamId1, teamId2, nome1, nome2) {
  const jogos1 = await buscarHistoricoSelecao(teamId1, 40)

  const n2 = norm(nome2)
  const confrontos = jogos1.filter(j =>
    norm(j.adversario).includes(n2.slice(0, 5)) ||
    n2.includes(norm(j.adversario).slice(0, 5))
  )

  return confrontos.slice(0, 10)
}

// ─────────────────────────────────────────────────────────────
// PROBABILIDADES DE GOLS COM FALLBACK POR RANKING FIFA
// Usado quando mesmo o histórico multi-liga é insuficiente
// ─────────────────────────────────────────────────────────────

// Ranking FIFA aproximado das seleções da Copa 2026
// Atualizar conforme ranking oficial em junho/2026
const RANKING_FIFA = {
  'Argentina':   1,  'France':    2,  'England':    3,
  'Brazil':      4,  'Portugal':  5,  'Spain':      6,
  'Belgium':     7,  'Germany':   8,  'Netherlands': 9,
  'Italy':      10,  'Uruguay':  11,  'Colombia':   12,
  'Morocco':    13,  'USA':      14,  'Mexico':     15,
  'Japan':      16,  'Croatia':  17,  'Senegal':    18,
  'Australia':  19,  'South Korea': 20, 'Canada':   21,
  'Ecuador':    22,  'Tunisia':  23,  'Cameroon':   24,
  'Ghana':      25,  'Serbia':   26,  'Poland':     27,
  'Switzerland': 28, 'Denmark':  29,  'Austria':    30,
}

export function calcularProbabilidadePorRanking(nomeTime1, nomeTime2) {
  const r1 = RANKING_FIFA[nomeTime1] ?? 50
  const r2 = RANKING_FIFA[nomeTime2] ?? 50

  // Converte ranking em rating (melhor ranking = maior rating)
  const elo1 = 2000 - (r1 * 10)
  const elo2 = 2000 - (r2 * 10)

  const expTime1 = 1 / (1 + Math.pow(10, (elo2 - elo1) / 400))
  const expTime2 = 1 - expTime1

  // Empate é estimado em ~25% para jogos de Copa
  const empate    = 0.25
  const vit1      = parseFloat(((expTime1 * 0.75)).toFixed(3))
  const vit2      = parseFloat(((expTime2 * 0.75)).toFixed(3))

  return {
    mandante:  parseFloat((vit1 * 100).toFixed(1)),
    empate:    parseFloat((empate * 100).toFixed(1)),
    visitante: parseFloat((vit2 * 100).toFixed(1)),
    fonte:     'ranking_fifa_fallback',
    aviso:     'Calculado por ranking FIFA — histórico insuficiente',
  }
}