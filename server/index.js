// server/index.js — VERSÃO COM POSTGRESQL
import express from 'express'
import fetch from 'node-fetch'
import cors from 'cors'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { existsSync } from 'fs'
import pg from 'pg'
import { registerSportsRoutes, LIGA_MAP, resolveLiga } from './sportsDataRoutes.js'
import { initSportsCache }      from './scrapers/sportsCache.js'
// 🔁 Estatísticas/resultado de futebol agora vêm da FlashLive (o SofaScore foi removido do projeto)
import { getPartidaStats, getIncidentesPartida } from './scrapers/flashscoreScraper.js'
// ✅ NOVO — item 6: liquidação automática de tênis (Vitória/ML e Sets Diretos)
import { getEstatisticasTenisAoVivo } from './scrapers/flashscoreTennisScraper.js'
// ✅ NOVO — Fase 1, item 2 do roadmap: segunda fonte (FlashLive) pra cross-check pós-jogo
import { getResultadoRealFlashLive } from './scrapers/flashliveScraper.js'
// 🔕 REMOVIDO — comandos /jogos e /tenis do bot (busca de jogos via Telegram).
// Isso disparava buscas pesadas que competiam com o site, causando
// lentidão nas rotas do site.
// O bot agora só recebe as notificações automáticas enviadas ao final da Etapa 3.

const { Pool } = pg
const app  = express()
const PORT = process.env.PORT || 3001

// ✅ Fix: chaves de API não têm mais fallback hardcoded no código-fonte.
// Se a env var não existir, a rota correspondente responde 500 com uma
// mensagem clara em vez de silenciosamente usar uma chave commitada no repo.
const FD_KEY     = process.env.FD_KEY     || ''
const GROQ_KEY   = process.env.GROQ_KEY   || ''
const ODDS_KEY   = process.env.ODDS_KEY   || ''
// SPORT_KEY: nome legado da chave RapidAPI — hoje só serve de fallback p/ FLASHLIVE_KEY
const SPORT_KEY  = process.env.SPORT_KEY  || ''

if (!FD_KEY)   console.warn('⚠️  FD_KEY não configurada — rotas /api/fd/* vão retornar erro 500.')
if (!GROQ_KEY) console.warn('⚠️  GROQ_KEY não configurada — rotas /api/groq vão retornar erro 500.')

// ── CORS ──────────────────────────────────────────────────────
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*'
app.use(cors({ origin: ALLOWED_ORIGIN === '*' ? true : ALLOWED_ORIGIN.split(',') }))
app.use(express.json())

// ── Conexão PostgreSQL ──────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
})

// ── Hash de senha (crypto.scrypt nativo — sem dependência extra) ──
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false
  const [salt, hashHex] = stored.split(':')
  const hashBuffer = Buffer.from(hashHex, 'hex')
  const testHash    = crypto.scryptSync(password, salt, 64)
  if (hashBuffer.length !== testHash.length) return false
  return crypto.timingSafeEqual(hashBuffer, testHash)
}

function isLegacyPlaintext(stored) {
  return !!stored && !stored.includes(':')
}

// ── Inicializa tabelas ──────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      password TEXT NOT NULL,
      role     TEXT NOT NULL DEFAULT 'user'
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      username   TEXT NOT NULL,
      role       TEXT NOT NULL,
      expires_at BIGINT NOT NULL
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tracker (
      id   SERIAL PRIMARY KEY,
      data JSONB  NOT NULL
    )
  `)

  await pool.query(`
  CREATE TABLE IF NOT EXISTS elo_ratings (
    team_id    INTEGER PRIMARY KEY,
    rating     NUMERIC(8,1) NOT NULL DEFAULT 1500,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`)
  console.log('✅ Tabela elo_ratings pronta')
    await pool.query(`
    CREATE TABLE IF NOT EXISTS elo_jogos_processados (
      chave     TEXT PRIMARY KEY,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // ✅ NOVO — Etapa 3: log de auditoria da liquidação automática/manual
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tracker_audit_log (
      id                  SERIAL PRIMARY KEY,
      tracker_id          TEXT NOT NULL,
      resultado_anterior  TEXT,
      resultado_novo      TEXT NOT NULL,
      placar_final        TEXT,
      fonte               TEXT NOT NULL,
      dados_brutos        JSONB,
      autor               TEXT,
      criado_em           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  console.log('✅ Tabela tracker_audit_log pronta')

  // ✅ NOVO — arquivo do histórico zerado. Quando o admin usa "Zerar histórico",
  // as entradas liquidadas (green/red/anulada) saem do tracker (dashboard,
  // gráficos, ranking, histórico começam do zero) mas ficam guardadas aqui,
  // completas. O calibrationService continua lendo green/red daqui, então a
  // calibração atual é mantida e só recebe os dados novos por cima.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tracker_archive (
      id            SERIAL PRIMARY KEY,
      entry_id      TEXT NOT NULL UNIQUE,
      evento_id     TEXT,
      mercado       TEXT,
      resultado     TEXT,
      data          JSONB NOT NULL,
      lote          TEXT NOT NULL,
      arquivado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  // Migração (idempotente): bancos antigos têm a coluna `sofascore_id`; renomeia p/ `evento_id`
  try {
    await pool.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'tracker_archive' AND column_name = 'sofascore_id') THEN
          ALTER TABLE tracker_archive RENAME COLUMN sofascore_id TO evento_id;
        END IF;
      END $$;
    `)
    // Migração (idempotente): campo `sofascoreId` → `eventoId` dentro do JSON das entradas
    await pool.query(`
      UPDATE tracker SET data = COALESCE((
        SELECT jsonb_agg(
          CASE WHEN jsonb_typeof(t.e) = 'object' AND t.e ? 'sofascoreId'
               THEN (t.e - 'sofascoreId') || jsonb_build_object('eventoId', COALESCE(t.e->'eventoId', t.e->'sofascoreId'))
               ELSE t.e END
          ORDER BY t.ord)
        FROM jsonb_array_elements(tracker.data) WITH ORDINALITY AS t(e, ord)
      ), '[]'::jsonb)
      WHERE jsonb_typeof(data) = 'array' AND data::text LIKE '%sofascoreId%'
    `)
    await pool.query(`
      UPDATE tracker_archive
         SET data = (data - 'sofascoreId') || jsonb_build_object('eventoId', COALESCE(data->'eventoId', data->'sofascoreId'))
       WHERE data ? 'sofascoreId'
    `)
  } catch (err) {
    console.error('[Migração eventoId] falhou (não crítico):', err.message)
  }
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tracker_archive_jogo ON tracker_archive (evento_id, mercado)`)
  console.log('✅ Tabela tracker_archive pronta')

  // ✅ NOVO — Fase 2, item 7 do roadmap: persistência dos fatores de calibração
  // (global + segmentos de liga/árbitro que o calibrationService já calcula
  // em memória). Guarda um snapshot no banco pra não depender só do cálculo
  // no navegador a cada análise, e serve de base pro job recorrente (item 13).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS calibration_factors (
      id             SERIAL PRIMARY KEY,
      mercado        TEXT NOT NULL,
      segmento_tipo  TEXT NOT NULL DEFAULT 'global',
      segmento_valor TEXT NOT NULL DEFAULT '',
      fator          NUMERIC(5,3) NOT NULL,
      n_amostras     INTEGER,
      atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (mercado, segmento_tipo, segmento_valor)
    )
  `)
  console.log('✅ Tabela calibration_factors pronta')

  // ✅ NOVO — alertas automáticos do modelo (GO/NO-GO e troca de técnica de calibração)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS alertas (
      id        SERIAL PRIMARY KEY,
      tipo      TEXT NOT NULL,
      mensagem  TEXT NOT NULL,
      dados     JSONB,
      enviado   BOOLEAN NOT NULL DEFAULT FALSE,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS modelo_estado (
      chave         TEXT PRIMARY KEY,
      valor         JSONB NOT NULL,
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  console.log('✅ Tabelas alertas e modelo_estado prontas')

  // ✅ NOVO — Fase 6: histórico de odds pra line movement / steam detection
  await pool.query(`
    CREATE TABLE IF NOT EXISTS odds_historico (
      id             SERIAL PRIMARY KEY,
      jogo_id        TEXT NOT NULL,
      liga_code      TEXT NOT NULL,
      mandante       TEXT NOT NULL,
      visitante      TEXT NOT NULL,
      comeca_em      TIMESTAMPTZ,
      prob_mandante  NUMERIC(5,1),
      prob_empate    NUMERIC(5,1),
      prob_visitante NUMERIC(5,1),
      capturado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_odds_historico_jogo ON odds_historico (mandante, visitante, capturado_em)`)
  console.log('✅ Tabela odds_historico pronta')

    // ✅ NOVO — histórico de jogos + odds (alimentado pelo coletor Python / soccerdata)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS jogos_historico (
      id                     SERIAL PRIMARY KEY,
      liga                   TEXT NOT NULL,
      temporada              TEXT NOT NULL,
      jogo_chave             TEXT NOT NULL,
      data_jogo              TIMESTAMPTZ,
      mandante               TEXT NOT NULL,
      visitante              TEXT NOT NULL,
      gols_mandante          SMALLINT,
      gols_visitante         SMALLINT,
      resultado              CHAR(1),
      gols_ht_mandante       SMALLINT,
      gols_ht_visitante      SMALLINT,
      chutes_mandante        SMALLINT,
      chutes_visitante       SMALLINT,
      chutes_alvo_mandante   SMALLINT,
      chutes_alvo_visitante  SMALLINT,
      escanteios_mandante    SMALLINT,
      escanteios_visitante   SMALLINT,
      amarelos_mandante      SMALLINT,
      amarelos_visitante     SMALLINT,
      vermelhos_mandante     SMALLINT,
      vermelhos_visitante    SMALLINT,
      odds_pin_h             NUMERIC(8,3),
      odds_pin_d             NUMERIC(8,3),
      odds_pin_a             NUMERIC(8,3),
      odds_pin_fech_h        NUMERIC(8,3),
      odds_pin_fech_d        NUMERIC(8,3),
      odds_pin_fech_a        NUMERIC(8,3),
      odds_med_h             NUMERIC(8,3),
      odds_med_d             NUMERIC(8,3),
      odds_med_a             NUMERIC(8,3),
      odds_med_fech_h        NUMERIC(8,3),
      odds_med_fech_d        NUMERIC(8,3),
      odds_med_fech_a        NUMERIC(8,3),
      over25_pin             NUMERIC(8,3),
      under25_pin            NUMERIC(8,3),
      over25_med             NUMERIC(8,3),
      under25_med            NUMERIC(8,3),
      over25_pin_fech        NUMERIC(8,3),
      under25_pin_fech       NUMERIC(8,3),
      over25_med_fech        NUMERIC(8,3),
      under25_med_fech       NUMERIC(8,3),
      dados_brutos           JSONB,
      atualizado_em          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (liga, temporada, jogo_chave)
    )
  `)
  console.log('✅ Tabela jogos_historico pronta')

  // ✅ NOVO — banca atual por usuário (base do Kelly em R$)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS banca (
      username      TEXT PRIMARY KEY,
      valor         NUMERIC(14,2) NOT NULL,
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  console.log('✅ Tabela banca pronta')

  const { rowCount } = await pool.query(`SELECT 1 FROM users WHERE username = 'admin'`)
  if (rowCount === 0) {
    // Senha inicial vem do ambiente; sem ela, gera uma aleatória e mostra uma única vez no log
    const senhaInicial = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url')
    await pool.query(
      `INSERT INTO users (username, password, role) VALUES ('admin', $1, 'admin')`,
      [hashPassword(senhaInicial)]
    )
    console.log(process.env.ADMIN_PASSWORD
      ? '✅ Usuário admin criado com a senha de ADMIN_PASSWORD'
      : `✅ Usuário admin criado — senha inicial: ${senhaInicial} (troque após o primeiro login)`)
  }
  await initSportsCache(pool)
  console.log('✅ Banco de dados inicializado')
}

// ── Sessões ───────────────────────────────────────────────────
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

async function getSession(token) {
  const { rows } = await pool.query(`SELECT * FROM sessions WHERE token = $1`, [token])
  if (!rows[0]) return null
  if (rows[0].expires_at < Date.now()) {
    await pool.query(`DELETE FROM sessions WHERE token = $1`, [token])
    return null
  }
  return { username: rows[0].username, role: rows[0].role }
}

async function setSession(token, data) {
  const expiresAt = Date.now() + SESSION_TTL_MS
  await pool.query(
    `INSERT INTO sessions (token, username, role, expires_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (token) DO UPDATE SET expires_at = $4`,
    [token, data.username, data.role, expiresAt]
  )
}

async function deleteSession(token) {
  await pool.query(`DELETE FROM sessions WHERE token = $1`, [token])
}

// ── Usuários ──────────────────────────────────────────────────
async function loadUsers() {
  const { rows } = await pool.query(`SELECT * FROM users`)
  return rows
}

async function saveUser(user) {
  await pool.query(
    `INSERT INTO users (username, password, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (username) DO UPDATE SET password = $2, role = $3`,
    [user.username, user.password, user.role || 'user']
  )
}

async function deleteUser(username) {
  await pool.query(`DELETE FROM users WHERE username = $1`, [username])
}

// ── Tracker ───────────────────────────────────────────────────
// Compat: abas/clientes antigos ainda mandam `sofascoreId` — converte p/ `eventoId` (in-place).
function normalizarEntradasTracker(arr) {
  if (!Array.isArray(arr)) return arr
  for (const j of arr) {
    if (j && typeof j === 'object' && 'sofascoreId' in j) {
      if (j.eventoId == null) j.eventoId = j.sofascoreId
      delete j.sofascoreId
    }
  }
  return arr
}

async function loadTracker() {
  const { rows } = await pool.query(`SELECT data FROM tracker ORDER BY id LIMIT 1`)
  if (!rows[0]) return []
  return normalizarEntradasTracker(rows[0].data)
}

async function saveTracker(dataArray) {
  normalizarEntradasTracker(dataArray)
  const { rowCount } = await pool.query(`SELECT id FROM tracker LIMIT 1`)
  if (rowCount === 0) {
    await pool.query(`INSERT INTO tracker (data) VALUES ($1)`, [JSON.stringify(dataArray)])
  } else {
    await pool.query(`UPDATE tracker SET data = $1`, [JSON.stringify(dataArray)])
  }
}

// ✅ FIX — item 3: evita perda de dados por concorrência. Em vez de carregar
// o array inteiro, mexer nele em memória (possivelmente durante chamadas de
// rede demoradas) e sobrescrever tudo no final, este helper trava a linha
// (FOR UPDATE), relê o estado MAIS RECENTE do banco e aplica só as mudanças
// que `mutateFn` fizer nesse array fresco. mutateFn deve retornar `true` se
// alterou algo (senão não grava).
async function atualizarTrackerPorEntrada(mutateFn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(`SELECT id, data FROM tracker ORDER BY id LIMIT 1 FOR UPDATE`)
    if (!rows[0]) { await client.query('ROLLBACK'); return { alterou: false } }
    const atual = normalizarEntradasTracker(Array.isArray(rows[0].data) ? rows[0].data : [])
    const alterou = mutateFn(atual)
    if (alterou) {
      await client.query(`UPDATE tracker SET data = $1 WHERE id = $2`, [JSON.stringify(atual), rows[0].id])
    }
    await client.query('COMMIT')
    return { alterou }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

// ✅ NOVO — Etapa 3: grava 1 linha de auditoria por liquidação (automática ou manual)
async function logAuditoria({ trackerId, resultadoAnterior, resultadoNovo, placarFinal, fonte, dadosBrutos, autor }) {
  try {
    await pool.query(
      `INSERT INTO tracker_audit_log (tracker_id, resultado_anterior, resultado_novo, placar_final, fonte, dados_brutos, autor)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [trackerId, resultadoAnterior ?? null, resultadoNovo, placarFinal ?? null, fonte, dadosBrutos ? JSON.stringify(dadosBrutos) : null, autor ?? null]
    )
  } catch (err) {
    // auditoria não pode derrubar a liquidação em si — só loga o erro
    console.error('[Auditoria] falha ao gravar log:', err.message)
  }
}

// ✅ NOVO — quais desses ids já foram arquivados (usado pra um navegador com
// tela antiga não "ressuscitar" entradas arquivadas ao salvar o array inteiro).
async function filtrarIdsArquivados(ids) {
  try {
    if (!ids.length) return new Set()
    const { rows } = await pool.query(`SELECT entry_id FROM tracker_archive WHERE entry_id = ANY($1::text[])`, [ids])
    return new Set(rows.map(r => r.entry_id))
  } catch (err) {
    console.error('[Arquivo] falha ao checar ids arquivados:', err.message)
    return new Set()
  }
}

// ✅ NOVO — esse jogo+mercado já foi arquivado? (evita que o auto-save recrie
// uma entrada de um jogo antigo e ele seja liquidado/contado duas vezes)
async function jogoJaArquivado(eventoId, mercado) {
  try {
    const { rowCount } = await pool.query(
      `SELECT 1 FROM tracker_archive WHERE evento_id = $1 AND mercado = $2 LIMIT 1`,
      [String(eventoId), String(mercado)]
    )
    return rowCount > 0
  } catch (err) {
    console.error('[Arquivo] falha ao checar jogo arquivado:', err.message)
    return false
  }
}

// ── Middlewares ───────────────────────────────────────────────
async function authMiddleware(req, res, next) {
  const token = req.headers['x-auth-token']
  if (!token) return res.status(401).json({ error: 'Não autenticado' })
  const session = await getSession(token)
  if (!session) return res.status(401).json({ error: 'Sessão expirada ou inválida. Faça login novamente.' })
  req.user = session
  next()
}

function adminMiddleware(req, res, next) {
  if (req.user?.role !== 'admin')
    return res.status(403).json({ error: 'Acesso negado — apenas admins' })
  next()
}

// ── Rate limiting simples para /api/login (em memória) ─────────
const LOGIN_MAX_TENTATIVAS = 5
const LOGIN_JANELA_MS      = 15 * 60 * 1000
const _loginAttempts = new Map()

function loginRateLimiter(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown'
  const agora = Date.now()
  const entry = _loginAttempts.get(ip)

  if (!entry || agora > entry.resetAt) {
    _loginAttempts.set(ip, { count: 1, resetAt: agora + LOGIN_JANELA_MS })
    return next()
  }

  if (entry.count >= LOGIN_MAX_TENTATIVAS) {
    const esperaMin = Math.ceil((entry.resetAt - agora) / 60000)
    return res.status(429).json({ error: `Muitas tentativas de login. Aguarde ${esperaMin} min.` })
  }

  entry.count++
  next()
}

setInterval(() => {
  const agora = Date.now()
  for (const [ip, entry] of _loginAttempts) {
    if (agora > entry.resetAt) _loginAttempts.delete(ip)
  }
}, 10 * 60 * 1000).unref()

// ── Auth ──────────────────────────────────────────────────────
app.post('/api/login', loginRateLimiter, async (req, res) => {
  const { username, password } = req.body
  if (!username || !password) return res.status(400).json({ error: 'Username e password obrigatórios' })

  const users = await loadUsers()
  const user  = users.find(u => u.username === username)

  const senhaOk = user && (
    isLegacyPlaintext(user.password)
      ? user.password === password
      : verifyPassword(password, user.password)
  )

  if (!user || !senhaOk) return res.status(401).json({ error: 'Usuário ou senha incorretos' })

  if (isLegacyPlaintext(user.password)) {
    await saveUser({ username: user.username, password: hashPassword(password), role: user.role })
  }

  const token = crypto.randomBytes(32).toString('hex')
  await setSession(token, { username: user.username, role: user.role })
  res.json({ token, username: user.username, role: user.role })
})

app.post('/api/logout', authMiddleware, async (req, res) => {
  await deleteSession(req.headers['x-auth-token'])
  res.json({ ok: true })
})

app.get('/api/me', authMiddleware, (req, res) => res.json(req.user))

// ── Usuários (admin) ─────────────────────────────────────────
app.get('/api/users', authMiddleware, adminMiddleware, async (req, res) => {
  const users = (await loadUsers()).map(({ password, ...u }) => u)
  res.json(users)
})

app.post('/api/users', authMiddleware, adminMiddleware, async (req, res) => {
  const { username, password, role = 'user' } = req.body
  if (!username || !password) return res.status(400).json({ error: 'Username e password obrigatórios' })
  const users = await loadUsers()
  if (users.find(u => u.username === username))
    return res.status(400).json({ error: 'Usuário já existe' })
  await saveUser({ username, password: hashPassword(password), role })
  res.json({ ok: true })
})

app.delete('/api/users/:username', authMiddleware, adminMiddleware, async (req, res) => {
  if (req.params.username === 'admin')
    return res.status(400).json({ error: 'Não é possível remover o admin principal' })
  await deleteUser(req.params.username)
  res.json({ ok: true })
})

app.patch('/api/users/:username/password', authMiddleware, adminMiddleware, async (req, res) => {
  const { password } = req.body
  if (!password) return res.status(400).json({ error: 'Nova senha obrigatória' })
  const users = await loadUsers()
  const user = users.find(u => u.username === req.params.username)
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' })
  await saveUser({ ...user, password: hashPassword(password) })
  res.json({ ok: true })
})

// ── Tracker ───────────────────────────────────────────────────
app.get('/api/tracker', async (req, res) => {
  try { res.json(await loadTracker()) }
  catch (err) { console.error('Erro ao ler tracker:', err.message); res.json([]) }
})

app.post('/api/tracker', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Body deve ser um array' })
    // ✅ NOVO — descarta o que já foi arquivado (tela desatualizada em outro navegador)
    const ids = req.body.map(j => j && j.id).filter(id => id != null).map(String)
    const arquivados = await filtrarIdsArquivados(ids)
    const lista = arquivados.size ? req.body.filter(j => !(j && arquivados.has(String(j.id)))) : req.body
    await saveTracker(lista)
    res.json({ ok: true, total: lista.length })
  } catch (err) {
    console.error('Erro ao salvar tracker:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── Tracker: auto-save da análise (sem precisar de login) ──────────
app.post('/api/tracker/auto-save', async (req, res) => {
  try {
    const {
      eventoId: eventoIdBody, sofascoreId: eventoIdLegado, mandante, visitante, liga,
      mercado, direcao, linha, probabilidade,
      lambdaEsperado, confianca, dataJogo, horario, odd,
      clima, esporte,
      motorVersao, // ✅ NOVO — Fase 1, item 4: versão do motor que gerou a previsão
      datasetVersao, // ✅ NOVO — item 29: versão do dataset/fontes de dado na hora da previsão
      arbitro, // ✅ NOVO — Fase 2, item 7: nome do árbitro, pra segmentação por árbitro
      subModelos, // ✅ NOVO — 1X2: componentes Forma/H2H/ELO (alimenta o stacking do 1X2)
      // ✅ NOVO — item 34: as 3 probabilidades do 1X2 juntas (não só a do lado
      // escolhido), pra dar pra calcular RPS depois que o jogo terminar.
      probMandante, probEmpate, probVisitante,
      // ✅ NOVO — item 41: fatores de calibração vigentes NO MOMENTO da previsão,
      // pra reproduzir uma entrada antiga sem depender do snapshot agregado
      // (que muda com o tempo). Endpoint sem login, não confia no corpo cru.
      fatoresCalibUsados,
    } = req.body || {}
    // aceita o nome antigo (eventoId) de abas/clientes ainda não atualizados
    const eventoId = eventoIdBody ?? eventoIdLegado

    if (!eventoId || !mandante || !visitante || !mercado)
      return res.status(400).json({ error: 'Campos obrigatórios ausentes' })

    // ✅ NOVO — contexto de clima/altitude guardado junto da entrada (alimenta os gráficos)
    const climaLimpo = clima && typeof clima === 'object' ? {
      temperaturaC:       clima.temperaturaC       ?? null,
      probabilidadeChuva: clima.probabilidadeChuva ?? null,
      ventoKmh:           clima.ventoKmh           ?? null,
      altitudeM:          clima.altitudeM          ?? null,
      altitudeClasse:     clima.altitudeClasse     ?? null,
    } : null

    // ✅ NOVO — sub-modelos: só números (endpoint sem login, não confia no corpo)
    const numOuNull = v => (typeof v === 'number' && Number.isFinite(v) ? v : null)
    const subLimpo = subModelos && typeof subModelos === 'object' ? {
      forma: numOuNull(subModelos.forma), h2h: numOuNull(subModelos.h2h), elo: numOuNull(subModelos.elo),
      poisson: numOuNull(subModelos.poisson), hist: numOuNull(subModelos.hist),
    } : null

    // ✅ NOVO — item 41: mesmo cuidado do subLimpo — só aceita pares chave/número,
    // ignora qualquer coisa que não seja um fator numérico (proteção do endpoint sem login)
    const fatoresCalibLimpo = fatoresCalibUsados && typeof fatoresCalibUsados === 'object'
      ? Object.fromEntries(
          Object.entries(fatoresCalibUsados).filter(([k, v]) => typeof k === 'string' && numOuNull(v) !== null)
        )
      : null

    // ✅ NOVO — jogo que já foi arquivado no "Zerar histórico" não volta pro tracker
    if (await jogoJaArquivado(eventoId, mercado)) {
      return res.json({ ok: true, ignorado: true, motivo: 'jogo já arquivado' })
    }

    // ✅ FIX — item 3: acha "existente" (ou monta "novo") com a linha travada e
    // lendo o array mais atual do banco. Assim, duas chamadas concorrentes de
    // auto-save (jogos diferentes, ou dois updates do mesmo jogo quase juntos)
    // não pisam uma na outra sobrescrevendo o array inteiro por cima.
    let resposta = null
    await atualizarTrackerPorEntrada(atual => {
      const existente = atual.find(j => j.eventoId === eventoId && j.origem === 'auto' && j.mercado === mercado)

      if (existente) {
        let mudou = false
        if (odd != null && odd !== '' && existente.odd !== parseFloat(odd)) {
          existente.odd = parseFloat(odd)
          mudou = true
        }
        if (climaLimpo && !existente.clima) {
          existente.clima = climaLimpo
          mudou = true
        }
        if (probabilidade != null && existente.probabilidade == null) {
          existente.probabilidade = probabilidade
          mudou = true
        }
        if (motorVersao != null && existente.motorVersao == null) {
          existente.motorVersao = motorVersao
          mudou = true
        }
        if (datasetVersao != null && existente.datasetVersao == null) {
          existente.datasetVersao = datasetVersao
          mudou = true
        }
        if (fatoresCalibLimpo && Object.keys(fatoresCalibLimpo).length && !existente.fatoresCalibUsados) {
          existente.fatoresCalibUsados = fatoresCalibLimpo
          mudou = true
        }
        if (arbitro && !existente.arbitro) {
          existente.arbitro = arbitro
          mudou = true
        }
        if (subLimpo && !existente.subModelos) {
          existente.subModelos = subLimpo
          mudou = true
        }
        if (typeof probMandante === 'number' && existente.probMandante == null) {
          existente.probMandante  = probMandante
          existente.probEmpate    = typeof probEmpate === 'number' ? probEmpate : null
          existente.probVisitante = typeof probVisitante === 'number' ? probVisitante : null
          mudou = true
        }
        resposta = { ok: true, atualizado: true, id: existente.id }
        return mudou
      }

      const novo = {
        id: 'auto_' + eventoId + '_' + Date.now(),
        eventoId, origem: 'auto',
        mandante, visitante, liga: liga || 'Outro',
        arbitro: arbitro || null, // ✅ NOVO — Fase 2, item 7: segmentação por árbitro
        esporte: esporte || null, // ✅ NOVO — 'tenis' faz o calibrationService reconhecer certo (ehEntradaTenis)
        mercado, direcao: direcao || 'over', linha: linha != null ? parseFloat(linha) : null,
        probabilidade: probabilidade ?? null,
        lambdaEsperado: lambdaEsperado ?? null,
        confianca: confianca || 'Média',
        dataJogo: dataJogo || null, horario: horario || null,
        odd: odd != null && odd !== '' ? parseFloat(odd) : null,
        clima: climaLimpo,
        motorVersao: motorVersao ?? null, // ✅ NOVO — Fase 1, item 4
        datasetVersao: datasetVersao ?? null, // ✅ NOVO — item 29
        fatoresCalibUsados: fatoresCalibLimpo && Object.keys(fatoresCalibLimpo).length ? fatoresCalibLimpo : null, // ✅ NOVO — item 41
        subModelos: subLimpo, // ✅ NOVO — 1X2: Forma/H2H/ELO (stacking)
        // ✅ NOVO — item 34: as 3 probabilidades do 1X2 (pra RPS). Só números —
        // mesmo cuidado do subLimpo, esse endpoint não exige login.
        probMandante:  typeof probMandante === 'number' ? probMandante : null,
        probEmpate:    typeof probEmpate === 'number' ? probEmpate : null,
        probVisitante: typeof probVisitante === 'number' ? probVisitante : null,
        obs: '', resultado: null, placarFinal: null,
        criadoEm: new Date().toISOString(), marcadoEm: null,
        criadoPor: 'sistema (auto)',
      }
      atual.unshift(novo)
      resposta = { ok: true, criado: true, id: novo.id }
      return true
    })

    res.json(resposta)
  } catch (err) {
    console.error('Erro no auto-save do tracker:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ✅ NOVO — Fase 2, item 7 do roadmap: persistência dos fatores de calibração.
// POST recebe o snapshot calculado no navegador (calcFatoresCalibration) e
// grava/atualiza por (mercado, segmento). GET devolve o snapshot mais recente.
app.post('/api/calibration-factors', async (req, res) => {
  try {
    const linhas = Array.isArray(req.body?.fatores) ? req.body.fatores : []
    for (const l of linhas) {
      if (!l?.mercado || typeof l.fator !== 'number') continue
      await pool.query(
        `INSERT INTO calibration_factors (mercado, segmento_tipo, segmento_valor, fator, n_amostras, atualizado_em)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (mercado, segmento_tipo, segmento_valor)
         DO UPDATE SET fator = $4, n_amostras = $5, atualizado_em = NOW()`,
        [l.mercado, l.segmentoTipo || 'global', l.segmentoValor || '', l.fator, l.nAmostras ?? null]
      )
    }
    res.json({ ok: true, gravados: linhas.length })
  } catch (err) {
    console.error('[Calibration] falha ao persistir fatores:', err.message)
    res.status(500).json({ error: 'Falha ao persistir fatores de calibração' })
  }
})

app.get('/api/calibration-factors', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT mercado, segmento_tipo, segmento_valor, fator, n_amostras, atualizado_em
       FROM calibration_factors ORDER BY mercado, segmento_tipo, segmento_valor`
    )
    res.json({ fatores: rows })
  } catch (err) {
    console.error('[Calibration] falha ao ler fatores persistidos:', err.message)
    res.json({ fatores: [] })
  }
})

// ✅ NOVO — banca atual do usuário logado (Kelly em R$). Cada usuário tem a sua.
app.get('/api/banca', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT valor FROM banca WHERE username = $1`, [req.user.username])
    res.json({ valor: rows[0] ? Number(rows[0].valor) : null })
  } catch (err) {
    console.error('[Banca] falha ao ler:', err.message)
    res.status(500).json({ error: 'Falha ao ler a banca' })
  }
})

app.put('/api/banca', authMiddleware, async (req, res) => {
  try {
    const valor = Number(req.body?.valor)
    if (!Number.isFinite(valor) || valor <= 0 || valor > 1e9)
      return res.status(400).json({ error: 'Valor de banca inválido' })
    const arred = Math.round(valor * 100) / 100
    await pool.query(
      `INSERT INTO banca (username, valor, atualizado_em) VALUES ($1, $2, NOW())
       ON CONFLICT (username) DO UPDATE SET valor = $2, atualizado_em = NOW()`,
      [req.user.username, arred]
    )
    res.json({ ok: true, valor: arred })
  } catch (err) {
    console.error('[Banca] falha ao salvar:', err.message)
    res.status(500).json({ error: 'Falha ao salvar a banca' })
  }
})

// ✅ NOVO — dados pra CALIBRAÇÃO: tracker atual + green/red arquivados.
// Os "atuais" alimentam dashboard/gráficos/ranking; os "arquivados" só entram
// na calibração (mesmos dados, mesma data → mesmo peso temporal de antes).
app.get('/api/tracker/calibracao-dados', async (req, res) => {
  try {
    const atuais = await loadTracker()
    let arquivadas = []
    try {
      const ids = new Set(atuais.map(j => String(j?.id)))
      const { rows } = await pool.query(`SELECT data FROM tracker_archive WHERE resultado IN ('green', 'red') ORDER BY id`)
      arquivadas = rows.map(r => r.data).filter(e => e && !ids.has(String(e.id)))
    } catch (err) {
      console.error('[Arquivo] falha ao ler arquivo p/ calibração:', err.message)
    }
    res.json({ atuais, arquivadas })
  } catch (err) {
    console.error('Erro ao ler dados de calibração:', err.message)
    res.json({ atuais: [], arquivadas: [] })
  }
})

// ✅ NOVO — "Zerar histórico": move green/red/anulada do tracker pro arquivo.
// Nada é apagado: as entradas ficam completas em tracker_archive e a calibração
// continua usando green/red delas. Pendentes ficam no tracker e contam como
// dado novo quando forem liquidadas.
const RESULTADOS_LIQUIDADOS = ['green', 'red', 'anulada']
app.post('/api/tracker/zerar-historico', authMiddleware, adminMiddleware, async (req, res) => {
  if (req.body?.confirmar !== true) return res.status(400).json({ error: 'Confirmação ausente' })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(`SELECT id, data FROM tracker ORDER BY id LIMIT 1 FOR UPDATE`)
    const atuais = Array.isArray(rows[0]?.data) ? rows[0].data : []
    const liquidadas = atuais.filter(j => RESULTADOS_LIQUIDADOS.includes(j?.resultado))

    if (!rows[0] || liquidadas.length === 0) {
      await client.query('ROLLBACK')
      return res.json({ ok: true, arquivadas: 0, greens: 0, reds: 0, anuladas: 0, mantidas: atuais.length })
    }

    const lote = new Date().toISOString()
    let idx = 0
    for (const j of liquidadas) {
      await client.query(
        `INSERT INTO tracker_archive (entry_id, evento_id, mercado, resultado, data, lote)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (entry_id) DO NOTHING`,
        [
          String(j.id ?? `sem_id_${lote}_${idx++}`),
          j.eventoId != null ? String(j.eventoId) : null,
          j.mercado ?? null, j.resultado, JSON.stringify(j), lote,
        ]
      )
    }
    const restantes = atuais.filter(j => !RESULTADOS_LIQUIDADOS.includes(j?.resultado))
    await client.query(`UPDATE tracker SET data = $1 WHERE id = $2`, [JSON.stringify(restantes), rows[0].id])
    await client.query('COMMIT')

    const contar = r => liquidadas.filter(j => j.resultado === r).length
    console.log(`🧹 Histórico zerado por ${req.user?.username}: ${liquidadas.length} entradas arquivadas, ${restantes.length} mantidas`)
    res.json({
      ok: true, arquivadas: liquidadas.length,
      greens: contar('green'), reds: contar('red'), anuladas: contar('anulada'),
      mantidas: restantes.length,
    })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('Erro ao zerar histórico:', err.message)
    res.status(500).json({ error: err.message })
  } finally {
    client.release()
  }
})

// ── Resolvedor automático: over/under de gols, cartões e escanteios ────
// ✅ ESTENDIDO: detecta a categoria pelo texto do mercado salvo no tracker e
// usa o total certo pra cada uma:
//  - Gols:       placar_casa + placar_fora (tempo normal, ver Patch 2)
//  - Cartões:    amarelos + vermelhos dos dois times (mesmo critério usado
//                no resto do sistema pra "total de cartões")
//  - Escanteios: escanteios_total (já vem somado do getPartidaStats)
function detectarCategoriaMercado(mercadoTxt) {
  const t = String(mercadoTxt || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  if (/cart/.test(t)) return 'cartoes'
  if (/escanteio/.test(t)) return 'escanteios'
  return 'gols'
}

function totalDaCategoria(stats, categoria) {
  if (categoria === 'cartoes') {
    if (stats.cartoes_amarelos_casa == null || stats.cartoes_amarelos_fora == null) return null
    return (stats.cartoes_amarelos_casa ?? 0) + (stats.cartoes_amarelos_fora ?? 0)
         + (stats.cartoes_vermelhos_casa ?? 0) + (stats.cartoes_vermelhos_fora ?? 0)
  }
  if (categoria === 'escanteios') return stats.escanteios_total ?? null
  if (stats.placar_casa == null || stats.placar_fora == null) return null
  return stats.placar_casa + stats.placar_fora
}

// ✅ NOVO — 1X2: reconhece "Vitória Mandante" / "Vitória Visitante" (com ou sem emoji)
function detectar1x2(mercadoTxt) {
  const t = normTxt(mercadoTxt)
  if (/vitoria\s+mandante/.test(t)) return 'mandante'
  if (/vitoria\s+visitante/.test(t)) return 'visitante'
  return null
}

function resolverMercadoLinha(stats, mercadoTxt, linha, direcao) {
  // ✅ NOVO — 1X2 liquida pelo placar do tempo normal (empate = red)
  const lado1x2 = detectar1x2(mercadoTxt)
  if (lado1x2) {
    if (stats.placar_casa == null || stats.placar_fora == null) return null
    const venceu = lado1x2 === 'mandante'
      ? stats.placar_casa > stats.placar_fora
      : stats.placar_fora > stats.placar_casa
    return venceu ? 'green' : 'red'
  }
  if (linha == null) return null
  const total = totalDaCategoria(stats, detectarCategoriaMercado(mercadoTxt))
  if (total == null) return null
  return direcao === 'under' ? (total < linha ? 'green' : 'red')
                              : (total > linha ? 'green' : 'red')
}

// ── Resolvedor automático de TÊNIS: "{jogador} vencedor (ML)" e
// "{jogador} sets diretos (X-Y)" — item 6 (baixa automática Green/Red).
// Compara pelo nome salvo no texto do mercado (mesma string usada ao gravar
// a entrada em App.jsx), contra quem realmente ganhou mais sets.
function normTxt(t) {
  return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
}

function ehTenis(esporte) {
  return normTxt(esporte).startsWith('tenis')
}

function resolverMercadoTenis(stats, mercadoTxt) {
  const setsCasa = stats.setsMandante ?? 0
  const setsFora = stats.setsVisitante ?? 0
  if (setsCasa === setsFora) return null // placar de sets ausente/empatado — não dá pra liquidar

  const vencedor       = setsCasa > setsFora ? stats.mandante : stats.visitante
  const setsPerdedor   = setsCasa > setsFora ? setsFora : setsCasa

  const mSets = String(mercadoTxt || '').match(/^(.*?)\s+sets diretos/i)
  if (mSets) {
    const jogador = normTxt(mSets[1])
    if (jogador !== normTxt(vencedor)) return 'red'      // nem ganhou a partida
    return setsPerdedor === 0 ? 'green' : 'red'          // ganhou mas cedeu 1+ set
  }

  const mML = String(mercadoTxt || '').match(/^(.*?)\s+vencedor/i)
  if (mML) {
    const jogador = normTxt(mML[1])
    return jogador === normTxt(vencedor) ? 'green' : 'red'
  }
  return null // texto do mercado não reconhecido — não arrisca liquidar errado
}

// Status (normalizados em flashscoreTennisScraper.js) em que uma partida de tênis nunca vai ter resultado
// confiável pra liquidar automaticamente. "retired"/"walkover" ficam de fora
// de propósito: mesmo com sets decididos, o critério de liquidação de casas
// de aposta pra desistência varia — mais seguro exigir conferência manual.
const TENNIS_STATUS_ANULA    = new Set(['postponed', 'canceled', 'cancelled'])
const TENNIS_STATUS_MANUAL   = new Set(['retired', 'walkover', 'abandoned', 'suspended'])

// ✅ NOVO — Etapa 3: status normalizados que significam "nunca vai ter placar
// válido pra esse jogo" → liquida como Anulada. Confirmado na documentação
// FlashLive → mapearStatus*(): "postponed"/"canceled" pra isso.
const STATUS_ANULA = new Set(['postponed', 'canceled'])
// Status em que o jogo ainda pode terminar normalmente, mas não terminou —
// fica pendente, não mexe (não é seguro presumir resultado aqui).
const STATUS_EM_ABERTO = new Set(['notstarted', 'live', 'inprogress', 'delayed', 'interrupted', 'abandoned', 'suspended'])

// ✅ NOVO — Fase 1, item 1 do roadmap: além de inferir green/red (que já
// existia), grava o RESULTADO REAL bruto (gols, cartões, escanteios, por
// time) na própria entrada da previsão. Antes, esses números só passavam
// "de relance" pelo `dadosBrutos` do log de auditoria — fica difícil de
// consultar em massa pra calibração (Fase 2+). Agora ficam também em
// `j.resultadoReal`, junto da previsão original, prontos pra qualquer
// cálculo futuro (fator de correção, ECE, reliability diagram etc.).
function extrairResultadoReal(stats) {
  const amarelosCasa = stats.cartoes_amarelos_casa ?? null
  const amarelosFora = stats.cartoes_amarelos_fora ?? null
  const vermelhosCasa = stats.cartoes_vermelhos_casa ?? null
  const vermelhosFora = stats.cartoes_vermelhos_fora ?? null
  const temCartoes = amarelosCasa != null || vermelhosCasa != null || amarelosFora != null || vermelhosFora != null

  return {
    golsCasa: stats.placar_casa ?? null,
    golsFora: stats.placar_fora ?? null,
    cartoesAmarelosCasa: amarelosCasa,
    cartoesAmarelosFora: amarelosFora,
    cartoesVermelhosCasa: vermelhosCasa,
    cartoesVermelhosFora: vermelhosFora,
    cartoesTotal: temCartoes
      ? (amarelosCasa || 0) + (amarelosFora || 0) + (vermelhosCasa || 0) + (vermelhosFora || 0)
      : null,
    escanteiosCasa: stats.escanteios_casa ?? null,
    escanteiosFora: stats.escanteios_fora ?? null,
    escanteiosTotal: stats.escanteios_total ?? null,
    fonte: 'flashlive',
    capturadoEm: new Date().toISOString(),
  }
}

// ✅ NOVO — Fase 1, item 2 do roadmap: cross-check com a FlashLive depois que
// a fonte principal já resolveu o jogo. NUNCA muda o green/red (isso continua
// vindo só da fonte principal) — só anota se as duas fontes bateram, pra a Fase 2
// (motor de calibração) poder aplicar a regra que o próprio roadmap sugere:
// "descartar o jogo da calibração se os dados forem inconsistentes".
const TOLERANCIA_GOLS = 0                 // placar tem que bater exato entre as fontes
const TOLERANCIA_CARTOES_ESCANTEIOS = 1   // 1 de diferença é tolerado — contagem de
                                           // cartão/escanteio diverge com frequência
                                           // entre provedores por critério de arredondamento

function compararComSegundaFonte(principal, secundario) {
  if (!secundario) return { status: 'sem_segunda_fonte', fonteSecundaria: 'flashlive' }

  const divergencias = []
  const checar = (campo, tolerancia) => {
    const a = principal[campo], b = secundario[campo]
    if (a == null || b == null) return
    if (Math.abs(a - b) > tolerancia) divergencias.push({ campo, principal: a, flashlive: b })
  }
  checar('golsCasa', TOLERANCIA_GOLS)
  checar('golsFora', TOLERANCIA_GOLS)
  checar('cartoesTotal', TOLERANCIA_CARTOES_ESCANTEIOS)
  checar('escanteiosTotal', TOLERANCIA_CARTOES_ESCANTEIOS)

  return {
    status: divergencias.length ? 'divergente' : 'ok',
    fonteSecundaria: 'flashlive',
    ...(divergencias.length ? { divergencias } : {}),
    dadosFonteSecundaria: secundario,
  }
}

// Busca a FlashLive e já devolve o crossCheck pronto pra anexar em
// `resultadoReal.crossCheck`. Nunca lança — pior caso, devolve
// "sem_segunda_fonte" e o job/endpoint que chamou segue normalmente.
// 🔁 DESATIVADO temporariamente: a fonte principal agora É a FlashLive, então comparar
// com a FlashLive seria comparar a fonte com ela mesma (sempre "ok") e gastaria chamadas
// da API à toa. Fica como "sem_segunda_fonte" (estado neutro que a calibração já entende)
// até existir uma segunda fonte independente (ex.: API-Football).
async function crossCheckFlashLive(j, resultadoRealPrincipal) {
  return { status: 'sem_segunda_fonte', fonteSecundaria: null, motivo: 'fonte unica (FlashLive) apos migracao' }
}

// ✅ NOVO — Fase 1, item 3 do roadmap: exclusão de outliers. Jogos com
// expulsão precoce ou contagem estatisticamente atípica de cartões/escanteios
// distorcem o cálculo do fator de calibração (Fase 2) se entrarem misturados
// com jogos "normais" — mas o resultado da aposta em si (green/red) continua
// valendo normalmente, e o jogo continua aparecendo no histórico geral.
// Isso só marca `resultadoReal.outlier`, pra a Fase 2 poder filtrar.
const LIMIAR_EXPULSAO_PRECOCE_MINUTO = 30   // vermelho antes disso muda MUITO a dinâmica do jogo
const LIMIAR_CARTOES_ATIPICO         = 12   // total de cartões (2 times) acima disso é raríssimo
const LIMIAR_ESCANTEIOS_ATIPICO      = 22   // total de escanteios (2 times) acima disso é raríssimo

async function detectarOutlier(matchId, resultadoReal) {
  const motivos  = []
  const detalhes = {}

  // Contagem atípica não depende de rede — checa primeiro e sempre.
  if (resultadoReal?.cartoesTotal != null && resultadoReal.cartoesTotal > LIMIAR_CARTOES_ATIPICO) {
    motivos.push('cartoes_atipico')
    detalhes.cartoesTotal = resultadoReal.cartoesTotal
  }
  if (resultadoReal?.escanteiosTotal != null && resultadoReal.escanteiosTotal > LIMIAR_ESCANTEIOS_ATIPICO) {
    motivos.push('escanteios_atipico')
    detalhes.escanteiosTotal = resultadoReal.escanteiosTotal
  }

  // Expulsão precoce exige buscar os incidentes (chamada extra à API) —
  // best-effort: se falhar, não bloqueia a resolução do jogo.
  try {
    const incidentes = await getIncidentesPartida(matchId)
    const precoce = incidentes.find(i => i.minuto <= LIMIAR_EXPULSAO_PRECOCE_MINUTO)
    if (precoce) {
      motivos.push('expulsao_precoce')
      detalhes.expulsaoPrecoce = precoce
    }
  } catch (err) {
    console.warn('[Outlier] falha ao buscar incidentes, seguindo sem checar expulsão precoce:', err.message)
  }

  return { flag: motivos.length > 0, motivos, detalhes }
}

async function resolverJogosPendentesAuto() {
  try {
    const jogos = await loadTracker()

    // Futebol: só entradas auto-salvas (origem 'auto'), como já era.
    // 🔁 Só IDs da FlashLive (alfanuméricos). IDs 100% numéricos são do SofaScore antigo:
    // a FlashLive não os conhece, então ficam de fora (resolver à mão em "Corrigir")
    // em vez de gastar 3 chamadas da API a cada 30 min sem nunca resolver.
    const idFlashLive = id => !/^\d+$/.test(String(id))
    const pendentesFutebol = jogos.filter(j =>
      j.origem === 'auto' && j.resultado === null && j.eventoId && idFlashLive(j.eventoId) && !ehTenis(j.esporte))

    // ✅ NOVO — Tênis: entradas de "Vitória" e "Sets Diretos" salvas pela
    // análise (origem 'analise_ia_tenis') também entram, desde que já
    // tenham eventoId (App.jsx passou a gravar isso). Usa a API de tênis
    // ao vivo/estatísticas de tênis (sets, não gols) — nunca mistura com
    // o resolvedor de futebol acima.
    const pendentesTenis = jogos.filter(j =>
      j.resultado === null && j.eventoId && ehTenis(j.esporte))

    if (pendentesFutebol.length === 0 && pendentesTenis.length === 0) return

    // ✅ FIX — item 3: as chamadas de rede (podem levar minutos ao todo)
    // ficam fora de qualquer transação. Os resultados vão pra este mapa por
    // id; a gravação de verdade, entrada por entrada e com a linha travada,
    // acontece só no final.
    const resolvidos = new Map()

    for (const j of pendentesFutebol) {
      const stats = await getPartidaStats(j.eventoId)
      if (!stats || stats.erro) continue

      if (STATUS_ANULA.has(stats.status_type)) {
        resolvidos.set(j.id, {
          resultado: 'anulada', placarFinal: null, resultadoReal: null,
          marcadoEm: new Date().toISOString(),
        })
        await logAuditoria({
          trackerId: j.id, resultadoAnterior: null, resultadoNovo: 'anulada',
          placarFinal: null, fonte: 'flashlive_auto', dadosBrutos: stats,
        })
        console.log(`⚪ Tracker auto: ${j.mandante} x ${j.visitante} → ANULADA (status: ${stats.status_type})`)
        continue
      }

      if (stats.status_type !== 'finished') continue // ainda não acabou (ou status desconhecido) — não mexe

      const resultado = resolverMercadoLinha(stats, j.mercado, j.linha, j.direcao)
      if (resultado === null) continue

      // placarFinal registra o placar de gols (tempo normal) sempre, mesmo pra
      // entradas de Cartões/Escanteios — é só referência do jogo, não é o
      // número usado pra liquidar esses dois mercados.
      const placarFinal = `${stats.placar_casa}-${stats.placar_fora}`
      const resultadoReal = extrairResultadoReal(stats)   // gols/cartões/escanteios brutos
      resultadoReal.crossCheck = await crossCheckFlashLive(j, resultadoReal)
      resultadoReal.outlier = await detectarOutlier(j.eventoId, resultadoReal)
      resolvidos.set(j.id, {
        resultado, placarFinal, resultadoReal, marcadoEm: new Date().toISOString(),
      })
      await logAuditoria({
        trackerId: j.id, resultadoAnterior: null, resultadoNovo: resultado,
        placarFinal, fonte: 'flashlive_auto', dadosBrutos: stats,
      })
      const ccTag = resultadoReal.crossCheck.status === 'divergente' ? ' ⚠️ divergência com FlashLive' : ''
      const outTag = resultadoReal.outlier.flag ? ` ⚠️ outlier (${resultadoReal.outlier.motivos.join(', ')})` : ''
      console.log(`✅ Tracker auto: ${j.mandante} x ${j.visitante} → ${j.mercado} = ${resultado} (${placarFinal})${ccTag}${outTag}`)
    }

    for (const j of pendentesTenis) {
      const stats = await getEstatisticasTenisAoVivo(j.eventoId)
      if (!stats || stats.erro) continue

      if (TENNIS_STATUS_ANULA.has(stats.status)) {
        resolvidos.set(j.id, {
          resultado: 'anulada', placarFinal: null, marcadoEm: new Date().toISOString(),
        })
        await logAuditoria({
          trackerId: j.id, resultadoAnterior: null, resultadoNovo: 'anulada',
          placarFinal: null, fonte: 'flashlive_auto_tenis', dadosBrutos: stats,
        })
        console.log(`⚪ Tracker auto (tênis): ${j.mandante} x ${j.visitante} → ANULADA (status: ${stats.status})`)
        continue
      }
      if (TENNIS_STATUS_MANUAL.has(stats.status)) continue // desistência/WO — exige conferência manual
      if (stats.status !== 'finished') continue            // ainda não acabou — não mexe

      const resultado = resolverMercadoTenis(stats, j.mercado)
      if (resultado === null) continue

      const placarFinal = `${stats.setsMandante}-${stats.setsVisitante}`
      resolvidos.set(j.id, { resultado, placarFinal, marcadoEm: new Date().toISOString() })
      await logAuditoria({
        trackerId: j.id, resultadoAnterior: null, resultadoNovo: resultado,
        placarFinal, fonte: 'flashlive_auto_tenis', dadosBrutos: stats,
      })
      console.log(`✅ Tracker auto (tênis): ${j.mandante} x ${j.visitante} → ${j.mercado} = ${resultado} (${placarFinal})`)
    }

    // ✅ FIX — item 3: grava com a linha travada, lendo o estado MAIS ATUAL
    // do banco (não o `jogos` carregado lá em cima, que já pode estar velho
    // depois de todas essas chamadas de rede) e só tocando nas entradas que
    // este ciclo resolveu. O `j.resultado === null` de novo aqui é o que
    // evita sobrescrever uma entrada que outro processo já liquidou nesse
    // meio-tempo (ex: reverificação manual concorrente).
    if (resolvidos.size > 0) {
      await atualizarTrackerPorEntrada(atual => {
        let mudou = false
        for (const j of atual) {
          const patch = resolvidos.get(j.id)
          if (patch && j.resultado === null) {
            Object.assign(j, patch)
            mudou = true
          }
        }
        return mudou
      })
    }
  } catch (err) {
    console.error('Erro ao resolver tracker automático:', err.message)
  }
}

setInterval(resolverJogosPendentesAuto, 30 * 60 * 1000).unref()

// ✅ NOVO — Etapa 3: botão manual "Reverificar" — roda a resolução pra 1 entrada
// específica, na hora, sem esperar o agendador de 30min. Não sobrescreve se já
// tiver sido liquidada (idempotente igual o automático).
app.post('/api/tracker/:id/reverificar', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const jogos = await loadTracker()
    const j = jogos.find(x => x.id === req.params.id)
    if (!j) return res.status(404).json({ error: 'Entrada não encontrada' })
    if (j.resultado !== null) return res.status(400).json({ error: 'Entrada já liquidada — use Corrigir para alterar manualmente' })
    if (!j.eventoId) return res.status(400).json({ error: 'Entrada sem eventoId — não dá pra reverificar automaticamente' })

    // ✅ NOVO — item 6: tênis agora tem resolvedor próprio (sets, não gols).
    if (ehTenis(j.esporte)) {
      const stats = await getEstatisticasTenisAoVivo(j.eventoId)
      if (!stats || stats.erro) return res.json({ ok: true, mudou: false, motivo: 'Sem dados da partida ainda' })

      if (TENNIS_STATUS_ANULA.has(stats.status)) {
        j.resultado = 'anulada'; j.placarFinal = null; j.marcadoEm = new Date().toISOString()
        await saveTracker(jogos)
        await logAuditoria({ trackerId: j.id, resultadoNovo: 'anulada', fonte: 'flashlive_manual_reverificar_tenis', dadosBrutos: stats, autor: req.user.username })
        return res.json({ ok: true, mudou: true, resultado: 'anulada' })
      }
      if (TENNIS_STATUS_MANUAL.has(stats.status)) {
        return res.json({ ok: true, mudou: false, motivo: `Jogo com desistência/WO (status: ${stats.status}) — use Corrigir manualmente` })
      }
      if (stats.status !== 'finished') {
        return res.json({ ok: true, mudou: false, motivo: `Jogo ainda não finalizado (status: ${stats.status})` })
      }
      const resultado = resolverMercadoTenis(stats, j.mercado)
      if (resultado === null) {
        return res.json({ ok: true, mudou: false, motivo: 'Placar de sets ausente ou mercado não reconhecido — não dá pra calcular' })
      }
      const placarFinal = `${stats.setsMandante}-${stats.setsVisitante}`
      j.resultado = resultado; j.placarFinal = placarFinal; j.marcadoEm = new Date().toISOString()
      await saveTracker(jogos)
      await logAuditoria({ trackerId: j.id, resultadoNovo: resultado, placarFinal, fonte: 'flashlive_manual_reverificar_tenis', dadosBrutos: stats, autor: req.user.username })
      return res.json({ ok: true, mudou: true, resultado, placarFinal })
    }

    const stats = await getPartidaStats(j.eventoId)
    if (!stats || stats.erro) return res.json({ ok: true, mudou: false, motivo: 'Sem dados da partida ainda' })

    if (STATUS_ANULA.has(stats.status_type)) {
      j.resultado = 'anulada'; j.placarFinal = null; j.resultadoReal = null; j.marcadoEm = new Date().toISOString()
      await saveTracker(jogos)
      await logAuditoria({ trackerId: j.id, resultadoNovo: 'anulada', fonte: 'flashlive_manual_reverificar', dadosBrutos: stats, autor: req.user.username })
      return res.json({ ok: true, mudou: true, resultado: 'anulada' })
    }
    if (stats.status_type !== 'finished') {
      return res.json({ ok: true, mudou: false, motivo: `Jogo ainda não finalizado (status: ${stats.status_type})` })
    }
    const resultado = resolverMercadoLinha(stats, j.mercado, j.linha, j.direcao)
    if (resultado === null) {
      return res.json({ ok: true, mudou: false, motivo: 'Placar/estatística ou linha ausente — não dá pra calcular' })
    }
    const placarFinal = `${stats.placar_casa}-${stats.placar_fora}`
    j.resultado = resultado; j.placarFinal = placarFinal
    j.resultadoReal = extrairResultadoReal(stats)   // ✅ NOVO — gols/cartões/escanteios brutos
    j.resultadoReal.crossCheck = await crossCheckFlashLive(j, j.resultadoReal)   // ✅ NOVO — item 2
    j.resultadoReal.outlier = await detectarOutlier(j.eventoId, j.resultadoReal)   // ✅ NOVO — item 3
    j.marcadoEm = new Date().toISOString()
    await saveTracker(jogos)
    await logAuditoria({ trackerId: j.id, resultadoNovo: resultado, placarFinal, fonte: 'flashlive_manual_reverificar', dadosBrutos: stats, autor: req.user.username })
    res.json({ ok: true, mudou: true, resultado, placarFinal, crossCheck: j.resultadoReal.crossCheck.status, outlier: j.resultadoReal.outlier.flag })
  } catch (err) {
    console.error('Erro ao reverificar:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ✅ NOVO — Etapa 3: botão manual "Corrigir" — sobrescreve o resultado (inclusive
// um já liquidado automaticamente), pra casos de exceção. Sempre fica registrado
// em auditoria, com o autor, pra dar pra conferir/desfazer depois.
app.patch('/api/tracker/:id/corrigir', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { resultado, placarFinal } = req.body || {}
    if (!['green', 'red', 'anulada', null].includes(resultado)) {
      return res.status(400).json({ error: "resultado deve ser 'green', 'red', 'anulada' ou null" })
    }
    const jogos = await loadTracker()
    const j = jogos.find(x => x.id === req.params.id)
    if (!j) return res.status(404).json({ error: 'Entrada não encontrada' })

    const anterior = j.resultado
    j.resultado   = resultado
    j.placarFinal = resultado ? (placarFinal || j.placarFinal || null) : null
    // ✅ NOVO — correção manual sobrescreve o veredito; o `resultadoReal`
    // automático (gols/cartões/escanteios) não tem mais garantia de bater
    // com o motivo da correção (pode ter sido jogo errado, WO não detectado
    // etc.), então some junto pra não ficar dado inconsistente na calibração.
    j.resultadoReal = null
    j.marcadoEm   = resultado ? new Date().toISOString() : null
    await saveTracker(jogos)
    await logAuditoria({
      trackerId: j.id, resultadoAnterior: anterior, resultadoNovo: resultado ?? 'desfeito',
      placarFinal: j.placarFinal, fonte: 'correcao_manual', autor: req.user.username,
    })
    res.json({ ok: true })
  } catch (err) {
    console.error('Erro ao corrigir:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ✅ NOVO — Etapa 3: consulta o histórico de auditoria de uma entrada (pra
// "conferir e desfazer" conforme pedido)
app.get('/api/tracker/:id/auditoria', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM tracker_audit_log WHERE tracker_id = $1 ORDER BY criado_em DESC`,
      [req.params.id]
    )
    res.json(rows)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Health check ──────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1')
    const { rows } = await pool.query(`SELECT COUNT(*) FROM sessions`)
    const trackerRows = await pool.query(`SELECT id FROM tracker LIMIT 1`)
    const userRows = await pool.query(`SELECT 1 FROM users LIMIT 1`)
    res.json({
      ok: true,
      database: 'PostgreSQL conectado',
      persistencia: 'postgres', // dados vivem no Postgres, não em volume/arquivo
      activeSessions: parseInt(rows[0].count),
      trackerExists: trackerRows.rowCount > 0,
      usersExists: userRows.rowCount > 0,
    })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, persistencia: 'erro' })
  }
})

// ── Proxy football-data.org ─────────────────────────────────────
app.get('/api/fd/*', authMiddleware, async (req, res) => {
  if (!FD_KEY) return res.status(500).json({ error: 'FD_KEY não configurada.' })
  const path  = req.params[0]
  const query = req.url.split('?')[1] ? '?' + req.url.split('?')[1] : ''
  try {
    const response = await fetch(`https://api.football-data.org/v4/${path}${query}`, { headers: { 'X-Auth-Token': FD_KEY } })
    res.status(response.status).json(await response.json())
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Proxy Groq ────────────────────────────────────────────────
app.post('/api/groq', authMiddleware, async (req, res) => {
  if (!GROQ_KEY) return res.status(500).json({ error: 'GROQ_KEY não configurada.' })
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
      body: JSON.stringify(req.body),
    })
    res.status(response.status).json(await response.json())
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Proxy Gemini ──────────────────────────────────────────────
app.post('/api/gemini', authMiddleware, async (req, res) => {
  const GEMINI_KEY = process.env.GEMINI_KEY || ''
  if (!GEMINI_KEY) return res.status(500).json({ error: 'GEMINI_KEY não configurada.' })
  const modelos = ['gemini-1.5-flash-latest', 'gemini-1.5-flash', 'gemini-1.0-pro']
  for (const modelo of modelos) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${GEMINI_KEY}`
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body) })
      const data = await response.json()
      if (response.status === 404) continue
      return res.status(response.status).json(data)
    } catch (err) { console.warn('[Gemini] erro no modelo', modelo, err.message) }
  }
  return res.status(500).json({ error: 'Nenhum modelo Gemini disponível.' })
})

// ── Proxy The Odds API ────────────────────────────────────────
// ✅ NOVO — cache em memória (20 min) por liga/regiões/mercados: cada chamada gasta
// (mercados × regiões) créditos, e o cache do front zera a cada recarga de página.
const _oddsCache = new Map()
const ODDS_CACHE_MS = 20 * 60 * 1000
app.get('/api/odds', authMiddleware, async (req, res) => {
  if (!ODDS_KEY) return res.status(500).json({ error: 'ODDS_KEY não configurada.' })
  // ✅ NOVO — regiões agora vêm da env ODDS_REGIONS (ex.: "eu,uk"; padrão "eu"),
  // então dá pra aumentar/reduzir sem mexer no front. Cada região extra = +1 crédito/mercado.
  const { sportKey, regions: regionsQuery, markets = 'h2h,totals', oddsFormat = 'decimal' } = req.query
  const regions = regionsQuery || process.env.ODDS_REGIONS || 'eu'
  if (!sportKey) return res.status(400).json({ error: 'sportKey obrigatório' })
  if (!/^[a-z0-9,]+$/.test(regions)) return res.status(400).json({ error: 'regions inválido' })
  const chaveCache = `${sportKey}|${regions}|${markets}|${oddsFormat}`
  const hit = _oddsCache.get(chaveCache)
  if (hit && hit.exp > Date.now()) return res.json(hit.data)
  try {
    const response = await fetch(`https://api.the-odds-api.com/v4/sports/${sportKey}/odds?apiKey=${ODDS_KEY}&regions=${regions}&markets=${markets}&oddsFormat=${oddsFormat}`)
    const restantes = response.headers.get('x-requests-remaining')
    if (restantes != null) console.log(`[Odds API] ${sportKey} regions=${regions} → custo ${response.headers.get('x-requests-last') ?? '?'} · restam ${restantes} créditos`)
    const data = await response.json()
    if (!response.ok) console.warn(`[Odds API] ${sportKey} erro ${response.status}:`, JSON.stringify(data).slice(0, 200))
    if (response.ok && Array.isArray(data)) _oddsCache.set(chaveCache, { exp: Date.now() + ODDS_CACHE_MS, data })
    res.status(response.status).json(data)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Proxy API-Basketball ──────────────────────────────────────
app.get('/api/abasket/*', authMiddleware, async (req, res) => {
  const ABASKET_KEY = process.env.ABASKET_KEY || SPORT_KEY
  if (!ABASKET_KEY) return res.status(500).json({ error: 'ABASKET_KEY não configurada.' })
  const path  = req.params[0]
  const query = req.url.split('?')[1] ? '?' + req.url.split('?')[1] : ''
  try {
    const response = await fetch(`https://api-basketball.p.rapidapi.com/${path}${query}`, {
      headers: { 'x-rapidapi-host': 'api-basketball.p.rapidapi.com', 'x-rapidapi-key': ABASKET_KEY },
    })
    res.status(response.status).json(await response.json())
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/allsports', authMiddleware, async (req, res) => {
  const ALLSPORTS_KEY = process.env.ALLSPORTS_KEY || ''
  if (!ALLSPORTS_KEY) return res.status(500).json({ error: 'ALLSPORTS_KEY não configurada.' })
  try {
    const query = new URLSearchParams(req.query).toString()
    const resp  = await fetch(`https://apiv2.allsportsapi.com/football/?APIkey=${ALLSPORTS_KEY}&${query}`)
    const text  = await resp.text()
    try { res.json(JSON.parse(text)) }
    catch { res.status(500).json({ error: 'AllSports retornou resposta inválida', raw: text.slice(0, 200) }) }
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Proxy API-Football ────────────────────────────────────────
const APIFOOTBALL_KEY  = process.env.APIFOOTBALL_KEY || ''
app.get('/api/apifootball/*', authMiddleware, async (req, res) => {
  if (!APIFOOTBALL_KEY) return res.status(500).json({ error: 'APIFOOTBALL_KEY não configurada.' })
  const path  = req.params[0]
  const query = req.url.split('?')[1] ? '?' + req.url.split('?')[1] : ''
  try {
    const response = await fetch(`https://v3.football.api-sports.io/${path}${query}`, {
      headers: { 'x-apisports-key': APIFOOTBALL_KEY },
    })
    res.status(response.status).json(await response.json())
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Proxy apifootball.com ────────────────────────────────────
const APIFOOTBALLCOM_KEY = process.env.APIFOOTBALLCOM_KEY || ''
app.get('/api/apifootballcom', authMiddleware, async (req, res) => {
  if (!APIFOOTBALLCOM_KEY) return res.status(500).json({ error: 'APIFOOTBALLCOM_KEY não configurada.' })
  try {
    const query = new URLSearchParams({ ...req.query, APIkey: APIFOOTBALLCOM_KEY }).toString()
    const resp  = await fetch(`https://apiv2.apifootball.com/?${query}`)
    res.json(await resp.json())
  } catch (err) { res.status(500).json({ error: err.message }) }
})

const FLASHLIVE_KEY  = process.env.FLASHLIVE_KEY || SPORT_KEY
// Cache no servidor (vale para todos os usuários) + junta chamadas iguais simultâneas
// + pausa de 60s depois de um 429, pra não queimar mais cota.
const _flCache = new Map()
const _flEmVoo = new Map()
let _flPausaAte = 0
const flTtl = p => /events\/list|live/.test(p) ? 10 * 60 * 1000 : 6 * 60 * 60 * 1000
app.get('/api/flashlive/*', authMiddleware, async (req, res) => {
  if (!FLASHLIVE_KEY) return res.status(500).json({ error: 'FLASHLIVE_KEY não configurada.' })
  const path  = req.params[0]
  const query = req.url.split('?')[1] ? '?' + req.url.split('?')[1] : ''
  const chave = path + query
  const hit = _flCache.get(chave)
  if (hit && hit.exp > Date.now()) return res.json(hit.data)
  if (Date.now() < _flPausaAte) return res.status(429).json({ error: 'FlashLive em pausa (cota). Tente em instantes.' })
  try {
    if (!_flEmVoo.has(chave)) {
      _flEmVoo.set(chave, (async () => {
        const response = await fetch(`https://flashlive-sports.p.rapidapi.com/v1/${path}${query}`, {
          headers: { 'x-rapidapi-host': 'flashlive-sports.p.rapidapi.com', 'x-rapidapi-key': FLASHLIVE_KEY },
        })
        const data = await response.json().catch(() => null)
        return { status: response.status, data }
      })().finally(() => _flEmVoo.delete(chave)))
    }
    const { status, data } = await _flEmVoo.get(chave)
    if (status === 429) { _flPausaAte = Date.now() + 60 * 1000; console.warn('[FlashLive] 429 — pausando 60s') }
    if (status === 200 && data) {
      if (_flCache.size > 2000) _flCache.clear()
      _flCache.set(chave, { exp: Date.now() + flTtl(path), data })
    }
    res.status(status).json(data ?? {})
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── ELO ratings ──────────────────────────────────────────────
app.get('/api/elo', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT team_id, rating FROM elo_ratings`)
    const ratings  = {}
    for (const row of rows) ratings[row.team_id] = parseFloat(row.rating)
    res.json(ratings)
  } catch (err) {
    console.error('[ELO] Erro ao ler ratings:', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/elo', authMiddleware, adminMiddleware, async (req, res) => {
  const ratings = req.body
  if (typeof ratings !== 'object' || Array.isArray(ratings)) {
    return res.status(400).json({ error: 'Body deve ser um objeto { teamId: rating }' })
  }
  const entries = Object.entries(ratings)
  if (!entries.length) return res.json({ ok: true, atualizados: 0 })
  try {
    const values = entries.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2}, NOW())`).join(', ')
    const params = entries.flatMap(([id, rating]) => [parseInt(id), parseFloat(rating)])
    await pool.query(
      `INSERT INTO elo_ratings (team_id, rating, updated_at)
       VALUES ${values}
       ON CONFLICT (team_id) DO UPDATE
         SET rating = EXCLUDED.rating, updated_at = NOW()`,
      params
    )
    res.json({ ok: true, atualizados: entries.length })
  } catch (err) {
    console.error('[ELO] Erro ao salvar ratings:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ✅ NOVO — aplica jogos ao ELO no servidor, UMA vez por jogo (chave = mandante|visitante|data)
app.post('/api/elo/jogos', authMiddleware, async (req, res) => {
  const partidas = req.body?.partidas
  if (!Array.isArray(partidas)) return res.status(400).json({ error: 'Body deve ser { partidas: [...] }' })

  const validas = partidas
    .map(p => ({
      h: parseInt(p.homeId), a: parseInt(p.awayId),
      gh: Number(p.homeScore), ga: Number(p.awayScore),
      data: String(p.data || '').slice(0, 10),
    }))
    .filter(p => Number.isInteger(p.h) && Number.isInteger(p.a) && p.h !== p.a &&
                 Number.isFinite(p.gh) && Number.isFinite(p.ga) && /^\d{4}-\d{2}-\d{2}$/.test(p.data))
    .sort((x, y) => x.data.localeCompare(y.data))
  if (!validas.length) return res.json({ ok: true, aplicados: 0 })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(7421)')
    let aplicados = 0
    for (const p of validas) {
      const ins = await client.query(
        `INSERT INTO elo_jogos_processados (chave) VALUES ($1) ON CONFLICT DO NOTHING`,
        [`${p.h}|${p.a}|${p.data}`]
      )
      if (!ins.rowCount) continue
      const { rows } = await client.query(
        `SELECT team_id, rating FROM elo_ratings WHERE team_id = ANY($1::int[])`, [[p.h, p.a]]
      )
      const r  = Object.fromEntries(rows.map(x => [x.team_id, parseFloat(x.rating)]))
      const eh = r[p.h] ?? 1500
      const ea = r[p.a] ?? 1500
      const exp = 1 / (1 + Math.pow(10, (ea - eh) / 400))
      const resH = p.gh > p.ga ? 1 : p.gh < p.ga ? 0 : 0.5
      const nh = +(eh + 32 * (resH - exp)).toFixed(1)
      const na = +(ea + 32 * ((1 - resH) - (1 - exp))).toFixed(1)
      await client.query(
        `INSERT INTO elo_ratings (team_id, rating, updated_at) VALUES ($1,$2,NOW()),($3,$4,NOW())
         ON CONFLICT (team_id) DO UPDATE SET rating = EXCLUDED.rating, updated_at = NOW()`,
        [p.h, nh, p.a, na]
      )
      aplicados++
    }
    await client.query('COMMIT')
    res.json({ ok: true, aplicados })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('[ELO] Erro ao aplicar jogos:', err.message)
    res.status(500).json({ error: err.message })
  } finally {
    client.release()
  }
})

// ═══════════════ ✅ NOVO — ALERTAS AUTOMÁTICOS DO MODELO ═══════════════
// De 6 em 6h roda o checklist GO/NO-GO e a validação out-of-sample (o mesmo que a
// aba Modelo do Admin mostra), compara com o último estado guardado no banco e
// avisa quando: (1) `podeDeployar` muda (GO ↔ NO-GO) ou (2) o `melhorTecnica` de
// calibração em produção troca sozinho (fator / isotonic / platt).
// Aviso = linha na tabela `alertas` (aparece na aba Modelo) + Telegram, se
// TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID estiverem configurados.
const MONITOR_INTERVALO_MS = 6 * 60 * 60 * 1000
const ALERTA_COOLDOWN_H    = 24   // mesmo tipo de alerta no máx. 1x por dia (evita spam se oscilar)
let _monitorando = false

async function enviarTelegram(texto, parseMode) {
  const token  = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (!token || !chatId) return false
  try {
    const body = { chat_id: chatId, text: texto }
    if (parseMode) body.parse_mode = parseMode
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return r.ok
  } catch (err) {
    console.warn('[Alertas] Telegram falhou:', err.message)
    return false
  }
}

// ═══════════════ ✅ NOVO — ENVIA A ANÁLISE DOS JOGOS (ETAPA 3) PRO TELEGRAM ═══════════════
// O texto já vem pronto (formatado no frontend, com os jogos separados +
// a múltipla sugerida) — aqui só valida o login e repassa pro bot.
app.post('/api/telegram/enviar-jogos', authMiddleware, async (req, res) => {
  const texto = (req.body?.texto || '').toString()
  if (!texto.trim()) return res.status(400).json({ error: 'Campo "texto" vazio.' })

  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    return res.status(503).json({ error: 'Telegram não configurado (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID ausentes no servidor).' })
  }

  // Telegram limita a 4096 caracteres por mensagem — quebra em partes se precisar
  const PARTE_MAX = 4000
  const partes = []
  let resto = texto
  while (resto.length > PARTE_MAX) {
    let corte = resto.lastIndexOf('\n', PARTE_MAX)
    if (corte <= 0) corte = PARTE_MAX
    partes.push(resto.slice(0, corte))
    resto = resto.slice(corte)
  }
  partes.push(resto)

  try {
    let todasEnviadas = true
    for (const parte of partes) {
      const ok = await enviarTelegram(parte, 'Markdown')
      if (!ok) todasEnviadas = false
    }
    res.json({ ok: true, enviado: todasEnviadas, partes: partes.length })
  } catch (err) {
    console.error('[Telegram] erro ao enviar jogos:', err.message)
    res.status(500).json({ error: err.message })
  }
})

async function registrarAlerta(tipo, mensagem, dados) {
  const enviado = await enviarTelegram(mensagem)
  await pool.query(
    `INSERT INTO alertas (tipo, mensagem, dados, enviado) VALUES ($1, $2, $3, $4)`,
    [tipo, mensagem, JSON.stringify(dados ?? null), enviado]
  )
  console.log(`🔔 Alerta [${tipo}]${enviado ? ' (Telegram enviado)' : ''}: ${mensagem.split('\n')[0]}`)
}

async function alertaEmCooldown(tipo) {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM alertas WHERE tipo = $1 AND criado_em > NOW() - INTERVAL '${ALERTA_COOLDOWN_H} hours' LIMIT 1`,
    [tipo]
  )
  return rowCount > 0
}

async function monitorarModelo() {
  if (_monitorando) return null
  _monitorando = true
  try {
    // O calibrationService roda no navegador; aqui ele lê os dados da própria API.
    globalThis.__API_BASE__ = `http://127.0.0.1:${PORT}`
    const { checklistPreDeploy, validacaoOutOfSample } = await import('../src/services/calibrationService.js')
    const [checklist, oos] = await Promise.all([checklistPreDeploy(), validacaoOutOfSample()])

    const { rows } = await pool.query(`SELECT valor FROM modelo_estado WHERE chave = 'snapshot'`)
    const anterior = rows[0]?.valor ?? null

    const atual = {
      podeDeployar: !!checklist.podeDeployar,
      // sem amostra suficiente no OOS, mantém a técnica anterior (não conta como "troca")
      melhorTecnica: oos.suficiente ? (oos.melhorTecnica ?? 'fator') : (anterior?.melhorTecnica ?? null),
    }
    const motivos = (checklist.motores || [])
      .filter(m => m.status === 'bloqueado')
      .flatMap(m => (m.motivos || []).map(t => `${m.motor}: ${t}`))

    const novoEstado = anterior ? { ...anterior } : { ...atual }
    let novos = 0

    if (anterior) {
      if (anterior.podeDeployar !== atual.podeDeployar) {
        const tipo = atual.podeDeployar ? 'go_liberado' : 'no_go'
        if (!(await alertaEmCooldown(tipo))) {
          const msg = atual.podeDeployar
            ? '✅ Football Scout — o checklist voltou a GO (pode subir versão nova).'
            : `🚫 Football Scout — o checklist virou NO-GO (não suba versão nova).\n${motivos.slice(0, 3).map(m => `• ${m.slice(0, 220)}`).join('\n')}`
          await registrarAlerta(tipo, msg, { motivos })
          novoEstado.podeDeployar = atual.podeDeployar
          novos++
        }
      }
      if (anterior.melhorTecnica && atual.melhorTecnica && anterior.melhorTecnica !== atual.melhorTecnica) {
        if (!(await alertaEmCooldown('tecnica_calibracao'))) {
          await registrarAlerta(
            'tecnica_calibracao',
            `🔀 Football Scout — a calibração em produção trocou de "${anterior.melhorTecnica}" para "${atual.melhorTecnica}" (walk-forward out-of-sample).`,
            { de: anterior.melhorTecnica, para: atual.melhorTecnica }
          )
          novoEstado.melhorTecnica = atual.melhorTecnica
          novos++
        }
      }
    }

    novoEstado.verificadoEm = new Date().toISOString()
    await pool.query(
      `INSERT INTO modelo_estado (chave, valor, atualizado_em) VALUES ('snapshot', $1, NOW())
       ON CONFLICT (chave) DO UPDATE SET valor = $1, atualizado_em = NOW()`,
      [JSON.stringify(novoEstado)]
    )
    return { primeiraVez: !anterior, atual, novos }
  } catch (err) {
    console.error('[Alertas] falha ao monitorar o modelo:', err.message)
    return { erro: err.message }
  } finally {
    _monitorando = false
  }
}

setTimeout(monitorarModelo, 2 * 60 * 1000).unref()          // 1ª checagem 2 min depois do boot (grava a referência)
setInterval(monitorarModelo, MONITOR_INTERVALO_MS).unref()

// ═══════════════ ✅ NOVO — Fase 6: LINE MOVEMENT / STEAM DETECTION ═══════════════
// Duplica o mapa liga→sportKey do groqService.js (mesmo motivo do
// modelVersion.js: servidor e navegador não compartilham bundler aqui, então
// os dois lados têm que ser alterados JUNTOS se uma liga nova entrar).
const ODDS_SPORT_KEY_SNAPSHOT = {
  BSA: 'soccer_brazil_campeonato',
  CLI: 'soccer_conmebol_copa_libertadores',
  CL:  'soccer_uefa_champs_league',
  EL:  'soccer_uefa_europa_league',
  PL:  'soccer_epl',
  PD:  'soccer_spain_la_liga',
  SA:  'soccer_italy_serie_a',
  BL1: 'soccer_germany_bundesliga',
}

const SNAPSHOT_INTERVALO_MS = 6 * 60 * 60 * 1000   // 1x/6h — a Odds API cobra por request
const STEAM_LIMIAR_PP = 4                       // shift >= 4pp na prob. no-vig = "steam move"

function devigSimples(precos) {
  if (precos.some(p => p == null || p <= 1)) return precos.map(() => null)
  const brutas = precos.map(p => 1 / p)
  const soma = brutas.reduce((s, v) => s + v, 0)
  return brutas.map(v => Math.round((v / soma) * 1000) / 10)
}

async function snapshotOddsTodasLigas() {
  if (!ODDS_KEY) return
  const regions = process.env.ODDS_REGIONS || 'eu'

  for (const [ligaCode, sportKey] of Object.entries(ODDS_SPORT_KEY_SNAPSHOT)) {
    try {
      const resp = await fetch(`https://api.the-odds-api.com/v4/sports/${sportKey}/odds?apiKey=${ODDS_KEY}&regions=${regions}&markets=h2h&oddsFormat=decimal`)
      if (!resp.ok) {
        console.warn(`[Line Movement] ${ligaCode} erro ${resp.status} — sem créditos ou chave inválida?`)
        if (resp.status === 401 || resp.status === 429) break
        continue
      }
      const jogos = await resp.json()
      if (!Array.isArray(jogos)) continue

      for (const jogo of jogos) {
        const market = jogo.bookmakers?.[0]?.markets?.find(m => m.key === 'h2h')
        if (!market) continue
        const precoM = market.outcomes?.find(o => o.name === jogo.home_team)?.price ?? null
        const precoE = market.outcomes?.find(o => o.name === 'Draw')?.price ?? null
        const precoV = market.outcomes?.find(o => o.name === jogo.away_team)?.price ?? null
        const [probM, probE, probV] = devigSimples([precoM, precoE, precoV])
        if (probM == null) continue

        await pool.query(
          `INSERT INTO odds_historico (jogo_id, liga_code, mandante, visitante, comeca_em, prob_mandante, prob_empate, prob_visitante)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [String(jogo.id), ligaCode, jogo.home_team, jogo.away_team, jogo.commence_time, probM, probE, probV]
        )
      }
      await new Promise(r => setTimeout(r, 500)) // não estoura rate limit entre ligas
    } catch (err) {
      console.warn(`[Line Movement] snapshot falhou pra ${ligaCode}:`, err.message)
    }
  }

  await detectarSteamMoves()
}

// Compara a 1ª e a última captura de cada jogo (últimas 48h). Se a
// probabilidade no-vig andou >= STEAM_LIMIAR_PP pontos, dispara alerta —
// sinal de "dinheiro sharp" entrando, complementar ao modelo estatístico.
async function detectarSteamMoves() {
  const { rows } = await pool.query(`
    SELECT jogo_id, liga_code, mandante, visitante,
           (array_agg(prob_mandante  ORDER BY capturado_em ASC))[1]  AS abertura_m,
           (array_agg(prob_mandante  ORDER BY capturado_em DESC))[1] AS atual_m,
           (array_agg(prob_visitante ORDER BY capturado_em ASC))[1]  AS abertura_v,
           (array_agg(prob_visitante ORDER BY capturado_em DESC))[1] AS atual_v,
           COUNT(*) AS n_capturas
    FROM odds_historico
    WHERE capturado_em > NOW() - INTERVAL '48 hours'
    GROUP BY jogo_id, liga_code, mandante, visitante
    HAVING COUNT(*) >= 2
  `)

  for (const r of rows) {
    const deltaM = r.atual_m - r.abertura_m
    const deltaV = r.atual_v - r.abertura_v
    const maior = Math.abs(deltaM) >= Math.abs(deltaV)
      ? { delta: deltaM, nome: r.mandante }
      : { delta: deltaV, nome: r.visitante }

    if (Math.abs(maior.delta) >= STEAM_LIMIAR_PP) {
      const tipo = `steam_${r.jogo_id}`
      if (await alertaEmCooldown(tipo)) continue
      await registrarAlerta(
        tipo,
        `📉 Steam move — ${r.mandante} x ${r.visitante} (${r.liga_code}): probabilidade de ${maior.nome} moveu ${maior.delta > 0 ? '+' : ''}${maior.delta.toFixed(1)}pp desde a 1ª captura (${r.n_capturas} capturas/48h).`,
        { jogoId: r.jogo_id, mandante: r.mandante, visitante: r.visitante }
      )
    }
  }
}

setInterval(snapshotOddsTodasLigas, SNAPSHOT_INTERVALO_MS).unref()
setTimeout(snapshotOddsTodasLigas, 3 * 60 * 1000).unref() // 1ª captura 3 min após o boot

app.get('/api/odds/historico', authMiddleware, async (req, res) => {
  const { mandante, visitante } = req.query
  if (!mandante || !visitante) return res.status(400).json({ error: 'mandante e visitante obrigatórios' })
  try {
    const { rows } = await pool.query(
      `SELECT prob_mandante, prob_empate, prob_visitante, capturado_em
       FROM odds_historico
       WHERE mandante = $1 AND visitante = $2 AND capturado_em > NOW() - INTERVAL '7 days'
       ORDER BY capturado_em ASC`,
      [mandante, visitante]
    )
    res.json({ historico: rows })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/alertas', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id, tipo, mensagem, enviado, criado_em FROM alertas ORDER BY id DESC LIMIT 20`)
    const est = await pool.query(`SELECT valor FROM modelo_estado WHERE chave = 'snapshot'`)
    res.json({
      alertas: rows,
      estado: est.rows[0]?.valor ?? null,
      telegramConfigurado: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
    })
  } catch (err) {
    console.error('[Alertas] falha ao listar:', err.message)
    res.status(500).json({ error: 'Falha ao listar alertas' })
  }
})

app.post('/api/alertas/verificar', authMiddleware, adminMiddleware, async (req, res) => {
  const r = await monitorarModelo()
  res.json({ ok: !r?.erro, ...(r || { ocupado: true }) })
})

// ✅ NOVO — Fase 7, item 30: alerta quando o modelo diverge fortemente do
// mercado (edge grande) — chamado pelo cliente logo após montar o value
// pick. Cooldown por jogo+mercado evita spam se a análise for reaberta.
const DIVERGENCIA_COOLDOWN_H = 12
app.post('/api/alertas/divergencia', authMiddleware, async (req, res) => {
  try {
    const { mandante, visitante, liga, mercado, edge, prob, odd } = req.body || {}
    if (!mandante || !visitante || !mercado || typeof edge !== 'number') {
      return res.status(400).json({ error: 'Payload incompleto' })
    }
    const chave = `divergencia_${mandante}_${visitante}_${mercado}`.replace(/\s+/g, '_').toLowerCase()
    const { rowCount } = await pool.query(
      `SELECT 1 FROM alertas WHERE tipo = $1 AND criado_em > NOW() - INTERVAL '${DIVERGENCIA_COOLDOWN_H} hours' LIMIT 1`,
      [chave]
    )
    if (rowCount > 0) return res.json({ ok: true, jaAlertado: true })

    await registrarAlerta(
      chave,
      `📡 Divergência forte — ${mandante} x ${visitante} (${liga || '?'}): modelo vê ${mercado} com edge de +${edge.toFixed(1)}pp sobre o mercado (prob. modelo ${prob}% vs odd ${odd}).`,
      { mandante, visitante, liga, mercado, edge, prob, odd }
    )
    res.json({ ok: true, jaAlertado: false })
  } catch (err) {
    console.error('[Alertas] falha ao registrar divergência:', err.message)
    res.status(500).json({ error: 'Falha ao registrar alerta' })
  }
})

// ═══════════════ ✅ NOVO — COMANDOS DO BOT DO TELEGRAM (long polling) ═══════════════
// Comandos: /start (mostra seu chat id), /status, /alertas, /verificar, /ajuda.
// Só o chat configurado em TELEGRAM_CHAT_ID pode usar os comandos (exceto /start).
let _tgOffset = 0
let _tgRodando = false

async function tgApi(metodo, corpo) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const r = await fetch(`https://api.telegram.org/bot${token}/${metodo}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo || {}),
  })
  return r.json()
}

async function tgResponder(chatId, texto) {
  try { await tgApi('sendMessage', { chat_id: chatId, text: texto }) }
  catch (err) { console.warn('[Telegram] falha ao responder:', err.message) }
}

// ✅ NOVO — igual ao tgResponder, mas com Markdown (negrito nas análises). Se o Telegram
// recusar o texto (ex.: nome de time com "_"), reenvia sem formatação em vez de perder a resposta.
async function tgResponderMd(chatId, texto) {
  try {
    const r = await tgApi('sendMessage', { chat_id: chatId, text: texto, parse_mode: 'Markdown' })
    if (!r?.ok) await tgApi('sendMessage', { chat_id: chatId, text: texto.replace(/[*_`]/g, '') })
  } catch (err) { console.warn('[Telegram] falha ao responder (md):', err.message) }
}

const TG_AJUDA =
  '🤖 Football Scout Alertas\n\n' +

  '📋 COMANDOS\n' +
  '/status — checklist GO/NO-GO e técnica de calibração atual\n' +
  '/alertas — últimos 5 alertas emitidos\n' +
  '/verificar — roda a checagem do modelo agora\n' +
  '/ajuda — mostra esta mensagem\n\n' +

  '🔔 NOTIFICAÇÕES\n' +
  'Os jogos analisados no site (Etapa 3) chegam aqui automaticamente, ' +
  'com a múltipla sugerida. A busca de jogos por comando foi desativada.\n\n' +

  'Alertas automáticos: mudança GO/NO-GO, troca de técnica de calibração, ' +
  'steam move (≥4pp) e divergência forte modelo x mercado.'

function tgFmtData(d) {
  return new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
}

async function tgTratarComando(msg) {
  const chatId = msg.chat.id
  const texto = (msg.text || '').trim()
  const partes = texto.split(/\s+/)
  const cmd = partes[0].split('@')[0].toLowerCase()
  const arg1 = partes[1] || ''
  const autorizado = String(chatId) === String(process.env.TELEGRAM_CHAT_ID || '')

  if (cmd === '/start') {
    if (autorizado) return tgResponder(chatId, `✅ Conectado! Vou te avisar aqui quando o modelo mudar.\n\n${TG_AJUDA}`)
    return tgResponder(chatId,
      `👋 Olá! O ID deste chat é:\n${chatId}\n\n` +
      'Coloque esse número na variável TELEGRAM_CHAT_ID do Railway e faça o redeploy para receber os alertas aqui.')
  }

  if (!autorizado) {
    return tgResponder(chatId, '⛔ Chat não autorizado. Envie /start para ver o ID deste chat.')
  }

  try {
    if (cmd === '/ajuda' || cmd === '/help') {
      return tgResponder(chatId, TG_AJUDA)
    }

    if (cmd === '/status') {
      const { rows } = await pool.query(`SELECT valor FROM modelo_estado WHERE chave = 'snapshot'`)
      const e = rows[0]?.valor
      if (!e) return tgResponder(chatId, 'Ainda não há checagem gravada. Use /verificar.')
      return tgResponder(chatId,
        '📊 Status do modelo\n' +
        `Checklist: ${e.podeDeployar ? '✅ GO (pode subir versão)' : '🚫 NO-GO (não suba versão)'}\n` +
        `Calibração em produção: ${e.melhorTecnica ?? '—'}\n` +
        `Última verificação: ${e.verificadoEm ? tgFmtData(e.verificadoEm) : '—'}`)
    }

    if (cmd === '/alertas') {
      const { rows } = await pool.query(`SELECT mensagem, criado_em FROM alertas ORDER BY id DESC LIMIT 5`)
      if (!rows.length) return tgResponder(chatId, 'Nenhum alerta emitido até agora.')
      return tgResponder(chatId,
        '🔔 Últimos alertas\n\n' +
        rows.map(a => `${tgFmtData(a.criado_em)}\n${a.mensagem}`).join('\n\n'))
    }

    if (cmd === '/verificar') {
      await tgResponder(chatId, '⏳ Verificando o modelo...')
      const r = await monitorarModelo()
      if (!r) return tgResponder(chatId, 'Já existe uma verificação em andamento. Tente em instantes.')
      if (r.erro) return tgResponder(chatId, `❌ Falhou: ${r.erro}`)
      return tgResponder(chatId,
        `✅ Verificação concluída.\nChecklist: ${r.atual.podeDeployar ? 'GO' : 'NO-GO'}\n` +
        `Calibração: ${r.atual.melhorTecnica ?? '—'}\n` +
        (r.primeiraVez ? 'Referência gravada (1ª vez).' : `Novos alertas: ${r.novos}`))
    }

    if (cmd === '/tenis' || cmd === '/tênis' || cmd === '/jogos') {
      return tgResponder(chatId,
        '🔕 A busca de jogos por aqui foi desativada.\n\n' +
        'Os jogos analisados no site (Etapa 3) chegam automaticamente aqui, com a múltipla sugerida.')
    }

    return tgResponder(chatId, 'Comando não reconhecido. Envie /ajuda.')
  } catch (err) {
    console.error('[Telegram] erro no comando', cmd, err.message)
    return tgResponder(chatId, '❌ Erro ao executar o comando.')
  }
}

async function tgLoop() {
  if (_tgRodando || !process.env.TELEGRAM_BOT_TOKEN) return
  _tgRodando = true
  const dormir = ms => new Promise(r => setTimeout(r, ms))
  try { await tgApi('deleteWebhook', {}) } catch {}
  console.log('🤖 Bot do Telegram: escutando comandos')
  while (true) {
    try {
      const data = await tgApi('getUpdates', { offset: _tgOffset, timeout: 25, allowed_updates: ['message'] })
      if (!data.ok) {
        // 409 = outra instância também está escutando (ex.: durante o redeploy)
        console.warn('[Telegram] getUpdates:', data.description)
        await dormir(15000)
        continue
      }
      for (const u of data.result) {
        _tgOffset = u.update_id + 1
        if (u.message?.text?.startsWith('/')) await tgTratarComando(u.message)
      }
    } catch (err) {
      console.warn('[Telegram] polling falhou:', err.message)
      await dormir(10000)
    }
  }
}
setTimeout(tgLoop, 5000).unref()

// ── Inicia servidor após conectar ao banco ──────────────────────
initDB()
  .then(() => {
    registerSportsRoutes(app, pool, authMiddleware, adminMiddleware)

    resolverJogosPendentesAuto() // roda uma vez no boot, além do interval de 30 min

    const __dirname = dirname(fileURLToPath(import.meta.url))
    const distPath  = join(__dirname, '../dist')
    if (existsSync(distPath)) {
      app.use(express.static(distPath))
      app.get('/admin', (req, res) => res.sendFile(join(distPath, 'admin.html')))
      app.get('*', (req, res) => {
        if (req.path.startsWith('/api/')) {
          return res.status(404).json({ error: 'Rota API não encontrada' })
        }
        res.sendFile(join(distPath, 'index.html'))
      })
    }

    app.listen(PORT, () => {
      console.log(`🚀 Servidor rodando na porta ${PORT}`)
      console.log(`🗄️  Banco: PostgreSQL (Railway)`)
    })
  })
  .catch(err => {
    console.error('Erro ao inicializar banco:', err.message)
    process.exit(1)
  })