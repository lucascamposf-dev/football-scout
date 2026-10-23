// server/scrapers/sofaHttp.js  (v4)
// Cliente HTTP ÚNICO pro SofaScore (futebol + tênis).
//
// Variáveis opcionais no Railway:
//   SOFA_PROXY_URL      → proxy HTTP(S) residencial  (http://user:senha@host:porta)
//   SOFA_BASE_URL       → relay próprio (ex: Cloudflare Worker) https://xxx.workers.dev/api/v1
//   SOFA_RELAY_KEY      → segredo enviado no header x-relay-key para o relay
//
// Proteções (evitam PIORAR o bloqueio do IP):
//   • NÃO repete a chamada em 403 (repetir só reforça o "challenge")
//   • Circuit breaker: após um 403, pausa 60s sem chamar o SofaScore
//   • Concorrência limitada (3 chamadas simultâneas no máximo)

import { fetch as undiciFetch, ProxyAgent } from 'undici'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const BASE = (process.env.SOFA_BASE_URL || 'https://api.sofascore.com/api/v1').replace(/\/+$/, '')
const PROXY = process.env.SOFA_PROXY_URL || ''
const RELAY_KEY = process.env.SOFA_RELAY_KEY || ''
const MAX_SIMULTANEAS = 3
const PAUSA_APOS_403_MS = 60_000

let agent = null
if (PROXY) {
  try { agent = new ProxyAgent(PROXY); console.log('[SofaHttp] usando proxy SOFA_PROXY_URL') }
  catch (e) { console.warn('[SofaHttp] SOFA_PROXY_URL inválida:', e.message) }
}
if (process.env.SOFA_BASE_URL) console.log('[SofaHttp] usando relay SOFA_BASE_URL')

const ULTIMOS_ERROS = []
function registrarErro(info) {
  ULTIMOS_ERROS.unshift({ ...info, quando: new Date().toISOString() })
  if (ULTIMOS_ERROS.length > 8) ULTIMOS_ERROS.pop()
}
export function getUltimosErrosSofa() { return ULTIMOS_ERROS }
export function getConfigSofa() {
  return {
    base: BASE, proxyConfigurado: !!agent, relayKeyConfigurada: !!RELAY_KEY,
    pausadoAteSegundos: Math.max(0, Math.round((bloqueadoAte - Date.now()) / 1000)),
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── limitador de concorrência ────────────────────────────────
let ativas = 0
const fila = []
async function adquirir() {
  if (ativas < MAX_SIMULTANEAS) { ativas++; return }
  await new Promise(r => fila.push(r))
}
function liberar() {
  const prox = fila.shift()
  if (prox) prox()      // passa a vaga direto pro próximo (ativas não muda)
  else ativas--
}

// ── circuit breaker ────────────────────────────────────────
let bloqueadoAte = 0

// ═══════════════ requisição direta / proxy / relay ═══════════
async function requestDireto(path, tentativas, timeoutMs) {
  const headers = {
    'User-Agent': UA,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
    'Referer': 'https://www.sofascore.com/',
    'Origin': 'https://www.sofascore.com',
    'Cache-Control': 'no-cache',
  }
  if (RELAY_KEY) headers['x-relay-key'] = RELAY_KEY

  for (let i = 1; i <= tentativas; i++) {
    try {
      const opts = { headers, signal: AbortSignal.timeout(timeoutMs) }
      const res = agent
        ? await undiciFetch(`${BASE}${path}`, { ...opts, dispatcher: agent })
        : await fetch(`${BASE}${path}`, opts)

      if (res.ok) return await res.json()

      const corpo = await res.text().catch(() => '')
      registrarErro({ path, status: res.status, corpo: corpo.slice(0, 200), tentativa: i })
      console.warn(`[SofaHttp] HTTP ${res.status} em ${path} (tentativa ${i}/${tentativas})`)

      if (res.status === 403) { bloqueadoAte = Date.now() + PAUSA_APOS_403_MS; return null } // não insiste
      if (res.status === 404) return null
    } catch (err) {
      registrarErro({ path, erro: err.message, tentativa: i })
      console.warn(`[SofaHttp] erro em ${path} (tentativa ${i}/${tentativas}):`, err.message)
    }
    if (i < tentativas) await sleep(700 * i)
  }
  return null
}

export async function sofaRequest(path, { tentativas = 2, timeoutMs = 12000 } = {}) {
  await adquirir()
  try {
    // tentativas === 1 é usado pela rota /diagnostico: ignora a pausa pra testar de verdade
    if (tentativas > 1 && Date.now() < bloqueadoAte) return null
    return await requestDireto(path, tentativas, timeoutMs)
  } finally {
    liberar()
  }
}
