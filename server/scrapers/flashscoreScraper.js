// server/scrapers/flashscoreScraper.js
// ─────────────────────────────────────────────────────────────
// Fonte de "jogos do dia" e "jogos ao vivo" via FlashLive Sports
// (RapidAPI) — mesma API já usada em flashliveScraper.js para
// cross-check, agora promovida a FONTE PRINCIPAL, substituindo o
// fonte anterior (SofaScore, removida do projeto).
//
// ⚠️ IMPORTANTE: isso usa a API OFICIAL via RapidAPI, com chave
// própria (FLASHLIVE_KEY) — não faz scraping do site flashscore.com.br.
//
// ⚠️ ATENÇÃO — nomes de campo não 100% documentados pela RapidAPI:
// A FlashLive não documenta publicamente o nome exato do campo que
// identifica CADA TORNEIO dentro de events/list (varia entre contas/
// versões: pode vir como NAME, CATEGORY_NAME, TOURNAMENT_NAME...).
// Por isso, nomeTorneio() tenta várias alternativas. Se depois de rodar
// em produção você perceber que uma liga nunca acha jogos (sempre cai em
// "erro"), rode a rota de diagnóstico abaixo e me mande o resultado —
// ela devolve os nomes de torneio crus que a API está retornando hoje,
// pra eu ajustar o mapa de palavras-chave (LIGA_MATCHERS).
// ─────────────────────────────────────────────────────────────
const FLASHLIVE_HOST = 'flashlive-sports.p.rapidapi.com'
const FLASHLIVE_KEY  = process.env.FLASHLIVE_KEY || process.env.SPORT_KEY || ''
const SPORT_SOCCER   = 1

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

const norm = s => String(s || '').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9 ]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()

async function flFetch(endpoint, params = {}) {
  if (!FLASHLIVE_KEY) return null
  const query = new URLSearchParams({ locale: 'pt_BR', ...params }).toString()
  try {
    const res = await fetch(`https://${FLASHLIVE_HOST}/v1/${endpoint}?${query}`, {
      headers: { 'x-rapidapi-host': FLASHLIVE_HOST, 'x-rapidapi-key': FLASHLIVE_KEY },
    })
    if (!res.ok) {
      console.warn(`[FlashScore/FlashLive] HTTP ${res.status} em ${endpoint}`)
      return null
    }
    const data = await res.json()
    return data?.DATA ?? null
  } catch (err) {
    console.warn('[FlashScore/FlashLive] fetch falhou:', err.message)
    return null
  }
}

// Mesmas chaves de liga já usadas pelo resto do sistema (LIGA_MAP em
// sportsDataRoutes.js), mapeadas para palavras-chave que devem aparecer
// no nome do torneio devolvido pela FlashLive.
// Identificação de liga usando o CAMPO PAÍS ("Brasil", "Inglaterra"...) +
// palavras-chave no nome da competição, já em PORTUGUÊS (confirmado via
// /flashlive/diagnostico em 25/09/2026 — a API devolve nomes como
// "Brasil: Brasileirão Série B" e "Europa: Liga das Nações da UEFA").
// Usar o país junto evita colisão entre "Serie A" da Itália e "Série A" do
// Brasil (o acento some depois do norm()).
const LIGA_MATCHERS = {
  brasileirao:      { pais: 'brasil',    nome: ['brasileirao'], excluir: ['serie b', 'sub-20', 'sub 20', 'feminin'] },
  serie_b:          { pais: 'brasil',    nome: ['brasileirao'], incluir: ['serie b'] },
  sudamericana:      { pais: null,        nome: ['sul-americana', 'sudamericana'] },
  libertadores:      { pais: null,        nome: ['libertadores'] },
  premier_league:    { pais: 'inglaterra', nome: ['premier league'], excluir: ['feminin'] },
  la_liga:           { pais: 'espanha',   nome: ['laliga'], excluir: ['laliga2'] },
  serie_a:           { pais: 'italia',    nome: ['serie a'] },
  bundesliga:        { pais: 'alemanha',  nome: ['bundesliga'] },
  ligue_1:           { pais: 'franca',    nome: ['ligue 1'] },
  champions_league:  { pais: 'europa',    nome: ['liga dos campeoes', 'champions league'] },
  europa_league:     { pais: 'europa',    nome: ['liga europa'] },
  nations_league:    { pais: 'europa',    nome: ['liga das nacoes'] },
  amistosos:         { pais: 'mundo',     nome: ['amistoso internacional'] },
  copa_mundo:        { pais: null,        nome: ['copa do mundo'], excluir: ['eliminat', 'feminin', 'sub-', 'sub ', 'clubes'] },
  eliminatorias:     { pais: null,        nome: ['eliminat'], incluir: ['copa do mundo'] },
  copa_america:      { pais: null,        nome: ['copa america'], excluir: ['feminin', 'sub-', 'sub '] },
}

function bateLiga(torneio, matcher) {
  const pais = norm(torneio.CATEGORY_NAME ?? '')
  const nome = nomeTorneio(torneio)
  if (matcher.pais && pais !== matcher.pais) return false
  if (matcher.nome && !matcher.nome.some(kw => nome.includes(kw))) return false
  if (matcher.excluir && matcher.excluir.some(kw => nome.includes(kw))) return false
  if (matcher.incluir && !matcher.incluir.some(kw => nome.includes(kw))) return false
  return true
}

function nomeTorneio(torneio) {
  return norm(
    torneio.NAME ?? torneio.CATEGORY_NAME ?? torneio.TOURNAMENT_NAME ??
    torneio.TOURNAMENT_STAGE_NAME ?? torneio.STAGE_NAME ?? ''
  )
}

function extrairStartTimestamp(ev) {
  const bruto = ev.START_TIME ?? ev.START_UTC_TIME ?? ev.START_TIMESTAMP ?? ev.MATCH_TIME ?? null
  if (bruto == null) return null
  const n = Number(bruto)
  if (!Number.isFinite(n)) return null
  // heurística: se vier em milissegundos (13 dígitos), converte pra segundos
  return n > 1e12 ? Math.floor(n / 1000) : n
}

async function buscarEventosDoDia(indentDays) {
  return await flFetch('events/list', {
    sport_id: SPORT_SOCCER, timezone: -3, indent_days: indentDays,
  })
}

// ─────────────────────────────────────────────────────────────
// JOGOS DE HOJE (ou amanhã) DE UMA LIGA — mesmo formato de retorno
// que getJogosDoDia() do flashscoreScraper.js, para ser um substituto
// direto nas rotas que já existem.
// ─────────────────────────────────────────────────────────────
export async function getJogosDoDia(liga, incluirAmanha = false) {
  const matcher = LIGA_MATCHERS[liga]
  if (!matcher) return { erro: `Liga '${liga}' não suportada (FlashLive)` }

  const eventosHoje = await buscarEventosDoDia(0)
  if (!eventosHoje) return { erro: 'FlashLive não respondeu (verifique FLASHLIVE_KEY)' }

  const extrairJogosDoTorneio = (grupos, usandoAmanha) => {
    const jogos = []
    for (const torneio of grupos) {
      if (!bateLiga(torneio, matcher)) continue
      for (const ev of torneio.EVENTS ?? []) {
        jogos.push({
          id: ev.EVENT_ID,
          mandante: ev.HOME_NAME ?? 'Time A',
          visitante: ev.AWAY_NAME ?? 'Time B',
          mandanteId: ev.HOME_PARTICIPANT_IDS?.[0] ?? null,
          visitanteId: ev.AWAY_PARTICIPANT_IDS?.[0] ?? null,
          startTimestamp: extrairStartTimestamp(ev),
          usandoAmanha,
        })
      }
    }
    return jogos
  }

  let jogos = extrairJogosDoTorneio(eventosHoje, false)

  // Sem jogo hoje, OU o usuário pediu amanhã também → busca o dia seguinte
  if (!jogos.length || incluirAmanha) {
    const eventosAmanha = await buscarEventosDoDia(1)
    if (eventosAmanha) {
      const jogosAmanha = extrairJogosDoTorneio(eventosAmanha, true)
      jogos = jogos.length ? [...jogos, ...jogosAmanha] : jogosAmanha
    }
  }

  if (!jogos.length) return { erro: `Nenhum jogo encontrado para '${liga}' (FlashLive)` }

  return { liga, fonte: 'flashlive', jogos }
}

// ─────────────────────────────────────────────────────────────
// JOGOS AO VIVO AGORA (todas as ligas, ou só as suportadas)
// ─────────────────────────────────────────────────────────────
// ⚠️ Os valores possíveis de STAGE_TYPE para partidas em andamento não são
// 100% documentados — tratamos como "ao vivo" tudo que NÃO for claramente
// "ainda não começou" nem "já terminou"/cancelado. Se perceber jogos
// errados aparecendo aqui (ou faltando), rode o diagnóstico abaixo.
const STATUS_NAO_INICIADO = new Set(['NOT_STARTED', 'SCHEDULED', 'FIXTURE'])
const STATUS_ENCERRADO    = new Set(['FINISHED', 'CANCELLED', 'POSTPONED', 'ABANDONED', 'WALKOVER'])

export async function getJogosAoVivo(todas = false) {
  const eventosHoje = await buscarEventosDoDia(0)
  if (!eventosHoje) return { erro: 'FlashLive não respondeu (verifique FLASHLIVE_KEY)' }

  const jogos = []
  for (const torneio of eventosHoje) {
    // chave interna da liga (brasileirao, premier_league...) ou null se não for suportada
    const ligaKey = Object.keys(LIGA_MATCHERS).find(k => bateLiga(torneio, LIGA_MATCHERS[k])) ?? null
    if (!todas && !ligaKey) continue

    for (const ev of torneio.EVENTS ?? []) {
      const status = String(ev.STAGE_TYPE ?? '').toUpperCase()
      if (STATUS_NAO_INICIADO.has(status) || STATUS_ENCERRADO.has(status)) continue

      const gm  = parseInt(ev.HOME_SCORE_CURRENT ?? '') || 0
      const gv  = parseInt(ev.AWAY_SCORE_CURRENT ?? '') || 0
      const p1m = parseInt(ev.HOME_SCORE_PART_1 ?? '')
      const p1v = parseInt(ev.AWAY_SCORE_PART_1 ?? '')

      // ⚠️ Mesmos nomes de campo do contrato antigo — a tela JogosAoVivo.jsx depende deles
      jogos.push({
        id: ev.EVENT_ID,
        liga: ligaKey,
        competicao: ligaKey
          ? (NOME_LIGA_PT[ligaKey] ?? ligaKey)
          : (torneio.NAME ?? torneio.CATEGORY_NAME ?? 'Desconhecida'),
        pais: torneio.CATEGORY_NAME ?? null,
        mandante: ev.HOME_NAME ?? 'Time A',
        visitante: ev.AWAY_NAME ?? 'Time B',
        mandanteId: ev.HOME_PARTICIPANT_IDS?.[0] ?? null,
        visitanteId: ev.AWAY_PARTICIPANT_IDS?.[0] ?? null,
        placarMandante: gm,
        placarVisitante: gv,
        placarPrimeiroTempoMandante: Number.isFinite(p1m) ? p1m : null,
        placarPrimeiroTempoVisitante: Number.isFinite(p1v) ? p1v : null,
        status: statusEmPortugues(ev),
        statusType: mapearStatusFlash(ev),
        minuto: minutoDoEvento(ev),
        startTimestamp: extrairStartTimestamp(ev),
        vencendo: gm === gv ? 'empate' : gm > gv ? 'mandante' : 'visitante',
      })
    }
  }

  // Ligas conhecidas primeiro, depois por minuto decrescente
  jogos.sort((a, b) => {
    if (!!a.liga !== !!b.liga) return a.liga ? -1 : 1
    return (parseInt(b.minuto) || 0) - (parseInt(a.minuto) || 0)
  })

  return { jogos, total: jogos.length, fonte: 'flashlive_live' }
}

// ─────────────────────────────────────────────────────────────
// ✅ ODDS (futebol) — converte a resposta crua da FlashLive
// (BETTING_TYPE > PERIODS > GROUPS > MARKETS) no formato que a tela
// de Odds e o liveOddsService esperam:
//   mercados[] = { nome, linha, periodo, principal, opcoes:[{ nome, odd, probImplicita }] }
// Usa sempre UMA casa (bet365; senão a primeira com odd) pra margem fazer sentido.
// ─────────────────────────────────────────────────────────────
const BOOK_PREFERIDA = 16 // bet365
const limpo   = s => String(s ?? '').replace(/^\*+/, '').trim()
const valor   = c => { const n = Number(c?.VALUE); return Number.isFinite(n) && n > 1 ? n : null }
const probImp = odd => (odd ? Math.round((1 / odd) * 1000) / 10 : null)

const NOME_MERCADO_PT = {
  '1x2': 'Resultado final (1X2)',
  ou:    'Total de gols',
  btts:  'Ambas as equipes marcam',
  dc:    'Dupla chance',
  dnb:   'Empate anula a aposta',
  hc:    'Handicap asiático',
  ml:    'Vencedor da partida',   // tênis
  cs:    'Placar de sets',        // tênis
}

function classificarMercado(bettingType, esporte = 'futebol') {
  const k = norm(bettingType)
  if (esporte === 'tenis') {
    if (/correct score|placar exato|set betting|placar de sets/.test(k)) return 'cs'
    if (/handicap/.test(k))                                              return 'hc'
    if (/home away|casa fora|winner|vencedor|moneyline/.test(k))         return 'ml'
    if (/over|under|total|mais|menos/.test(k))                           return 'ou'
    return 'outro'
  }
  if (/handicap/.test(k))                           return 'hc'
  if (/draw no bet|empate anula|dnb/.test(k))       return 'dnb'
  if (/double|dupla/.test(k))                       return 'dc'
  if (/both|btts|ambas/.test(k))                    return 'btts'
  if (/1x2|home draw away|resultado final/.test(k)) return '1x2'
  if (/over|under|total|mais|menos/.test(k))        return 'ou'
  return 'outro'
}

// ⚠️ O nome do campo da linha (2.5, 3.5...) não está documentado — tenta os mais prováveis.
function extrairLinha(grupo, mkt) {
  const candidatos = [
    mkt?.HANDICAP?.HANDICAP_VALUE, mkt?.HANDICAP?.VALUE, mkt?.HANDICAP_VALUE, mkt?.HANDICAP,
    grupo?.HANDICAP?.HANDICAP_VALUE, grupo?.HANDICAP?.VALUE, grupo?.HANDICAP_VALUE, grupo?.HANDICAP,
    grupo?.GROUP_NAME, grupo?.NAME,
  ]
  for (const c of candidatos) {
    if (c == null || typeof c === 'object') continue
    const m = String(c).match(/-?\d+(\.\d+)?/)
    if (m) return m[0]
  }
  return null
}

function rotulosOpcoes(tipo, n, linha) {
  if (tipo === 'ml')   return ['1', '2']   // o cruzamento de tênis procura a opção que começa com "1"/"2"
  if (tipo === 'dc')   return ['Casa ou empate', 'Casa ou fora', 'Empate ou fora']
  if (tipo === 'ou')   return [`Mais de ${linha ?? ''}`.trim(), `Menos de ${linha ?? ''}`.trim()]
  if (tipo === 'btts') return ['Sim', 'Não']
  return n === 3 ? ['Casa', 'Empate', 'Fora'] : ['Casa', 'Fora']
}

function montarMercados(dados, esporte = 'futebol') {
  const saida = []
  for (const m of Array.isArray(dados) ? dados : []) {
    const tipo = classificarMercado(m.BETTING_TYPE, esporte)
    const nomeBase = (esporte === 'tenis' && tipo === 'ou')
      ? 'Total de games'
      : (NOME_MERCADO_PT[tipo] ?? (limpo(m.BETTING_TYPE) || 'Mercado'))
    const periodos = m.PERIODS ?? []
    let idxPrincipal = periodos.findIndex(p => /full|regulament|normal/i.test(limpo(p.ODDS_STAGE)))
    if (idxPrincipal < 0) idxPrincipal = 0

    periodos.forEach((periodo, pi) => {
      const estagio   = limpo(periodo.ODDS_STAGE)
      const principal = pi === idxPrincipal
      const nome      = principal ? nomeBase : `${nomeBase} · ${estagio}`
      const escolherMkt = grupo => {
        const mkts = grupo.MARKETS ?? []
        return mkts.find(x => Number(x.BOOKMAKER_ID) === BOOK_PREFERIDA && valor(x.ODD_CELL_FIRST))
            ?? mkts.find(x => valor(x.ODD_CELL_FIRST))
      }

      // Placar de sets (tênis): cada grupo é um placar (2:0, 2:1...) → junta tudo num mercado só
      if (tipo === 'cs') {
        const opcoes = []
        for (const grupo of periodo.GROUPS ?? []) {
          const mkt = escolherMkt(grupo)
          const rotulo = [grupo.GROUP_NAME, grupo.NAME, grupo.SCORE, mkt?.SCORE, grupo.HANDICAP?.VALUE, grupo.HANDICAP]
            .find(r => r != null && typeof r !== 'object' && /\d\s*[:\-]\s*\d/.test(String(r)))
          if (!mkt || !rotulo) continue
          const odd = valor(mkt.ODD_CELL_FIRST)
          opcoes.push({ nome: String(rotulo).replace(/\s+/g, ''), odd, probImplicita: probImp(odd) })
        }
        if (opcoes.length) saida.push({ tipo, nome, linha: null, periodo: estagio, principal, casa: null, opcoes })
        return
      }

      for (const grupo of periodo.GROUPS ?? []) {
        const mkt = escolherMkt(grupo)
        if (!mkt) continue

        const linha   = (tipo === 'ou' || tipo === 'hc') ? extrairLinha(grupo, mkt) : null
        const celulas = [mkt.ODD_CELL_FIRST, mkt.ODD_CELL_SECOND, mkt.ODD_CELL_THIRD].filter(c => c != null)
        const rotulos = rotulosOpcoes(tipo, celulas.length, linha)

        saida.push({
          tipo, nome, linha,
          periodo: estagio,
          principal,
          casa: mkt.BOOKMAKER_NAME ?? null,
          opcoes: celulas.map((c, i) => ({
            nome: rotulos[i] ?? `Opção ${i + 1}`,
            odd: valor(c),
            probImplicita: probImp(valor(c)),
          })),
        })
      }
    })
  }
  return saida
}

/** 1X2 + Over/Under 2.5 + margem da casa — o que o card de cada jogo mostra. */
function resumirOdds(mercados) {
  const principais = mercados.filter(m => m.principal)
  const x12  = principais.find(m => m.tipo === '1x2' && m.opcoes.length === 3)
  const ou25 = principais.find(m => m.tipo === 'ou' && parseFloat(m.linha) === 2.5)
  const [mandante, empate, visitante] = x12 ? x12.opcoes.map(o => o.odd) : [null, null, null]
  const margem = [mandante, empate, visitante].every(o => o > 1)
    ? Math.round((1 / mandante + 1 / empate + 1 / visitante - 1) * 1000) / 10
    : null
  return {
    mandante, empate, visitante,
    over25:  ou25?.opcoes?.[0]?.odd ?? null,
    under25: ou25?.opcoes?.[1]?.odd ?? null,
    margemCasa1x2: margem,
  }
}

/** Odds pré-jogo de UMA partida (todos os mercados). */
export async function getOddsEvento(eventId, esporte = 'futebol') {
  if (!eventId) return { erro: 'eventId obrigatório' }
  const dados = await flFetch('events/odds', { event_id: eventId })
  if (!dados) return { erro: 'Sem odds disponíveis para este evento (ou fora do período coberto)' }

  const mercados = montarMercados(dados, esporte)
  if (!mercados.length) return { erro: 'A FlashLive não trouxe odds para este evento' }
  return { eventId, mercados, fonte: 'flashlive_odds' }
}

/** Odds dos próximos jogos de uma liga (até `limite` partidas). */
export async function getOddsLiga(liga, limite = 12) {
  const jogosResp = await getJogosDoDia(liga, true)
  if (jogosResp?.erro) return jogosResp

  const jogos = jogosResp.jogos.slice(0, limite)
  const resultados = await Promise.all(jogos.map(async j => {
    const r    = await getOddsEvento(j.id)
    const odds = resumirOdds(r?.mercados ?? [])
    return { ...j, odds, semOdds: odds.mandante == null, oddsErro: r?.erro ?? null }
  }))

  const comOdds = resultados.filter(j => !j.semOdds).length
  return {
    liga, fonte: 'flashlive_odds', jogos: resultados,
    total: resultados.length, comOdds, semOdds: resultados.length - comOdds,
  }
}

/** Diagnóstico: mostra a estrutura crua das odds de um jogo (pra achar o campo da linha). */
export async function getDiagnosticoOddsEvento(eventId) {
  const dados = await flFetch('events/odds', { event_id: eventId })
  if (!dados) return { respondeu: false }
  return {
    respondeu: true,
    tipos: dados.map(m => ({
      BETTING_TYPE: m.BETTING_TYPE,
      periodos: (m.PERIODS ?? []).map(p => ({
        ODDS_STAGE: p.ODDS_STAGE,
        totalGrupos: (p.GROUPS ?? []).length,
        primeiroGrupo: (({ MARKETS, ...resto }) => resto)(p.GROUPS?.[0] ?? {}),
        primeiroMarket: p.GROUPS?.[0]?.MARKETS?.[0] ?? null,
      })),
    })),
  }
}

// ─────────────────────────────────────────────────────────────
// DIAGNÓSTICO — abre no navegador para ver os nomes de torneio crus
// que a FlashLive está devolvendo hoje. Use isso se uma liga nunca
// encontrar jogos, para ajustar LIGA_MATCHERS acima com o nome real.
// ─────────────────────────────────────────────────────────────
export async function getDiagnosticoTorneios() {
  const eventos = await buscarEventosDoDia(0)
  if (!eventos) return { flashliveRespondeu: false, chaveConfigurada: !!FLASHLIVE_KEY }

  return {
    flashliveRespondeu: true,
    totalTorneios: eventos.length,
    nomesTorneios: eventos.map(t => ({
      NAME: t.NAME ?? null,
      CATEGORY_NAME: t.CATEGORY_NAME ?? null,
      TOURNAMENT_NAME: t.TOURNAMENT_NAME ?? null,
      totalJogos: (t.EVENTS ?? []).length,
    })),
  }
}


// ═════════════════════════════════════════════════════════════
// ✅ PATCH 1 — ÚLTIMOS JOGOS + H2H de FUTEBOL via FlashLive
// Substituem getUltimosJogosTime / getH2HEvento do flashscoreScraper.js
// (mesmo formato de retorno, para o frontend não precisar mudar).
// IDs aqui são STRINGS alfanuméricas da FlashLive (ex.: "0jR7cwU6").
// ═════════════════════════════════════════════════════════════
function achatarEventosFutebol(dados) {
  const eventos = []
  for (const grupo of Array.isArray(dados) ? dados : []) {
    const torneio = grupo.NAME ?? grupo.TOURNAMENT_NAME ?? grupo.CATEGORY_NAME ?? 'Desconhecida'
    for (const ev of grupo.EVENTS ?? []) eventos.push({ ...ev, _torneio: torneio })
  }
  return eventos
}

export async function getUltimosJogosTime(teamId, limit = 8) {
  if (!teamId) return []
  const id = String(teamId)

  const dados = await flFetch('teams/results', { sport_id: SPORT_SOCCER, team_id: id, page: 1 })
  if (!dados) return []

  return achatarEventosFutebol(dados)
    .filter(ev => String(ev.STAGE_TYPE ?? '').toUpperCase() === 'FINISHED')
    .map(ev => {
      const ehCasa = String(ev.HOME_PARTICIPANT_IDS?.[0] ?? '') === id
      const ehFora = String(ev.AWAY_PARTICIPANT_IDS?.[0] ?? '') === id
      if (!ehCasa && !ehFora) return null

      const h = parseInt(ev.HOME_SCORE_CURRENT ?? '')
      const a = parseInt(ev.AWAY_SCORE_CURRENT ?? '')
      if (!Number.isFinite(h) || !Number.isFinite(a)) return null

      const golsMarcados = ehCasa ? h : a
      const golsSofridos = ehCasa ? a : h
      const resultado = golsMarcados === golsSofridos ? 'E'
                      : golsMarcados > golsSofridos ? 'V' : 'D'

      return {
        resultado, golsMarcados, golsSofridos,
        totalGols:  h + a,
        eventId:    ev.EVENT_ID,
        data:       extrairStartTimestamp(ev),
        competicao: ev._torneio,
        adversario: ehCasa ? (ev.AWAY_NAME ?? '?') : (ev.HOME_NAME ?? '?'),
      }
    })
    .filter(Boolean)
    .sort((x, y) => (y.data ?? 0) - (x.data ?? 0))
    .slice(0, limit)
}

const limparNomeH2H = (nome = '') => String(nome).replace(/^\*/, '').trim()

export async function getH2HEvento(eventId, mandanteId, visitanteId) {
  const vazio = { confrontos: [], totalJogos: 0, semDados: true }
  if (!eventId) return vazio

  const dados = await flFetch('events/h2h', { event_id: String(eventId) })
  if (!Array.isArray(dados) || !dados.length) return vazio

  // Pega o grupo "Confrontos diretos" da primeira aba que tiver um
  let items = []
  for (const aba of dados) {
    const grupo = (aba?.GROUPS ?? []).find(g => norm(g.GROUP_LABEL).includes('confronto'))
    if (grupo?.ITEMS?.length) { items = grupo.ITEMS; break }
  }
  if (!items.length) return vazio

  const jogoHoje = items.find(it => String(it.EVENT_ID) === String(eventId))
  if (!jogoHoje) return vazio
  const mandanteHoje = norm(limparNomeH2H(jogoHoje.HOME_PARTICIPANT))

  let vitM = 0, vitV = 0, emp = 0
  for (const it of items) {
    if (String(it.EVENT_ID) === String(eventId)) continue
    const [g1, g2] = String(it.CURRENT_RESULT ?? '').split(':').map(n => parseInt(n))
    if (!Number.isFinite(g1) || !Number.isFinite(g2)) continue
    const mandanteHojeEraCasa = norm(limparNomeH2H(it.HOME_PARTICIPANT)) === mandanteHoje
    const golsMandHoje = mandanteHojeEraCasa ? g1 : g2
    const golsVisitHoje = mandanteHojeEraCasa ? g2 : g1
    if (golsMandHoje === golsVisitHoje) emp++
    else if (golsMandHoje > golsVisitHoje) vitM++
    else vitV++
  }

  const totalJogos = vitM + vitV + emp
  if (totalJogos < 3) return vazio

  // Mesmo contrato da fonte antiga: não alimenta o λ de gols (semDados: true),
  // só devolve o resumo de vitórias/empates para a interface.
  return {
    confrontos: [], totalJogos: 0, semDados: true, fonte: 'flashlive_h2h',
    resumoSemGols: {
      vitoriasMandante: vitM, vitoriasVisitante: vitV, empates: emp, totalJogos,
      probMH2H: Math.round((vitM / totalJogos) * 100),
      probEH2H: Math.round((emp / totalJogos) * 100),
      probVH2H: Math.round((vitV / totalJogos) * 100),
    },
  }
}

// Diagnóstico: devolve a resposta CRUA da FlashLive para futebol, para confirmar os campos
export async function getDiagnosticoFutebolTime(teamId) {
  if (!teamId) return { erro: 'teamId obrigatório (use mandanteId de /jogos-hoje/:liga)' }
  const dados = await flFetch('teams/results', { sport_id: SPORT_SOCCER, team_id: String(teamId), page: 1 })
  if (!dados) return { erro: 'FlashLive não respondeu (chave, assinatura ou teamId)' }
  return { teamId, totalGrupos: Array.isArray(dados) ? dados.length : null, exemploGrupo: Array.isArray(dados) ? dados[0] : dados }
}
export async function getDiagnosticoH2HFutebol(eventId) {
  if (!eventId) return { erro: 'eventId obrigatório' }
  const dados = await flFetch('events/h2h', { event_id: String(eventId) })
  if (!dados) return { erro: 'FlashLive não respondeu (chave, assinatura ou eventId)' }
  return { eventId, resultadoCru: dados }
}


// ═════════════════════════════════════════════════════════════
// ✅ PATCH 3 — ESTATÍSTICAS DE UMA PARTIDA (futebol) via FlashLive
// Substitui getPartidaStats / getIncidentesPartida do flashscoreScraper.js.
// Devolve os MESMOS campos (placar_casa, status_type, escanteios_casa...),
// então o resolvedor automático e o frontend não precisam mudar.
// ⚠️ Como a chamada usa locale pt_BR, os nomes das estatísticas vêm em
// PORTUGUÊS ("Escanteios", "Posse de bola") — por isso o parser aceita PT e EN.
// ═════════════════════════════════════════════════════════════
function extrairEventoUnico(dados) {
  const candidatos = [dados, dados?.EVENT, dados?.EVENTS?.[0], Array.isArray(dados) ? dados[0] : null]
  return candidatos.find(c => c && typeof c === 'object' && (c.HOME_NAME || c.EVENT_ID)) ?? null
}

// Converte o status da FlashLive para os valores usados no resto do projeto
// (finished / postponed / canceled / abandoned / notstarted / inprogress).
function mapearStatusFlash(ev) {
  const t = String(ev.STAGE_TYPE ?? '').toUpperCase()
  const s = String(ev.STAGE ?? '').toUpperCase()
  const txt = `${t} ${s}`
  if (/POSTPONED|ADIADO/.test(txt)) return 'postponed'
  if (/CANCEL/.test(txt)) return 'canceled'
  if (/ABANDON|WALKOVER/.test(txt)) return 'abandoned'
  if (t === 'FINISHED') return 'finished'
  if (['NOT_STARTED', 'SCHEDULED', 'FIXTURE'].includes(t)) return 'notstarted'
  return 'inprogress'
}

// Placar do TEMPO NORMAL: se a API trouxer os tempos (1º + 2º), soma só eles
// (prorrogação/pênaltis ficam de fora, como as casas liquidam Over/Under).
// Sem os tempos, cai no placar atual.
function placarTempoNormal(ev, lado) {
  const p1 = parseInt(ev[`${lado}_SCORE_PART_1`] ?? '')
  const p2 = parseInt(ev[`${lado}_SCORE_PART_2`] ?? '')
  if (Number.isFinite(p1) && Number.isFinite(p2)) return p1 + p2
  const atual = parseInt(ev[`${lado}_SCORE_CURRENT`] ?? '')
  return Number.isFinite(atual) ? atual : null
}

// Escolhe o bloco "jogo todo" (e não 1º/2º tempo): o que tiver nome de partida/total, senão o primeiro.
function blocoJogoTodo(statsData) {
  const blocos = Array.isArray(statsData) ? statsData : []
  return blocos.find(b => /^(partida|jogo|match|geral|all|total)/.test(norm(b.STAGE_NAME ?? ''))) ?? blocos[0] ?? null
}

export async function getPartidaStats(matchId) {
  if (!matchId) return { erro: 'matchId obrigatório' }
  const id = String(matchId)

  const [dadosEvento, statsData, summary] = await Promise.all([
    flFetch('events/data',       { event_id: id }),
    flFetch('events/statistics', { event_id: id }),
    flFetch('events/summary',    { event_id: id }),
  ])

  const ev = extrairEventoUnico(dadosEvento)
  if (!ev) return { erro: `Partida ${id} não encontrada na FlashLive` }

  const r = {
    match_id: id, fonte: 'flashlive',
    time_casa: ev.HOME_NAME ?? '', time_fora: ev.AWAY_NAME ?? '',
    placar_casa: placarTempoNormal(ev, 'HOME'), placar_fora: placarTempoNormal(ev, 'AWAY'),
    status: String(ev.STAGE ?? ev.STAGE_TYPE ?? ''), status_type: mapearStatusFlash(ev),
    // campos extras usados só pela tela ao vivo (getEstatisticasAoVivo)
    placar_atual_casa: parseInt(ev.HOME_SCORE_CURRENT ?? '') || 0,
    placar_atual_fora: parseInt(ev.AWAY_SCORE_CURRENT ?? '') || 0,
    minuto: minutoDoEvento(ev),
    competicao: ev.TOURNAMENT_NAME ?? ev.NAME ?? '',
  }

  // ── Estatísticas agregadas (escanteios, posse, chutes, xG...) ──
  for (const grupo of blocoJogoTodo(statsData)?.GROUPS ?? []) {
    for (const item of grupo.ITEMS ?? []) {
      const nome = norm(item.INCIDENT_NAME)
      const casa = item.VALUE_HOME ?? 0
      const fora = item.VALUE_AWAY ?? 0
      const i = v => parseInt(v) || 0
      const f = v => parseFloat(v) || 0

      if (nome.includes('escanteio') || nome.includes('corner')) {
        r.escanteios_casa = i(casa); r.escanteios_fora = i(fora); r.escanteios_total = i(casa) + i(fora)
      } else if (nome.includes('amarelo') || nome.includes('yellow card')) {
        r._amarelos_stats = [i(casa), i(fora)]
      } else if (nome.includes('vermelho') || nome.includes('red card')) {
        r._vermelhos_stats = [i(casa), i(fora)]
      } else if (nome.includes('gols esperados') || nome.includes('expected goals') || nome === 'xg') {
        r.xg_casa = f(casa); r.xg_fora = f(fora)
      } else if (nome.includes('posse') || nome.includes('possession')) {
        r.posse_casa = i(casa); r.posse_fora = i(fora)
      } else if (nome.includes('no alvo') || nome.includes('no gol') || nome.includes('on target')) {
        r.chutes_gol_casa = i(casa); r.chutes_gol_fora = i(fora)
      } else if (['finalizacoes', 'total de finalizacoes', 'chutes', 'total shots', 'shots'].includes(nome)) {
        r.chutes_casa = i(casa); r.chutes_fora = i(fora)
      } else if (nome.includes('chances claras perdidas') || nome.includes('big chances missed')) {
        r.grandes_chances_perdidas_casa = i(casa); r.grandes_chances_perdidas_fora = i(fora)
      } else if (nome.includes('chances claras') || nome.includes('grandes chances') || nome.includes('big chance')) {
        r.grandes_chances_casa = i(casa); r.grandes_chances_fora = i(fora)
      } else if (nome.includes('ataques perigosos') || nome.includes('dangerous attack')) {
        r.ataques_perigosos_casa = i(casa); r.ataques_perigosos_fora = i(fora)
      }
    }
  }

  // ── Cartões: contagem pelos incidentes (mais precisa); se não vier, usa as estatísticas ──
  let amC = 0, amF = 0, vmC = 0, vmF = 0, achouIncidente = false
  for (const bloco of Array.isArray(summary) ? summary : []) {
    for (const item of bloco.ITEMS ?? []) {
      for (const inc of item.INCIDENT_PARTICIPANTS ?? []) {
        const casa = item.INCIDENT_TEAM === 1
        if (inc.INCIDENT_TYPE === 'YELLOW_CARD') { achouIncidente = true; casa ? amC++ : amF++ }
        if (inc.INCIDENT_TYPE === 'RED_CARD')    { achouIncidente = true; casa ? vmC++ : vmF++ }
      }
    }
  }
  if (achouIncidente || r.status_type === 'finished') {
    r.cartoes_amarelos_casa  = achouIncidente ? amC : (r._amarelos_stats?.[0] ?? 0)
    r.cartoes_amarelos_fora  = achouIncidente ? amF : (r._amarelos_stats?.[1] ?? 0)
    r.cartoes_vermelhos_casa = achouIncidente ? vmC : (r._vermelhos_stats?.[0] ?? 0)
    r.cartoes_vermelhos_fora = achouIncidente ? vmF : (r._vermelhos_stats?.[1] ?? 0)
  }
  delete r._amarelos_stats; delete r._vermelhos_stats

  return r
}

// Cartões vermelhos com o minuto — usado só para marcar "expulsão precoce" (outlier).
// Best-effort: se a FlashLive não trouxer o minuto, devolve lista vazia e o jogo segue normal.
export async function getIncidentesPartida(matchId) {
  const summary = await flFetch('events/summary', { event_id: String(matchId) })
  const saida = []
  for (const bloco of Array.isArray(summary) ? summary : []) {
    for (const item of bloco.ITEMS ?? []) {
      for (const inc of item.INCIDENT_PARTICIPANTS ?? []) {
        if (inc.INCIDENT_TYPE !== 'RED_CARD') continue
        const minuto = parseInt(item.INCIDENT_TIME ?? item.TIME ?? item.INCIDENT_MINUTE ?? '')
        if (!Number.isFinite(minuto)) continue
        saida.push({
          minuto,
          timeDoJogo: item.INCIDENT_TEAM === 1 ? 'casa' : item.INCIDENT_TEAM === 2 ? 'fora' : null,
          tipo: 'vermelho_direto',
          jogador: inc.PARTICIPANT_NAME ?? inc.NAME ?? null,
        })
      }
    }
  }
  return saida
}

// Diagnóstico: resposta CRUA de uma partida (dados + estatísticas + resumo)
export async function getDiagnosticoPartidaFutebol(matchId) {
  if (!matchId) return { erro: 'matchId obrigatório' }
  const id = String(matchId)
  const [dados, estatisticas, resumo] = await Promise.all([
    flFetch('events/data', { event_id: id }),
    flFetch('events/statistics', { event_id: id }),
    flFetch('events/summary', { event_id: id }),
  ])
  return { matchId: id, dados, estatisticas, resumo }
}


// ═════════════════════════════════════════════════════════════
// ✅ PATCH 5 — TELA "JOGOS AO VIVO" (futebol) via FlashLive
// ═════════════════════════════════════════════════════════════
const NOME_LIGA_PT = {
  brasileirao: 'Brasileirão Série A', serie_b: 'Brasileirão Série B',
  sudamericana: 'Copa Sul-Americana', libertadores: 'CONMEBOL Libertadores',
  premier_league: 'Premier League', la_liga: 'La Liga', serie_a: 'Serie A (Itália)',
  bundesliga: 'Bundesliga', ligue_1: 'Ligue 1', champions_league: 'UEFA Champions League',
  europa_league: 'UEFA Europa League', nations_league: 'UEFA Nations League',
  amistosos: 'Amistosos Internacionais',
  copa_mundo: 'Copa do Mundo', eliminatorias: 'Eliminatórias da Copa', copa_america: 'Copa América',
}

// Texto do período em português (a tela mostra esse texto ao lado do placar)
function statusEmPortugues(ev) {
  const x = String(ev.STAGE ?? ev.STAGE_TYPE ?? '').toUpperCase()
  if (/1ST_HALF|FIRST_HALF/.test(x)) return '1º tempo'
  if (/2ND_HALF|SECOND_HALF/.test(x)) return '2º tempo'
  if (/HALF_TIME|INTERVALO|BREAK/.test(x)) return 'Intervalo'
  if (/EXTRA/.test(x)) return 'Prorrogação'
  if (/PENALT/.test(x)) return 'Pênaltis'
  return x ? x.toLowerCase().replace(/_/g, ' ') : 'Ao vivo'
}

// Minuto do jogo no formato que a tela espera: "37", "INT", "FIM" ou null.
// ⚠️ O campo do minuto na FlashLive (GAME_TIME) ainda NÃO foi confirmado com dados reais —
// use /api/sportsdata/flashlive/futebol/ao-vivo para ver o jogo cru e me mandar.
function minutoDoEvento(ev) {
  const stage = String(ev.STAGE ?? '').toUpperCase()
  if (/HALF_TIME|INTERVALO|BREAK/.test(stage)) return 'INT'
  if (String(ev.STAGE_TYPE ?? '').toUpperCase() === 'FINISHED') return 'FIM'
  const bruto = ev.GAME_TIME ?? ev.MATCH_MINUTE ?? null
  if (bruto == null || bruto === '' || String(bruto) === '-1') return null
  return String(bruto).replace(/[^0-9+]/g, '') || null
}

// Estatísticas ao vivo de UMA partida: mesmas estatísticas da partida + placar/minuto atuais.
export async function getEstatisticasAoVivo(matchId) {
  if (!matchId) return { erro: 'matchId obrigatório' }
  const s = await getPartidaStats(matchId)
  if (!s || s.erro) return s ?? { erro: `Partida ${matchId} não encontrada` }

  return {
    ...s,
    id: s.match_id,
    mandante: s.time_casa,
    visitante: s.time_fora,
    placarMandante: s.placar_atual_casa ?? 0,
    placarVisitante: s.placar_atual_fora ?? 0,
    minuto: s.minuto ?? null,
    status: statusEmPortugues({ STAGE: s.status }),
    statusType: s.status_type,
    competicao: s.competicao ?? '',
    fonte: 'flashlive_live_stats',
  }
}

// Diagnóstico: primeiros jogos AO VIVO crus (para confirmar campo do minuto, STAGE_TYPE etc.)
export async function getDiagnosticoAoVivo() {
  const eventos = await buscarEventosDoDia(0)
  if (!eventos) return { erro: 'FlashLive não respondeu (verifique FLASHLIVE_KEY)' }
  const vivos = []
  for (const t of eventos) {
    for (const ev of t.EVENTS ?? []) {
      const st = String(ev.STAGE_TYPE ?? '').toUpperCase()
      if (STATUS_NAO_INICIADO.has(st) || STATUS_ENCERRADO.has(st)) continue
      vivos.push({ torneio: t.NAME ?? null, pais: t.CATEGORY_NAME ?? null, eventoCru: ev })
      if (vivos.length >= 3) return { totalAoVivoAmostra: vivos.length, vivos }
    }
  }
  return { totalAoVivoAmostra: vivos.length, vivos }
}

// ═════════════════════════════════════════════════════════════
// ✅ PATCH 7 — CARTÕES/ESCANTEIOS (média real dos times) + H2H COMPLETO via FlashLive
// Substituem as funções de mesmo nome do flashscoreScraper.js (bloqueado).
// ═════════════════════════════════════════════════════════════
const pausa    = ms => new Promise(r => setTimeout(r, ms))
const normNome = s => norm(s).replace(/ /g, '')
const mesmoTime = (a, b) => {
  const x = normNome(a), y = normNome(b)
  if (!x || !y) return false
  return x.includes(y.slice(0, 5)) || y.includes(x.slice(0, 5))
}
const media2 = (lista) => lista.length
  ? parseFloat((lista.reduce((s, v) => s + v, 0) / lista.length).toFixed(2))
  : null

/** Estatísticas de um jogo JÁ FINALIZADO (1 chamada). Campo que não veio fica null. */
async function statsJogoPassado(eventId) {
  const dados = await flFetch('events/statistics', { event_id: String(eventId) })
  const bloco = blocoJogoTodo(dados)
  if (!bloco) return null

  const s = { amarelos: null, vermelhos: null, escanteios: null, xg: null }
  for (const grupo of bloco.GROUPS ?? []) {
    for (const item of grupo.ITEMS ?? []) {
      const nome = norm(item.INCIDENT_NAME)
      const par  = [parseInt(item.VALUE_HOME) || 0, parseInt(item.VALUE_AWAY) || 0]
      if (!s.escanteios && /escanteio|corner/.test(nome))             s.escanteios = par
      else if (!s.amarelos && /amarelo|yellow card/.test(nome))       s.amarelos   = par
      else if (!s.vermelhos && /vermelho|red card/.test(nome))        s.vermelhos  = par
      else if (!s.xg && /gols esperados|expected goals/.test(nome) && !/alvo|target/.test(nome)) {
        s.xg = [parseFloat(item.VALUE_HOME) || 0, parseFloat(item.VALUE_AWAY) || 0]
      }
    }
  }
  return s
}

/** Últimos jogos finalizados do time, com flag de mando (mais recente primeiro). */
async function jogosFinalizadosDoTime(teamId) {
  const id = String(teamId)
  const dados = await flFetch('teams/results', { sport_id: SPORT_SOCCER, team_id: id, page: 1 })
  if (!dados) return []
  return achatarEventosFutebol(dados)
    .filter(ev => String(ev.STAGE_TYPE ?? '').toUpperCase() === 'FINISHED')
    .map(ev => {
      const ehCasa = String(ev.HOME_PARTICIPANT_IDS?.[0] ?? '') === id
      const ehFora = String(ev.AWAY_PARTICIPANT_IDS?.[0] ?? '') === id
      if (!ehCasa && !ehFora) return null
      return { eventId: ev.EVENT_ID, ehCasa, data: extrairStartTimestamp(ev) ?? 0 }
    })
    .filter(Boolean)
    .sort((a, b) => b.data - a.data)
}

/** Média de cartões/escanteios/xG de UM time nos últimos `last` jogos (só em casa ou só fora). */
async function getMediasCartoesEscanteiosTime(teamId, mandante, last = 6) {
  if (!teamId) return null
  let jogos = await jogosFinalizadosDoTime(teamId)
  const doMando = jogos.filter(j => j.ehCasa === mandante)
  if (doMando.length >= 3) jogos = doMando          // poucos jogos nesse mando → usa todos
  jogos = jogos.slice(0, last)
  if (!jogos.length) return null

  const cartoes = [], escanteios = [], xgFeito = [], xgSofrido = []
  for (const j of jogos) {
    const st = await statsJogoPassado(j.eventId)
    await pausa(150)
    if (!st) continue
    const lado = j.ehCasa ? 0 : 1
    if (st.amarelos || st.vermelhos) cartoes.push((st.amarelos?.[lado] ?? 0) + (st.vermelhos?.[lado] ?? 0))
    if (st.escanteios) escanteios.push(st.escanteios[lado])
    if (st.xg) { xgFeito.push(st.xg[lado]); xgSofrido.push(st.xg[1 - lado]) }
  }
  if (!cartoes.length && !escanteios.length) return null

  return {
    mediaCartoesTotais: media2(cartoes),
    mediaEscanteios:    media2(escanteios),
    mediaXgFeito:       media2(xgFeito),
    mediaXgSofrido:     media2(xgSofrido),
    amostras:           Math.max(cartoes.length, escanteios.length),
    amostrasXg:         xgFeito.length,
    mandante,
  }
}

/** Acha a partida (hoje/amanhã) da liga pelo nome dos dois times. */
async function acharPartidaFL(liga, casaNome, foraNome) {
  const resp = await getJogosDoDia(liga, true)
  if (resp?.erro) return { erro: resp.erro }
  const partida = resp.jogos.find(p => mesmoTime(p.mandante, casaNome) && mesmoTime(p.visitante, foraNome))
  if (!partida) return { erro: `Partida "${casaNome} x ${foraNome}" não encontrada em ${liga}` }
  return { partida }
}

export async function getConfrontoCartoesEscanteios(liga, casaNome, foraNome) {
  const { partida, erro } = await acharPartidaFL(liga, casaNome, foraNome)
  if (erro) return { erro }
  if (!partida.mandanteId || !partida.visitanteId) return { erro: 'Partida encontrada, mas sem IDs de time da FlashLive' }

  const [mediasCasa, mediasFora] = await Promise.all([
    getMediasCartoesEscanteiosTime(partida.mandanteId, true, 6),
    getMediasCartoesEscanteiosTime(partida.visitanteId, false, 6),
  ])
  if (!mediasCasa && !mediasFora) return { erro: 'Sem histórico de cartões/escanteios para nenhum dos dois times' }

  const resumo = m => ({
    mediaCartoesTotais: m?.mediaCartoesTotais ?? null, mediaEscanteios: m?.mediaEscanteios ?? null, amostras: m?.amostras ?? 0,
    mediaXgFeito: m?.mediaXgFeito ?? null, mediaXgSofrido: m?.mediaXgSofrido ?? null, amostrasXg: m?.amostrasXg ?? 0,
  })
  const soma = (a, b) => parseFloat(((a ?? 0) + (b ?? 0)).toFixed(2)) || null

  return {
    mandante:  resumo(mediasCasa),
    visitante: resumo(mediasFora),
    mediaCartoesJogo:    soma(mediasCasa?.mediaCartoesTotais, mediasFora?.mediaCartoesTotais),
    mediaEscanteiosJogo: soma(mediasCasa?.mediaEscanteios,    mediasFora?.mediaEscanteios),
    arbitro: null, // a FlashLive não expõe a carreira do árbitro — a tela já aceita null
    fonte: 'flashlive_historico_real',
  }
}

export async function getHistoricoConfrontosDiretos(liga, casaNome, foraNome, limiteJogos = 5) {
  const { partida, erro } = await acharPartidaFL(liga, casaNome, foraNome)
  if (erro) return { erro }

  const dados = await flFetch('events/h2h', { event_id: String(partida.id) })
  let items = []
  for (const aba of Array.isArray(dados) ? dados : []) {
    const grupo = (aba?.GROUPS ?? []).find(g => norm(g.GROUP_LABEL).includes('confronto'))
    if (grupo?.ITEMS?.length) { items = grupo.ITEMS; break }
  }

  const confrontos = items
    .filter(it => String(it.EVENT_ID) !== String(partida.id))
    .map(it => {
      const [h, a] = String(it.CURRENT_RESULT ?? '').split(':').map(n => parseInt(n))
      if (!Number.isFinite(h) || !Number.isFinite(a)) return null
      const ts = extrairStartTimestamp(it)
      const mandanteHojeEraCasa = mesmoTime(limparNomeH2H(it.HOME_PARTICIPANT), partida.mandante)
      const golsA = mandanteHojeEraCasa ? h : a
      const golsB = mandanteHojeEraCasa ? a : h
      return {
        _ts: ts ?? 0,
        data: ts ? new Date(ts * 1000).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '?',
        competicao:    it.EVENT_NAME ?? it.EVENT_ACRONYM ?? it.TOURNAMENT_NAME ?? 'Desconhecida',
        mandanteNome:  limparNomeH2H(it.HOME_PARTICIPANT) || '?',
        visitanteNome: limparNomeH2H(it.AWAY_PARTICIPANT) || '?',
        homeScore: h, awayScore: a,
        golsTimeA: golsA, golsTimeB: golsB,
        totalGols: h + a,
        resultado: h === a ? 'E' : golsA > golsB ? 'M' : 'V',
        mandanteJogouEmCasa: mandanteHojeEraCasa,
        eventId: it.EVENT_ID,
      }
    })
    .filter(Boolean)
    .sort((x, y) => y._ts - x._ts)
    .slice(0, limiteJogos)
    .map(({ _ts, ...c }) => c)

  if (!confrontos.length) return { confrontos: [], totalJogos: 0, semDados: true }

  // "Séries" (menos de X cartões / mais de Y escanteios nos confrontos) — best-effort
  for (const c of confrontos) {
    try {
      const st = await statsJogoPassado(c.eventId)
      if (st?.amarelos || st?.vermelhos) {
        c.cartoesTotal = (st.amarelos ?? [0, 0]).reduce((s, v) => s + v, 0) + (st.vermelhos ?? [0, 0]).reduce((s, v) => s + v, 0)
      }
      if (st?.escanteios) c.escanteiosTotal = st.escanteios[0] + st.escanteios[1]
    } catch { /* segue sem séries */ }
    await pausa(150)
  }
  const comCartoes    = confrontos.filter(c => c.cartoesTotal != null)
  const comEscanteios = confrontos.filter(c => c.escanteiosTotal != null)
  const statsSeries = (comCartoes.length || comEscanteios.length) ? {
    amostraSeries:        Math.max(comCartoes.length, comEscanteios.length),
    menosDe4_5Cartoes:    `${comCartoes.filter(c => c.cartoesTotal < 4.5).length}/${comCartoes.length}`,
    maisDe10_5Escanteios: `${comEscanteios.filter(c => c.escanteiosTotal > 10.5).length}/${comEscanteios.length}`,
  } : null

  const n   = confrontos.length
  const pct = fn => Math.round((confrontos.filter(fn).length / n) * 100)
  const vitoriasMandante  = confrontos.filter(c => c.resultado === 'M').length
  const vitoriasVisitante = confrontos.filter(c => c.resultado === 'V').length
  const empates           = confrontos.filter(c => c.resultado === 'E').length

  return {
    confrontos, totalJogos: n, semDados: false,
    vitoriasMandante, vitoriasVisitante, empates,
    probMH2H: Math.round((vitoriasMandante / n) * 100),
    probEH2H: Math.round((empates / n) * 100),
    probVH2H: Math.round((vitoriasVisitante / n) * 100),
    mediaGolsTotais: parseFloat((confrontos.reduce((s, c) => s + c.totalGols, 0) / n).toFixed(2)),
    bttsRateH2H:   pct(c => c.golsTimeA > 0 && c.golsTimeB > 0),
    over15RateH2H: pct(c => c.totalGols >= 2),
    over25RateH2H: pct(c => c.totalGols >= 3),
    over35RateH2H: pct(c => c.totalGols >= 4),
    ...analisarH2HAvancado(confrontos),
    statsSeries,
    fonte: 'flashlive_h2h_completo',
  }
}