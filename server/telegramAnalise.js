// server/telegramAnalise.js — análise completa (melhor entrada + múltipla) pro bot do Telegram
// ─────────────────────────────────────────────────────────────────────────
// Roda, DENTRO do servidor, o MESMO motor que o site roda no navegador
// (src/services/*.js: etapa1 → etapa2 → etapa3), sem duplicar nenhuma conta.
//
// Como isso é possível sem reescrever o motor:
//   • o motor chama as rotas do próprio servidor (/api/fd, /api/odds, ...) com
//     o token do usuário que ele lê do localStorage → aqui o "localStorage" é
//     um objeto em memória com um token de sessão INTERNO (login interno);
//   • o motor monta as URLs como http://localhost:3001/... → um fetch
//     "embrulhado" redireciona pra porta real do servidor (process.env.PORT);
//   • o motor lê `window.location.hostname` no topo dos arquivos → o `window`
//     de mentira existe só durante o import e é apagado logo depois;
//   • a análise de texto da Groq (gerarAnaliseIA) é desligada — só números.
//
// A múltipla e as mensagens vêm de src/services/multiplaService.js, o mesmo
// arquivo que o App.jsx usa → site e bot nunca divergem.
// ─────────────────────────────────────────────────────────────────────────

import crypto from 'crypto'
import {
  montarMensagemTelegram,
  montarMensagemTelegramTenis,
} from '../src/services/multiplaService.js'

const PORT            = process.env.PORT || 3001
const JOGOS_POR_PAGINA = 3            // teto do próprio motor (etapa2/3 fazem slice(0, 3))
const MAX_JOGOS_TENIS  = Number(process.env.TG_MAX_JOGOS_TENIS) || 5
const TIMEOUT_MS       = 6 * 60 * 1000
const TG_PARTE_MAX     = 3800         // limite do Telegram é 4096

// ── Ligas com motor de análise ────────────────────────────────
// motor: 'groq' = etapas do groqService (football-data) | os demais = serviços próprios
const LIGAS_ANALISE = {
  BSA: { motor: 'groq',   nome: 'Campeonato Brasileiro Serie A', label: 'Brasileirão Série A' },
  BSB: { motor: 'serieb', nome: 'Campeonato Brasileiro Serie B', label: 'Brasileirão Série B' },
  CLI: { motor: 'groq',   nome: 'Copa Libertadores',             label: 'Copa Libertadores' },
  CSA: { motor: 'csa',    nome: 'Copa Sul-Americana',            label: 'Copa Sul-Americana' },
  CL:  { motor: 'groq',   nome: 'UEFA Champions League',         label: 'Champions League' },
  EL:  { motor: 'el',     nome: 'UEFA Europa League',            label: 'Europa League' },
  PL:  { motor: 'groq',   nome: 'Premier League Inglaterra',     label: 'Premier League' },
  PD:  { motor: 'groq',   nome: 'La Liga Espanha',               label: 'La Liga' },
  SA:  { motor: 'groq',   nome: 'Serie A Italia',                label: 'Serie A (Itália)' },
  BL1: { motor: 'groq',   nome: 'Bundesliga Alemanha',           label: 'Bundesliga' },
  WC:  { motor: 'groq',   nome: 'Copa do Mundo',                 label: 'Copa do Mundo' },
  WCQ: { motor: 'groq',   nome: 'Eliminatórias Copa',            label: 'Eliminatórias da Copa' },
  CA:  { motor: 'groq',   nome: 'Copa América',                  label: 'Copa América' },
  NL:  { motor: 'nl',     nome: 'UEFA Nations League',           label: 'Nations League' },
  AMI: { motor: 'am',     nome: 'Amistosos Internacionais',      label: 'Amistosos (Seleções)' },
}

const APELIDOS = {
  BRA: 'BSA', BRASILEIRAO: 'BSA', SERIE_A_BR: 'BSA',
  SERIE_B: 'BSB', SERIEB: 'BSB',
  LIBERTADORES: 'CLI',
  SUDAMERICANA: 'CSA', SUL_AMERICANA: 'CSA',
  CHAMPIONS: 'CL', CHAMPIONS_LEAGUE: 'CL',
  EUROPA_LEAGUE: 'EL', EUROPA: 'EL',
  PREMIER: 'PL', PREMIER_LEAGUE: 'PL',
  LA_LIGA: 'PD', LALIGA: 'PD',
  SERIE_A: 'SA', ITALIA: 'SA',
  BUNDESLIGA: 'BL1',
  NATIONS_LEAGUE: 'NL', NATIONS: 'NL',
  AMISTOSOS: 'AMI',
}

export function resolverCodigoAnalise(arg) {
  const k = String(arg || '').trim().toUpperCase().replace(/[\s-]+/g, '_')
  if (LIGAS_ANALISE[k]) return k
  return APELIDOS[k] ?? null
}

export const CODIGOS_ANALISE = Object.keys(LIGAS_ANALISE)

export function ehComandoTenis(arg) {
  return ['TENIS', 'TÊNIS', 'TENNIS'].includes(String(arg || '').trim().toUpperCase())
}

// ── Preparação do ambiente pro motor "de navegador" rodar no Node ──────
const _storage = new Map()
let _motor = null
let _carregando = null
let _ocupado = null // descrição da análise em andamento (o motor tem cache/limites globais → 1 por vez)

function instalarShims() {
  if (!globalThis.__scoutShimsOk) {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true, writable: true,
      value: {
        getItem:    k => (_storage.has(k) ? _storage.get(k) : null),
        setItem:    (k, v) => { _storage.set(k, String(v)) },
        removeItem: k => { _storage.delete(k) },
      },
    })

    // O motor fala com o servidor por http://localhost:3001 (ou /api/... relativo).
    // Em produção a porta é outra (Railway) → redireciona pro próprio processo.
    const fetchOriginal = globalThis.fetch
    const base = `http://127.0.0.1:${PORT}`
    globalThis.fetch = (input, init) => {
      if (typeof input === 'string') {
        if (input.startsWith('http://localhost:3001')) input = base + input.slice('http://localhost:3001'.length)
        else if (input.startsWith('/api/'))             input = base + input
      }
      return fetchOriginal(input, init)
    }
    globalThis.__scoutShimsOk = true
  }
  globalThis.__SCOUT_SEM_IA__ = true // groqService.gerarAnaliseIA → não chama a Groq (só números)
}

async function carregarMotor() {
  if (_motor) return _motor
  if (_carregando) return _carregando

  _carregando = (async () => {
    instalarShims()
    // `window` só precisa existir enquanto os arquivos são avaliados
    // (eles leem window.location.hostname no topo). Depois removemos, pra
    // não enganar outras bibliotecas do servidor que testam `typeof window`.
    globalThis.window = { location: { hostname: 'localhost' } }
    try {
      const base = new URL('../src/services/', import.meta.url)
      const imp  = nome => import(new URL(nome, base).href)
      const [groq, csa, serieb, el, nl, am, tenis, calib] = await Promise.all([
        imp('groqService.js'), imp('sudamericanaService.js'), imp('serieBService.js'),
        imp('europaLeagueService.js'), imp('nationsLeagueService.js'), imp('amistososService.js'),
        imp('tennisService.js'), imp('calibrationService.js'),
      ])
      _motor = { groq, csa, serieb, el, nl, am, tenis, calib }
      return _motor
    } finally {
      delete globalThis.window
      _carregando = null
    }
  })()

  return _carregando
}

// Login interno: sessão fixa derivada do token do bot (uma linha só na tabela
// `sessions`, renovada a cada uso). Role 'admin' pra que o motor consiga
// gravar ELO (POST /api/elo) igual acontece quando você roda pelo site.
async function garantirSessaoInterna(salvarSessao) {
  const token = crypto
    .createHmac('sha256', process.env.TELEGRAM_BOT_TOKEN || 'sem-token')
    .update('scout-telegram-sessao-interna')
    .digest('hex')
  await salvarSessao(token, { username: 'telegram-bot', role: 'admin' })
  _storage.set('scout_token', token)
}

// ── Utilidades ────────────────────────────────────────────────
const jogoEncerrado = j =>
  /finish|ended|encerr|cancel|postpon|adiad|abandon|award/i.test(String(j?.status || ''))

function dividirMensagem(texto) {
  // quebra entre blocos de jogo (linhas que começam com ━━━), nunca no meio de um jogo
  const blocos = texto.split(/\n(?=━━━)/)
  const partes = []
  let atual = ''
  for (const b of blocos) {
    if (atual && (atual.length + b.length + 1) > TG_PARTE_MAX) { partes.push(atual); atual = b }
    else atual = atual ? `${atual}\n${b}` : b
  }
  if (atual) partes.push(atual)
  return partes
}

async function executarComLock(descricao, fn) {
  if (_ocupado) return { ok: false, ocupado: true, mensagem: `⏳ Já tem uma análise rodando (${_ocupado}). Aguarde terminar e tente de novo.` }
  _ocupado = descricao
  const trabalho = Promise.resolve().then(fn)
  trabalho.catch(() => {}).finally(() => { _ocupado = null })

  let timer
  const limite = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('__TIMEOUT__')), TIMEOUT_MS) })
  try {
    return await Promise.race([trabalho, limite])
  } catch (e) {
    if (e.message === '__TIMEOUT__') {
      return { ok: false, mensagem: '⏱️ A análise passou de 6 minutos e foi interrompida. Tente de novo em instantes (as fontes de dados podem estar lentas).' }
    }
    return { ok: false, mensagem: `❌ ${e.message}` }
  } finally {
    clearTimeout(timer)
  }
}

function funcoesDoMotor(m, cfg, incluirAmanha) {
  switch (cfg.motor) {
    case 'groq': return {
      e1: () => m.groq.etapa1_buscarJogos('', cfg.nome, incluirAmanha),
      e2: j  => m.groq.etapa2_buscarHistoricos('', j),
      e3: j  => m.groq.etapa3_calcularProbabilidades('', j),
    }
    case 'serieb': return { e1: () => m.serieb.sb_etapa1_buscarJogos(incluirAmanha), e2: j => m.serieb.sb_etapa2_buscarHistoricos(j), e3: j => m.serieb.sb_etapa3_calcularProbabilidades(j) }
    case 'csa':    return { e1: () => m.csa.csa_etapa1_buscarJogos(incluirAmanha),   e2: j => m.csa.csa_etapa2_buscarHistoricos(j),   e3: j => m.csa.csa_etapa3_calcularProbabilidades(j) }
    case 'el':     return { e1: () => m.el.el_etapa1_buscarJogos(incluirAmanha),     e2: j => m.el.el_etapa2_buscarHistoricos(j),     e3: j => m.el.el_etapa3_calcularProbabilidades(j) }
    case 'nl':     return { e1: () => m.nl.nl_etapa1_buscarJogos(incluirAmanha),     e2: j => m.nl.nl_etapa2_buscarHistoricos(j),     e3: j => m.nl.nl_etapa3_calcularProbabilidades(j) }
    case 'am':     return { e1: () => m.am.am_etapa1_buscarJogos(incluirAmanha),     e2: j => m.am.am_etapa2_buscarHistoricos(j),     e3: j => m.am.am_etapa3_calcularProbabilidades(j) }
    default: throw new Error(`Motor desconhecido: ${cfg.motor}`)
  }
}

const listaDe = r => (Array.isArray(r) ? r : (r?.jogos ?? []))

// ═════════════════════════════════════════════════════════════
// FUTEBOL — /jogos <liga> [amanha] [página]
// devolve { ok, mensagens: string[] (Markdown) } ou { ok:false, mensagem }
// ═════════════════════════════════════════════════════════════
export async function analisarLigaParaTelegram(codigo, {
  incluirAmanha = false, pagina = 1, salvarSessao, progresso = async () => {},
} = {}) {
  const cfg = LIGAS_ANALISE[codigo]
  if (!cfg) return { ok: false, mensagem: `Liga '${codigo}' sem motor de análise.` }

  return executarComLock(`${cfg.label}`, async () => {
    await garantirSessaoInterna(salvarSessao)
    const m = await carregarMotor()
    const { e1, e2, e3 } = funcoesDoMotor(m, cfg, incluirAmanha)

    // ETAPA 1 — jogos
    let lista
    try { lista = listaDe(await e1()) }
    catch (e) { return { ok: false, mensagem: `⚠️ ${cfg.label}: ${e.message}` } }

    const abertos = lista.filter(j => !jogoEncerrado(j))
    const todos   = abertos.length ? abertos : lista
    if (!todos.length) return { ok: false, mensagem: `Nenhum jogo encontrado para ${cfg.label}.` }

    const totalPaginas = Math.ceil(todos.length / JOGOS_POR_PAGINA)
    const pag = Math.min(Math.max(pagina, 1), totalPaginas)
    const ini = (pag - 1) * JOGOS_POR_PAGINA
    const escolhidos = todos.slice(ini, ini + JOGOS_POR_PAGINA)

    await progresso(
      `⏳ Analisando ${cfg.label}: jogos ${ini + 1}–${ini + escolhidos.length} de ${todos.length}...\n` +
      `Isso leva 1–2 min (as fontes de dados têm limite de requisições). Te aviso quando terminar.`
    )

    // ETAPA 2 — históricos / H2H / cartões / escanteios / clima
    let comHistorico
    try { comHistorico = await e2(escolhidos) }
    catch (e) { return { ok: false, mensagem: `❌ Falhou buscando históricos: ${e.message}` } }

    // ETAPA 3 — probabilidades, melhores entradas (a Groq de texto fica desligada)
    let analisados
    try { analisados = listaDe(await e3(comHistorico)) }
    catch (e) { return { ok: false, mensagem: `❌ Falhou calculando probabilidades: ${e.message}` } }
    if (!analisados.length) return { ok: false, mensagem: `Não consegui calcular nenhum jogo de ${cfg.label} agora.` }

    let texto = montarMensagemTelegram(analisados)

    // jogos que ficaram de fora (o motor analisa 3 por vez)
    const analisadosSet = new Set(escolhidos)
    const restantes = todos.filter(j => !analisadosSet.has(j))
    if (restantes.length) {
      const linhas = restantes.map(j => `${j.horario || '--:--'} — ${j.mandante} x ${j.visitante}`)
      const dica = pag < totalPaginas
        ? `\n\n➡️ Para analisar os próximos: /jogos ${codigo}${incluirAmanha ? ' amanha' : ''} ${pag + 1}`
        : ''
      texto += `\n\n━━━━━━━━━━━━━━━━━━━\n➕ Outros jogos (não analisados agora):\n${linhas.join('\n')}${dica}`
    }
    return { ok: true, mensagens: dividirMensagem(texto) }
  })
}

// ═════════════════════════════════════════════════════════════
// TÊNIS — /tenis            → lista os torneios ativos
//         /tenis <número>   → analisa os jogos do torneio
// ═════════════════════════════════════════════════════════════
export async function listarTorneiosTenisParaTelegram({ incluirAmanha = false } = {}) {
  try {
    const m = await carregarMotor()
    const lista = await m.tenis.ts_buscarTorneiosAtivos(incluirAmanha)
    if (!lista.length) return { ok: false, mensagem: 'Nenhum torneio de tênis (ATP/WTA) com jogos agora.' }
    const linhas = lista.map((t, i) =>
      `${i + 1}. ${t.temAoVivo ? '🔴 ' : ''}${t.nome} (${t.categoria}) — ${t.qtdJogosHoje} jogo${t.qtdJogosHoje === 1 ? '' : 's'}`)
    return {
      ok: true,
      mensagens: [`🎾 Torneios de tênis${incluirAmanha ? ' (hoje + amanhã)' : ''}\n\n${linhas.join('\n')}\n\nPra analisar: /tenis <número> (ex.: /tenis 1)`],
    }
  } catch (e) {
    return { ok: false, mensagem: `⚠️ Tênis: ${e.message}` }
  }
}

export async function analisarTenisParaTelegram(numero, {
  incluirAmanha = false, salvarSessao, progresso = async () => {},
} = {}) {
  return executarComLock('Tênis', async () => {
    await garantirSessaoInterna(salvarSessao)
    const m = await carregarMotor()

    let torneios
    try { torneios = await m.tenis.ts_buscarTorneiosAtivos(incluirAmanha) }
    catch (e) { return { ok: false, mensagem: `⚠️ Tênis: ${e.message}` } }
    if (!torneios.length) return { ok: false, mensagem: 'Nenhum torneio de tênis (ATP/WTA) com jogos agora.' }

    // número da lista (1..n); se for maior que a lista, trata como id do torneio
    const n = Number(numero)
    const torneio = (Number.isInteger(n) && n >= 1 && n <= torneios.length)
      ? torneios[n - 1]
      : torneios.find(t => String(t.id) === String(numero))
    if (!torneio) return { ok: false, mensagem: `Torneio '${numero}' não encontrado. Use /tenis pra ver a lista.` }

    let jogos
    try { jogos = await m.tenis.ts_buscarJogosTorneio(String(torneio.id), incluirAmanha) }
    catch (e) { return { ok: false, mensagem: `⚠️ ${torneio.nome}: ${e.message}` } }
    if (!jogos.length) return { ok: false, mensagem: `Nenhum jogo a disputar em ${torneio.nome}.` }

    const escolhidos = jogos.slice(0, MAX_JOGOS_TENIS)
    await progresso(`⏳ Analisando ${torneio.nome}: ${escolhidos.length} de ${jogos.length} jogo(s)... (históricos + H2H, pode levar ~1 min)`)

    let analisados
    try {
      const comHistorico = await m.tenis.ts_buscarHistoricos(escolhidos)
      let data = await m.tenis.ts_calcularProbabilidades(comHistorico)
      data = await m.calib.calibrarJogosTenis(data) // mesma calibração do Tracker que o site aplica
      analisados = data?.jogos ?? []
    } catch (e) {
      return { ok: false, mensagem: `❌ Falhou analisando tênis: ${e.message}` }
    }
    if (!analisados.length) return { ok: false, mensagem: `Não consegui calcular jogos de ${torneio.nome} agora.` }

    let texto = montarMensagemTelegramTenis(analisados)
    if (jogos.length > escolhidos.length) {
      texto += `\n\n➕ ${jogos.length - escolhidos.length} jogo(s) deste torneio não foram analisados (limite de ${MAX_JOGOS_TENIS} por comando).`
    }
    return { ok: true, mensagens: dividirMensagem(texto) }
  })
}