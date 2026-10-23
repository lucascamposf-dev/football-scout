// server/scrapers/fbrefScraper.js
// Raspa dados de gols e cartões do FBref.com
// Usa node-fetch (já no package.json) + cheerio para parse HTML
// ─────────────────────────────────────────────────────────────

import * as cheerio from 'cheerio'

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'pt-BR,pt;q=0.9',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
}

// URLs de estatísticas gerais por liga
const FBREF_STATS = {
  brasileirao:      'https://fbref.com/pt/comps/24/stats/Estatisticas-do-Brasileirao',
  premier_league:   'https://fbref.com/pt/comps/9/stats/Estatisticas-Premier-League',
  la_liga:          'https://fbref.com/pt/comps/12/stats/Estatisticas-La-Liga',
  serie_a:          'https://fbref.com/pt/comps/11/stats/Estatisticas-Serie-A',
  bundesliga:       'https://fbref.com/pt/comps/20/stats/Estatisticas-Bundesliga',
  ligue_1:          'https://fbref.com/pt/comps/13/stats/Estatisticas-Ligue-1',
  champions_league: 'https://fbref.com/pt/comps/8/stats/Estatisticas-Champions-League',
}

// URLs de estatísticas disciplinares (cartões) por liga
const FBREF_MISC = {
  brasileirao:      'https://fbref.com/pt/comps/24/misc/Estatisticas-do-Brasileirao',
  premier_league:   'https://fbref.com/pt/comps/9/misc/Estatisticas-Premier-League',
  la_liga:          'https://fbref.com/pt/comps/12/misc/Estatisticas-La-Liga',
  serie_a:          'https://fbref.com/pt/comps/11/misc/Estatisticas-Serie-A',
  bundesliga:       'https://fbref.com/pt/comps/20/misc/Estatisticas-Bundesliga',
  ligue_1:          'https://fbref.com/pt/comps/13/misc/Estatisticas-Ligue-1',
  champions_league: 'https://fbref.com/pt/comps/8/misc/Estatisticas-Champions-League',
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── Fetch com retry ───────────────────────────────────────────
async function fetchHtml(url, tentativas = 3) {
  for (let i = 0; i < tentativas; i++) {
    try {
      await sleep(i * 1500) // backoff entre tentativas
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20_000) })
      if (!res.ok) {
        console.warn(`[FBref] HTTP ${res.status} em ${url}`)
        continue
      }
      return await res.text()
    } catch (err) {
      console.warn(`[FBref] tentativa ${i + 1} falhou: ${err.message}`)
    }
  }
  return null
}

// ── Parser genérico de tabela HTML do FBref ───────────────────
function parseTabelaFBref(html, colunasFallback = []) {
  if (!html) return []
  const $ = cheerio.load(html)
  const resultados = []

  // FBref usa tabelas com id começando em "stats_"
  const tabela = $('table[id^="stats_"]').first()
  if (!tabela.length) {
    console.warn('[FBref] tabela stats_ não encontrada')
    return []
  }

  // Extrair cabeçalhos (FBref usa thead com duas linhas — pega a última)
  const headers = []
  tabela.find('thead tr').last().find('th, td').each((_, el) => {
    headers.push($(el).attr('data-stat') || $(el).text().trim().toLowerCase())
  })

  // Extrair linhas do tbody
  tabela.find('tbody tr').each((_, row) => {
    const $row = $(row)

    // Pular linhas de separação (class="spacer" ou sem célula de time)
    if ($row.hasClass('spacer') || $row.hasClass('thead')) return

    const celulas = {}
    $row.find('th, td').each((i, el) => {
      const key = headers[i] || `col_${i}`
      celulas[key] = $(el).text().trim()
    })

    // O time fica em data-stat="squad" ou na primeira coluna
    const nomeTime = celulas['squad'] || celulas[headers[0]] || ''
    if (!nomeTime || nomeTime === 'Squad') return

    celulas._nomeTime = nomeTime
    resultados.push(celulas)
  })

  return resultados
}

// ── Normaliza nome para comparação parcial ────────────────────
function norm(s = '') {
  return s.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '')
}

// ─────────────────────────────────────────────────────────────
// Busca estatísticas de gols de todos os times de uma liga
// ─────────────────────────────────────────────────────────────
export async function getGolsLiga(liga) {
  const url = FBREF_STATS[liga]
  if (!url) return { erro: `Liga '${liga}' não suportada` }

  const html = await fetchHtml(url)
  if (!html) return { erro: 'FBref indisponível' }

  const linhas = parseTabelaFBref(html)
  if (!linhas.length) return { erro: 'Tabela não encontrada no FBref' }

  const times = linhas.map(row => {
    const jogos = parseInt(row['games'] || row['mp'] || row['pj'] || 0) || 0
    const gf    = parseInt(row['goals'] || row['gf'] || row['gols'] || 0) || 0
    const ga    = parseInt(row['goals_against'] || row['ga'] || row['gc'] || 0) || 0

    return {
      time:                   row._nomeTime,
      jogos,
      gols_marcados:          gf,
      gols_sofridos:          ga,
      media_gols_marcados:    jogos > 0 ? parseFloat((gf / jogos).toFixed(2)) : 0,
      media_gols_sofridos:    jogos > 0 ? parseFloat((ga / jogos).toFixed(2)) : 0,
      media_total_gols:       jogos > 0 ? parseFloat(((gf + ga) / jogos).toFixed(2)) : 0,
    }
  }).filter(t => t.time && t.jogos > 0)

  return { liga, fonte: 'fbref', times }
}

// ─────────────────────────────────────────────────────────────
// Busca estatísticas de cartões de todos os times de uma liga
// ─────────────────────────────────────────────────────────────
export async function getCartoesLiga(liga) {
  const url = FBREF_MISC[liga]
  if (!url) return { erro: `Liga '${liga}' não suportada` }

  const html = await fetchHtml(url)
  if (!html) return { erro: 'FBref indisponível' }

  const linhas = parseTabelaFBref(html)
  if (!linhas.length) return { erro: 'Tabela não encontrada no FBref' }

  const times = linhas.map(row => {
    const jogos     = parseInt(row['games'] || row['mp'] || row['pj'] || 0) || 0
    const amarelos  = parseInt(row['cards_yellow'] || row['crdy'] || row['ca'] || 0) || 0
    const vermelhos = parseInt(row['cards_red']    || row['crdr'] || row['cv'] || 0) || 0

    return {
      time:                   row._nomeTime,
      jogos,
      cartoes_amarelos:       amarelos,
      cartoes_vermelhos:      vermelhos,
      media_amarelos:         jogos > 0 ? parseFloat((amarelos  / jogos).toFixed(2)) : 0,
      media_vermelhos:        jogos > 0 ? parseFloat((vermelhos / jogos).toFixed(2)) : 0,
      media_cartoes_total:    jogos > 0 ? parseFloat(((amarelos + vermelhos) / jogos).toFixed(2)) : 0,
    }
  }).filter(t => t.time && t.jogos > 0)

  return { liga, fonte: 'fbref', times }
}

// ─────────────────────────────────────────────────────────────
// Busca dados de um time específico (gols + cartões combinados)
// Faz match parcial e case-insensitive no nome do time
// ─────────────────────────────────────────────────────────────
export async function getTimeStats(liga, nomeTime) {
  // Busca os dois em paralelo
  const [resGols, resCartoes] = await Promise.all([
    getGolsLiga(liga),
    getCartoesLiga(liga),
  ])

  const nomeNorm = norm(nomeTime)
  const resultado = { time: nomeTime, liga, fonte: 'fbref' }

  if (resGols?.times) {
    const match = resGols.times.find(t =>
      norm(t.time).includes(nomeNorm.slice(0, 5)) ||
      nomeNorm.includes(norm(t.time).slice(0, 5))
    )
    if (match) Object.assign(resultado, {
      jogos:                  match.jogos,
      gols_marcados:          match.gols_marcados,
      gols_sofridos:          match.gols_sofridos,
      media_gols_marcados:    match.media_gols_marcados,
      media_gols_sofridos:    match.media_gols_sofridos,
      media_total_gols:       match.media_total_gols,
    })
  }

  if (resCartoes?.times) {
    const match = resCartoes.times.find(t =>
      norm(t.time).includes(nomeNorm.slice(0, 5)) ||
      nomeNorm.includes(norm(t.time).slice(0, 5))
    )
    if (match) Object.assign(resultado, {
      cartoes_amarelos:       match.cartoes_amarelos,
      cartoes_vermelhos:      match.cartoes_vermelhos,
      media_amarelos:         match.media_amarelos,
      media_vermelhos:        match.media_vermelhos,
      media_cartoes_total:    match.media_cartoes_total,
    })
  }

  if (!resultado.jogos) return { erro: `Time '${nomeTime}' não encontrado na liga '${liga}'` }
  return resultado
}