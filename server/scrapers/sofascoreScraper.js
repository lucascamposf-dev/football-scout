// server/scrapers/sofascoreScraper.js
// Usa a API pública do SofaScore via fetch direto (sem Playwright)

import { sofaRequest } from './sofaHttp.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const SOFASCORE_TOURNAMENTS = {
  brasileirao:      325,
  serie_b:          390,
  sudamericana:      480,
  libertadores:      384,
  premier_league:   17,
  la_liga:          8,
  serie_a:          23,
  bundesliga:       35,
  ligue_1:          34,
  champions_league: 7,
  europa_league:    679,   // ✅ NOVO — UEFA Europa League (id do unique-tournament na SofaScore)
  nations_league:   10783, // ✅ NOVO — UEFA Nations League
  amistosos:        851,   // ✅ NOVO — International Friendly Games (amistosos de seleções)
}

const sofaFetch = (path, tentativas = 3) => sofaRequest(path, { tentativas })

export async function getPartidaStats(matchId) {
  if (!matchId) return { erro: 'matchId obrigatório' }

  const [eventData, statsData] = await Promise.all([
    sofaFetch(`/event/${matchId}`),
    sofaFetch(`/event/${matchId}/statistics`),
  ])

  const resultado = { match_id: matchId, fonte: 'sofascore' }

  if (eventData?.event) {
    const ev = eventData.event
    resultado.time_casa   = ev.homeTeam?.name ?? ''
    resultado.time_fora   = ev.awayTeam?.name ?? ''
    // ✅ FIX: em mata-mata com prorrogação, `current` inclui os gols da
    // prorrogação (e pênaltis). As casas de apostas liquidam Over/Under pelo
    // TEMPO NORMAL. `normaltime` é o placar só dos 90min; cai pra `current`
    // quando o jogo não teve prorrogação (aí `normaltime` nem existe).
    resultado.placar_casa = ev.homeScore?.normaltime ?? ev.homeScore?.current ?? null
    resultado.placar_fora = ev.awayScore?.normaltime ?? ev.awayScore?.current ?? null
     resultado.status      = ev.status?.description ?? ''
    resultado.status_type = ev.status?.type ?? ''
  }

  if (statsData?.statistics) {
    const grupos = statsData.statistics
    const all = grupos.find(g => ['ALL', 'all', 'FullTime'].includes(g.period)) ?? grupos[0]

    for (const grupo of all?.groups ?? []) {
      for (const item of grupo.statisticsItems ?? []) {
        const nome = (item.name ?? '').toLowerCase()
        const casa = item.home ?? 0
        const fora = item.away ?? 0

        if (nome.includes('corner') || nome.includes('escanteio')) {
          resultado.escanteios_casa  = parseInt(casa) || 0
          resultado.escanteios_fora  = parseInt(fora) || 0
          resultado.escanteios_total = (parseInt(casa) || 0) + (parseInt(fora) || 0)
        } else if (nome.includes('yellow card') || nome.includes('amarelo')) {
          resultado.cartoes_amarelos_casa = parseInt(casa) || 0
          resultado.cartoes_amarelos_fora = parseInt(fora) || 0
        } else if (nome.includes('red card') || nome.includes('vermelho')) {
          resultado.cartoes_vermelhos_casa = parseInt(casa) || 0
          resultado.cartoes_vermelhos_fora = parseInt(fora) || 0
        } else if (nome.includes('expected goals')) {
          resultado.xg_casa  = parseFloat(casa) || 0
          resultado.xg_fora  = parseFloat(fora) || 0
        } else if (nome.includes('ball possession') || nome.includes('posse de bola')) {
          resultado.posse_casa = parseInt(casa) || 0
          resultado.posse_fora = parseInt(fora) || 0
        } else if (nome.includes('big chances missed')) {
          resultado.grandes_chances_perdidas_casa = parseInt(casa) || 0
          resultado.grandes_chances_perdidas_fora = parseInt(fora) || 0
        } else if (nome.includes('big chance')) {
          resultado.grandes_chances_casa = parseInt(casa) || 0
          resultado.grandes_chances_fora = parseInt(fora) || 0
        } else if (nome.includes('total shots') || nome === 'shots') {
          resultado.chutes_casa = parseInt(casa) || 0
          resultado.chutes_fora = parseInt(fora) || 0
        } else if (nome.includes('shots on target') || nome.includes('chutes a gol')) {
          resultado.chutes_gol_casa = parseInt(casa) || 0
          resultado.chutes_gol_fora = parseInt(fora) || 0
        } else if (nome.includes('dangerous attack')) {
          resultado.ataques_perigosos_casa = parseInt(casa) || 0
          resultado.ataques_perigosos_fora = parseInt(fora) || 0
        }
      }
    }
  }

  if (!resultado.time_casa) return { erro: `Partida ${matchId} não encontrada` }
  return resultado
}

// ✅ NOVO — Fase 1, item 3 do roadmap: incidentes da partida (cartões com o
// minuto exato em que aconteceram), usado pra detectar expulsão precoce.
// Endpoint público da SofaScore: /event/{id}/incidents.
// Formato defensivo de propósito (igual ao resto do arquivo) — a API não é
// documentada oficialmente e o nome exato dos campos já mudou no passado.
export async function getIncidentesPartida(matchId) {
  const data = await sofaFetch(`/event/${matchId}/incidents`)
  const incidentes = data?.incidents ?? []
  if (!Array.isArray(incidentes)) return []

  return incidentes
    .filter(inc => {
      const tipo = (inc.incidentType ?? inc.type ?? '').toLowerCase()
      const cor  = (inc.incidentClass ?? inc.color ?? inc.cardType ?? '').toLowerCase()
      return tipo.includes('card') && (cor.includes('red') || cor.includes('yellowred'))
    })
    .map(inc => ({
      minuto:   inc.time ?? inc.minute ?? null,
      timeDoJogo: inc.isHome === true ? 'casa' : inc.isHome === false ? 'fora' : null,
      tipo:     (inc.incidentClass ?? inc.color ?? '').toLowerCase().includes('yellowred') ? 'segundo_amarelo' : 'vermelho_direto',
      jogador:  inc.player?.name ?? null,
    }))
    .filter(inc => inc.minuto != null)
}

export async function getPartidasLiga(liga) {
  const tournamentId = SOFASCORE_TOURNAMENTS[liga]
  if (!tournamentId) return { erro: `Liga '${liga}' não suportada` }

  const seasonData = await sofaFetch(`/unique-tournament/${tournamentId}/seasons`)
  const seasonId = seasonData?.seasons?.[0]?.id
  if (!seasonId) return { erro: 'Season não encontrada' }

  const data = await sofaFetch(`/unique-tournament/${tournamentId}/season/${seasonId}/events/last/0`)

  const partidas = []
  for (const ev of data?.events ?? []) {
    partidas.push({
      match_id:    ev.id,
      time_casa:   ev.homeTeam?.name ?? '',
      time_fora:   ev.awayTeam?.name ?? '',
      // ✅ Adicionado: IDs do SofaScore dos dois times. Antes essa função só
      // devolvia os nomes, o que obrigava o resto do sistema a "adivinhar" o
      // match certo só pelo nome — e sem os IDs era impossível buscar o
      // histórico de cartões/escanteios de cada time (só dava pra ler a
      // própria partida, que ainda nem aconteceu). Ver getConfrontoCartoesEscanteios.
      mandante_id:  ev.homeTeam?.id ?? null,
      visitante_id: ev.awayTeam?.id ?? null,
      status:      ev.status?.description ?? '',
      placar_casa: ev.homeScore?.current ?? null,
      placar_fora: ev.awayScore?.current ?? null,
      timestamp:   ev.startTimestamp ?? null,
    })
  }

  return { liga, fonte: 'sofascore', partidas }
}

// ─────────────────────────────────────────────────────────────
// ✅ NOVO — Média REAL de cartões/escanteios de um time, calculada a
// partir dos últimos jogos FINALIZADOS dele (não da partida futura que
// ainda vai acontecer). Corrige o bug de getPartidaStats() sendo usado
// para estimar cartões/escanteios de um jogo que ainda não começou —
// aquele endpoint só tem dado depois que a bola rola.
// ─────────────────────────────────────────────────────────────
// ✅ NOVO — parâmetro `mandante` (true = só jogos em casa, false = só jogos
// fora, null/undefined = mantém o comportamento antigo, sem filtro de mando).
// Escanteios tendem a ser sistematicamente mais altos jogando em casa (time
// pressiona mais o ataque), e cartões também variam por venue — então a
// média "geral" misturava dois sinais diferentes. Como filtrar por mando
// corta a amostra pela metade, paginamos mais páginas de /events/last/N pra
// ainda conseguir `last` jogos com esse filtro.
export async function getMediasCartoesEscanteiosTime(teamId, mandante = null, last = 6) {
  if (!teamId) return null

  // Sem filtro de mando, a página 0 já basta (comportamento antigo).
  // Com filtro, busca mais páginas pra trás pra compensar a amostra menor.
  const paginas = mandante == null ? [0] : [0, 1, 2]
  const respostas = await Promise.all(
    paginas.map(p => sofaFetch(`/team/${teamId}/events/last/${p}`).catch(() => null))
  )

  let eventos = respostas
    .flatMap(data => data?.events ?? [])
    .filter(ev => ev.status?.type === 'finished')

  if (mandante === true)  eventos = eventos.filter(ev => ev.homeTeam?.id === teamId)
  if (mandante === false) eventos = eventos.filter(ev => ev.awayTeam?.id === teamId)

  eventos = eventos
    .sort((a, b) => (b.startTimestamp ?? 0) - (a.startTimestamp ?? 0))
    .slice(0, last)

  if (!eventos.length) return null

  const amostras = []
  for (const ev of eventos) {
    const stats = await sofaFetch(`/event/${ev.id}/statistics`)
    const grupos = stats?.statistics
    if (!grupos) continue

    const isHome = ev.homeTeam?.id === teamId
    const all = grupos.find(g => ['ALL', 'all', 'FullTime'].includes(g.period)) ?? grupos[0]

    let amarelos = 0, vermelhos = 0, escanteios = 0
    let xgFeito = null, xgSofrido = null
    for (const grupo of all?.groups ?? []) {
      for (const item of grupo.statisticsItems ?? []) {
        const nome     = (item.name ?? '').toLowerCase()
        const valor    = isHome ? item.home : item.away
        const valorAdv = isHome ? item.away : item.home
        const num      = parseInt(valor) || 0
        if (nome.includes('yellow card'))      amarelos   = num
        else if (nome.includes('red card'))    vermelhos  = num
        else if (nome.includes('corner'))      escanteios = num
        // ✅ NOVO — item 9: mesmo stat "expected goals" que getPartidaStats()
        // já lê pra jogos passados, só que aqui aproveitado pra alimentar a
        // média móvel de xG/xGA do time (não só cartões/escanteios).
        else if (nome.includes('expected goals')) {
          xgFeito   = parseFloat(valor)    || 0
          xgSofrido = parseFloat(valorAdv) || 0
        }
      }
    }
    amostras.push({ cartoes: amarelos + vermelhos, escanteios, xgFeito, xgSofrido })
    await new Promise(r => setTimeout(r, 200)) // evita rate-limit do SofaScore
  }

  if (!amostras.length) return null

  const media = campo => parseFloat(
    (amostras.reduce((s, a) => s + a[campo], 0) / amostras.length).toFixed(2)
  )

  // ✅ NOVO — nem toda partida do SofaScore expõe "Expected goals" (varia por
  // liga/temporada), então a média de xG usa só as partidas em que o dado
  // realmente veio, não as `last` todas — evita puxar a média com zeros falsos.
  const amostrasXg = amostras.filter(a => a.xgFeito != null && a.xgSofrido != null)
  const mediaXg = campo => amostrasXg.length
    ? parseFloat((amostrasXg.reduce((s, a) => s + a[campo], 0) / amostrasXg.length).toFixed(2))
    : null

  // ✅ NOVO — coeficiente de variação por campo (mesmo cálculo usado em
  // calcEstatisticasGols pra gols), usado pra ajustar o K do shrinkage
  // bayesiano: time inconsistente (CV alto) puxa mais forte pra média da liga.
  const cv = campo => {
    const m = amostras.reduce((s, a) => s + a[campo], 0) / amostras.length
    if (m <= 0) return null
    const variancia = amostras.reduce((s, a) => s + Math.pow(a[campo] - m, 2), 0) / amostras.length
    return parseFloat((Math.sqrt(variancia) / m).toFixed(2))
  }

  return {
    mediaCartoesTotais: media('cartoes'),
    mediaEscanteios:    media('escanteios'),
    cvCartoes:          cv('cartoes'),
    cvEscanteios:       cv('escanteios'),
    mediaXgFeito:       mediaXg('xgFeito'),    // ✅ NOVO
    mediaXgSofrido:     mediaXg('xgSofrido'),  // ✅ NOVO
    amostrasXg:         amostrasXg.length,     // ✅ NOVO
    amostras:           amostras.length,
    mandante,           // ✅ NOVO — marca se essa média já é específica de mando de campo
  }
}

// ─────────────────────────────────────────────────────────────
// ✅ NOVO — Dados do árbitro da partida: nome + média histórica de
// cartões por jogo dele (quando o SofaScore expõe essa carreira).
// Best-effort: se o SofaScore não retornar o objeto "referee" completo
// (varia por liga/campeonato), degrada para null sem quebrar o resto.
// ─────────────────────────────────────────────────────────────
export async function getArbitroDoEvento(matchId) {
  if (!matchId) return null
  try {
    const eventData = await sofaFetch(`/event/${matchId}`)
    const ref = eventData?.event?.referee
    if (!ref?.id) return null

    const refData = await sofaFetch(`/referee/${ref.id}`)
    const r = refData?.referee ?? {}

    const jogos     = r.games ?? r.matches ?? null
    const amarelos  = r.yellowCards ?? null
    const vermelhos = r.redCards ?? 0
    const mediaCartoesPorJogo = (jogos && amarelos != null && jogos > 0)
      ? parseFloat(((amarelos + vermelhos) / jogos).toFixed(2))
      : null

    return {
      id:   ref.id,
      nome: r.name ?? ref.name ?? 'Desconhecido',
      pais: ref.country?.name ?? r.country?.name ?? null,
      jogosApitados:     jogos,
      mediaCartoesPorJogo,
      fonte: 'sofascore',
    }
  } catch (err) {
    console.warn('[SofaScore] árbitro falhou:', err.message)
    return null
  }
}

// ─────────────────────────────────────────────────────────────
// ✅ NOVO — Função "tudo em um" chamada pela rota /api/sportsdata/sofascore/
// cartoes-escanteios/:liga/:casa/:fora. Localiza a partida pelo nome dos
// times, pega os IDs reais do SofaScore e então busca:
//  1) média de cartões/escanteios dos ÚLTIMOS JOGOS de cada time (real)
//  2) dados do árbitro da partida (quando disponível)
// Substitui o fluxo antigo que lia (incorretamente) as estatísticas da
// própria partida futura.
// ─────────────────────────────────────────────────────────────
function normNome(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '')
}

// ✅ NOVO — mesma ideia de getPartidasLiga, mas busca jogos FUTUROS
// (events/next), não os já finalizados (events/last). Usada apenas para
// localizar a partida ainda não disputada e pegar os IDs dos times.
async function getProximasPartidasLiga(liga) {
  const tournamentId = SOFASCORE_TOURNAMENTS[liga]
  if (!tournamentId) return { erro: `Liga '${liga}' não suportada` }

  const seasonId = await getSeasonIdAtual(tournamentId)
  if (!seasonId) return { erro: 'Season não encontrada' }

  const [pag0, pag1] = await Promise.all([
    sofaFetch(`/unique-tournament/${tournamentId}/season/${seasonId}/events/next/0`),
    sofaFetch(`/unique-tournament/${tournamentId}/season/${seasonId}/events/next/1`),
  ])

  const eventos = [...(pag0?.events ?? []), ...(pag1?.events ?? [])]
  if (!eventos.length) return { erro: `Nenhum jogo futuro encontrado para '${liga}'` }

  const partidas = eventos.map(ev => ({
    match_id:     ev.id,
    time_casa:    ev.homeTeam?.name ?? '',
    time_fora:    ev.awayTeam?.name ?? '',
    mandante_id:  ev.homeTeam?.id ?? null,
    visitante_id: ev.awayTeam?.id ?? null,
    // ✅ NOVO — necessário pra tela de Odds mostrar data/hora de cada jogo
    startTimestamp: ev.startTimestamp ?? null,
  }))

  return { liga, fonte: 'sofascore', partidas }
}

export async function getConfrontoCartoesEscanteios(liga, casaNome, foraNome) {
  const { partidas, erro } = await getProximasPartidasLiga(liga)
  if (erro) return { erro }

  const nC = normNome(casaNome)
  const nF = normNome(foraNome)

  const partida = (partidas ?? []).find(p => {
    const h = normNome(p.time_casa)
    const a = normNome(p.time_fora)
    return (h.includes(nC.slice(0, 5)) || nC.includes(h.slice(0, 5))) &&
           (a.includes(nF.slice(0, 5)) || nF.includes(a.slice(0, 5)))
  })

  if (!partida) return { erro: `Partida "${casaNome} x ${foraNome}" não encontrada em ${liga}` }
  if (!partida.mandante_id || !partida.visitante_id) {
    return { erro: 'Partida encontrada, mas sem IDs de time do SofaScore' }
  }

  // ✅ NOVO — mandante entra com a média DELE jogando em casa, visitante
  // entra com a média DELE jogando fora (antes os dois usavam os últimos 6
  // jogos em qualquer mando, o que borrava o efeito casa/fora sabido de
  // escanteios e, em menor grau, de cartões).
  const [mediasCasa, mediasFora, arbitro] = await Promise.all([
    getMediasCartoesEscanteiosTime(partida.mandante_id, true, 6),
    getMediasCartoesEscanteiosTime(partida.visitante_id, false, 6),
    getArbitroDoEvento(partida.match_id),
  ])

  if (!mediasCasa && !mediasFora) {
    return { erro: 'Sem histórico de cartões/escanteios para nenhum dos dois times' }
  }

  const mediaCartoesJogo    = parseFloat((((mediasCasa?.mediaCartoesTotais ?? 0)) + ((mediasFora?.mediaCartoesTotais ?? 0))).toFixed(2))
  const mediaEscanteiosJogo = parseFloat((((mediasCasa?.mediaEscanteios ?? 0))    + ((mediasFora?.mediaEscanteios ?? 0))).toFixed(2))

  return {
    mandante: {
      mediaCartoesTotais: mediasCasa?.mediaCartoesTotais ?? null, mediaEscanteios: mediasCasa?.mediaEscanteios ?? null, amostras: mediasCasa?.amostras ?? 0,
      // ✅ NOVO — item 9
      mediaXgFeito: mediasCasa?.mediaXgFeito ?? null, mediaXgSofrido: mediasCasa?.mediaXgSofrido ?? null, amostrasXg: mediasCasa?.amostrasXg ?? 0,
    },
    visitante: {
      mediaCartoesTotais: mediasFora?.mediaCartoesTotais ?? null, mediaEscanteios: mediasFora?.mediaEscanteios ?? null, amostras: mediasFora?.amostras ?? 0,
      // ✅ NOVO — item 9
      mediaXgFeito: mediasFora?.mediaXgFeito ?? null, mediaXgSofrido: mediasFora?.mediaXgSofrido ?? null, amostrasXg: mediasFora?.amostrasXg ?? 0,
    },
    mediaCartoesJogo:    mediaCartoesJogo    || null,
    mediaEscanteiosJogo: mediaEscanteiosJogo || null,
    arbitro,
    fonte: 'sofascore_historico_real',
  }
}

// ─────────────────────────────────────────────────────────────
// ✅ NOVO — Histórico completo de confrontos diretos (H2H), igual ao que
// o SofaScore mostra na própria página do jogo: lista dos últimos jogos
// entre os dois times (não só o resumo agregado de getH2HEvento) + uma
// mini "série" de cartões/escanteios nesses confrontos.
// ─────────────────────────────────────────────────────────────
// ✅ NOVO — Estatísticas avançadas de H2H: separa o confronto por mando de
// campo (como o mandante de hoje se saiu quando jogou EM CASA contra esse
// rival vs quando jogou FORA), calcula a sequência atual (streak) e a
// tendência de gols recente. Espera `confrontos` do mais recente pro mais
// antigo, cada item com { resultado: 'M'|'E'|'V', totalGols, golsTimeA,
// golsTimeB } e `isNormalOrder` OU `mandanteJogouEmCasa` (mesmo conceito,
// nomes diferentes conforme a fonte de dados).
export function analisarH2HAvancado(confrontos) {
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

  let sequenciaResultado = confrontos[0].resultado
  let sequenciaTamanho = 1
  for (let i = 1; i < confrontos.length; i++) {
    if (confrontos[i].resultado === sequenciaResultado) sequenciaTamanho++
    else break
  }

  let tendenciaGols = 'estavel'
  if (confrontos.length >= 4) {
    const recentes = confrontos.slice(0, 3)
    const antigos  = confrontos.slice(3)
    const mediaRecente = recentes.reduce((s, c) => s + c.totalGols, 0) / recentes.length
    const mediaAntiga  = antigos.reduce((s, c) => s + c.totalGols, 0) / antigos.length
    if (mediaRecente - mediaAntiga >= 0.75)      tendenciaGols = 'subindo'
    else if (mediaAntiga - mediaRecente >= 0.75) tendenciaGols = 'caindo'
  }

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

export async function getHistoricoConfrontosDiretos(liga, casaNome, foraNome, limiteJogos = 5) {
  const { partidas, erro } = await getProximasPartidasLiga(liga)
  if (erro) return { erro }

  const nC = normNome(casaNome)
  const nF = normNome(foraNome)
  const partida = (partidas ?? []).find(p => {
    const h = normNome(p.time_casa)
    const a = normNome(p.time_fora)
    return (h.includes(nC.slice(0, 5)) || nC.includes(h.slice(0, 5))) &&
           (a.includes(nF.slice(0, 5)) || nF.includes(a.slice(0, 5)))
  })
  if (!partida) return { erro: `Partida "${casaNome} x ${foraNome}" não encontrada em ${liga}` }

  const data = await sofaFetch(`/event/${partida.match_id}/h2h/events`)
  const eventos = (data?.events ?? [])
    .filter(ev => ev.status?.type === 'finished' &&
                  typeof ev.homeScore?.current === 'number' &&
                  typeof ev.awayScore?.current === 'number')
    .sort((a, b) => (b.startTimestamp ?? 0) - (a.startTimestamp ?? 0))
    .slice(0, limiteJogos)

  if (!eventos.length) return { confrontos: [], totalJogos: 0, semDados: true }

  const confrontos = eventos.map(ev => {
    const hScore = ev.homeScore.current
    const aScore = ev.awayScore.current
    const casaEhMandanteHoje = normNome(ev.homeTeam?.name).includes(nC.slice(0, 5)) || nC.includes(normNome(ev.homeTeam?.name).slice(0, 5))
    const golsA = casaEhMandanteHoje ? hScore : aScore
    const golsB = casaEhMandanteHoje ? aScore : hScore

    let resultado
    if (hScore === aScore)        resultado = 'E'
    else if (casaEhMandanteHoje)  resultado = hScore > aScore ? 'M' : 'V'
    else                          resultado = aScore > hScore ? 'M' : 'V'

    return {
      data: ev.startTimestamp ? new Date(ev.startTimestamp * 1000).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '?',
      competicao:    ev.tournament?.name ?? 'Desconhecida',
      mandanteNome:  ev.homeTeam?.name ?? '?',
      visitanteNome: ev.awayTeam?.name ?? '?',
      homeScore: hScore, awayScore: aScore,
      golsTimeA: golsA, golsTimeB: golsB,
      totalGols: hScore + aScore,
      resultado,
      mandanteJogouEmCasa: casaEhMandanteHoje, // ✅ NOVO — pra separar H2H por mando
      eventId: ev.id,
    }
  })

  const totalJogos        = confrontos.length
  const vitoriasMandante  = confrontos.filter(c => c.resultado === 'M').length
  const vitoriasVisitante = confrontos.filter(c => c.resultado === 'V').length
  const empates           = confrontos.filter(c => c.resultado === 'E').length
  const mediaGolsTotais   = parseFloat((confrontos.reduce((s, c) => s + c.totalGols, 0) / totalJogos).toFixed(2))
  const bttsRateH2H       = Math.round((confrontos.filter(c => c.golsTimeA > 0 && c.golsTimeB > 0).length / totalJogos) * 100)
  const over15RateH2H     = Math.round((confrontos.filter(c => c.totalGols >= 2).length / totalJogos) * 100)
  const over25RateH2H     = Math.round((confrontos.filter(c => c.totalGols >= 3).length / totalJogos) * 100)
  const over35RateH2H     = Math.round((confrontos.filter(c => c.totalGols >= 4).length / totalJogos) * 100) // ✅ NOVO — paridade com fetchH2H

  // "Séries" estilo SofaScore (menos de X cartões / mais de Y escanteios
  // nos confrontos) — best-effort: busca estatística de cada jogo passado.
  // Mais lento (1 chamada extra por jogo do histórico), por isso limitado
  // aos jogos já filtrados acima (no máx. `limiteJogos`).
  let statsSeries = null
  try {
    // ✅ Anexa cartoesTotal/escanteiosTotal DIRETO em cada confronto `c`
    // (em vez de empilhar num array paralelo) — elimina o bug de
    // desalinhamento quando algum jogo não retorna `stats` (o antigo
    // `continue` pulava o push e desalinhava os índices).
    for (const c of confrontos) {
      const stats  = await sofaFetch(`/event/${c.eventId}/statistics`)
      const grupos = stats?.statistics
      if (!grupos) continue
      const all = grupos.find(g => ['ALL', 'all', 'FullTime'].includes(g.period)) ?? grupos[0]
      let cartoesTotal = 0, escanteiosTotal = 0
      for (const grupo of all?.groups ?? []) {
        for (const item of grupo.statisticsItems ?? []) {
          const nome = (item.name ?? '').toLowerCase()
          const casa = parseInt(item.home) || 0
          const fora = parseInt(item.away) || 0
          if (nome.includes('yellow card') || nome.includes('red card')) cartoesTotal += casa + fora
          if (nome.includes('corner')) escanteiosTotal = casa + fora
        }
      }
      c.cartoesTotal    = cartoesTotal
      c.escanteiosTotal = escanteiosTotal
      await new Promise(r => setTimeout(r, 150))
    }
    const comStats = confrontos.filter(c => c.cartoesTotal != null)
    if (comStats.length) {
      statsSeries = {
        amostraSeries:        comStats.length,
        menosDe4_5Cartoes:    `${comStats.filter(s => s.cartoesTotal < 4.5).length}/${comStats.length}`,
        maisDe10_5Escanteios: `${comStats.filter(s => s.escanteiosTotal > 10.5).length}/${comStats.length}`,
      }
    }
  } catch { /* segue sem séries — não é crítico */ }

  return {
    confrontos, totalJogos, semDados: false,
    vitoriasMandante, vitoriasVisitante, empates,
    probMH2H: Math.round((vitoriasMandante  / totalJogos) * 100),
    probEH2H: Math.round((empates           / totalJogos) * 100),
    probVH2H: Math.round((vitoriasVisitante / totalJogos) * 100),
    mediaGolsTotais, bttsRateH2H, over15RateH2H, over25RateH2H, over35RateH2H,
    ...analisarH2HAvancado(confrontos), // ✅ NOVO — mando, sequência, tendência
    statsSeries,
    fonte: 'sofascore_h2h_completo',
  }
}

function getBrazilDayRangeTimestamps() {
  // Mesmo critério de "dia BRT" usado no groqService.js (corte às 3h UTC)
  const now = new Date()
  const utcH = now.getUTCHours()
  const start = new Date(now)
  start.setUTCMinutes(0, 0, 0)
  if (utcH >= 3) { start.setUTCHours(3) }
  else { start.setUTCDate(start.getUTCDate() - 1); start.setUTCHours(3) }
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000)
  return { startTs: Math.floor(start.getTime() / 1000), endTs: Math.floor(end.getTime() / 1000) }
}
 
async function getSeasonIdAtual(tournamentId) {
  const data = await sofaFetch(`/unique-tournament/${tournamentId}/seasons`)
  const id = data?.seasons?.[0]?.id ?? null
  if (!id) console.warn(`[SofaScore] sem season para o torneio ${tournamentId}. Resposta:`, JSON.stringify(data)?.slice(0, 200))
  return id
}
 
// ─────────────────────────────────────────────────────────────
// JOGOS DE HOJE (ou amanhã, se não houver hoje) DE UMA LIGA
// Usado pela Etapa 1
// ─────────────────────────────────────────────────────────────
// incluirAmanha: quando true, inclui explicitamente os jogos do dia seguinte
// JUNTO com os de hoje (além do fallback automático de sempre, que busca o
// próximo dia com jogo quando não há nenhum jogo hoje).
export async function getJogosDoDia(liga, incluirAmanha = false) {
  const tournamentId = SOFASCORE_TOURNAMENTS[liga]
  if (!tournamentId) return { erro: `Liga '${liga}' não suportada` }
 
  const seasonId = await getSeasonIdAtual(tournamentId)
  if (!seasonId) return { erro: 'Season não encontrada' }
 
  // Busca 2 páginas de próximos jogos (cobre folgas de rodada)
  const [pag0, pag1] = await Promise.all([
    sofaFetch(`/unique-tournament/${tournamentId}/season/${seasonId}/events/next/0`),
    sofaFetch(`/unique-tournament/${tournamentId}/season/${seasonId}/events/next/1`),
  ])
 
  const todosEventos = [...(pag0?.events ?? []), ...(pag1?.events ?? [])]
  if (!todosEventos.length) return { erro: `Nenhum jogo futuro encontrado para '${liga}'` }
 
  const { startTs, endTs } = getBrazilDayRangeTimestamps()
  const jogosHoje = todosEventos.filter(ev => ev.startTimestamp >= startTs && ev.startTimestamp < endTs)

  let jogosAmanha  = []
  let usandoAmanha = false // true = TODOS os jogos retornados são de amanhã (fallback, sem jogo hoje)

  if (!jogosHoje.length) {
    // tenta o próximo dia com jogo (pode não ser exatamente amanhã se for pausa de rodada)
    const futuros = todosEventos
      .filter(ev => ev.startTimestamp >= endTs)
      .sort((a, b) => a.startTimestamp - b.startTimestamp)
    if (!futuros.length) return { erro: `Nenhum jogo futuro encontrado para '${liga}'` }
    const proximoDiaTs = futuros[0].startTimestamp
    const proxStart = proximoDiaTs - (proximoDiaTs % 86400)
    jogosAmanha = futuros.filter(ev => ev.startTimestamp >= proxStart && ev.startTimestamp < proxStart + 86400)
    usandoAmanha = true
  } else if (incluirAmanha) {
    // Há jogos hoje, mas o usuário também pediu explicitamente os de amanhã
    const amanhaStart = endTs
    const amanhaEnd   = endTs + 86400
    jogosAmanha = todosEventos.filter(ev => ev.startTimestamp >= amanhaStart && ev.startTimestamp < amanhaEnd)
  }

  const jogos = [
    ...jogosHoje.map(ev => ({
      id: ev.id, mandante: ev.homeTeam?.name ?? 'Time A', visitante: ev.awayTeam?.name ?? 'Time B',
      mandanteId: ev.homeTeam?.id, visitanteId: ev.awayTeam?.id,
      startTimestamp: ev.startTimestamp, usandoAmanha: false,
    })),
    ...jogosAmanha.map(ev => ({
      id: ev.id, mandante: ev.homeTeam?.name ?? 'Time A', visitante: ev.awayTeam?.name ?? 'Time B',
      mandanteId: ev.homeTeam?.id, visitanteId: ev.awayTeam?.id,
      startTimestamp: ev.startTimestamp, usandoAmanha: usandoAmanha || true && !jogosHoje.length ? true : true,
    })),
  ]
  // (o campo usandoAmanha de cada jogo de amanhã é sempre true; jogos de hoje sempre false)
  jogos.forEach(j => { if (jogosAmanha.some(a => a.id === j.id)) j.usandoAmanha = true })
 
  return { liga, fonte: 'sofascore', jogos }
}
 
// ─────────────────────────────────────────────────────────────
// ÚLTIMOS JOGOS FINALIZADOS DE UM TIME (qualquer competição,
// igual ao comportamento do football-data.org no groqService.js)
// ─────────────────────────────────────────────────────────────
export async function getUltimosJogosTime(teamId, limit = 8) {
  if (!teamId) return []
 
  // SofaScore pagina por "página" (0 = mais recentes)
  const data = await sofaFetch(`/team/${teamId}/events/last/0`)
  const eventos = data?.events ?? []
 
  const finalizados = eventos
    .filter(ev => ev.status?.type === 'finished' &&
                  typeof ev.homeScore?.current === 'number' &&
                  typeof ev.awayScore?.current === 'number')
    .sort((a, b) => b.startTimestamp - a.startTimestamp)
    .slice(0, limit)
 
  return finalizados.map(ev => {
    const isHome       = ev.homeTeam?.id === teamId
    const hScore       = ev.homeScore.current
    const aScore       = ev.awayScore.current
    const golsMarcados = isHome ? hScore : aScore
    const golsSofridos = isHome ? aScore : hScore
 
    let resultado
    if (hScore === aScore) resultado = 'E'
    else if (isHome)       resultado = hScore > aScore ? 'V' : 'D'
    else                   resultado = aScore > hScore ? 'V' : 'D'
 
    return {
      resultado, golsMarcados, golsSofridos,
      totalGols:  hScore + aScore,
      eventId:    ev.id,
      data:       ev.startTimestamp,
      competicao: ev.tournament?.name ?? 'Desconhecida',
      adversario: isHome ? (ev.awayTeam?.name ?? '?') : (ev.homeTeam?.name ?? '?'),
    }
  })
}
 
// ─────────────────────────────────────────────────────────────
// H2H — tenta obter confrontos diretos entre os dois times
// via o evento de hoje. Degrada com segurança (semDados: true)
// se a API não retornar histórico detalhado.
// ─────────────────────────────────────────────────────────────
export async function getH2HEvento(eventId, mandanteId, visitanteId) {
  if (!eventId) return { confrontos: [], totalJogos: 0, semDados: true }

  const data = await sofaFetch(`/event/${eventId}/h2h`)
  const duelo = data?.teamDuel
  if (!duelo) return { confrontos: [], totalJogos: 0, semDados: true }

  const totalJogos = (duelo.homeWins ?? 0) + (duelo.awayWins ?? 0) + (duelo.draws ?? 0)
  if (totalJogos < 3) return { confrontos: [], totalJogos: 0, semDados: true }

  // O SofaScore só devolve o resumo agregado nesse endpoint (sem placar por jogo),
  // então NÃO alimentamos o cálculo de gols (semDados: true evita corromper o λ).
  // Mas guardamos o resumo de vitórias/empates para exibir na interface.
  return {
    confrontos: [],
    totalJogos: 0,
    semDados: true,
    resumoSemGols: {
      vitoriasMandante: duelo.homeWins ?? 0,
      vitoriasVisitante: duelo.awayWins ?? 0,
      empates: duelo.draws ?? 0,
      totalJogos,
      probMH2H: Math.round(((duelo.homeWins ?? 0) / totalJogos) * 100),
      probEH2H: Math.round(((duelo.draws ?? 0) / totalJogos) * 100),
      probVH2H: Math.round(((duelo.awayWins ?? 0) / totalJogos) * 100),
    },
  }
}

// ═════════════════════════════════════════════════════════════
// ✅ NOVO — JOGOS AO VIVO
// Usa /sport/football/events/live (todos os jogos do mundo em
// andamento agora) e filtra pelos torneios que o sistema suporta.
// Passe todasLigas = true pra não filtrar nada.
// ═════════════════════════════════════════════════════════════

// id do unique-tournament → chave interna usada no resto do sistema
const TOURNAMENT_ID_TO_LIGA = Object.fromEntries(
  Object.entries(SOFASCORE_TOURNAMENTS).map(([liga, id]) => [id, liga])
)

const NOME_LIGA_PT = {
  brasileirao: 'Brasileirão Série A',
  serie_b: 'Brasileirão Série B',
  sudamericana: 'Copa Sul-Americana',
  libertadores: 'CONMEBOL Libertadores',
  premier_league: 'Premier League',
  la_liga: 'La Liga',
  serie_a: 'Serie A (Itália)',
  bundesliga: 'Bundesliga',
  ligue_1: 'Ligue 1',
  champions_league: 'UEFA Champions League',
  europa_league: 'UEFA Europa League',
  nations_league: 'UEFA Nations League',
  amistosos: 'Amistosos Internacionais',
}

// Minuto aproximado do jogo. O SofaScore não devolve o minuto pronto:
// ele manda o timestamp de início do período atual + o "offset" do período.
function calcularMinuto(ev) {
  const t = ev?.time ?? {}
  const inicioPeriodo = t.currentPeriodStartTimestamp
  const statusCode = ev?.status?.code

  // Períodos parados (intervalo, fim de jogo) não têm minuto correndo
  if (statusCode === 31) return 'INT'          // intervalo
  if (ev?.status?.type === 'finished') return 'FIM'
  if (!inicioPeriodo) return null

  // offset do período: 0 no 1º tempo, 45 no 2º, 90/105 na prorrogação
  const offset = (t.initial != null ? t.initial : 0) / 60
  const decorrido = Math.floor((Date.now() / 1000 - inicioPeriodo) / 60)
  const minuto = Math.max(0, Math.floor(offset) + decorrido)

  // teto por período pra não mostrar "97'" no primeiro tempo
  const maxPeriodo = t.max != null ? Math.floor(t.max / 60) : null
  if (maxPeriodo && minuto > maxPeriodo) return `${maxPeriodo}+`
  return String(minuto)
}

export async function getJogosAoVivo(todasLigas = false) {
  const data = await sofaFetch('/sport/football/events/live')
  const eventos = data?.events ?? []
  if (!eventos.length) return { jogos: [], total: 0, fonte: 'sofascore_live' }

  const filtrados = eventos.filter(ev => {
    if (todasLigas) return true
    const utId = ev.tournament?.uniqueTournament?.id
    return utId != null && TOURNAMENT_ID_TO_LIGA[utId] != null
  })

  const jogos = filtrados.map(ev => {
    const utId = ev.tournament?.uniqueTournament?.id
    const ligaKey = TOURNAMENT_ID_TO_LIGA[utId] ?? null

    return {
      id: ev.id,
      liga: ligaKey,
      competicao: ligaKey
        ? (NOME_LIGA_PT[ligaKey] ?? ligaKey)
        : (ev.tournament?.uniqueTournament?.name ?? ev.tournament?.name ?? 'Desconhecida'),
      pais: ev.tournament?.category?.name ?? null,
      mandante: ev.homeTeam?.name ?? 'Time A',
      visitante: ev.awayTeam?.name ?? 'Time B',
      mandanteId: ev.homeTeam?.id ?? null,
      visitanteId: ev.awayTeam?.id ?? null,
      placarMandante: ev.homeScore?.current ?? 0,
      placarVisitante: ev.awayScore?.current ?? 0,
      placarPrimeiroTempoMandante: ev.homeScore?.period1 ?? null,
      placarPrimeiroTempoVisitante: ev.awayScore?.period1 ?? null,
      status: ev.status?.description ?? '',
      statusType: ev.status?.type ?? '',
      minuto: calcularMinuto(ev),
      startTimestamp: ev.startTimestamp ?? null,
      // usado pela tela pra destacar quem está "por cima"
      vencendo: (ev.homeScore?.current ?? 0) === (ev.awayScore?.current ?? 0)
        ? 'empate'
        : (ev.homeScore?.current ?? 0) > (ev.awayScore?.current ?? 0) ? 'mandante' : 'visitante',
    }
  })

  // Ordena: ligas conhecidas primeiro, depois por minuto decrescente
  jogos.sort((a, b) => {
    if (!!a.liga !== !!b.liga) return a.liga ? -1 : 1
    const ma = parseInt(a.minuto) || 0
    const mb = parseInt(b.minuto) || 0
    return mb - ma
  })

  return { jogos, total: jogos.length, fonte: 'sofascore_live' }
}

// ═════════════════════════════════════════════════════════════
// ✅ NOVO — Estatísticas AO VIVO de um jogo específico
// (reaproveita getPartidaStats, mas acrescenta minuto/placar ao vivo)
// ═════════════════════════════════════════════════════════════
export async function getEstatisticasAoVivo(matchId) {
  if (!matchId) return { erro: 'matchId obrigatório' }

  const [eventData, stats] = await Promise.all([
    sofaFetch(`/event/${matchId}`),
    getPartidaStats(matchId),
  ])

  const ev = eventData?.event
  if (!ev) return { erro: `Partida ${matchId} não encontrada` }

  return {
    ...(stats?.erro ? {} : stats),
    id: ev.id,
    mandante: ev.homeTeam?.name ?? 'Time A',
    visitante: ev.awayTeam?.name ?? 'Time B',
    placarMandante: ev.homeScore?.current ?? 0,
    placarVisitante: ev.awayScore?.current ?? 0,
    minuto: calcularMinuto(ev),
    status: ev.status?.description ?? '',
    statusType: ev.status?.type ?? '',
    competicao: ev.tournament?.uniqueTournament?.name ?? ev.tournament?.name ?? '',
    fonte: 'sofascore_live_stats',
  }
}

// ═════════════════════════════════════════════════════════════
// ✅ NOVO — ODDS DO SOFASCORE
// Endpoint /event/{id}/odds/1/all devolve as odds em formato
// FRACIONÁRIO ("5/2"), então convertemos para decimal aqui.
// ═════════════════════════════════════════════════════════════
function fracionarioParaDecimal(fractional) {
  if (!fractional) return null
  const txt = String(fractional).trim()
  if (txt === '-' || txt === '') return null
  if (!txt.includes('/')) {
    const n = parseFloat(txt)
    return Number.isFinite(n) ? parseFloat(n.toFixed(2)) : null
  }
  const [num, den] = txt.split('/').map(v => parseFloat(v))
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null
  return parseFloat((num / den + 1).toFixed(2))
}

const probImplicita = odd => (odd && odd > 1 ? Math.round((1 / odd) * 1000) / 10 : null)

// ═════════════════════════════════════════════════════════════
// ✅ TRADUÇÃO DOS NOMES DE MERCADO (SofaScore devolve tudo em inglês)
// 1) MERCADOS_PT_EXATO: nomes que batem 100% com o que a SofaScore manda
//    → tradução direta, sem adivinhação.
// 2) MERCADOS_PT_PARCIAL: pedaços/termos comuns que aparecem dentro de
//    nomes compostos (ex.: "1st Half - Both Teams To Score"). Serve de
//    rede de segurança para mercados que não estão no mapa exato acima,
//    trocando os termos conhecidos e mantendo o resto como veio.
// ═════════════════════════════════════════════════════════════
const MERCADOS_PT_EXATO = {
  'full time':                 'Resultado Final',
  'match winner':              'Vencedor da Partida',
  '1x2':                       'Resultado Final (1X2)',
  'double chance':             'Dupla Chance',
  'draw no bet':               'Empate Anula a Aposta',
  'both teams to score':       'Ambas as Equipes Marcam',
  'both teams to score - 1st half': 'Ambas Marcam no 1º Tempo',
  'both teams to score - 2nd half': 'Ambas Marcam no 2º Tempo',
  'match goals':                'Total de Gols da Partida',
  'total goals':                'Total de Gols',
  'over/under':                 'Mais/Menos de Gols',
  '1st half':                   '1º Tempo',
  '2nd half':                   '2º Tempo',
  'half time':                  'Resultado do 1º Tempo',
  'half time/full time':        '1º Tempo / Resultado Final',
  'ht/ft':                      '1º Tempo / Resultado Final',
  'correct score':              'Placar Exato',
  'asian handicap':             'Handicap Asiático',
  'european handicap':          'Handicap Europeu',
  'handicap':                   'Handicap',
  'team to score first':        'Time que Marca Primeiro',
  'first team to score':        'Time que Marca Primeiro',
  'last team to score':         'Time que Marca por Último',
  'clean sheet':                'Não Sofre Gol (Clean Sheet)',
  'win to nil':                 'Vence sem Sofrer Gol',
  'highest scoring half':       'Tempo com Mais Gols',
  'odd/even':                   'Ímpar/Par (Total de Gols)',
  'home team total goals':      'Total de Gols do Mandante',
  'away team total goals':      'Total de Gols do Visitante',
  'corners':                    'Escanteios',
  'total corners':              'Total de Escanteios',
  'cards':                      'Cartões',
  'total cards':                'Total de Cartões',
  'player to score':            'Jogador para Marcar',
  'anytime goalscorer':         'Marcador a Qualquer Momento',
  'exact number of goals':      'Número Exato de Gols',
  'result and both teams to score': 'Resultado e Ambas Marcam',
  'result/total goals':         'Resultado e Total de Gols',
  'draw no bet - 1st half':     'Empate Anula (1º Tempo)',
  'draw no bet - 2nd half':     'Empate Anula (2º Tempo)',
  'to win either half':         'Vence pelo Menos um Tempo',
  'win both halves':            'Vence os Dois Tempos',
  'penalty awarded':            'Pênalti na Partida',
  'red card':                   'Cartão Vermelho na Partida',
  'total goals - 1st half':     'Total de Gols no 1º Tempo',
  'total goals - 2nd half':     'Total de Gols no 2º Tempo',
  // ✅ NOVO — mercados de TÊNIS (mesmo endpoint /event/{id}/odds/1/all,
  // sport-agnóstico — só nunca tinha entrado nenhum nome de tênis aqui,
  // então caía tudo em inglês por não bater com nada em MERCADOS_PT_PARCIAL).
  'match winner':               'Vencedor da Partida',
  'to win match':               'Vencedor da Partida',
  'total games':                'Total de Games',
  'set betting':                'Placar de Sets',
  'correct score (sets)':       'Placar de Sets',
  'total sets':                 'Total de Sets',
  '1st set winner':             'Vencedor do 1º Set',
  'set 1 winner':               'Vencedor do 1º Set',
}

// Trocas parciais (ordem importa: mais específico primeiro)
const MERCADOS_PT_PARCIAL = [
  [/both teams to score/gi, 'Ambas as Equipes Marcam'],
  [/draw no bet/gi,        'Empate Anula a Aposta'],
  [/match goals/gi,        'Total de Gols'],
  [/total goals/gi,        'Total de Gols'],
  [/over\/under/gi,        'Mais/Menos de Gols'],
  [/1st half/gi,           '1º Tempo'],
  [/2nd half/gi,           '2º Tempo'],
  [/half time/gi,          'Intervalo'],
  [/full time/gi,          'Final da Partida'],
  [/double chance/gi,      'Dupla Chance'],
  [/correct score/gi,      'Placar Exato'],
  [/asian handicap/gi,     'Handicap Asiático'],
  [/european handicap/gi,  'Handicap Europeu'],
  [/handicap/gi,           'Handicap'],
  [/clean sheet/gi,        'Não Sofre Gol'],
  [/win to nil/gi,         'Vence sem Sofrer Gol'],
  [/odd\/even/gi,          'Ímpar/Par'],
  [/corners/gi,            'Escanteios'],
  [/cards/gi,              'Cartões'],
  [/home team/gi,          'Mandante'],
  [/away team/gi,          'Visitante'],
  [/goalscorer/gi,         'Marcador'],
  [/to score first/gi,     'Marca Primeiro'],
  [/win both halves/gi,    'Vence os Dois Tempos'],
]

/** Traduz o nome de um mercado de odds (SofaScore manda tudo em inglês).
 *  1º tenta bater exato com MERCADOS_PT_EXATO; se não achar, aplica as
 *  trocas parciais de MERCADOS_PT_PARCIAL; se nada bater, devolve o nome
 *  original (melhor mostrar em inglês do que quebrar a tela). */
function traduzirMercado(nomeOriginal) {
  if (!nomeOriginal) return 'Mercado'
  const chave = nomeOriginal.trim().toLowerCase()
  if (MERCADOS_PT_EXATO[chave]) return MERCADOS_PT_EXATO[chave]

  let traduzido = nomeOriginal
  let mudou = false
  for (const [regex, pt] of MERCADOS_PT_PARCIAL) {
    if (regex.test(traduzido)) { traduzido = traduzido.replace(regex, pt); mudou = true }
  }
  return mudou ? traduzido : nomeOriginal
}

// Normaliza o rótulo das escolhas ("1"/"X"/"2", "Over"/"Under", "Yes"/"No")
function rotuloOpcao(choice, market) {
  const nome = String(choice?.name ?? '').trim()
  const mapa = { '1': '1 (Casa)', 'X': 'Empate', '2': '2 (Fora)', 'Yes': 'Sim', 'No': 'Não', 'Over': 'Mais de', 'Under': 'Menos de' }
  const base = mapa[nome] ?? nome
  const linha = market?.choiceGroup ?? null
  return linha && (nome === 'Over' || nome === 'Under') ? `${base} ${linha}` : base
}

export async function getOddsEvento(matchId) {
  if (!matchId) return { erro: 'matchId obrigatório' }

  const data = await sofaFetch(`/event/${matchId}/odds/1/all`)
  const markets = data?.markets ?? []
  if (!markets.length) return { erro: `Sem odds disponíveis para a partida ${matchId}` }

  const mercados = markets
    .map(m => {
      const opcoes = (m.choices ?? []).map(c => {
        const odd = fracionarioParaDecimal(c.fractionalValue)
        return {
          nome: rotuloOpcao(c, m),
          odd,
          probImplicita: probImplicita(odd),
          vencedora: c.winning ?? null,
        }
      }).filter(o => o.odd != null)

      if (!opcoes.length) return null

      // Margem da casa (overround): soma das probabilidades implícitas - 100%
      const somaProb = opcoes.reduce((s, o) => s + (o.probImplicita ?? 0), 0)

      return {
        nome: traduzirMercado(m.marketName),
        nomeOriginal: m.marketName ?? '', // usado só internamente p/ localizar 1X2 e Gols (removido antes de responder)
        linha: m.choiceGroup ?? null,
        aoVivo: m.isLive ?? false,
        suspenso: !!m.suspended,
        opcoes,
        margemCasa: opcoes.length > 1 ? parseFloat((somaProb - 100).toFixed(1)) : null,
      }
    })
    .filter(Boolean)

  // Atalhos pros dois mercados mais usados (a busca usa o nome ORIGINAL em
  // inglês, guardado em m.nomeOriginal, porque m.nome já vem traduzido)
  const m1x2 = mercados.find(m => /full time|match winner|1x2/i.test(m.nomeOriginal))
  const mGols = mercados.find(m => /match goals|total goals|over\/under/i.test(m.nomeOriginal) && m.linha === '2.5')

  return {
    matchId,
    mercados: mercados.map(({ nomeOriginal, ...resto }) => resto), // não expõe o nome em inglês pro front
    resumo: {
      mandante: m1x2?.opcoes?.find(o => o.nome.startsWith('1'))?.odd ?? null,
      empate: m1x2?.opcoes?.find(o => o.nome === 'Empate')?.odd ?? null,
      visitante: m1x2?.opcoes?.find(o => o.nome.startsWith('2'))?.odd ?? null,
      over25: mGols?.opcoes?.find(o => o.nome.startsWith('Mais de'))?.odd ?? null,
      under25: mGols?.opcoes?.find(o => o.nome.startsWith('Menos de'))?.odd ?? null,
      margemCasa1x2: m1x2?.margemCasa ?? null,
    },
    fonte: 'sofascore_odds',
  }
}

// ═════════════════════════════════════════════════════════════
// ✅ NOVO — Odds de TODOS os próximos jogos de uma liga
// Junta getProximasPartidasLiga + getOddsEvento em lote, com
// intervalo entre chamadas pra não tomar rate-limit do SofaScore.
// ═════════════════════════════════════════════════════════════
export async function getOddsLiga(liga, limite = 12) {
  const { partidas, erro } = await getProximasPartidasLiga(liga)
  if (erro) return { erro }
  if (!partidas?.length) return { erro: `Nenhum jogo futuro encontrado para '${liga}'` }

  const alvo = partidas.slice(0, limite)
  const jogos = []

  for (const p of alvo) {
    const odds = await getOddsEvento(p.match_id)
    jogos.push({
      id: p.match_id,
      mandante: p.time_casa,
      visitante: p.time_fora,
      mandanteId: p.mandante_id,
      visitanteId: p.visitante_id,
      startTimestamp: p.startTimestamp ?? null,
      odds: odds?.erro ? null : odds.resumo,
      mercados: odds?.erro ? [] : odds.mercados,
      semOdds: !!odds?.erro,
    })
    await new Promise(r => setTimeout(r, 180)) // evita rate-limit
  }

  const comOdds = jogos.filter(j => !j.semOdds).length

  return {
    liga,
    jogos,
    total: jogos.length,
    comOdds,
    semOdds: jogos.length - comOdds,
    fonte: 'sofascore_odds_liga',
  }
}