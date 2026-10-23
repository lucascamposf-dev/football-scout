// server/scrapers/sportsCache.js
// Cache no PostgreSQL já existente no projeto
// Usa o mesmo `pool` do server/index.js — passado como parâmetro
// TTL configurável por tipo de dado
// ─────────────────────────────────────────────────────────────

const TTL = {
  fbref_gols:         6 * 60 * 60 * 1000,  // 6h
  fbref_cartoes:      6 * 60 * 60 * 1000,  // 6h
  fbref_time:         6 * 60 * 60 * 1000,  // 6h
  jogos_partida:  2 * 60 * 60 * 1000,  // 2h
  jogos_liga:     1 * 60 * 60 * 1000,  // 1h
  confronto:          6 * 60 * 60 * 1000,  // 6h
  jogos_cartoes_confronto: 3 * 60 * 60 * 1000, // 3h (cartões/escanteios/árbitro reais)
  jogos_time_cartoes:      6 * 60 * 60 * 1000, // 6h (médias históricas por time)
  jogos_arbitro:           12 * 60 * 60 * 1000, // 12h
  weather:                     3 * 60 * 60 * 1000, // 3h (previsão muda)
  // ✅ NOVO — telas "Jogos ao Vivo" e "Odds"
  jogos_ao_vivo:        20 * 1000,        // 20s (placar ao vivo)
  jogos_ao_vivo_stats:  30 * 1000,        // 30s (stats ao vivo)
  jogos_odds_evento:    5 * 60 * 1000,    // 5min (odds mexem, mas não a cada segundo)
  jogos_odds_liga:      10 * 60 * 1000,   // 10min (lote é caro de montar)
  // ✅ FlashLive futebol (Patch 2)
  flashlive_ultimos:        6 * 60 * 60 * 1000, // 6h (últimos jogos do time)
  flashlive_h2h:            6 * 60 * 60 * 1000, // 6h (confronto direto não muda rápido)
  tenis_torneios:     30 * 60 * 1000,      // 30min
  tenis_jogos:        5 * 60 * 1000,       // 5min (placar muda rápido, jogo ao vivo)
  tenis_historico:    6 * 60 * 60 * 1000,  // 6h (histórico de jogador não muda tão rápido)
  // ✅ NOVO — tela "Jogos ao Vivo" de tênis
  tenis_ao_vivo:       20 * 1000,          // 20s (placar ao vivo)
  tenis_ao_vivo_stats: 30 * 1000,          // 30s (stats ao vivo)
  // ✅ NOVO — Fase 1 da migração pra FlashLive (25/09/2026): tênis "cru"
  flashlive_tenis_jogos:    5 * 60 * 1000,   // 5min
  flashlive_tenis_ao_vivo:  20 * 1000,       // 20s (placar ao vivo)
  flashlive_tenis_h2h:      6 * 60 * 60 * 1000, // 6h (histórico não muda rápido)
  flashlive_tenis_ranking:  6 * 60 * 60 * 1000, // 6h (ranking atualiza 1x/semana)
  flashlive_tenis_odds:     5 * 60 * 1000,   // 5min
  flashlive_tenis_historico: 6 * 60 * 60 * 1000, // 6h (histórico do jogador)
  // Basquete via FlashLive
  flashlive_basquete_jogos:   5 * 60 * 1000,      // 5min (jogos do dia / placar)
  flashlive_basquete_ultimos: 6 * 60 * 60 * 1000, // 6h (histórico do time)
  flashlive_basquete_ao_vivo: 20 * 1000,          // 20s (placar ao vivo)
  default:            3 * 60 * 60 * 1000,  // 3h
}

// ── Inicializa tabela de cache (chama uma vez no initDB) ───────
export async function initSportsCache(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sports_cache (
      chave       TEXT PRIMARY KEY,
      dados       JSONB NOT NULL,
      tipo        TEXT,
      criado_em   BIGINT NOT NULL,
      expira_em   BIGINT NOT NULL,
      hits        INTEGER DEFAULT 0
    )
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sports_cache_expira
    ON sports_cache (expira_em)
  `)
  console.log('✅ Tabela sports_cache inicializada')
}

// ── Busca no cache ─────────────────────────────────────────────
export async function getCached(pool, chave) {
  try {
    const { rows } = await pool.query(
      `SELECT dados, expira_em FROM sports_cache WHERE chave = $1`,
      [chave]
    )
    if (!rows[0]) return null

    if (Date.now() > rows[0].expira_em) {
      await pool.query(`DELETE FROM sports_cache WHERE chave = $1`, [chave])
      return null
    }

    await pool.query(
      `UPDATE sports_cache SET hits = hits + 1 WHERE chave = $1`,
      [chave]
    )
    return rows[0].dados  // JSONB já vem parseado pelo pg driver

  } catch (err) {
    console.warn('[SportsCache] getCached erro:', err.message)
    return null
  }
}

// ── Salva no cache ─────────────────────────────────────────────
export async function setCached(pool, chave, dados, tipo = 'default') {
  const ttl      = TTL[tipo] ?? TTL.default
  const agora    = Date.now()
  const expira   = agora + ttl

  try {
    await pool.query(`
      INSERT INTO sports_cache (chave, dados, tipo, criado_em, expira_em, hits)
      VALUES ($1, $2, $3, $4, $5, 0)
      ON CONFLICT (chave) DO UPDATE
        SET dados = $2, tipo = $3, criado_em = $4, expira_em = $5, hits = 0
    `, [chave, JSON.stringify(dados), tipo, agora, expira])
    return dados
  } catch (err) {
    console.warn('[SportsCache] setCached erro:', err.message)
    return dados  // retorna os dados mesmo se cache falhar
  }
}

// ── Limpa entradas expiradas (chamar via cronjob ou rota admin) ─
export async function limparExpirados(pool) {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM sports_cache WHERE expira_em < $1`,
      [Date.now()]
    )
    return rowCount
  } catch (err) {
    console.warn('[SportsCache] limparExpirados erro:', err.message)
    return 0
  }
}

// ── Força remoção de cache por tipo, MESMO que ainda não tenha expirado.
// Útil logo depois de um deploy que muda a lógica de um scraper: o cache
// antigo (calculado com o código velho) continua "válido" até o TTL bater,
// então limparExpirados() sozinho não resolve — precisa desse aqui.
export async function limparPorTipo(pool, tipo) {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM sports_cache WHERE tipo = $1`,
      [tipo]
    )
    return rowCount
  } catch (err) {
    console.warn('[SportsCache] limparPorTipo erro:', err.message)
    return 0
  }
}

// ── Estatísticas do cache ──────────────────────────────────────
export async function getCacheStats(pool) {
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)                                          AS total,
        COUNT(*) FILTER (WHERE expira_em > $1)            AS ativas,
        COUNT(*) FILTER (WHERE expira_em <= $1)           AS expiradas,
        SUM(hits)                                         AS total_hits,
        tipo,
        COUNT(*) as por_tipo
      FROM sports_cache
      GROUP BY tipo
    `, [Date.now()])
    return rows
  } catch (err) {
    return []
  }
}

// ── Gera chave de cache consistente ───────────────────────────
export function makeKey(tipo, ...partes) {
  const slug = partes
    .map(p => String(p).toLowerCase().replace(/[^a-z0-9]/g, '_'))
    .join(':')
  return `${tipo}:${slug}`
}