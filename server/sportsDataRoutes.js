// server/sportsDataRoutes.js
// Rotas /api/sportsdata/* — registrar no server/index.js
// Chama os scrapers JS e usa o PostgreSQL para cache
//
// Como usar no server/index.js:
//   import { registerSportsRoutes } from './sportsDataRoutes.js'
//   ...dentro do initDB().then(() => { ... }):
//   registerSportsRoutes(app, pool)
// ─────────────────────────────────────────────────────────────

import { getGolsLiga, getCartoesLiga, getTimeStats } from './scrapers/fbrefScraper.js'
// 🔁 Jogos do dia, ao vivo e ODDS de futebol agora vêm da FlashLive (RapidAPI),
// (Fase 1 da migração — 25/09/2026; o SofaScore foi removido do projeto)
import {
  getJogosDoDia, getJogosAoVivo, getDiagnosticoTorneios, getOddsEvento, getOddsLiga,
  getUltimosJogosTime, getH2HEvento, getDiagnosticoFutebolTime, getDiagnosticoH2HFutebol,
  getPartidaStats, getDiagnosticoPartidaFutebol,
  getEstatisticasAoVivo, getDiagnosticoAoVivo, getDiagnosticoOddsEvento,
  getConfrontoCartoesEscanteios, getHistoricoConfrontosDiretos,
} from './scrapers/flashscoreScraper.js'
// ✅ NOVO — TÊNIS via FlashLive (Fase 1 da migração, 25/09/2026). O motor de
// previsão pré-jogo (probabilidades, fadiga, risco de desistência) continua
// em tennisScraper.js por enquanto — só a camada de jogos/odds/H2H/ranking
// "cru" migrou. Ver flashscoreTennisScraper.js para detalhes.
import {
  getJogosTenisHoje, getJogosTenisAoVivo as getJogosTenisAoVivoFL,
  getEstatisticasTenisAoVivo as getEstatisticasTenisAoVivoFL,
  getH2HTenis, getRankingTenis, getOddsTenisEvento, getOddsTenisAoVivo,
  getDiagnosticoTenis, getDiagnosticoHistoricoTenis, getHistoricoJogadorTenis, getDiagnosticoRankingTenis,
} from './scrapers/flashscoreTennisScraper.js'
import { getJogosBasqueteDia, getUltimosJogosBasquete, getDiagnosticoBasquete, getJogosBasqueteAoVivo } from './scrapers/flashscoreBasketScraper.js'
import { getClimaJogo } from './scrapers/weatherScraper.js'
import {
  getCached, setCached, limparExpirados, limparPorTipo,
  getCacheStats, makeKey,
} from './scrapers/sportsCache.js'
import { getHistoricosJogosTenis, calcularProbabilidadesTenis } from './scrapers/tennisScraper.js'

// Mapa de códigos de liga (os mesmos que já circulam no seu groqService)
// ✅ exportado para ser reaproveitado pelo comando /jogos do bot do Telegram
// (server/index.js) — mesmo motivo do ODDS_SPORT_KEY_SNAPSHOT: evitar dois
// mapas divergentes espalhados pelo código.
export const LIGA_MAP = {
  'BSA': 'brasileirao', 'BRA': 'brasileirao', 'brasileirao': 'brasileirao',
  'BSB': 'serie_b', 'serie_b': 'serie_b',
  'CSA': 'sudamericana', 'sudamericana': 'sudamericana',
  'PL':  'premier_league', 'premier_league': 'premier_league',
  'PD':  'la_liga',         'la_liga': 'la_liga',
  'SA':  'serie_a',         'serie_a': 'serie_a',
  'BL1': 'bundesliga',      'bundesliga': 'bundesliga',
  'FL1': 'ligue_1',         'ligue_1': 'ligue_1',
  'CL':  'champions_league',
  'CLI': 'libertadores',     'LIB': 'libertadores',  'libertadores': 'libertadores',
  'AMI': 'amistosos',        'amistosos': 'amistosos',
   'champions_league': 'champions_league',
  'EL':  'europa_league',    'europa_league': 'europa_league',
   'WC':  'copa_mundo',  'copa_mundo': 'copa_mundo',
  'WCQ': 'eliminatorias', 'eliminatorias': 'eliminatorias',
  'CA':  'copa_america',  'copa_america': 'copa_america',
  'NL':  'nations_league', 'nations_league': 'nations_league',
}

export const resolveLiga = code => LIGA_MAP[code] ?? LIGA_MAP[code?.toUpperCase()] ?? null

// ── Helpers de resposta ────────────────────────────────────────
const ok  = (res, data, cache = 'miss') => res.json({ status: 'ok',   data: { ...data, _cache: cache } })
const err = (res, msg, status = 400)    => res.status(status).json({ status: 'erro', mensagem: msg })

// ── Handler genérico com cache ─────────────────────────────────
async function withCache(res, pool, chave, tipo, fn) {
  const cached = await getCached(pool, chave)
  if (cached) return ok(res, cached, 'hit')

  const dados = await fn()
  if (!dados)          return err(res, 'Não foi possível obter dados', 502)
  if (dados?.erro)     return err(res, dados.erro, 404)

  await setCached(pool, chave, dados, tipo)
  return ok(res, dados, 'miss')
}

// ─────────────────────────────────────────────────────────────
export function registerSportsRoutes(app, pool, authMiddleware, adminMiddleware) {

  // ── FBref: gols de toda a liga ──────────────────────────────
  // GET /api/sportsdata/fbref/gols/:liga
  app.get('/api/sportsdata/fbref/gols/:liga', async (req, res) => {
    const liga = resolveLiga(req.params.liga)
    if (!liga) return err(res, `Liga '${req.params.liga}' não suportada`)

    await withCache(res, pool,
      makeKey('fbref_gols', liga),
      'fbref_gols',
      () => getGolsLiga(liga)
    )
  })

  // ── FBref: cartões de toda a liga ───────────────────────────
  // GET /api/sportsdata/fbref/cartoes/:liga
  app.get('/api/sportsdata/fbref/cartoes/:liga', async (req, res) => {
    const liga = resolveLiga(req.params.liga)
    if (!liga) return err(res, `Liga '${req.params.liga}' não suportada`)

    await withCache(res, pool,
      makeKey('fbref_cartoes', liga),
      'fbref_cartoes',
      () => getCartoesLiga(liga)
    )
  })

  // ── FBref: dados completos de um time ───────────────────────
  // GET /api/sportsdata/fbref/time/:liga/:time
  app.get('/api/sportsdata/fbref/time/:liga/:time', async (req, res) => {
    const liga = resolveLiga(req.params.liga)
    if (!liga) return err(res, `Liga '${req.params.liga}' não suportada`)
    const nomeTime = decodeURIComponent(req.params.time)

    await withCache(res, pool,
      makeKey('fbref_time', liga, nomeTime),
      'fbref_time',
      () => getTimeStats(liga, nomeTime)
    )
  })

  // ── Estatísticas de uma partida (fonte: FlashLive) ──────────
  // GET /api/sportsdata/jogos/partida/:matchId
  // ⚠️ matchId agora é string alfanumérica da FlashLive — NÃO usar parseInt.
  app.get('/api/sportsdata/jogos/partida/:matchId', async (req, res) => {
    const matchId = String(req.params.matchId ?? '').trim()
    if (!matchId) return err(res, 'matchId inválido')

    try {
      const chave  = makeKey('jogos_partida', matchId)
      const cached = await getCached(pool, chave)
      if (cached) return ok(res, cached, 'hit')

      const dados = await getPartidaStats(matchId)
      if (!dados || dados.erro) return err(res, dados?.erro ?? 'Não foi possível obter dados', dados?.erro ? 404 : 502)
      // só guarda no cache jogo FINALIZADO (placar ao vivo não pode ficar velho)
      if (dados.status_type === 'finished') await setCached(pool, chave, dados, 'jogos_partida')
      return ok(res, dados, 'miss')
    } catch (e) {
      return err(res, e.message, 502)
    }
  })

  // ── Confronto completo (FBref dos dois times combinados) ────
  // GET /api/sportsdata/confronto/:liga/:casa/:fora
  app.get('/api/sportsdata/confronto/:liga/:casa/:fora', async (req, res) => {
    const liga = resolveLiga(req.params.liga)
    if (!liga) return err(res, `Liga '${req.params.liga}' não suportada`)

    const casa = decodeURIComponent(req.params.casa)
    const fora = decodeURIComponent(req.params.fora)

    const chave = makeKey('confronto', liga, casa, fora)
    const cached = await getCached(pool, chave)
    if (cached) return ok(res, cached, 'hit')

    // Busca os dois times em paralelo
    const [dadosCasa, dadosFora] = await Promise.all([
      getTimeStats(liga, casa),
      getTimeStats(liga, fora),
    ])

    if (dadosCasa?.erro) return err(res, `Time casa: ${dadosCasa.erro}`)
    if (dadosFora?.erro) return err(res, `Time fora: ${dadosFora.erro}`)

    const s = (obj, campo) => parseFloat(obj?.[campo] ?? 0)

    const resultado = {
      liga,
      confronto:    `${casa} vs ${fora}`,
      time_casa:    dadosCasa,
      time_fora:    dadosFora,
      projecao: {
        gols_esperados:       parseFloat((s(dadosCasa,'media_gols_marcados') + s(dadosFora,'media_gols_marcados')).toFixed(2)),
        over_2_5:             (s(dadosCasa,'media_gols_marcados') + s(dadosFora,'media_gols_marcados')) >= 2.5,
        over_3_5:             (s(dadosCasa,'media_gols_marcados') + s(dadosFora,'media_gols_marcados')) >= 3.5,
        cartoes_esperados:    parseFloat((s(dadosCasa,'media_cartoes_total') + s(dadosFora,'media_cartoes_total')).toFixed(2)),
        over_3_cartoes:       (s(dadosCasa,'media_cartoes_total') + s(dadosFora,'media_cartoes_total')) >= 3.0,
        over_4_5_cartoes:     (s(dadosCasa,'media_cartoes_total') + s(dadosFora,'media_cartoes_total')) >= 4.5,
      },
      fonte: 'fbref',
    }

    await setCached(pool, chave, resultado, 'confronto')
    return ok(res, resultado, 'miss')
  })

  // ── Cache: limpeza manual (admin) ───────────────────────────
  // POST /api/sportsdata/cache/limpar
  app.post('/api/sportsdata/cache/limpar', authMiddleware, adminMiddleware, async (req, res) => {
    const removidos = await limparExpirados(pool)
    res.json({ ok: true, removidos })
  })

  // ── Cache: limpeza FORÇADA por tipo, mesmo sem estar expirado (admin) ─
  // POST /api/sportsdata/cache/limpar-tipo/:tipo
  // Ex.: POST /api/sportsdata/cache/limpar-tipo/tenis_torneios
  // Use isso logo depois de um deploy que mudou algum scraper — o cache
  // "válido" (não expirado) continua servindo o resultado calculado com o
  // código antigo até você forçar a remoção.
  app.post('/api/sportsdata/cache/limpar-tipo/:tipo', authMiddleware, adminMiddleware, async (req, res) => {
    const { tipo } = req.params
    const removidos = await limparPorTipo(pool, tipo)
    res.json({ ok: true, tipo, removidos })
  })

  // ── Cache: estatísticas ─────────────────────────────────────
  // GET /api/sportsdata/cache/stats
  app.get('/api/sportsdata/cache/stats', async (req, res) => {
    const stats = await getCacheStats(pool)
    res.json({ status: 'ok', data: stats })
  })

  // ════════════════════════════════════════════════════════════
  // BASQUETE via FlashLive (substitui o proxy SportAPI /api/sport/*)
  // Exigem login, como o proxy antigo exigia.
  // ════════════════════════════════════════════════════════════
  // GET /api/sportsdata/flashlive/basquete/diagnostico
  app.get('/api/sportsdata/flashlive/basquete/diagnostico', authMiddleware, async (req, res) => {
    res.json(await getDiagnosticoBasquete())
  })

  // GET /api/sportsdata/flashlive/basquete/jogos-dia/:indent   (0 = hoje, -1 = ontem, 1 = amanhã)
  app.get('/api/sportsdata/flashlive/basquete/jogos-dia/:indent', authMiddleware, async (req, res) => {
    const indent = parseInt(req.params.indent)
    if (!Number.isFinite(indent)) return err(res, 'indent inválido')
    await withCache(res, pool,
      makeKey('flashlive_basquete_jogos', indent),
      'flashlive_basquete_jogos',
      () => getJogosBasqueteDia(indent)
    )
  })

  // GET /api/sportsdata/flashlive/basquete/ao-vivo  — placar ao vivo (cache 20s)
  app.get('/api/sportsdata/flashlive/basquete/ao-vivo', authMiddleware, async (req, res) => {
    await withCache(res, pool,
      makeKey('flashlive_basquete_ao_vivo'),
      'flashlive_basquete_ao_vivo',
      () => getJogosBasqueteAoVivo()
    )
  })

  // GET /api/sportsdata/flashlive/basquete/time/:teamId/ultimos?limit=8
  app.get('/api/sportsdata/flashlive/basquete/time/:teamId/ultimos', authMiddleware, async (req, res) => {
    const teamId = String(req.params.teamId ?? '').trim()
    if (!teamId) return err(res, 'teamId inválido')
    const limit = parseInt(req.query.limit) || 8
    await withCache(res, pool,
      makeKey('flashlive_basquete_ultimos', teamId, limit),
      'flashlive_basquete_ultimos',
      () => getUltimosJogosBasquete(teamId, limit)
    )
  })

  // ── ✅ NOVO — Diagnóstico da FlashLive (abrir no navegador) ──
  // GET /api/sportsdata/flashlive/diagnostico
  // Mostra os nomes de torneio crus que a API está devolvendo hoje —
  // use se alguma liga nunca encontrar jogos, para ajustar LIGA_KEYWORDS
  // em flashscoreScraper.js.
  app.get('/api/sportsdata/flashlive/diagnostico', async (req, res) => {
    const dados = await getDiagnosticoTorneios()
    res.json(dados)
  })

  // ✅ Diagnóstico de FUTEBOL na FlashLive (abrir no navegador) — mostra a resposta crua
  // GET /api/sportsdata/flashlive/futebol/time/:teamId   (use um mandanteId de /jogos-hoje/:liga)
  app.get('/api/sportsdata/flashlive/futebol/time/:teamId', async (req, res) => {
    res.json(await getDiagnosticoFutebolTime(req.params.teamId))
  })
  // GET /api/sportsdata/flashlive/futebol/h2h/:eventId   (use um id de /jogos-hoje/:liga)
  app.get('/api/sportsdata/flashlive/futebol/h2h/:eventId', async (req, res) => {
    res.json(await getDiagnosticoH2HFutebol(req.params.eventId))
  })
  // GET /api/sportsdata/flashlive/futebol/partida/:matchId   (dados + estatísticas + resumo crus)
  app.get('/api/sportsdata/flashlive/futebol/partida/:matchId', async (req, res) => {
    res.json(await getDiagnosticoPartidaFutebol(req.params.matchId))
  })
  // GET /api/sportsdata/flashlive/futebol/ao-vivo   (3 jogos ao vivo CRUS — confirma minuto e status)
  app.get('/api/sportsdata/flashlive/futebol/ao-vivo', async (req, res) => {
    res.json(await getDiagnosticoAoVivo())
  })

    // GET /api/sportsdata/flashlive/futebol/odds/:eventId   (estrutura crua das odds de 1 jogo)
  app.get('/api/sportsdata/flashlive/futebol/odds/:eventId', async (req, res) => {
    res.json(await getDiagnosticoOddsEvento(req.params.eventId))
  })

  // ════════════════════════════════════════════════════════════
  // ✅ NOVO — TÊNIS via FlashLive (Fase 1 da migração, 25/09/2026)
  // Camada "crua" de jogos/odds/H2H/ranking. O motor de previsão
  // (/api/sportsdata/tenis/*, mais abaixo) também usa dados da FlashLive
  // (ver tennisScraper.js).
  // ════════════════════════════════════════════════════════════

  // ── Diagnóstico de tênis (abrir no navegador) — confirma nomes reais
  // de torneio ATP/WTA e mostra um evento cru completo (pra achar piso) ──
  // GET /api/sportsdata/flashlive/tenis/diagnostico
  app.get('/api/sportsdata/flashlive/tenis/diagnostico', async (req, res) => {
    const dados = await getDiagnosticoTenis()
    res.json(dados)
  })

  // GET /api/sportsdata/flashlive/tenis/diagnostico-ranking  (confere os campos reais do ranking)
  app.get('/api/sportsdata/flashlive/tenis/diagnostico-ranking', async (req, res) => {
    res.json(await getDiagnosticoRankingTenis())
  })

    // GET /api/sportsdata/flashlive/tenis/diagnostico-historico/:playerId
  app.get('/api/sportsdata/flashlive/tenis/diagnostico-historico/:playerId', async (req, res) => {
    const dados = await getDiagnosticoHistoricoTenis(req.params.playerId)
    res.json(dados)
  })

  // ── Jogos de tênis de hoje (ou hoje+amanhã), agrupados por torneio ──
  // GET /api/sportsdata/flashlive/tenis/jogos?incluirAmanha=1
  app.get('/api/sportsdata/flashlive/tenis/jogos', async (req, res) => {
    const incluirAmanha = req.query.incluirAmanha === '1' || req.query.incluirAmanha === 'true'
    await withCache(res, pool,
      makeKey('flashlive_tenis_jogos', incluirAmanha ? 'com_amanha' : 'hoje'),
      'flashlive_tenis_jogos',
      () => getJogosTenisHoje(incluirAmanha)
    )
  })

  // ── Tênis ao vivo agora ──────────────────────────────────────
  // GET /api/sportsdata/flashlive/tenis/ao-vivo
  app.get('/api/sportsdata/flashlive/tenis/ao-vivo', async (req, res) => {
    await withCache(res, pool,
      makeKey('flashlive_tenis_ao_vivo'),
      'flashlive_tenis_ao_vivo',
      () => getJogosTenisAoVivoFL()
    )
  })

  // ── H2H de uma partida de tênis específica ──────────────────
  // GET /api/sportsdata/flashlive/tenis/h2h/:eventId
  app.get('/api/sportsdata/flashlive/tenis/h2h/:eventId', async (req, res) => {
    const { eventId } = req.params
    if (!eventId) return err(res, 'eventId inválido')
    await withCache(res, pool,
      makeKey('flashlive_tenis_h2h', eventId),
      'flashlive_tenis_h2h',
      () => getH2HTenis(eventId)
    )
  })

    // GET /api/sportsdata/flashlive/tenis/historico/:playerId?limit=8
  app.get('/api/sportsdata/flashlive/tenis/historico/:playerId', async (req, res) => {
    const { playerId } = req.params
    const limit = parseInt(req.query.limit) || 8
    if (!playerId) return err(res, 'playerId inválido')
    await withCache(res, pool,
      makeKey('flashlive_tenis_historico', playerId, limit),
      'flashlive_tenis_historico',
      () => getHistoricoJogadorTenis(playerId, limit)
    )
  })

  // ── Ranking ATP ou WTA ───────────────────────────────────────
  // GET /api/sportsdata/flashlive/tenis/ranking/:tipo  (tipo = atp|wta)
  app.get('/api/sportsdata/flashlive/tenis/ranking/:tipo', async (req, res) => {
    const tipo = req.params.tipo
    await withCache(res, pool,
      makeKey('flashlive_tenis_ranking', tipo),
      'flashlive_tenis_ranking',
      () => getRankingTenis(tipo)
    )
  })

  // ── Odds pré-jogo de uma partida de tênis (todas as casas) ──
  // GET /api/sportsdata/flashlive/tenis/odds/:eventId
  app.get('/api/sportsdata/flashlive/tenis/odds/:eventId', async (req, res) => {
    const { eventId } = req.params
    if (!eventId) return err(res, 'eventId inválido')
    await withCache(res, pool,
      makeKey('flashlive_tenis_odds', eventId),
      'flashlive_tenis_odds',
      () => getOddsTenisEvento(eventId)
    )
  })

  // ── Odds AO VIVO de uma partida de tênis (exige book_id; padrão bet365) ──
  // GET /api/sportsdata/flashlive/tenis/odds-ao-vivo/:eventId?bookId=16
  // Sem cache — odds ao vivo mudam rápido.
  app.get('/api/sportsdata/flashlive/tenis/odds-ao-vivo/:eventId', async (req, res) => {
    const { eventId } = req.params
    const bookId = parseInt(req.query.bookId) || 16
    if (!eventId) return err(res, 'eventId inválido')
    try {
      const dados = await getOddsTenisAoVivo(eventId, bookId)
      if (dados?.erro) return err(res, dados.erro, 404)
      return ok(res, dados, 'miss')
    } catch (e) {
      return err(res, e.message, 502)
    }
  })

  // ── Jogos de hoje/amanhã de uma liga (fonte: FlashLive) ─────
  // GET /api/sportsdata/jogos/jogos-hoje/:liga
  app.get('/api/sportsdata/jogos/jogos-hoje/:liga', async (req, res) => {
    const liga = resolveLiga(req.params.liga)
    if (!liga) return err(res, `Liga '${req.params.liga}' não suportada`)

    // ✅ Fix: o frontend envia ?incluirAmanha=1, mas esse valor estava sendo
    // descartado aqui — a rota nunca repassava para getJogosDoDia(), então o
    // toggle "buscar jogos de amanhã" não tinha efeito nenhum para a Série B.
    const incluirAmanha = req.query.incluirAmanha === '1' || req.query.incluirAmanha === 'true'

    try {
      const resultado = await getJogosDoDia(liga, incluirAmanha)
      if (resultado?.erro) return err(res, resultado.erro, 404)
      return ok(res, resultado, 'miss')
    } catch (e) {
      return err(res, e.message, 502)
    }
  })


  

  // ── Últimos jogos finalizados de um time (fonte: FlashLive) ──
  // GET /api/sportsdata/jogos/time/:teamId/ultimos?limit=8
  // ⚠️ teamId agora é string alfanumérica da FlashLive — NÃO usar parseInt.
  app.get('/api/sportsdata/jogos/time/:teamId/ultimos', async (req, res) => {
    const teamId = String(req.params.teamId ?? '').trim()
    const limit  = Math.min(parseInt(req.query.limit) || 8, 20)
    if (!teamId) return err(res, 'teamId inválido')

    try {
      const chave  = makeKey('flashlive_ultimos', teamId, limit)
      const cached = await getCached(pool, chave)
      if (cached) return ok(res, cached, 'hit')

      const jogos = await getUltimosJogosTime(teamId, limit)
      const dados = { teamId, jogos }
      if (jogos.length) await setCached(pool, chave, dados, 'flashlive_ultimos') // não guarda resultado vazio
      return ok(res, dados, 'miss')
    } catch (e) {
      return err(res, e.message, 502)
    }
  })

  // ── H2H baseado no evento de hoje (fonte: FlashLive) ─────────
  // GET /api/sportsdata/jogos/h2h/:eventId
  // ⚠️ eventId agora é string alfanumérica da FlashLive — NÃO usar parseInt.
  app.get('/api/sportsdata/jogos/h2h/:eventId', async (req, res) => {
    const eventId = String(req.params.eventId ?? '').trim()
    if (!eventId) return err(res, 'eventId inválido')

    try {
      const chave  = makeKey('flashlive_h2h', eventId)
      const cached = await getCached(pool, chave)
      if (cached) return ok(res, cached, 'hit')

      const h2h = await getH2HEvento(eventId, req.query.mandanteId, req.query.visitanteId)
      if (!h2h.semDados || h2h.resumoSemGols) await setCached(pool, chave, h2h, 'flashlive_h2h')
      return ok(res, h2h, 'miss')
    } catch (e) {
      return err(res, e.message, 502)
    }
  })

  // ── ✅ NOVO — Cartões/escanteios REAIS (histórico dos times) + árbitro ──
  // GET /api/sportsdata/jogos/cartoes-escanteios/:liga/:casa/:fora
  // Substitui o fluxo antigo (flashliveService lendo a própria partida
  // futura, que retornava zeros/nulos). Agora calcula a média dos últimos
  // jogos finalizados de cada time + dados do árbitro quando disponíveis.
  app.get('/api/sportsdata/jogos/cartoes-escanteios/:liga/:casa/:fora', async (req, res) => {
    const liga = resolveLiga(req.params.liga)
    if (!liga) return err(res, `Liga '${req.params.liga}' não suportada`)
    const casa = decodeURIComponent(req.params.casa)
    const fora = decodeURIComponent(req.params.fora)

    await withCache(res, pool,
      makeKey('jogos_cartoes_confronto', liga, casa, fora),
      'jogos_cartoes_confronto',
      () => getConfrontoCartoesEscanteios(liga, casa, fora)
    )
  })

  // ── ✅ NOVO — Histórico completo de confrontos diretos (H2H real) ──
  // GET /api/sportsdata/jogos/h2h-completo/:liga/:casa/:fora
  app.get('/api/sportsdata/jogos/h2h-completo/:liga/:casa/:fora', async (req, res) => {
    const liga = resolveLiga(req.params.liga)
    if (!liga) return err(res, `Liga '${req.params.liga}' não suportada`)
    const casa = decodeURIComponent(req.params.casa)
    const fora = decodeURIComponent(req.params.fora)

    await withCache(res, pool,
      makeKey('jogos_h2h_completo', liga, casa, fora),
      'jogos_h2h_completo',
      () => getHistoricoConfrontosDiretos(liga, casa, fora)
    )
  })

  // ── ✅ NOVO — Clima previsto no estádio do mandante na data do jogo ──
  // GET /api/sportsdata/weather/:time/:data   (data = YYYY-MM-DD)
  // Cobertura limitada aos principais clubes (ver weatherScraper.js).
  // Query opcional ?hora=HH:MM com o horário real do chute inicial (fuso local
  // do estádio). Sem isso, cai no fallback de 20h já usado antes.
  app.get('/api/sportsdata/weather/:time/:data', async (req, res) => {
    const nomeTime = decodeURIComponent(req.params.time)
    const dataJogo = req.params.data
    const horaJogo = typeof req.query.hora === 'string' ? req.query.hora : null
    const chave = makeKey('weather', nomeTime, dataJogo, horaJogo || '')

    const cached = await getCached(pool, chave)
    if (cached) return ok(res, cached, 'hit')

    const clima = await getClimaJogo(nomeTime, dataJogo, horaJogo)
    if (!clima) return err(res, 'Sem cobertura de clima para este time/data', 404)

    await setCached(pool, chave, clima, 'weather')
    return ok(res, clima, 'miss')
  })

  // ── Tênis: histórico + H2H dos jogos selecionados (Etapa 2) ──
  // POST /api/sportsdata/tenis/historicos   body: { jogos: [...] }
  app.post('/api/sportsdata/tenis/historicos', async (req, res) => {
    const jogos = req.body?.jogos
    if (!Array.isArray(jogos) || jogos.length === 0) return err(res, 'Envie a lista de jogos selecionados (máx. 3)')

    const idsJogos = jogos.slice(0, 3).map(j => j.id).join('_')
    const chave = makeKey('tenis_historico', idsJogos)

    const cached = await getCached(pool, chave)
    if (cached) return ok(res, { jogos: cached }, 'hit')

        try {
      const resultado = await getHistoricosJogosTenis(jogos)
      // não cacheia resultado incompleto (ex.: 429 da API deixou algum histórico vazio)
      const incompleto = resultado.some(g => !g.historicoMandante?.length || !g.historicoVisitante?.length)
      if (!incompleto) await setCached(pool, chave, resultado, 'tenis_historico')
      return ok(res, { jogos: resultado }, 'miss')
    } catch (e) {
      return err(res, e.message, 502)
    }
  })

  // ── Tênis: cálculo de probabilidades (Etapa 3) ──────────────
  // POST /api/sportsdata/tenis/probabilidades   body: { jogos: [...] } (já com histórico da Etapa 2)
  app.post('/api/sportsdata/tenis/probabilidades', async (req, res) => {
    const jogos = req.body?.jogos
    if (!Array.isArray(jogos) || jogos.length === 0) return err(res, 'Envie os jogos com histórico (saída da Etapa 2)')

    try {
      const resultado = calcularProbabilidadesTenis(jogos)
      return ok(res, resultado, 'calculado')
    } catch (e) {
      return err(res, e.message, 500)
    }
  })

  // ════════════════════════════════════════════════════════════
  // ✅ NOVO — TELA "JOGOS AO VIVO"
  // ════════════════════════════════════════════════════════════

  // ── Todos os jogos em andamento agora ──────────────────
  // GET /api/sportsdata/jogos/ao-vivo?todas=1
  // Sem ?todas=1 devolve só as ligas suportadas pelo sistema.
  // Cache curtíssimo (20s) — placar ao vivo não pode ficar velho.
  app.get('/api/sportsdata/jogos/ao-vivo', async (req, res) => {
    const todas = req.query.todas === '1' || req.query.todas === 'true'

    await withCache(res, pool,
      makeKey('jogos_ao_vivo', todas ? 'todas' : 'suportadas'),
      'jogos_ao_vivo',
      () => getJogosAoVivo(todas)
    )
  })

  // ── Estatísticas ao vivo de uma partida específica ────────
  // GET /api/sportsdata/jogos/ao-vivo/:matchId
  // ⚠️ matchId agora é string alfanumérica da FlashLive — NÃO usar parseInt.
  app.get('/api/sportsdata/jogos/ao-vivo/:matchId', async (req, res) => {
    const matchId = String(req.params.matchId ?? '').trim()
    if (!matchId) return err(res, 'matchId inválido')

    await withCache(res, pool,
      makeKey('jogos_ao_vivo_stats', matchId),
      'jogos_ao_vivo_stats',
      () => getEstatisticasAoVivo(matchId)
    )
  })

   // GET /api/sportsdata/jogos/tenis/ao-vivo   (agora FlashLive; o caminho antigo foi mantido pro front)
  app.get('/api/sportsdata/jogos/tenis/ao-vivo', async (req, res) => {
    await withCache(res, pool,
      makeKey('tenis_ao_vivo_v2'),
      'tenis_ao_vivo',
      () => getJogosTenisAoVivoFL()
    )
  })

  // GET /api/sportsdata/jogos/tenis/ao-vivo/:matchId
  // ⚠️ matchId é string alfanumérica da FlashLive — NÃO usar parseInt.
  app.get('/api/sportsdata/jogos/tenis/ao-vivo/:matchId', async (req, res) => {
    const matchId = String(req.params.matchId ?? '').trim()
    if (!matchId) return err(res, 'matchId inválido')

    await withCache(res, pool,
      makeKey('tenis_ao_vivo_stats_v2', matchId),
      'tenis_ao_vivo_stats',
      () => getEstatisticasTenisAoVivoFL(matchId)
    )
  })
  // ════════════════════════════════════════════════════════════
  // ✅ NOVO — TELA "ODDS"
  // ════════════════════════════════════════════════════════════

  // ── Odds de TODOS os próximos jogos de uma liga ──────────
  // GET /api/sportsdata/jogos/odds/liga/:liga?limite=12
  app.get('/api/sportsdata/jogos/odds/liga/:liga', async (req, res) => {
    const liga = resolveLiga(req.params.liga)
    if (!liga) return err(res, `Liga '${req.params.liga}' não suportada`)
    const limite = Math.min(parseInt(req.query.limite) || 12, 20)

    await withCache(res, pool,
      makeKey('jogos_odds_liga_v2', liga, limite),
      'jogos_odds_liga',
      () => getOddsLiga(liga, limite)
    )
  })

  // ── Odds completas de uma partida (todos os mercados) ──────
  // GET /api/sportsdata/jogos/odds/:matchId
  // ⚠️ matchId agora é o EVENT_ID da FlashLive (string alfanumérica, ex.:
  // "0jR7cwU6") — não é numérico (como era na fonte antiga). Por isso não
  // fazemos mais parseInt aqui (isso corrompia o ID e quebrava a busca).
  app.get('/api/sportsdata/jogos/odds/:matchId', async (req, res) => {
    const matchId = req.params.matchId
    if (!matchId) return err(res, 'matchId inválido')
    const esporte = req.query.esporte === 'tenis' ? 'tenis' : 'futebol'

    await withCache(res, pool,
      makeKey('jogos_odds_evento_v2', matchId, esporte),
      'jogos_odds_evento',
      () => getOddsEvento(matchId, esporte)
    )
  })

  console.log('✅ Rotas /api/sportsdata/* registradas')
}