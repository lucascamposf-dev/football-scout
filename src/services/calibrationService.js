// calibrationService.js — calibração automática a partir do Scout Tracker
// Lê greens/reds do /api/tracker e ajusta probabilidades de gols.
//
// ✅ HISTÓRICO ZERADO × CALIBRAÇÃO: quando o admin usa "Zerar histórico", os
// greens/reds saem do tracker (dashboard, gráficos, ranking recomeçam do zero)
// e vão pra tabela tracker_archive. A calibração lê os DOIS (tracker atual +
// arquivados) via /api/tracker/calibracao-dados — os fatores continuam iguais
// e só recebem os dados novos por cima. Relatórios de ANÁLISE por contexto
// (esporte/clima/altitude/liga) usam só o tracker atual.
// ─────────────────────────────────────────────────────────────

// ✅ AJUSTE DE PESO: valores antigos (20 / 5) deixavam a calibração reagir
// forte demais a amostras pequenas — 5-6 greens/reds seguidos (que podem
// ser só sorte/azar) já empurravam o fator perto do teto/piso (0.70–1.30).
// Subindo os mínimos, o sistema exige mais histórico real antes de confiar
// no ajuste, o que reduz entradas erradas motivadas por ruído estatístico.
// ✅ REVISADO — Fase 2, item 6 do roadmap: MIN_AMOSTRAS_FULL agora é o "k"
// (pseudo-amostras do prior) da fórmula bayesiana Beta-Binomial abaixo, não
// mais um teto de "amostra cheia = confiança total". Ver estatisticasGrupo().
const MIN_AMOSTRAS_FULL = 25   // pseudo-amostras do prior (era 20)
const MIN_AMOSTRAS_SOFT = 8    // a partir daqui já aplica fator suavizado (era 5)

// ✅ NOVO — DECAIMENTO TEMPORAL. Antes, um green/red de 4 meses atrás pesava
// igual ao de ontem — se o modelo foi ajustado desde então (ou a liga mudou de
// fase), o fator ficava "preso" a um comportamento que já não existe.
// Agora cada entrada vale 0.5^(idade / meia-vida): com meia-vida de 45 dias,
// uma entrada de 45d pesa 50%, de 90d pesa 25%, de 135d pesa ~12%.
// PESO_MIN_TEMPORAL impede que o histórico antigo "suma" de vez.
const MEIA_VIDA_DIAS     = 45
const PESO_MIN_TEMPORAL  = 0.10
const MS_DIA             = 24 * 60 * 60 * 1000

// ✅ NOVO — teto/piso por categoria. Gols, Cartões e Escanteios têm relação
// probabilidade↔odd bem diferente: em Gols, 88%+ já costuma virar odd sem
// valor (1.05-1.10). Em Cartões (principalmente linhas baixas como Over 1.5)
// é normal a probabilidade real passar de 90% e a odd ainda ficar em
// 1.25-1.30 — ou seja, ainda vale a entrada. Usar o mesmo teto de Gols pra
// Cartões travava a linha antes da hora e tirava a entrada do ranking de
// "melhor", mesmo sendo uma aposta legítima.
const CAPS_POR_CATEGORIA = {
  Gols:       { teto: 88, piso: 12 },
  Cartões:    { teto: 94, piso: 6  },
  Escanteios: { teto: 90, piso: 10 },
}

/** Teto/piso de probabilidade calibrada pra uma categoria (Gols/Cartões/Escanteios). */
export function getCapsCategoria(categoria) {
  return CAPS_POR_CATEGORIA[categoria] ?? CAPS_POR_CATEGORIA.Gols
}

const IS_PROD     = typeof window !== 'undefined' && window.location.hostname !== 'localhost'
const API_BASE    = globalThis.__API_BASE__ ?? (IS_PROD ? '' : 'http://localhost:3001') // ✅ server (monitor de alertas) define __API_BASE__
const TRACKER_URL = `${API_BASE}/api/tracker`
const CALIBRACAO_URL = `${API_BASE}/api/tracker/calibracao-dados`

/** Chaves canônicas usadas nos fatores */
// NOVO
export const MERCADOS_ALVO = [
  'Gols:Over 1.5', 'Gols:Over 2.5', 'Gols:Over 3.5',
  'Gols:Under 1.5', 'Gols:Under 2.5', 'Gols:Under 3.5',
  'BTTS',
  'Cartões:Over 1.5', 'Cartões:Over 2.5', 'Cartões:Over 3.5', 'Cartões:Over 4.5', 'Cartões:Over 5.5', 'Cartões:Over 6.5',
  'Cartões:Under 1.5', 'Cartões:Under 2.5', 'Cartões:Under 3.5', 'Cartões:Under 4.5', 'Cartões:Under 5.5', 'Cartões:Under 6.5',
  'Escanteios:Over 3.5', 'Escanteios:Over 4.5', 'Escanteios:Over 5.5', 'Escanteios:Over 6.5', 'Escanteios:Over 7.5', 'Escanteios:Over 8.5',
  'Escanteios:Over 9.5', 'Escanteios:Over 10.5', 'Escanteios:Over 11.5', 'Escanteios:Over 12.5', 'Escanteios:Over 13.5', 'Escanteios:Over 14.5',
  'Escanteios:Under 3.5', 'Escanteios:Under 4.5', 'Escanteios:Under 5.5', 'Escanteios:Under 6.5', 'Escanteios:Under 7.5', 'Escanteios:Under 8.5',
  'Escanteios:Under 9.5', 'Escanteios:Under 10.5', 'Escanteios:Under 11.5', 'Escanteios:Under 12.5', 'Escanteios:Under 13.5', 'Escanteios:Under 14.5',
]

// ✅ NOVO — mercados de TÊNIS (calibração separada, não mistura com futebol).
// Agrupados por TIPO de mercado (não por linha) pra juntar amostra suficiente.
export const MERCADOS_TENIS = [
  'Tênis:Vencedor', 'Tênis:Sets Diretos', 'Tênis:Handicap de Sets', 'Tênis:Vencer Set',
  'Tênis:Over Games', 'Tênis:Under Games', 'Tênis:Tie-Break Sim', 'Tênis:Tie-Break Não',
]

const semAcento = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

// ✅ NOVO — clima/altitude podem vir em DOIS formatos e antes só um era lido:
//  • entradas manuais: strings do formulário  → clima: "Chuva", altitude: "Alta (1000-2000m)"
//  • entradas automáticas (auto-save): objeto → clima: { temperaturaC, probabilidadeChuva,
//    ventoKmh, altitudeM, altitudeClasse }
// Estas funções unificam os dois nos MESMOS rótulos do formulário (CLIMAS/ALTITUDES do
// ScoutTracker), pra dashboard, gráficos e relatórios usarem a mesma classificação.
const numOuNull = v => (typeof v === 'number' && Number.isFinite(v)) ? v : null

const ALTITUDE_ROTULOS = {
  'baixa':      'Baixa (< 500m)',
  'moderada':   'Moderada (500-1000m)',
  'alta':       'Alta (1000-2000m)',
  'muito alta': 'Muito alta (2000m+)',
}

/** Categoria de clima da entrada (mesmos rótulos do formulário) ou null se não houver dado. */
export function categoriaClima(e) {
  const c = e?.clima
  if (c == null) return null
  if (typeof c === 'string') {
    const s = c.trim()
    return s && semAcento(s) !== 'nao informado' ? s : null
  }
  if (typeof c !== 'object') return null
  const chuva = numOuNull(c.probabilidadeChuva)
  const vento = numOuNull(c.ventoKmh)
  const temp  = numOuNull(c.temperaturaC)
  if (chuva != null && chuva >= 60) return 'Chuva'        // mesmo limiar usado no modelo de cartões
  if (vento != null && vento >= 35) return 'Vento forte'
  if (temp  != null && temp  >= 30) return 'Muito quente'
  if (temp  != null && temp  <= 8)  return 'Muito frio'
  if (chuva != null || vento != null || temp != null) return 'Seco / Ameno'
  return null
}

/** Categoria de altitude da entrada (mesmos rótulos do formulário) ou null se não houver dado. */
export function categoriaAltitude(e) {
  const a = e?.altitude
  if (typeof a === 'string' && a.trim() && semAcento(a) !== 'nao informado') return a.trim()
  const c = e?.clima
  if (c && typeof c === 'object') {
    let classe = c.altitudeClasse ? semAcento(c.altitudeClasse).trim() : null
    const m = numOuNull(c.altitudeM)
    if (!ALTITUDE_ROTULOS[classe] && m != null) {
      classe = m >= 2000 ? 'muito alta' : m >= 1000 ? 'alta' : m >= 500 ? 'moderada' : 'baixa'
    }
    return ALTITUDE_ROTULOS[classe] ?? null
  }
  return null
}

/** true se a entrada do tracker é de tênis (campo esporte, origem, liga ou texto do mercado). */
export function ehEntradaTenis(e) {
  if (!e) return false
  if (semAcento(e.esporte) === 'tenis') return true
  if (e.origem === 'analise_ia_tenis') return true
  const liga = semAcento(e.liga)
  if (['atp', 'wta', 'itf', 'challenger'].some(k => liga.includes(k))) return true
  return /jogador\s*[12]|\bsets?\b|\bgames?\b|tie\s*-?\s*break/.test(semAcento(e.mercado))
}

/** Chave canônica de calibração do tênis (ou null se o texto não for reconhecido). */
export function normalizarMercadoTenis(txt) {
  const t = semAcento(txt).replace(/[^\w\s.]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!t) return null
  if (/tie\s*break/.test(t)) return /\bnao\b/.test(t) ? 'Tênis:Tie-Break Não' : 'Tênis:Tie-Break Sim'
  if (/sets?\s+diretos|straight/.test(t)) return 'Tênis:Sets Diretos'
  if (/handicap/.test(t) && /\bsets?\b/.test(t)) return 'Tênis:Handicap de Sets'
  if (/\b[1-5]\s*(o\s*)?set\b/.test(t) || /vencer\s+o\s+\d/.test(t)) return 'Tênis:Vencer Set'
  if (/\bgames?\b/.test(t)) {
    if (/\bover\b|\bmais\b/.test(t))  return 'Tênis:Over Games'
    if (/\bunder\b|\bmenos\b/.test(t)) return 'Tênis:Under Games'
  }
  if (/vencedor|\bml\b|vitoria|jogador\s*[12]/.test(t)) return 'Tênis:Vencedor'
  return null
}

/** Chave de calibração de QUALQUER entrada do tracker (futebol ou tênis). */
export function chaveDaEntrada(e) {
  return ehEntradaTenis(e) ? normalizarMercadoTenis(e.mercado) : normalizarMercado(e.mercado)
}

/** Prob. prevista de uma entrada de tênis. Devolve null se não houver — não usa 50 "neutro",
 *  senão entradas manuais sem probabilidade distorcem o fator. Prefere probBruta (antes da calibração).
 *  ✅ FIX: entradas automáticas de tênis ao vivo (origem 'auto', ver JogosAoVivo.jsx →
 *  salvarNoTracker) gravam a prob no campo `probabilidade`, igual ao futebol — sem isso,
 *  TODA entrada de tênis ao vivo caía em prob == null e nunca entrava na calibração. */
function extrairProbTenis(e) {
  for (const v of [e.probBruta, e.probPrevista, e.probabilidade, e.prob]) {
    if (typeof v === 'number' && !Number.isNaN(v)) return v
  }
  const m = String(e.obs || '').match(/\bp\s*=\s*(\d{1,3})/i)
  return m ? Math.min(99, Math.max(1, parseInt(m[1], 10))) : null
}

// ── Decaimento temporal ──────────────────────────────────────

/** Converte ISO ("2026-09-18") ou "DD/MM/YYYY" em timestamp (ms). null se inválido. */
function parseDataFlex(v) {
  if (!v) return null
  const str = String(v).trim()
  const br = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  const t = br ? Date.parse(`${br[3]}-${br[2].padStart(2, '0')}-${br[1].padStart(2, '0')}T12:00:00`) : Date.parse(str)
  return Number.isNaN(t) ? null : t
}

/** Data de referência da entrada: dia do jogo > momento em que foi marcada > criação. */
function dataDaEntrada(e) {
  return parseDataFlex(e.dataJogo) ?? parseDataFlex(e.marcadoEm) ?? parseDataFlex(e.criadoEm)
}

/** Peso 0.10–1.00 da entrada conforme a idade. Sem data reconhecível → 1 (comportamento antigo). */
export function pesoTemporal(e, agora = Date.now()) {
  const t = dataDaEntrada(e)
  if (t == null) return 1
  const idadeDias = Math.max(0, (agora - t) / MS_DIA)
  return Math.max(PESO_MIN_TEMPORAL, Math.pow(0.5, idadeDias / MEIA_VIDA_DIAS))
}

// ── Cache em memória ─────────────────────────────────────────
let _cacheEntradas  = null   // entradas ATUAIS do tracker
let _cacheArquivo   = []     // green/red ARQUIVADOS (só entram na calibração)
let _cacheExpiresAt = 0
const CACHE_TTL_MS  = 5 * 60 * 1000  // 5 min (reage mais rápido a novos greens/reds)

/**
 * Normaliza qualquer texto de mercado do tracker/UI para a chave canônica.
 * Ex.: "🟢 Over 2.5 Gols" → "Over 2.5"
 *      "BTTS Sim" → "BTTS"
 *      "Under 1.5" → "Under 1.5"
 */// NOVO
export function normalizarMercado(txt) {
  if (!txt) return null
  const t = String(txt)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

  if (/\bbtts\b/.test(t) || /ambos\s*marcam/.test(t)) return 'BTTS'

  // ✅ NOVO — categoria (Cartões/Escanteios/Gols) pra não misturar
  // greens/reds de mercados diferentes na mesma chave de calibração.
  let categoria = 'Gols'
  if (/cart/.test(t)) categoria = 'Cartões'
  else if (/escanteio/.test(t)) categoria = 'Escanteios'

  const mOver  = t.match(/\bover\s*(\d+(?:[.,]\d+)?)/)
  const mUnder = t.match(/\bunder\s*(\d+(?:[.,]\d+)?)/)
  if (mOver)  return `${categoria}:Over ${mOver[1].replace(',', '.')}`
  if (mUnder) return `${categoria}:Under ${mUnder[1].replace(',', '.')}`

  // fallback numérico solto "2.5 gols" sem over/under → null
  return null
}

/** green/red/acerto/erro → boolean acerto ou null se pendente */
function isAcerto(resultado) {
  if (resultado == null) return null
  const r = String(resultado).toLowerCase()
  if (r === 'green' || r === 'acerto' || r === 'hit' || r === 'win') return true
  if (r === 'red'   || r === 'erro'   || r === 'miss' || r === 'loss') return false
  return null
}

/**
 * Extrai probabilidade prevista salva na entrada.
 * Aceita campo dedicado ou parse de obs tipo "λ=2.85 · score=72 · p=68"
 */
function extrairProbPrevista(entrada, mercadoCanon) {
  // ✅ FIX — `probBruta` = prob. ANTES de qualquer calibração (fator, isotonic, Platt, fator de linha).
  // É a única que pode alimentar o cálculo do fator, o walk-forward e as curvas: usar a
  // prob. já calibrada (probPrevista/probabilidade) corrigia em cima do já corrigido.
  // Entradas antigas (sem probBruta) caem nos campos abaixo, como antes.
  if (typeof entrada.probBruta === 'number' && !Number.isNaN(entrada.probBruta)) {
    return entrada.probBruta
  }
  if (typeof entrada.probPrevista === 'number' && !Number.isNaN(entrada.probPrevista)) {
    return entrada.probPrevista
  }
  // ✅ FIX: as entradas automáticas (origem 'auto') gravam a probabilidade no
  // campo `probabilidade` (vindo do auto-save), não em `probPrevista`/`prob`.
  // Sem isso, TODA entrada automática caía no "neutro 50" e distorcia os
  // fatores de calibração do futebol.
  if (typeof entrada.probabilidade === 'number' && !Number.isNaN(entrada.probabilidade)) {
    return entrada.probabilidade
  }
  if (typeof entrada.prob === 'number') return entrada.prob

  const obs = String(entrada.obs || '')
  const m = obs.match(/\bp\s*=\s*(\d{1,3})/i) || obs.match(/\bprob\s*[:=]\s*(\d{1,3})/i)
  if (m) return Math.min(99, Math.max(1, parseInt(m[1], 10)))

  // fallback: se veio da análise, tenta campos legados
  const map = {
    'Gols:Over 1.5':  entrada.over15_gols,
    'Gols:Over 2.5':  entrada.over25_gols,
    'Gols:Over 3.5':  entrada.over35_gols,
    'Gols:Under 1.5': entrada.under15_gols,
    'Gols:Under 2.5': entrada.under25_gols,
    'Gols:Under 3.5': entrada.under35_gols,
    'BTTS':      entrada.btts,
  }
  const v = map[mercadoCanon]
  if (typeof v === 'number') return v

  return 50 // neutro se não souber
}

async function carregarDados() {
  const agora = Date.now()
  if (_cacheEntradas && agora < _cacheExpiresAt) return

  try {
    const res = await fetch(CALIBRACAO_URL)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    _cacheEntradas  = Array.isArray(data?.atuais)     ? data.atuais     : []
    _cacheArquivo   = Array.isArray(data?.arquivadas) ? data.arquivadas : []
    _cacheExpiresAt = agora + CACHE_TTL_MS
    return
  } catch (err) {
    console.warn('[Calibration] calibracao-dados indisponível, usando /api/tracker:', err.message)
  }

  // fallback (servidor antigo / rota fora do ar): só o tracker atual, cache curto pra tentar de novo logo
  try {
    const res = await fetch(TRACKER_URL)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    _cacheEntradas  = Array.isArray(data) ? data : []
    _cacheArquivo   = []
    _cacheExpiresAt = agora + 60_000
  } catch (err) {
    console.warn('[Calibration] Falha ao ler tracker:', err.message)
    _cacheEntradas  = []
    _cacheArquivo   = []
    _cacheExpiresAt = agora + 60_000
  }
}

/** Entradas ATUAIS do tracker (análise: dashboard/contexto). Não inclui o arquivo. */
async function lerEntradas() {
  await carregarDados()
  return _cacheEntradas
}

/** Tracker atual + green/red arquivados — base da CALIBRAÇÃO (fatores e previsto × real). */
async function lerEntradasCalibracao() {
  await carregarDados()
  return _cacheArquivo.length ? [..._cacheEntradas, ..._cacheArquivo] : _cacheEntradas
}

// ── Herança de força entre linhas (Cartões / Escanteios) ─────

/** "Cartões:Over 4.5" → "Cartões:Over" (grupo da categoria+direção). null p/ Gols, BTTS, Tênis. */
function chaveGrupoLinha(mercado) {
  const m = /^(Cartões|Escanteios):(Over|Under) /.exec(mercado || '')
  return m ? `${m[1]}:${m[2]}` : null
}

const novoGrupo = () => ({ acertos: 0, total: 0, somaProb: 0, wTotal: 0, wAcertos: 0, wSomaProb: 0, wSomaQuad: 0 })

function acumular(g, w, prob, acerto) {
  g.total++
  g.somaProb  += prob
  g.wTotal    += w
  g.wSomaProb += w * prob
  g.wSomaQuad += w * w
  if (acerto) { g.acertos++; g.wAcertos += w }
}

/**
 * Estatísticas ponderadas (decaimento temporal) de um grupo. null se amostra/probabilidade inviável.
 *
 * ✅ REVISADO — Fase 2, item 6 do roadmap: `peso` antes era
 * `Math.min(1, nEfetivo / MIN_AMOSTRAS_FULL)` — uma rampa LINEAR que travava
 * em 1.0 (confiança total, zero influência do prior) assim que nEfetivo
 * passava de 25, com uma quebra dura bem nesse ponto. Isso não é shrinkage
 * bayesiano de verdade: uma amostra de 25 jogos passava a ser tratada como
 * 100% confiável, igual uma de 500.
 *
 * A fórmula correta (equivalente a um prior Beta com "k" pseudo-observações,
 * o resultado padrão de shrinkage Beta-Binomial/James-Stein) é:
 *
 *     peso = nEfetivo / (nEfetivo + k)      k = MIN_AMOSTRAS_FULL (25)
 *
 * Ela nunca chega a 1 — sempre sobra um pouco de peso pro prior — e sobe de
 * forma suave, sem quebra. Na prática muda pouco perto de nEfetivo pequeno
 * (que já era puxado forte pro prior antes), mas corrige o excesso de
 * confiança em amostras de 25-60 jogos, que antes viravam fator "pleno" e
 * agora continuam com uma pitada de regressão à média:
 *   nEfetivo=25  → peso=0.50 (era 1.00)
 *   nEfetivo=75  → peso=0.75 (era 1.00)
 *   nEfetivo=225 → peso=0.90 (era 1.00)
 */
function estatisticasGrupo(g) {
  if (g.total < MIN_AMOSTRAS_SOFT || g.wTotal <= 0) return null
  const taxaReal     = g.wAcertos / g.wTotal
  const taxaPrevista = (g.wSomaProb / g.wTotal) / 100
  if (taxaPrevista < 0.05 || taxaPrevista > 0.95) return null
  // nEfetivo (Kish) = (Σw)² / Σw² → histórico velho/desigual vale menos que a contagem bruta
  const nEfetivo = (g.wTotal * g.wTotal) / g.wSomaQuad
  return {
    taxaReal, taxaPrevista, nEfetivo,
    peso:  nEfetivo / (nEfetivo + MIN_AMOSTRAS_FULL),   // ✅ shrinkage bayesiano (item 6)
    bruto: taxaReal / taxaPrevista,
  }
}

const clampFator = f => Math.min(1.30, Math.max(0.70, f))

// ═══════ ✅ NOVO — Fase 2, item 7 do roadmap: SEGMENTAÇÃO POR LIGA E ÁRBITRO ═══════
// O fator GLOBAL (calcFatoresCalibration) mistura o histórico de TODAS as
// ligas e árbitros num fator só por mercado — mas o modelo pode estar bem
// calibrado numa liga e mal calibrado noutra (ex.: uma liga tem mais cartão
// que a média e o modelo não captura isso 100%), ou um árbitro específico
// fugir do padrão do próprio grupo (mais rigoroso/liberal que a média).
//
// Igual à herança de força entre linhas (Cartões/Escanteios, acima), aqui o
// fator GLOBAL vira o PRIOR do fator segmentado — nunca substituído, só
// ajustado quando já há amostra própria suficiente pra confiar no desvio.
// A amostra exigida é menor que a do global (k=25): segmentos naturalmente
// têm menos jogos (uma liga só, ou só os jogos de um árbitro), então exigir
// o mesmo k do global travaria a segmentação pra sempre.
const MIN_AMOSTRAS_SEGMENTO_FULL = 15  // pseudo-amostras do prior (segmento)
const MIN_AMOSTRAS_SEGMENTO_SOFT = 6   // mínimo pra sequer considerar o segmento

/** Estatísticas ponderadas de um segmento (liga OU árbitro) — mesma fórmula
 *  de estatisticasGrupo() acima, só que com k menor (MIN_AMOSTRAS_SEGMENTO_FULL),
 *  adequado a amostras naturalmente menores que o global ou o grupo de linha. */
function estatisticasSegmento(g) {
  if (g.total < MIN_AMOSTRAS_SEGMENTO_SOFT || g.wTotal <= 0) return null
  const taxaReal     = g.wAcertos / g.wTotal
  const taxaPrevista = (g.wSomaProb / g.wTotal) / 100
  if (taxaPrevista < 0.05 || taxaPrevista > 0.95) return null
  const nEfetivo = (g.wTotal * g.wTotal) / g.wSomaQuad
  return {
    taxaReal, taxaPrevista, nEfetivo,
    peso: nEfetivo / (nEfetivo + MIN_AMOSTRAS_SEGMENTO_FULL),
    bruto: taxaReal / taxaPrevista,
  }
}

/**
 * Ajusta `fatores` (mutando o objeto, já calculado pelo passo global) com o
 * desvio de LIGA e/ou ÁRBITRO do jogo específico passado em `contextoSegmento`.
 *
 * Os dois eixos são independentes e SOMADOS como desvio em relação ao fator
 * global (não substituem o fator sozinhos):
 *   fatorFinal = global + (desvioLiga) + (desvioArbitro)
 * Isso evita que os dois eixos "briguem" pelo mesmo espaço de correção — cada
 * um só contribui com o quanto o histórico DAQUELE segmento se afasta do que
 * o fator global já capturava. Resultado sempre travado em 0.70–1.30
 * (clampFator), igual ao fator global.
 *
 * ✅ Árbitro sem histórico salvo: entradas do Tracker anteriores à introdução
 * do campo `arbitro` (ver server/index.js, rota /api/tracker/auto-save) não
 * têm esse dado — contam normalmente pro fator GLOBAL, mas ficam de fora do
 * grupo do árbitro (não distorcem nem "diluem" a segmentação).
 */
function aplicarSegmentacao(fatores, entradas, { liga, arbitro } = {}) {
  if (!liga && !arbitro) return
  const agora = Date.now()
  const gruposLiga    = {}  // por mercado, só entradas da MESMA liga do jogo
  const gruposArbitro = {}  // por mercado, só entradas do MESMO árbitro do jogo

  for (const entrada of entradas) {
    const acerto = isAcerto(entrada.resultado)
    if (acerto === null) continue
    if (!entradaConfiavelParaFator(entrada)) continue

    const mercado = chaveDaEntrada(entrada)
    if (!mercado) continue
    const prob = mercado.startsWith('Tênis:') ? extrairProbTenis(entrada) : extrairProbPrevista(entrada, mercado)
    if (prob == null) continue
    const w = pesoTemporal(entrada, agora)

    if (liga && entrada.liga === liga) {
      if (!gruposLiga[mercado]) gruposLiga[mercado] = novoGrupo()
      acumular(gruposLiga[mercado], w, prob, acerto)
    }
    if (arbitro && entrada.arbitro === arbitro) {
      if (!gruposArbitro[mercado]) gruposArbitro[mercado] = novoGrupo()
      acumular(gruposArbitro[mercado], w, prob, acerto)
    }
  }

  const desvio = (grupos, mercado, global) => {
    const g = grupos[mercado]
    if (!g) return 0
    const est = estatisticasSegmento(g)
    if (!est) return 0
    return (est.bruto - global) * est.peso
  }

  const mercadosTocados = new Set([...Object.keys(gruposLiga), ...Object.keys(gruposArbitro)])
  for (const mercado of mercadosTocados) {
    const global   = fatores[mercado] ?? 1.0
    const dLiga    = desvio(gruposLiga, mercado, global)
    const dArbitro = desvio(gruposArbitro, mercado, global)
    if (dLiga === 0 && dArbitro === 0) continue

    fatores[mercado] = parseFloat(clampFator(global + dLiga + dArbitro).toFixed(3))
    if (dLiga !== 0)    fatores[`_n_liga_${mercado}`]    = gruposLiga[mercado].total
    if (dArbitro !== 0) fatores[`_n_arbitro_${mercado}`] = gruposArbitro[mercado].total

    console.info(
      `[Calibration] segmento ${mercado} (liga=${liga ?? '-'}, árbitro=${arbitro ?? '-'}): ` +
      `global=${global.toFixed(3)}${dLiga !== 0 ? ` · liga(n=${gruposLiga[mercado].total})=${(global + dLiga).toFixed(3)}` : ''}` +
      `${dArbitro !== 0 ? ` · árbitro(n=${gruposArbitro[mercado].total})=${(global + dArbitro).toFixed(3)}` : ''} · final=${fatores[mercado]}`
    )
  }
}

// ✅ NOVO — Fase 2, item 5 do roadmap: o fator de correção por mercado agora
// usa o que a Fase 1 já produz e ainda ficava sem uso aqui — `resultadoReal.
// outlier` (item 3) e `resultadoReal.crossCheck` (item 2). Uma entrada suja
// (expulsão precoce, contagem atípica, ou placar/cartões/escanteios que
// divergiram entre as duas fontes) não deve empurrar o fator de
// mercado nenhum — mas o green/red dela continua valendo normalmente pro
// desempenho geral (dashboard, ranking etc.), só é excluída DAQUI.
// "sem_segunda_fonte" não é descartado: falta de segunda fonte não é sinal
// de dado ruim, só de que não deu pra confirmar.
function entradaConfiavelParaFator(entrada) {
  const rr = entrada?.resultadoReal
  if (!rr) return true // entradas antigas (anteriores à Fase 1) não têm o campo — não penaliza
  if (rr.outlier?.flag) return false
  if (rr.crossCheck?.status === 'divergente') return false
  return true
}

/**
 * Calcula fatores por mercado a partir do histórico green/red.
 * fator < 1 → modelo superestima esse mercado
 * fator > 1 → modelo subestima
 *
 * O fator é sempre puxado em direção ao prior (1.0, ou o fator do grupo pra
 * Cartões/Escanteios) por um shrinkage bayesiano Beta-Binomial — ver
 * estatisticasGrupo(). Amostra pequena puxa forte pro prior; amostra grande
 * puxa pouco, mas NUNCA solta 100% (não existe "amostra cheia = confiança
 * total") — regressão à média sempre sobra um pouco, mesmo com muito histórico.
 *
 * ✅ Decaimento temporal: cada green/red é ponderado por 0.5^(idade/45 dias)
 * (piso 0.10), então o fator reflete mais o desempenho RECENTE do modelo.
 *
 * ✅ Herança de força (Cartões/Escanteios): cada linha (Over 3.5, Over 4.5...)
 * tem pouca amostra sozinha, então todas as linhas da mesma categoria+direção
 * são juntas num GRUPO ("Cartões:Over", "Escanteios:Under"...). O fator do grupo
 * vira o ponto de partida (prior) de cada linha:
 *   • linha com amostra própria ≥ MIN_AMOSTRAS_SOFT → puxa do grupo em direção
 *     ao próprio dado, com peso crescente conforme a amostra da linha cresce;
 *   • linha com pouca/nenhuma amostra → HERDA o fator do grupo (em vez de 1.0).
 * O fator do grupo também fica salvo em `<Categoria>:<Direção> (grupo)` e serve de
 * fallback pra linhas fora de MERCADOS_ALVO (ver aplicarFatorLinha).
 * Gols, BTTS e Tênis seguem a lógica anterior (prior = 1.0).
 *
 * ✅ NOVO — Fase 2, item 7 do roadmap: `contextoSegmento` (opcional)
 * = { liga, arbitro } do JOGO específico sendo analisado. Quando informado,
 * o fator global de cada mercado ainda é calculado normalmente (todas as
 * ligas/árbitros juntos) e DEPOIS ajustado pelo desvio próprio daquela
 * liga e/ou árbitro, se já houver amostra suficiente — ver aplicarSegmentacao().
 * Sem contextoSegmento (chamadas antigas, sem esse argumento), o
 * comportamento é idêntico a antes.
 */
export function calcFatoresDeEntradas(entradas, contextoSegmento = null) {
  const fatores = {}
  const TODOS_MERCADOS = [...MERCADOS_ALVO, ...MERCADOS_TENIS]
  TODOS_MERCADOS.forEach(m => { fatores[m] = 1.0 })

  if (!entradas.length) return fatores

  const agora  = Date.now()
  const grupos = {}   // por linha/mercado
  const pools  = {}   // por categoria+direção (Cartões:Over, Escanteios:Under, ...)
  TODOS_MERCADOS.forEach(m => { grupos[m] = novoGrupo() })

  let descartadasSujeira = 0   // ✅ NOVO — item 5: contador só pra log/telemetria

  for (const entrada of entradas) {
    const acerto = isAcerto(entrada.resultado)
    if (acerto === null) continue // ainda pendente

    // ✅ NOVO — item 5: descarta outlier/divergência ANTES de entrar no
    // grupo/pool, pra não distorcer nem o fator da linha nem o do grupo.
    if (!entradaConfiavelParaFator(entrada)) { descartadasSujeira++; continue }

    const mercado = chaveDaEntrada(entrada)
    if (!mercado) continue
    const gk = mercado.startsWith('Tênis:') ? null : chaveGrupoLinha(mercado)
    if (!grupos[mercado] && !gk) continue

    const prob = mercado.startsWith('Tênis:') ? extrairProbTenis(entrada) : extrairProbPrevista(entrada, mercado)
    if (prob == null) continue // tênis sem probabilidade salva não entra na conta

    const w = pesoTemporal(entrada, agora)
    if (grupos[mercado]) acumular(grupos[mercado], w, prob, acerto)
    if (gk) {
      if (!pools[gk]) pools[gk] = novoGrupo()
      acumular(pools[gk], w, prob, acerto)   // conta também linhas fora de MERCADOS_ALVO
    }
  }

  // 1) Fator de cada GRUPO (shrinkage em direção a 1.0)
  const fatoresGrupo = {}
  for (const [gk, g] of Object.entries(pools)) {
    const est = estatisticasGrupo(g)
    if (!est) continue
    const f = parseFloat(clampFator(1 + (est.bruto - 1) * est.peso).toFixed(3))
    fatoresGrupo[gk] = f
    fatores[`${gk} (grupo)`]  = f
    fatores[`_n_grupo_${gk}`] = g.total
    console.info(
      `[Calibration] GRUPO ${gk}: n=${g.total} (efetivo ${est.nEfetivo.toFixed(1)}) · ` +
      `previsto=${(est.taxaPrevista * 100).toFixed(1)}% · real=${(est.taxaReal * 100).toFixed(1)}% · fator=${f}`
    )
  }

  // 2) Fator de cada linha/mercado, com o grupo como prior
  for (const [mercado, g] of Object.entries(grupos)) {
    const gk     = chaveGrupoLinha(mercado)
    const fGrupo = gk ? fatoresGrupo[gk] : undefined
    const est    = estatisticasGrupo(g)

    if (!est) {
      // amostra própria insuficiente: herda o grupo (Cartões/Escanteios) ou fica neutro
      if (fGrupo != null) {
        fatores[mercado] = fGrupo
        if (g.total > 0) console.info(`[Calibration] ${mercado}: ${g.total}/${MIN_AMOSTRAS_SOFT} amostras — herda grupo (${fGrupo})`)
      } else {
        fatores[mercado] = 1.0
        if (g.total > 0) console.info(`[Calibration] ${mercado}: ${g.total}/${MIN_AMOSTRAS_SOFT} amostras — neutro`)
      }
      continue
    }

    const prior = fGrupo ?? 1.0
    const fator = clampFator(prior + (est.bruto - prior) * est.peso)
    fatores[mercado] = parseFloat(fator.toFixed(3))
    fatores[`_n_${mercado}`] = g.total   // guarda o tamanho da amostra p/ uso no ranking

    console.info(
      `[Calibration] ${mercado}: n=${g.total} (efetivo ${est.nEfetivo.toFixed(1)}) · ` +
      `previsto=${(est.taxaPrevista * 100).toFixed(1)}% · ` +
      `real=${(est.taxaReal * 100).toFixed(1)}% · ` +
      `fator=${fatores[mercado]} (peso=${est.peso.toFixed(2)}${fGrupo != null ? `, prior grupo=${fGrupo}` : ''})`
    )
  }

  if (descartadasSujeira > 0) {
    console.info(`[Calibration] item 5: ${descartadasSujeira} entrada(s) descartada(s) do cálculo do fator (outlier/divergência) — resultado do green/red delas não muda.`)
  }

  // ✅ CORREÇÃO — item 7: aplicarSegmentacao() existia mas nunca era chamada
  // aqui, então o desvio por liga/árbitro nunca entrava no fator final.
  if (contextoSegmento && (contextoSegmento.liga || contextoSegmento.arbitro)) {
    aplicarSegmentacao(fatores, entradas, contextoSegmento)
  }

  return fatores
}

export async function calcFatoresCalibration(contextoSegmento = null) {
  const entradas = await lerEntradasCalibracao()
  return calcFatoresDeEntradas(entradas, contextoSegmento)
}

/** Multiplica as probs brutas pelos fatores e rebalanceia over/under. */
export function aplicarCalibration(probs, fatores) {
  if (!fatores || !Object.keys(fatores).length) {
    // Mesmo sem fatores, garante over+under = 100
    return normalizarParesOverUnder(probs)
  }

  const aplicar = (valor, chave) => {
    if (valor == null || Number.isNaN(valor)) return valor
    const f = fatores[chave] ?? 1.0
    const cal = Math.round(Math.min(88, Math.max(12, valor * f)))
    // ✅ CORREÇÃO: a calibração nunca move a prob. bruta mais que MAX_MOVIMENTO_CALIBRACAO_PP
    return Math.round(limitarMovimento(valor, cal))
  }

  // ✅ FIX — item 4: os fatores de Under (Gols:Under 1.5/2.5/3.5) já são
  // calculados em calcFatoresDeEntradas a partir do histórico de entradas
  // Under de verdade, mas nunca eram lidos aqui — o Under sempre saía como
  // espelho do Over calibrado (100 - overCal), herdando só o viés do lado
  // Over (que só aprende de jogos em que o Over foi a entrada escolhida).
  // Agora os dois lados são calibrados com o próprio fator aprendido e
  // DEPOIS rebalanceados proporcionalmente pra somar 100 — em vez de um
  // lado apagar o ajuste do outro.
  const rebalancear = (o, u) => {
    if (o == null || u == null) return [o, u]
    const soma = o + u
    if (soma <= 0) return [o, u]
    const oNorm = Math.round((o / soma) * 100)
    return [oNorm, 100 - oNorm]
  }

  const [over15Cal, under15Cal] = rebalancear(
    aplicar(probs.over15, 'Gols:Over 1.5'), aplicar(probs.under15, 'Gols:Under 1.5')
  )
  const [over25Cal, under25Cal] = rebalancear(
    aplicar(probs.over25, 'Gols:Over 2.5'), aplicar(probs.under25, 'Gols:Under 2.5')
  )
  const [over35Cal, under35Cal] = rebalancear(
    aplicar(probs.over35, 'Gols:Over 3.5'), aplicar(probs.under35, 'Gols:Under 3.5')
  )

  return normalizarParesOverUnder({
    ...probs,
    over15: over15Cal, under15: under15Cal,
    over25: over25Cal, under25: under25Cal,
    over35: over35Cal, under35: under35Cal,
    btts:   aplicar(probs.btts, 'BTTS'),
  })
}

/**
 * ✅ NOVO — aplica o fator de calibração numa linha genérica de
 * Cartões/Escanteios (mesmo espírito de `aplicar()` dentro de
 * aplicarCalibration, mas parametrizado por categoria+linha em vez de
 * mercados fixos de gols). Só calibra o lado OVER; o UNDER é sempre
 * o espelho (100 - over), igual já acontece com gols.
 */
export function aplicarFatorLinha(overPct, categoria, linha, fatoresCalib) {
  if (overPct == null || Number.isNaN(overPct)) return overPct
  const { teto, piso } = getCapsCategoria(categoria)
  if (!fatoresCalib) return Math.round(Math.min(teto, Math.max(piso, overPct)))
  const chave = `${categoria}:Over ${linha}`
  // fallback: linha fora de MERCADOS_ALVO (ex.: Escanteios Over 15.5) usa o fator do grupo
  const f = fatoresCalib[chave] ?? fatoresCalib[`${categoria}:Over (grupo)`] ?? 1.0
  return Math.round(Math.min(teto, Math.max(piso, overPct * f)))
}

/** Garante over + under = 100 em todos os totais */
export function normalizarParesOverUnder(probs) {
  if (!probs) return probs
  const o15 = probs.over15 != null ? Math.round(probs.over15) : null
  const o25 = probs.over25 != null ? Math.round(probs.over25) : null
  const o35 = probs.over35 != null ? Math.round(probs.over35) : null
  return {
    ...probs,
    over15:  o15,
    under15: o15 != null ? 100 - o15 : probs.under15,
    over25:  o25,
    under25: o25 != null ? 100 - o25 : probs.under25,
    over35:  o35,
    under35: o35 != null ? 100 - o35 : probs.under35,
    btts:    probs.btts != null ? Math.round(probs.btts) : probs.btts,
  }
}

/**
 * Reavalia o melhor mercado de gols usando probs já calibradas.
 * gap mínimo padrão 8 pp (mesmo espírito do modelo original).
 */
/**
 * fatoresCalib (opcional): objeto vindo de calcFatoresCalibration(), ex.:
 *   { 'Over 1.5': 1.12, 'Over 2.5': 0.95, ... }
 * fator > 1 → mercado historicamente acerta MAIS do que o modelo previa → ganha peso
 * fator < 1 → mercado historicamente acerta MENOS do que o modelo previa → perde peso
 */
// ✅ AJUSTE DE PESO: gapMinimo subiu de 13 para 16pp. O "gap" mede a
// distância entre o mercado escolhido e o lado oposto (ex.: Over 65% vs
// Under 35% = gap 30). Com 13pp de mínimo, mercados quase 50/50 (56% x 44%)
// já entravam como "melhor pick" — é exatamente esse tipo de jogo raspando
// a linha que mais gera red. Com 16pp, o modelo passa a exigir mais folga
// antes de recomendar uma entrada, priorizando qualidade sobre quantidade
// de picks.
export function escolherMelhorMercadoCalibrado(probs, fatoresCalib = null, gapMinimo = 16) {
  const candidatos = [
    { nome: 'Over 1.5 Gols',  chave: 'Gols:Over 1.5',  emoji: '🔥', prob: probs.over15,  direcao: 'over',  threshold: 1.5, pesoUtil: 0.40 },
    { nome: 'Under 1.5 Gols', chave: 'Gols:Under 1.5', emoji: '🧊', prob: probs.under15, direcao: 'under', threshold: 1.5, pesoUtil: 0.75 },
    { nome: 'Over 2.5 Gols',  chave: 'Gols:Over 2.5',  emoji: '⚡', prob: probs.over25,  direcao: 'over',  threshold: 2.5, pesoUtil: 1.00 },
    { nome: 'Under 2.5 Gols', chave: 'Gols:Under 2.5', emoji: '🛡️', prob: probs.under25, direcao: 'under', threshold: 2.5, pesoUtil: 1.00 },
    { nome: 'Over 3.5 Gols',  chave: 'Gols:Over 3.5',  emoji: '💥', prob: probs.over35,  direcao: 'over',  threshold: 3.5, pesoUtil: 0.95 },
    { nome: 'Under 3.5 Gols', chave: 'Gols:Under 3.5', emoji: '🔒', prob: probs.under35, direcao: 'under', threshold: 3.5, pesoUtil: 0.50 },
    { nome: 'BTTS Sim',       chave: 'BTTS',      emoji: '🎯', prob: probs.btts,    direcao: 'btts',  threshold: null, pesoUtil: 0.95 },
  ].filter(c => typeof c.prob === 'number')

  const ranking = candidatos
    .map(c => {
      const gap = Math.round(2 * c.prob - 100)
      // Zona útil de apostas: 52–70%. Acima de 72% = odd baixa, pouco value
      let fatorZona = 1.0
      if (c.prob >= 80) fatorZona = 0.25
      else if (c.prob >= 72) fatorZona = 0.45
      else if (c.prob >= 52) fatorZona = 1.0
      else fatorZona = 0.55

      // ✅ CORRIGIDO — antes o "Alta" só valia numa janela FECHADA de 70–73,99%,
      // o que invertia a lógica: Over 1.5 a 75% virava "Média" enquanto Under
      // 3.5 a 70% virava "Alta". A intenção original ("não recomendar mercado
      // trivial") era sobre VALOR DE ODD, não sobre confiança — misturar as
      // duas coisas no mesmo rótulo confundia a leitura.
      // Agora: confiança mede só o quanto o modelo está seguro (quanto maior a
      // prob, maior a confiança), e a questão da odd baixa vira a flag
      // `oddBaixa` abaixo + o fatorZona, que já penaliza no ranking.
      // Escala alinhada com cartões/escanteios (Alta ≥ 65) pra não ter duas
      // réguas diferentes na mesma tela.
      let confianca = 'Baixa'
      if (c.prob >= 65) confianca = 'Alta'
      else if (c.prob >= 58 && gap >= 13) confianca = 'Média'
      else if (c.prob > 50) confianca = 'Baixa'

      // ✅ NOVO — sinaliza mercado com odd provavelmente baixa demais pra
      // compensar. Separado da confiança: dá pra ter confiança Alta E odd
      // ruim ao mesmo tempo (é justamente o caso do Over 1.5 em jogo de
      // favorito claro).
      const oddBaixa = c.prob >= 80

      // NOVO: pesoUtil deixa de ser fixo — é ajustado pela taxa de acerto real
      // desse mercado no Scout Tracker. fatorCalib já vem clampado 0.70–1.30
      // por calcFatoresCalibration(), então o ajuste nunca é abrupto.
      // Só deixa a calibração pesar na ESCOLHA do mercado (não só na %)
      // quando já tem amostra decente (≥10). Com menos que isso, é fácil
      // um mercado "parecer bom" por sorte de 4-5 jogos e te empurrar
      // pra uma aposta que na real não tem base — trava aqui.
      const nAmostraMercado = fatoresCalib?.[`_n_${c.chave}`] ?? null
      const amostraSuficiente = nAmostraMercado == null || nAmostraMercado >= 10

      const fatorCalibBruto = fatoresCalib?.[c.chave] ?? 1.0
      // Clamp mais apertado que o da probabilidade (0.70–1.30):
      // aqui é só reordenação de ranking, não precisa de tanta força.
      const fatorCalib = amostraSuficiente
        ? Math.min(1.15, Math.max(0.85, fatorCalibBruto))
        : 1.0
      const pesoUtilAjustado = parseFloat((c.pesoUtil * fatorCalib).toFixed(3))

      return { ...c, gap, confianca, oddBaixa, pesoUtilAjustado, fatorCalibUsado: fatorCalib, scoreUtil: gap * pesoUtilAjustado * fatorZona }
    })
    .filter(c => c.prob > 50)
    // NOVO: prioriza acertividade (maior % primeiro). scoreUtil vira
    // critério de desempate, não o principal — reflete a decisão de
    // favorecer taxa de acerto sobre "valor de odd".
    .sort((a, b) => b.prob !== a.prob ? b.prob - a.prob : b.scoreUtil - a.scoreUtil)

  // Confiança mínima pra entrar no ranking como "melhor": ainda exige
  // gap mínimo (>=13pp de distância do lado oposto), só não bloqueia
  // mais por ser "trivial"/odd baixa.
  let melhor = ranking.find(m => m.gap >= gapMinimo) || null

  // ✅ NOVO — melhor entrada separada por direção (Over / Under)
  const melhorOver  = ranking.find(m => m.direcao === 'over')  || null
  const melhorUnder = ranking.find(m => m.direcao === 'under') || null

  return {
    ranking,
    melhor,
    melhorOver,
    melhorUnder,
    mercadoGols:      melhor ? `${melhor.emoji} ${melhor.nome}` : '⚖️ Mercado sem borda clara',
    mercadoGolsLimpo: melhor ? melhor.nome : 'Mercado sem borda clara',
    confiancaGols:    melhor ? melhor.confianca : 'Baixa',
  }
}

/**
 * Probabilidade prevista do mercado escolhido (para gravar no tracker).
 */
export function probDoMercado(probs, mercadoTxt) {
  const chave = normalizarMercado(mercadoTxt)
  if (!chave || !probs) return 50
  const map = {
    'Gols:Over 1.5':  probs.over15,
    'Gols:Over 2.5':  probs.over25,
    'Gols:Over 3.5':  probs.over35,
    'Gols:Under 1.5': probs.under15,
    'Gols:Under 2.5': probs.under25,
    'Gols:Under 3.5': probs.under35,
    'BTTS':      probs.btts,
  }
  const v = map[chave]
  return typeof v === 'number' ? v : 50
}

export function invalidarCacheCalibration() {
  _cacheEntradas  = null
  _cacheArquivo   = []
  _cacheExpiresAt = 0
}

// ═══════════════ ✅ NOVO — Fase 3, item 10 do roadmap: VALIDAÇÃO OUT-OF-SAMPLE ═══════════════
// Calibrar e medir acerto no MESMO histórico que gerou o fator é "decorar":
// qualquer fator vai parecer bom ali, porque foi extraído exatamente daqueles
// jogos. A prova real é calcular o fator só com uma fatia do histórico
// (treino) e medir se ele melhora a previsão numa fatia que ele NUNCA viu
// (teste). Divide CRONOLOGICAMENTE (não aleatório) — treino = jogos mais
// antigos, teste = os mais recentes — pra não vazar informação do futuro
// pro passado (mesmo cuidado de look-ahead bias que a Fase 7 exige).
const OOS_MIN_TREINO = 40   // mínimo de finalizados no treino pra gerar fator confiável
const OOS_MIN_TESTE  = 20   // mínimo no teste pra a comparação ter algum peso
// ✅ NOVO — Fase 7, item 33: walk-forward com purge gap
const OOS_GAP_DIAS  = 3     // dias de "zona morta" entre fim do treino e início do teste
const OOS_NUM_FOLDS = 3     // nº de janelas de teste consecutivas (expandindo o treino a cada uma)

// ═══════════════ ✅ CORREÇÃO DE CALIBRAÇÃO (isotonic/Platt inflavam probabilidades) ═══════════════
// Bug: a curva era treinada só com as APOSTAS ESCOLHIDAS (quase todas > 50%) e,
// ao receber uma probabilidade baixa (ex.: Over 3.5 = 20%), devolvia a taxa de
// acerto do bloco mais baixo que conhecia (~83–85%). Além disso, o treino
// misturava Cartões/Escanteios com Gols. Regras novas, todas centralizadas aqui:
//
//  • CALIBRACAO_CURVA_HABILITADA = false → produção usa SEMPRE o fator simples
//    (limitado a 0.70–1.30). As curvas continuam sendo avaliadas na validação,
//    mas só entram em produção se você ligar esta chave E elas passarem em tudo.
//  • Curva só vale DENTRO da faixa de probabilidades em que foi treinada.
//  • Nenhuma calibração move a probabilidade bruta mais que MAX_MOVIMENTO_CALIBRACAO_PP.
//  • Curva só é treinada com Gols (1.5/2.5/3.5) e BTTS de futebol — nunca Cartões,
//    Escanteios, Tênis ou Basquete.
//  • Amostra mínima por técnica, e teste de estresse (5%–95%) antes de ligar.
const CALIBRACAO_CURVA_HABILITADA = false
const MAX_MOVIMENTO_CALIBRACAO_PP = 10   // teto de quanto a calibração pode mover a prob. bruta
const TOLERANCIA_TRAVA_PP         = 2    // folga (arredondamento/rebalanceamento) acima do teto antes da trava final agir
const CURVA_MIN_AMOSTRAS_ISOTONIC = 150  // apostas de Gols/BTTS finalizadas (sem contar os pares espelho)
const CURVA_MIN_AMOSTRAS_PLATT    = 80

const MERCADOS_CURVA = new Set([
  'Gols:Over 1.5', 'Gols:Over 2.5', 'Gols:Over 3.5',
  'Gols:Under 1.5', 'Gols:Under 2.5', 'Gols:Under 3.5',
  'BTTS',
])
const ESPORTES_FORA_DA_CURVA = ['basquete', 'basketball', 'nba', 'tenis', 'tennis']

/** Limita quanto a calibrada pode se afastar da bruta (em pontos percentuais). */
function limitarMovimento(bruta, calibrada, maxPP = MAX_MOVIMENTO_CALIBRACAO_PP) {
  if (typeof bruta !== 'number' || typeof calibrada !== 'number') return calibrada
  if (Number.isNaN(bruta) || Number.isNaN(calibrada)) return calibrada
  const d = calibrada - bruta
  if (Math.abs(d) <= maxPP) return calibrada
  return bruta + Math.sign(d) * maxPP
}

/** Brier Score (menor = melhor) de uma lista de { probPct, acerto }. */
function brierDe(itens) {
  if (!itens.length) return null
  const soma = itens.reduce((s, it) => s + (it.probPct / 100 - (it.acerto ? 1 : 0)) ** 2, 0)
  return soma / itens.length
}

/** ✅ NOVO — Fase 7, item 34: Log Loss (menor = melhor), complementa o Brier.
 *  Pune mais forte que o Brier quando o modelo erra "com confiança" (ex.:
 *  dizer 95% e não acontecer) — é o segundo critério de qualidade de
 *  probabilidade, ao lado do Brier, para decidir se um modelo é melhor. */
/** ✅ NOVO — Fase 7, item 34: Log Loss (menor = melhor), complementa o Brier.
 *  Pune mais forte que o Brier quando o modelo erra "com confiança" (ex.:
 *  dizer 95% e não acontecer) — é o segundo critério de qualidade de
 *  probabilidade, ao lado do Brier, para decidir se um modelo é melhor. */
function logLossDe(itens) {
  if (!itens.length) return null
  const EPS = 1e-6 // evita log(0) em previsões de 0%/100%
  const soma = itens.reduce((s, it) => {
    const p = Math.min(1 - EPS, Math.max(EPS, it.probPct / 100))
    return s + (it.acerto ? -Math.log(p) : -Math.log(1 - p))
  }, 0)
  return soma / itens.length
}

// ✅ NOVO — Fase 8, item 35: Isotonic Regression + Platt Scaling + ECE
// Diferente do fator multiplicativo (que só "escala" a prob. inteira por um
// número fixo), essas duas técnicas aprendem uma CURVA de correção — podem
// esticar mais um pedaço da faixa de probabilidade do que outro. Isotonic é
// não-paramétrica (só exige monotonicidade: prob. maior nunca pode virar
// taxa real menor) — mais flexível, precisa de mais dado. Platt é 1
// parâmetro (regressão logística em cima do logit) — mais rígida, mais
// estável com pouco dado. ECE mede o "erro de calibração" residual dos dois
// (e do fator antigo) em bins de 10% — 0 = perfeitamente calibrado.

/** Pool Adjacent Violators — treina uma função-escada monótona não-decrescente
 *  em cima de pares (x, y) ordenados por x. x = probBruta/100, y = acerto (0/1).
 *  ✅ CORREÇÃO: devolve também o DOMÍNIO do treino (min/max de x). Fora dele a curva
 *  NÃO se aplica (applyIsotonic devolve null) — antes ela devolvia o bloco da ponta. */
function fitIsotonic(pares) {
  if (!pares.length) return { blocos: [], min: null, max: null, n: 0 }
  const pts = [...pares].sort((a, b) => a.x - b.x)
  let blocos = pts.map(p => ({ y: p.y, w: 1, xmin: p.x, xmax: p.x }))
  let i = 0
  while (i < blocos.length - 1) {
    if (blocos[i].y > blocos[i + 1].y + 1e-12) {
      const a = blocos[i], b = blocos[i + 1]
      const merged = { y: (a.y * a.w + b.y * b.w) / (a.w + b.w), w: a.w + b.w, xmin: a.xmin, xmax: b.xmax }
      blocos.splice(i, 2, merged)
      i = Math.max(0, i - 1)
    } else i++
  }
  return { blocos, min: pts[0].x, max: pts[pts.length - 1].x, n: pts.length }
}

/** Aplica a curva isotonic a um x (probBruta/100). Devolve null se x estiver FORA
 *  da faixa em que a curva foi treinada — quem chama deve usar o valor bruto. */
function applyIsotonic(modelo, x) {
  if (!modelo || !modelo.blocos?.length || modelo.min == null) return null
  if (typeof x !== 'number' || Number.isNaN(x)) return null
  if (x < modelo.min - 1e-9 || x > modelo.max + 1e-9) return null
  for (const b of modelo.blocos) if (x <= b.xmax) return b.y
  return modelo.blocos[modelo.blocos.length - 1].y
}

/** Platt scaling: regressão logística 1D em cima do logit(probBruta) — a·logit(x)+b.
 *  Gradiente descendente simples (sem dependência externa), poucas iterações.
 *  ✅ CORREÇÃO: também guarda o domínio do treino (min/max de x). */
function fitPlatt(pares) {
  if (!pares.length) return { a: 1, b: 0, min: null, max: null, n: 0 }
  const EPS = 1e-6
  let a = 1, b = 0
  const lr = 0.1, iters = 300
  for (let it = 0; it < iters; it++) {
    let ga = 0, gb = 0
    for (const { x, y } of pares) {
      const z = Math.log(Math.max(EPS, x) / Math.max(EPS, 1 - x))
      const p = 1 / (1 + Math.exp(-(a * z + b)))
      const err = p - y
      ga += err * z
      gb += err
    }
    a -= lr * ga / pares.length
    b -= lr * gb / pares.length
  }
  let min = Infinity, max = -Infinity
  for (const { x } of pares) { if (x < min) min = x; if (x > max) max = x }
  return { a, b, min, max, n: pares.length }
}

/** Aplica o Platt treinado a um x (probBruta/100). Devolve null fora do domínio de treino. */
function applyPlatt(modelo, x) {
  if (!modelo || modelo.min == null) return null
  if (typeof x !== 'number' || Number.isNaN(x)) return null
  if (x < modelo.min - 1e-9 || x > modelo.max + 1e-9) return null
  const EPS = 1e-6
  const z = Math.log(Math.max(EPS, x) / Math.max(EPS, 1 - x))
  return 1 / (1 + Math.exp(-(modelo.a * z + modelo.b)))
}

/** ✅ NOVO — aplica UMA técnica de curva a uma probabilidade em % já com todas as
 *  proteções de produção: domínio de treino, clamp 12–88 e teto de movimento.
 *  Usada tanto em produção (aplicarCurvaProducao) quanto na validação, pra que o
 *  walk-forward meça exatamente o que vai pro ar. */
function calibrarPorCurva(tecnica, modelo, probPct) {
  const x = probPct / 100
  const p = tecnica === 'isotonic' ? applyIsotonic(modelo, x) : applyPlatt(modelo, x)
  if (p == null || Number.isNaN(p)) return { pct: probPct, foraDominio: true }
  const cal = Math.min(88, Math.max(12, p * 100))
  return { pct: limitarMovimento(probPct, cal), foraDominio: false }
}

/** ✅ NOVO — a entrada do tracker serve pra treinar a curva? Só Gols 1.5/2.5/3.5 e BTTS
 *  de FUTEBOL. Cartões, Escanteios, Tênis, Basquete e linhas ao vivo atípicas ficam de fora. */
function entradaServeParaCurva(e, mercadoCanon) {
  if (!mercadoCanon || !MERCADOS_CURVA.has(mercadoCanon)) return false
  if (ehEntradaTenis(e)) return false
  const esp = semAcento(e?.esporte)
  if (esp && ESPORTES_FORA_DA_CURVA.includes(esp)) return false
  return true
}

/** ✅ NOVO — monta os pares de treino da curva. Cada aposta (p, acerto) gera também o
 *  par ESPELHO (1−p, 1−acerto): Over/Under da mesma linha (e BTTS Sim/Não) são
 *  complementares, então o espelho é verdadeiro e dá à curva cobertura legítima das
 *  probabilidades baixas (5%–50%), que as apostas escolhidas quase nunca tocam.
 *  `nReais` = nº de apostas de verdade (sem contar os espelhos). */
function paresParaCurva(entradas) {
  const pares = []
  let nReais = 0
  for (const e of entradas) {
    const m = normalizarMercado(e.mercado)
    if (!entradaServeParaCurva(e, m)) continue
    const p  = extrairProbPrevista(e, m)
    const ac = isAcerto(e.resultado)
    if (p == null || ac === null) continue
    const x = Math.min(0.99, Math.max(0.01, p / 100))
    const y = ac ? 1 : 0
    pares.push({ x, y })
    pares.push({ x: 1 - x, y: 1 - y })
    nReais++
  }
  return { pares, nReais }
}

/** ✅ NOVO — TESTE DE ESTRESSE: varre 5%–95% (dentro do domínio de treino) e reprova a
 *  curva se algum ponto se mover mais que MAX_MOVIMENTO_CALIBRACAO_PP ou se ela não for
 *  monótona (prob. maior nunca pode virar taxa menor). */
function testeEstresseCurva(tecnica, modelo) {
  if (!modelo || modelo.min == null) return { ok: false, motivo: 'sem modelo treinado', maxDesvioPP: null, monotona: null }
  let maxDesvio = 0, monotona = true, prev = -Infinity, pontos = 0
  for (let i = 5; i <= 95; i++) {
    const x = i / 100
    const p = tecnica === 'isotonic' ? applyIsotonic(modelo, x) : applyPlatt(modelo, x)
    if (p == null) continue // fora do domínio: a produção devolve o valor bruto, nada a testar
    pontos++
    if (p < prev - 1e-9) monotona = false
    prev = p
    maxDesvio = Math.max(maxDesvio, Math.abs(p - x) * 100)
  }
  if (!pontos) return { ok: false, motivo: 'domínio de treino não cobre 5%–95%', maxDesvioPP: null, monotona: null }
  maxDesvio = Math.round(maxDesvio * 10) / 10
  const ok = monotona && maxDesvio <= MAX_MOVIMENTO_CALIBRACAO_PP
  return {
    ok,
    motivo: ok ? 'ok' : (!monotona ? 'curva não monótona' : `move até ${maxDesvio}pp (limite ${MAX_MOVIMENTO_CALIBRACAO_PP}pp)`),
    maxDesvioPP: maxDesvio,
    monotona,
  }
}

/** Expected Calibration Error: bins de 10%, cada bin pesa por |confiança média − acerto médio|.
 *  0 = perfeitamente calibrado. Diferente do Brier (não separa "erro de calibração" de "erro de resolução"). */
function eceDe(itens, nBins = 10) {
  if (!itens.length) return null
  const bins = Array.from({ length: nBins }, () => ({ somaP: 0, somaY: 0, n: 0 }))
  for (const it of itens) {
    const p = Math.min(0.999999, Math.max(0, it.probPct / 100))
    const idx = Math.min(nBins - 1, Math.floor(p * nBins))
    bins[idx].somaP += p
    bins[idx].somaY += it.acerto ? 1 : 0
    bins[idx].n++
  }
  let ece = 0
  for (const b of bins) {
    if (!b.n) continue
    ece += (b.n / itens.length) * Math.abs(b.somaP / b.n - b.somaY / b.n)
  }
  return ece
}

/**
 * ✅ NOVO — Fase 3, item 11: intervalo de confiança de Wilson pra uma taxa de
 * acerto observada (acertos/n). Diferente do intervalo normal (± z·√(p(1-p)/n)),
 * o de Wilson não estoura de [0,1] em amostra pequena ou taxa perto de 0%/100%
 * — é o caso mais comum aqui (poucos jogos por mercado). z=1.96 → 95% de confiança.
 */
function wilsonInterval(acertos, n, z = 1.96) {
  if (!n) return null
  const p = acertos / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const centro = p + z2 / (2 * n)
  const margem = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))
  return {
    low:  Math.max(0, (centro - margem) / denom),
    high: Math.min(1, (centro + margem) / denom),
  }
}

/**
 * Testa se a calibração generaliza: divide o histórico em TREINO (mais
 * antigo) e TESTE (mais recente), calcula os fatores só com o treino, aplica
 * esses fatores nas probabilidades BRUTAS do teste e compara o Brier Score
 * calibrado × bruto no teste. Se o calibrado for menor (melhor), a
 * calibração generaliza de fato — não é ruído decorado do próprio histórico
 * usado pra calculá-la.
 */
/**
 * ✅ REVISADO — Fase 7, item 33: em vez de um único corte treino/teste, agora
 * é walk-forward de verdade — várias janelas de teste consecutivas, cada uma
 * com o treino expandindo (só passado, nunca embaralha o tempo) e um "purge
 * gap" de OOS_GAP_DIAS entre o fim do treino e o início do teste, pra evitar
 * que contexto quase simultâneo (forma recente, lesão de véspera) vaze de um
 * lado pro outro. Também calcula Log Loss ao lado do Brier (item 34) — os
 * dois juntos formam o critério de "essa calibração generaliza de fato".
 */
export async function validacaoOutOfSample() {
  const todas = await lerEntradasCalibracao()
  const finalizadas = todas
    .filter(e => isAcerto(e.resultado) !== null && !ehEntradaTenis(e))
    .map(e => ({ ...e, _ts: dataDaEntrada(e) ?? 0 }))
    .sort((a, b) => a._ts - b._ts)

  if (finalizadas.length < OOS_MIN_TREINO + OOS_MIN_TESTE) {
    return {
      suficiente: false,
      totalTreino: 0,
      totalTeste: finalizadas.length,
      minimoTreino: OOS_MIN_TREINO,
      minimoTeste: OOS_MIN_TESTE,
      mensagem: `Histórico ainda pequeno pra validar fora da amostra (precisa de ${OOS_MIN_TREINO}+ no treino e ${OOS_MIN_TESTE}+ no teste; hoje: ${finalizadas.length} no total).`,
    }
  }

  const disponivel = finalizadas.length - OOS_MIN_TREINO
  const numFolds   = Math.max(1, Math.min(OOS_NUM_FOLDS, Math.floor(disponivel / OOS_MIN_TESTE)))
  const tamFold    = Math.floor(disponivel / numFolds)

  const porMercado      = {}
  const foldsResumo     = []
  const todosBrutos     = []
  const todosCalibrados = []
  const todosIsotonic   = []   // ✅ NOVO — item 35
  const todosPlatt      = []   // ✅ NOVO — item 35
  let totalCurvaAplicada = 0, totalForaDominio = 0   // ✅ NOVO — cobertura do domínio de treino

  for (let f = 0; f < numFolds; f++) {
    const inicioTeste = OOS_MIN_TREINO + f * tamFold
    const fimTeste     = (f === numFolds - 1) ? finalizadas.length : inicioTeste + tamFold
    const teste = finalizadas.slice(inicioTeste, fimTeste)
    if (teste.length < OOS_MIN_TESTE) continue

    // purge gap: tira do treino qualquer entrada muito próxima do início do teste
    const corteGap = teste[0]._ts - OOS_GAP_DIAS * MS_DIA
    const treino = finalizadas.slice(0, inicioTeste).filter(e => e._ts <= corteGap)
    if (treino.length < OOS_MIN_TREINO * 0.5) continue // gap comeu treino demais nesse fold

        const fatoresTreino = calcFatoresDeEntradas(treino)

    // ✅ NOVO — item 35: treina isotonic/Platt SÓ com o treino do fold (mesma
    // regra de não-vazamento do fator multiplicativo) e testa no teste do fold.
    // ✅ CORREÇÃO: só Gols 1.5/2.5/3.5 + BTTS de futebol, com pares espelho
    // (ver paresParaCurva), domínio de treino guardado e amostra mínima por técnica.
    // Se o treino do fold não atinge o mínimo, a técnica cai no fator — exatamente
    // o que a produção faria.
    const { pares: paresTreino, nReais: nTreinoCurva } = paresParaCurva(treino)
    const blocosIsotonic = fitIsotonic(paresTreino)
    const modeloPlatt    = fitPlatt(paresTreino)
    const isoLiberada    = nTreinoCurva >= CURVA_MIN_AMOSTRAS_ISOTONIC
    const plattLiberada  = nTreinoCurva >= CURVA_MIN_AMOSTRAS_PLATT

    const brutosFold = [], calibradosFold = [], isotonicFold = [], plattFold = []

        for (const e of teste) {
      const mercado = normalizarMercado(e.mercado)
      if (!mercado) continue
      const probBruta = extrairProbPrevista(e, mercado)
      if (probBruta == null) continue
      const acerto = isAcerto(e.resultado)
      const fator  = fatoresTreino[mercado] ?? 1.0
      // ✅ CORREÇÃO: mesmo clamp (12–88) e mesmo teto de movimento da produção
      // (antes: clamp 3–97 só na validação, o que a deixava diferente do que vai pro ar).
      const probCalibrada = limitarMovimento(probBruta, Math.min(88, Math.max(12, probBruta * fator)))
      // ✅ CORREÇÃO: mesmas proteções da produção (domínio, clamp 12–88, teto de movimento).
      // Mercado que a curva não cobre (Cartões, Escanteios...) ou técnica sem amostra
      // mínima → usa o fator, como na produção. Fora do domínio → valor bruto.
      const usaCurva = entradaServeParaCurva(e, mercado)
      let probIsotonic = probCalibrada, probPlatt = probCalibrada
      if (usaCurva) {
        if (isoLiberada) {
          const r = calibrarPorCurva('isotonic', blocosIsotonic, probBruta)
          probIsotonic = Math.round(r.pct * 10) / 10
          totalCurvaAplicada++; if (r.foraDominio) totalForaDominio++
        }
        if (plattLiberada) {
          const r = calibrarPorCurva('platt', modeloPlatt, probBruta)
          probPlatt = Math.round(r.pct * 10) / 10
        }
      }

      const itemBruto     = { probPct: probBruta, acerto }
      const itemCalibrado = { probPct: probCalibrada, acerto }
      const itemIsotonic  = { probPct: probIsotonic, acerto }
      const itemPlatt     = { probPct: probPlatt, acerto }
      brutosFold.push(itemBruto); todosBrutos.push(itemBruto)
      calibradosFold.push(itemCalibrado); todosCalibrados.push(itemCalibrado)
      isotonicFold.push(itemIsotonic); todosIsotonic.push(itemIsotonic)
      plattFold.push(itemPlatt); todosPlatt.push(itemPlatt)

      if (!porMercado[mercado]) porMercado[mercado] = { n: 0, brutos: [], calibrados: [] }
      porMercado[mercado].n++
      porMercado[mercado].brutos.push(itemBruto)
      porMercado[mercado].calibrados.push(itemCalibrado)
    }

    foldsResumo.push({
      fold: f + 1,
      totalTreino: treino.length,
      totalTeste: teste.length,
      brierBruto: brierDe(brutosFold),
      brierCalibrado: brierDe(calibradosFold),
      logLossBruto: logLossDe(brutosFold),
      logLossCalibrado: logLossDe(calibradosFold),
      brierIsotonic: brierDe(isotonicFold),
      logLossIsotonic: logLossDe(isotonicFold),
      brierPlatt: brierDe(plattFold),
      logLossPlatt: logLossDe(plattFold),
      eceBruto: eceDe(brutosFold),
      eceCalibrado: eceDe(calibradosFold),
      eceIsotonic: eceDe(isotonicFold),
      ecePlatt: eceDe(plattFold),
    })
  }

  if (!foldsResumo.length) {
    return {
      suficiente: false,
      totalTreino: 0,
      totalTeste: finalizadas.length,
      minimoTreino: OOS_MIN_TREINO,
      minimoTeste: OOS_MIN_TESTE,
      mensagem: 'Histórico não rendeu nenhuma janela válida depois do purge gap — precisa de mais dados recentes.',
    }
  }

    const brierBruto       = brierDe(todosBrutos)
  const brierCalibrado   = brierDe(todosCalibrados)
  const logLossBruto     = logLossDe(todosBrutos)
  const logLossCalibrado = logLossDe(todosCalibrados)
  const brierIsotonic    = brierDe(todosIsotonic)
  const logLossIsotonic  = logLossDe(todosIsotonic)
  const brierPlatt       = brierDe(todosPlatt)
  const logLossPlatt     = logLossDe(todosPlatt)
  const eceBruto         = eceDe(todosBrutos)
  const eceCalibrado     = eceDe(todosCalibrados)
  const eceIsotonic      = eceDe(todosIsotonic)
  const ecePlatt         = eceDe(todosPlatt)

  const mercados = Object.entries(porMercado)
    .filter(([, g]) => g.n >= 5)
    .map(([mercado, g]) => {
      const acertos = g.brutos.filter(x => x.acerto).length
      const ic = wilsonInterval(acertos, g.n)
      return {
        mercado, n: g.n,
        brierBruto: Math.round(brierDe(g.brutos) * 1000) / 1000,
        brierCalibrado: Math.round(brierDe(g.calibrados) * 1000) / 1000,
        logLossBruto: Math.round(logLossDe(g.brutos) * 1000) / 1000,
        logLossCalibrado: Math.round(logLossDe(g.calibrados) * 1000) / 1000,
        taxaRealPct: Math.round((acertos / g.n) * 1000) / 10,
        icBaixo: ic ? Math.round(ic.low * 1000) / 10 : null,
        icAlto:  ic ? Math.round(ic.high * 1000) / 10 : null,
      }
    })
    .sort((a, b) => b.n - a.n)

  // ✅ item 35: qual técnica de calibração generaliza melhor neste histórico —
  // decide por Log Loss (mais sensível a excesso de confiança que o Brier).
  // ✅ CORREÇÃO: isotonic/Platt só concorrem se (1) o histórico de Gols/BTTS atinge a
  // amostra mínima da técnica e (2) a curva treinada com TODO o histórico passa no
  // teste de estresse 5%–95% (não move nada > MAX_MOVIMENTO_CALIBRACAO_PP e é monótona).
  // Antes, a escolha olhava só a faixa das apostas escolhidas e aprovava curvas que
  // quebravam as probabilidades baixas.
  const { pares: paresTodos, nReais: nTodosCurva } = paresParaCurva(finalizadas)
  const curvaIsoFinal    = fitIsotonic(paresTodos)
  const curvaPlattFinal  = fitPlatt(paresTodos)
  const estresseIsotonic = testeEstresseCurva('isotonic', curvaIsoFinal)
  const estressePlatt    = testeEstresseCurva('platt', curvaPlattFinal)
  const isoElegivel   = nTodosCurva >= CURVA_MIN_AMOSTRAS_ISOTONIC && estresseIsotonic.ok
  const plattElegivel = nTodosCurva >= CURVA_MIN_AMOSTRAS_PLATT    && estressePlatt.ok
  const foraDominioPct = totalCurvaAplicada > 0
    ? Math.round((totalForaDominio / totalCurvaAplicada) * 1000) / 10
    : null

  const candidatas = [
    { nome: 'fator',    logLoss: logLossCalibrado, brier: brierCalibrado, ece: eceCalibrado },
    isoElegivel   ? { nome: 'isotonic', logLoss: logLossIsotonic, brier: brierIsotonic, ece: eceIsotonic } : null,
    plattElegivel ? { nome: 'platt',    logLoss: logLossPlatt,    brier: brierPlatt,    ece: ecePlatt }    : null,
  ].filter(c => c && c.logLoss != null)
  const melhorTecnicaValidada = candidatas.length
    ? candidatas.reduce((a, b) => (b.logLoss < a.logLoss ? b : a)).nome
    : null
  // O que realmente roda em produção: com a chave desligada é sempre o fator.
  const melhorTecnica = CALIBRACAO_CURVA_HABILITADA ? melhorTecnicaValidada : 'fator'

  const diagnosticoCurvas = {
    habilitada: CALIBRACAO_CURVA_HABILITADA,
    maxMovimentoPP: MAX_MOVIMENTO_CALIBRACAO_PP,
    amostrasGolsBtts: nTodosCurva,
    minimoIsotonic: CURVA_MIN_AMOSTRAS_ISOTONIC,
    minimoPlatt: CURVA_MIN_AMOSTRAS_PLATT,
    dominioTreino: curvaIsoFinal.min != null
      ? { minPct: Math.round(curvaIsoFinal.min * 1000) / 10, maxPct: Math.round(curvaIsoFinal.max * 1000) / 10 }
      : null,
    foraDominioPct,
    isotonic: { elegivel: isoElegivel,   estresse: estresseIsotonic },
    platt:    { elegivel: plattElegivel, estresse: estressePlatt },
  }

  return {
    suficiente: true,
    numFolds: foldsResumo.length,
    gapDias: OOS_GAP_DIAS,
    folds: foldsResumo,
    totalTreino: foldsResumo.reduce((s, f) => s + f.totalTreino, 0),
    totalTeste:  foldsResumo.reduce((s, f) => s + f.totalTeste, 0),
    brierBruto, brierCalibrado, brierIsotonic, brierPlatt,
    logLossBruto, logLossCalibrado, logLossIsotonic, logLossPlatt,
    eceBruto, eceCalibrado, eceIsotonic, ecePlatt,
    melhorou:        brierBruto != null && brierCalibrado != null && brierCalibrado < brierBruto,
    melhorouLogLoss: logLossBruto != null && logLossCalibrado != null && logLossCalibrado < logLossBruto,
    melhorTecnica, // 'fator' | 'isotonic' | 'platt' — a que roda em produção (flag-aware)
    melhorTecnicaValidada, // ✅ NOVO — vencedora do walk-forward entre as técnicas elegíveis
    diagnosticoCurvas,     // ✅ NOVO — amostra, domínio, % fora do domínio e teste de estresse
    mercados,
    geradoEm: new Date().toISOString(),
  }
}

// ✅ NOVO — Fase 3, item 12: backtesting automatizado como GATE antes de subir
// uma versão nova do motor (modelVersion.js). Não substitui validacaoOutOfSample
// (que testa se a CALIBRAÇÃO generaliza) — aqui o teste é "a versão que já está
// rodando pode virar produção estável, ou a próxima subida de versão está prestes
// a piorar as coisas?". Não há pipeline de CI aqui (é um app solo), então isso não
// bloqueia nada sozinho: é um relatório GO/NO-GO pra olhar ANTES de mudar o número
// em MOTOR_VERSAO_ATUAL (modelVersion.js).
const BACKTEST_MIN_AMOSTRAS   = 30     // mínimo de finalizados pra confiar nas métricas de uma versão
const BACKTEST_BRIER_NAIVE    = 0.25   // Brier de "sempre 50%" — piso de referência
const BACKTEST_PIORA_MAX      = 0.02   // quanto o Brier pode piorar vs a versão anterior antes de virar bloqueio
const BACKTEST_LOGLOSS_NAIVE  = 0.6931 // Log Loss de "sempre 50%" (-ln(0.5)) — piso de referência
const BACKTEST_LOGLOSS_PIORA_MAX = 0.05 // quanto o Log Loss pode piorar vs a versão anterior antes de virar bloqueio

function avaliarVersaoMotor(nome, porVersaoMotor) {
  const versoes = (porVersaoMotor || [])
    .filter(v => v.motorVersao !== 'sem versão (anterior ao versionamento)')
    .sort((a, b) => a.motorVersao.localeCompare(b.motorVersao, undefined, { numeric: true }))

  if (versoes.length === 0) {
    return { motor: nome, status: 'sem-dado', versaoAtual: null, n: 0, brier: null, logLoss: null, motivos: ['Nenhuma entrada com motorVersao registrada ainda — versionamento é recente, precisa acumular histórico.'] }
  }

  const atual    = versoes[versoes.length - 1]
  const anterior = versoes.length > 1 ? versoes[versoes.length - 2] : null
  const motivos  = []
  let ok = true

  if (atual.n < BACKTEST_MIN_AMOSTRAS) {
    ok = false
    motivos.push(`Versão ${atual.motorVersao} só tem ${atual.n} previsões finalizadas (mínimo ${BACKTEST_MIN_AMOSTRAS}) — métricas ainda não são confiáveis pra decidir nada.`)
  }
  if (atual.brierScore != null && atual.brierScore >= BACKTEST_BRIER_NAIVE) {
    ok = false
    motivos.push(`Brier da versão ${atual.motorVersao} (${atual.brierScore}) está pior ou igual ao naive de "sempre 50%" (${BACKTEST_BRIER_NAIVE}).`)
  }
  // ✅ NOVO — Fase 7, item 34: mesmo gate, agora também com Log Loss
  if (atual.logLoss != null && atual.logLoss >= BACKTEST_LOGLOSS_NAIVE) {
    ok = false
    motivos.push(`Log Loss da versão ${atual.motorVersao} (${atual.logLoss}) está pior ou igual ao naive de "sempre 50%" (${BACKTEST_LOGLOSS_NAIVE}).`)
  }
  if (anterior && atual.brierScore != null && anterior.brierScore != null) {
    const piora = atual.brierScore - anterior.brierScore
    if (piora > BACKTEST_PIORA_MAX) {
      ok = false
      motivos.push(`Brier piorou de ${anterior.brierScore} (${anterior.motorVersao}) para ${atual.brierScore} (${atual.motorVersao}) — variação de +${Math.round(piora * 1000) / 1000}, acima do limite de ${BACKTEST_PIORA_MAX}.`)
    }
  }
  if (anterior && atual.logLoss != null && anterior.logLoss != null) {
    const pioraLL = atual.logLoss - anterior.logLoss
    if (pioraLL > BACKTEST_LOGLOSS_PIORA_MAX) {
      ok = false
      motivos.push(`Log Loss piorou de ${anterior.logLoss} (${anterior.motorVersao}) para ${atual.logLoss} (${atual.motorVersao}) — variação de +${Math.round(pioraLL * 1000) / 1000}, acima do limite de ${BACKTEST_LOGLOSS_PIORA_MAX}.`)
    }
  }
  if (motivos.length === 0) {
    motivos.push(`Versão ${atual.motorVersao}: ${atual.n} amostras, Brier ${atual.brierScore} / Log Loss ${atual.logLoss}${anterior ? ` (vs ${anterior.brierScore} / ${anterior.logLoss} em ${anterior.motorVersao})` : ' (sem versão anterior pra comparar)'} — dentro do esperado.`)
  }

  return { motor: nome, status: ok ? 'ok' : 'bloqueado', versaoAtual: atual.motorVersao, n: atual.n, brier: atual.brierScore, logLoss: atual.logLoss, motivos }
}

/**
 * Checklist GO/NO-GO pra rodar ANTES de subir uma versão nova em modelVersion.js.
 * Junta: (1) Brier por versão de cada motor (futebol/tênis) — a versão mais
 * recente já validada não pode estar pior que a anterior nem pior que o naive;
 * (2) o resultado mais recente da validação out-of-sample (a calibração atual
 * generaliza?). Se `podeDeployar` vier false, tem motivo listado em `motivos`.
 */
export async function checklistPreDeploy() {
  const [futebol, tenis, oos] = await Promise.all([
    relatorioCalibracaoCompleto(),
    relatorioCalibracaoTenis(),
    validacaoOutOfSample(),
  ])

  const motores = [
    avaliarVersaoMotor('futebol', futebol.porVersaoMotor),
    avaliarVersaoMotor('tenis', tenis.porVersaoMotor),
  ]

  return {
    geradoEm: new Date().toISOString(),
    podeDeployar: motores.every(m => m.status !== 'bloqueado'),
    oos: {
      suficiente: oos.suficiente,
      melhorou: oos.suficiente ? oos.melhorou : null,
      melhorouLogLoss: oos.suficiente ? oos.melhorouLogLoss : null,
      brierBruto: oos.brierBruto,
      brierCalibrado: oos.brierCalibrado,
      logLossBruto: oos.logLossBruto,
      logLossCalibrado: oos.logLossCalibrado,
    },
    motores,
  }
}

// ═══════════════ ✅ NOVO — Fase 8, item 36: STACKING (Poisson × Histórico) ═══════════════
// Mesma lógica de segurança do walk-forward (Fase 7): aprende o peso ÓTIMO do
// blend só com o TREINO (passado), testa no TESTE (futuro que o treino nunca
// viu), e só confia se bater o heurístico atual (peso fixo por amostra) de
// forma consistente nos folds — senão fica nulo e o heurístico continua valendo.
const STACKING_PESO_HEURISTICO_PADRAO = 0.6 // valor default do blendSafe()
const STACKING_MIN_AMOSTRAS = 40

/** Melhor peso (grid 0–1, passo 0.05) pro Poisson no blend, minimizando Log Loss. */
function melhorPesoStacking(itens) {
  let melhorW = STACKING_PESO_HEURISTICO_PADRAO, melhorLL = Infinity
  for (let w = 0; w <= 1.0001; w += 0.05) {
    let soma = 0
    for (const { poisson, hist, acerto } of itens) {
      const p = Math.min(0.999, Math.max(0.001, (poisson * w + hist * (1 - w)) / 100))
      soma += acerto ? -Math.log(p) : -Math.log(1 - p)
    }
    const ll = soma / itens.length
    if (ll < melhorLL) { melhorLL = ll; melhorW = w }
  }
  return { peso: Math.round(melhorW * 100) / 100, logLoss: Math.round(melhorLL * 1000) / 1000 }
}

/** Log Loss do blend com um peso fixo (pra comparar aprendido × heurístico). */
function logLossComPeso(itens, w) {
  if (!itens.length) return null
  const soma = itens.reduce((s, { poisson, hist, acerto }) => {
    const p = Math.min(0.999, Math.max(0.001, (poisson * w + hist * (1 - w)) / 100))
    return s + (acerto ? -Math.log(p) : -Math.log(1 - p))
  }, 0)
  return soma / itens.length
}

/**
 * Walk-forward do peso de stacking do mercado `mercado` (hoje só 'Gols:Over 2.5',
 * que é o único que grava `over25_subModelos` no tracker). Mesmo purge gap e
 * mesmo número de folds da validação out-of-sample (OOS_GAP_DIAS/OOS_NUM_FOLDS).
 */
export async function validacaoStackingGols(mercado = 'Gols:Over 2.5') {
  const todas = await lerEntradasCalibracao()
  const finalizadas = todas
    .filter(e => normalizarMercado(e.mercado) === mercado && e.subModelos && isAcerto(e.resultado) !== null)
    .map(e => ({
      poisson: e.subModelos.poisson,
      hist: e.subModelos.hist,
      acerto: isAcerto(e.resultado),
      _ts: dataDaEntrada(e) ?? 0,
    }))
    .sort((a, b) => a._ts - b._ts)

  if (finalizadas.length < STACKING_MIN_AMOSTRAS) {
    return {
      suficiente: false,
      n: finalizadas.length,
      minimo: STACKING_MIN_AMOSTRAS,
      mensagem: `Ainda não há ${mercado} suficiente com sub-modelos gravados (precisa ${STACKING_MIN_AMOSTRAS}; hoje: ${finalizadas.length}). Isso só passa a crescer a partir de quando o over25_subModelos começar a ser salvo no tracker.`,
    }
  }

  const disponivel = finalizadas.length - Math.floor(STACKING_MIN_AMOSTRAS * 0.6)
  const numFolds = Math.max(1, Math.min(OOS_NUM_FOLDS, Math.floor(disponivel / (STACKING_MIN_AMOSTRAS * 0.4))))
  const tamFold  = Math.floor(disponivel / numFolds)
  const treinoMin = Math.floor(STACKING_MIN_AMOSTRAS * 0.6)

  const foldsResumo = []
  let somaPesoPonderado = 0, somaN = 0

  for (let f = 0; f < numFolds; f++) {
    const inicioTeste = treinoMin + f * tamFold
    const fimTeste     = (f === numFolds - 1) ? finalizadas.length : inicioTeste + tamFold
    const teste = finalizadas.slice(inicioTeste, fimTeste)
    if (teste.length < 5) continue

    const corteGap = teste[0]._ts - OOS_GAP_DIAS * MS_DIA
    const treino = finalizadas.slice(0, inicioTeste).filter(e => e._ts <= corteGap)
    if (treino.length < treinoMin * 0.5) continue

    const { peso } = melhorPesoStacking(treino)
    const llAprendido  = logLossComPeso(teste, peso)
    const llHeuristico = logLossComPeso(teste, STACKING_PESO_HEURISTICO_PADRAO)

    foldsResumo.push({
      fold: f + 1, totalTreino: treino.length, totalTeste: teste.length,
      pesoAprendido: peso,
      logLossAprendido: llAprendido != null ? Math.round(llAprendido * 1000) / 1000 : null,
      logLossHeuristico: llHeuristico != null ? Math.round(llHeuristico * 1000) / 1000 : null,
      melhorou: llAprendido != null && llHeuristico != null && llAprendido < llHeuristico,
    })
    somaPesoPonderado += peso * teste.length
    somaN += teste.length
  }

  if (!foldsResumo.length) {
    return { suficiente: false, n: finalizadas.length, minimo: STACKING_MIN_AMOSTRAS, mensagem: 'Nenhuma janela válida depois do purge gap.' }
  }

  const melhorouNaMaioria = foldsResumo.filter(f => f.melhorou).length >= Math.ceil(foldsResumo.length / 2)
  return {
    suficiente: true,
    mercado,
    numFolds: foldsResumo.length,
    folds: foldsResumo,
    pesoRecomendado: melhorouNaMaioria ? Math.round((somaPesoPonderado / somaN) * 100) / 100 : null,
    pesoHeuristicoPadrao: STACKING_PESO_HEURISTICO_PADRAO,
    confiavel: melhorouNaMaioria, // só usar em produção se bateu o heurístico na maioria dos folds
    geradoEm: new Date().toISOString(),
  }
}

// Cache curto (mesmo TTL do resto) — evita rodar o walk-forward a cada jogo analisado.
const STACKING_MERCADOS = ['Gols:Over 1.5', 'Gols:Over 2.5', 'Gols:Over 3.5', 'BTTS'] // ✅ NOVO — item 40
let _cachePesoStacking = null
let _cachePesoStackingExpiraEm = 0

/**
 * ✅ REVISADO — item 40: generaliza obterPesoStackingGols() (só Over 2.5) pros
 * 4 mercados de Gols que agora gravam subModelos no tracker. Devolve sempre
 * um objeto (pode vir vazio {}) — mercado sem peso confiável ainda simplesmente
 * não entra na chave; quem consome usa `?? wP` (heurístico) como fallback.
 */
export async function obterPesosStackingGols() {
  const agora = Date.now()
  if (_cachePesoStacking && agora < _cachePesoStackingExpiraEm) return _cachePesoStacking
  const pesos = {}
  for (const mercado of STACKING_MERCADOS) {
    try {
      const r = await validacaoStackingGols(mercado)
      if (r.suficiente && r.confiavel) pesos[mercado] = r.pesoRecomendado
    } catch (e) {
      console.warn(`[Stacking] falha em ${mercado}, usando heurístico:`, e.message)
    }
  }
  _cachePesoStacking = pesos
  _cachePesoStackingExpiraEm = agora + CACHE_TTL_MS
  return _cachePesoStacking
}

// ═══════════════ ✅ NOVO — STACKING DO 1X2 (Forma / H2H / ELO) ═══════════════
// Mesma lógica de segurança do stacking de Gols (walk-forward, purge gap, só
// confia se bater o heurístico na maioria dos folds), mas aprende 3 pesos que
// somam 1. Treina com as entradas "Vitória Mandante/Visitante" que gravaram
// subModelos {forma, h2h, elo} (prob. 3-vias de cada fonte isolada, no lado
// apostado) e já foram liquidadas em green/red.
const STACKING_1X2_PESOS_PADRAO = { forma: 0.55, h2h: 0.20, elo: 0.25 } // blend fixo atual
const STACKING_1X2_MIN_AMOSTRAS = 40

function ehEntrada1x2(e) {
  return !ehEntradaTenis(e) && /vitoria\s+(mandante|visitante)/.test(semAcento(e?.mercado))
}

// ✅ NOVO — item 34: Ranked Probability Score pro 1X2. Diferente do Log
// Loss/Brier tratados aqui como binário ("acertei o lado que apostei"),
// o RPS usa as 3 probabilidades do jogo (mandante/empate/visitante) JUNTAS
// contra o placar real — penaliza mais um erro "longe" (prever vitória
// mandante e sair vitória visitante) do que um erro "perto" (prever vitória
// mandante e sair empate), porque empate é o resultado intermediário entre
// os dois. Usa o placarFinal (sempre gravado, independente de qual lado foi
// apostado) pra saber o resultado real — não depende do green/red da aposta.
function extrairPlacar(placarFinal) {
  const m = /^(\d+)-(\d+)$/.exec(String(placarFinal ?? '').trim())
  if (!m) return null
  return { golsMandante: parseInt(m[1], 10), golsVisitante: parseInt(m[2], 10) }
}

function entradasParaRPS(entradas) {
  return entradas
    .filter(e => ehEntrada1x2(e) && typeof e.probMandante === 'number' && typeof e.probEmpate === 'number' && typeof e.probVisitante === 'number')
    .map(e => {
      const p = extrairPlacar(e.placarFinal)
      if (!p) return null
      const outcome = p.golsMandante > p.golsVisitante ? 'M' : p.golsMandante < p.golsVisitante ? 'V' : 'E'
      return { probMandante: e.probMandante, probEmpate: e.probEmpate, probVisitante: e.probVisitante, outcome }
    })
    .filter(Boolean)
}

function rpsDe(itens) {
  if (!itens.length) return null
  const soma = itens.reduce((s, it) => {
    const pM = it.probMandante / 100
    const pE = it.probEmpate   / 100
    const obsM = it.outcome === 'M' ? 1 : 0
    const obsE = it.outcome === 'E' ? 1 : 0
    const cumPred1 = pM,        cumPred2 = pM + pE
    const cumObs1  = obsM,      cumObs2  = obsM + obsE
    return s + 0.5 * (Math.pow(cumPred1 - cumObs1, 2) + Math.pow(cumPred2 - cumObs2, 2))
  }, 0)
  return parseFloat((soma / itens.length).toFixed(4))
}

function logLoss1x2(itens, w) {
  if (!itens.length) return null
  const soma = itens.reduce((s, { sub, acerto }) => {
    const p = Math.min(0.999, Math.max(0.001, (w.forma * sub.forma + w.h2h * sub.h2h + w.elo * sub.elo) / 100))
    return s + (acerto ? -Math.log(p) : -Math.log(1 - p))
  }, 0)
  return soma / itens.length
}

/** Melhor trio de pesos (grid de 0.05 no simplex) minimizando Log Loss. */
function melhorPesos1x2(itens) {
  let melhor = { ...STACKING_1X2_PESOS_PADRAO }, melhorLL = Infinity
  for (let i = 0; i <= 20; i++) {
    for (let j = 0; j <= 20 - i; j++) {
      const w = { forma: i / 20, h2h: j / 20, elo: (20 - i - j) / 20 }
      const ll = logLoss1x2(itens, w)
      if (ll < melhorLL) { melhorLL = ll; melhor = w }
    }
  }
  return melhor
}

export async function validacaoStacking1x2() {
  const todas = await lerEntradasCalibracao()
  const finalizadas = todas
    .filter(e => ehEntrada1x2(e) && isAcerto(e.resultado) !== null
      && ['forma', 'h2h', 'elo'].every(k => typeof e.subModelos?.[k] === 'number'))
    .map(e => ({ sub: e.subModelos, acerto: isAcerto(e.resultado), _ts: dataDaEntrada(e) ?? 0 }))
    .sort((a, b) => a._ts - b._ts)

  if (finalizadas.length < STACKING_1X2_MIN_AMOSTRAS) {
    return {
      suficiente: false,
      n: finalizadas.length,
      minimo: STACKING_1X2_MIN_AMOSTRAS,
      mensagem: `Ainda não há 1X2 suficiente com sub-modelos e green/red (precisa ${STACKING_1X2_MIN_AMOSTRAS}; hoje: ${finalizadas.length}). Só entram jogos com H2H válido.`,
    }
  }

  const treinoMin  = Math.floor(STACKING_1X2_MIN_AMOSTRAS * 0.6)
  const disponivel = finalizadas.length - treinoMin
  const numFolds   = Math.max(1, Math.min(OOS_NUM_FOLDS, Math.floor(disponivel / (STACKING_1X2_MIN_AMOSTRAS * 0.4))))
  const tamFold    = Math.floor(disponivel / numFolds)

  const folds = []
  const acc = { forma: 0, h2h: 0, elo: 0 }
  let somaN = 0

  for (let f = 0; f < numFolds; f++) {
    const inicioTeste = treinoMin + f * tamFold
    const fimTeste    = (f === numFolds - 1) ? finalizadas.length : inicioTeste + tamFold
    const teste = finalizadas.slice(inicioTeste, fimTeste)
    if (teste.length < 5) continue

    const corteGap = teste[0]._ts - OOS_GAP_DIAS * MS_DIA
    const treino = finalizadas.slice(0, inicioTeste).filter(e => e._ts <= corteGap)
    if (treino.length < treinoMin * 0.5) continue

    const pesos = melhorPesos1x2(treino)
    const llAprendido  = logLoss1x2(teste, pesos)
    const llHeuristico = logLoss1x2(teste, STACKING_1X2_PESOS_PADRAO)

    folds.push({
      fold: f + 1, totalTreino: treino.length, totalTeste: teste.length, pesosAprendidos: pesos,
      logLossAprendido:  llAprendido  != null ? Math.round(llAprendido  * 1000) / 1000 : null,
      logLossHeuristico: llHeuristico != null ? Math.round(llHeuristico * 1000) / 1000 : null,
      melhorou: llAprendido != null && llHeuristico != null && llAprendido < llHeuristico,
    })
    for (const k of Object.keys(acc)) acc[k] += pesos[k] * teste.length
    somaN += teste.length
  }

  if (!folds.length) {
    return { suficiente: false, n: finalizadas.length, minimo: STACKING_1X2_MIN_AMOSTRAS, mensagem: 'Nenhuma janela válida depois do purge gap.' }
  }

  const melhorouNaMaioria = folds.filter(f => f.melhorou).length >= Math.ceil(folds.length / 2)
  const forma = Math.round((acc.forma / somaN) * 100) / 100
  const h2h   = Math.round((acc.h2h   / somaN) * 100) / 100
  const elo   = Math.max(0, Math.round((1 - forma - h2h) * 100) / 100)

  // ✅ NOVO — item 34: RPS calculado à parte (não depende de sub-modelos —
  // só das 3 probabilidades + placar real), então usa TODAS as entradas
  // disponíveis, não só as que entraram no walk-forward acima.
  const rps = rpsDe(entradasParaRPS(todas))

  return {
    suficiente: true,
    mercado: '1X2',
    numFolds: folds.length,
    folds,
    pesoRecomendado: melhorouNaMaioria ? { forma, h2h, elo } : null,
    pesoHeuristicoPadrao: STACKING_1X2_PESOS_PADRAO,
    confiavel: melhorouNaMaioria, // só usar em produção se bateu o heurístico na maioria dos folds
    rps, // ✅ NOVO — quanto menor, melhor; null se ainda não tem entrada com placar + 3 probs
    geradoEm: new Date().toISOString(),
  }
}

// Cache curto (mesmo TTL do resto) — evita rodar o walk-forward a cada jogo analisado.
let _cachePesos1x2 = undefined
let _cachePesos1x2ExpiraEm = 0

/** {forma, h2h, elo} se o walk-forward confia; null → groqService segue com o blend fixo 55/20/25. */
export async function obterPesosStacking1x2() {
  const agora = Date.now()
  if (_cachePesos1x2 !== undefined && agora < _cachePesos1x2ExpiraEm) return _cachePesos1x2
  let pesos = null
  try {
    const r = await validacaoStacking1x2()
    if (r.suficiente && r.confiavel) pesos = r.pesoRecomendado
  } catch (e) {
    console.warn('[Stacking 1X2] falha, usando heurístico:', e.message)
  }
  _cachePesos1x2 = pesos
  _cachePesos1x2ExpiraEm = agora + CACHE_TTL_MS
  return pesos
}


// ═══════════════ ✅ NOVO — Fase 8, item 39: CALIBRAÇÃO EM PRODUÇÃO ═══════════════
// Fecha o loop do item 35: validacaoOutOfSample() já mede, com walk-forward
// (sem vazamento), se isotonic/Platt batem o fator multiplicativo. Aqui é só
// o "liga o interruptor": se bateu, treina a curva com o histórico INTEIRO
// (agora sim pode — não é mais o teste, é a aplicação) e passa a usar ela
// em vez do fator. Se não bateu (ou não tem dado suficiente), continua no
// fator de sempre — o padrão nunca fica pior do que já era.
let _cacheCurvaProducao = null
let _cacheCurvaProducaoExpiraEm = 0

/** Treina isotonic + Platt com TODO o histórico de Gols 1.5/2.5/3.5 + BTTS de futebol
 *  (pooled entre esses mercados: pouco dado por mercado isolado pra uma curva decente).
 *  ✅ CORREÇÃO: antes entrava TUDO (inclusive Cartões/Escanteios, com taxas de acerto
 *  bem mais altas) e só as apostas escolhidas (> 50%). Agora: só mercados de Gols/BTTS,
 *  com pares espelho pra cobrir as probabilidades baixas, e o domínio é guardado. */
async function treinarCurvaProducao() {
  const todas = await lerEntradasCalibracao()
  const { pares, nReais } = paresParaCurva(todas)
  if (nReais < OOS_MIN_TREINO) return null
  return { isotonic: fitIsotonic(pares), platt: fitPlatt(pares), n: nReais }
}

/** Decide (com cache curto) qual técnica usar em produção.
 *  ✅ CORREÇÃO: com CALIBRACAO_CURVA_HABILITADA = false (padrão) é SEMPRE o fator.
 *  Ligada, a curva só entra se: o walk-forward a elegeu, há amostra mínima da técnica
 *  e o teste de estresse 5%–95% passou. Qualquer falha → fator. */
export async function obterCalibracaoProducao() {
  const agora = Date.now()
  if (_cacheCurvaProducao && agora < _cacheCurvaProducaoExpiraEm) return _cacheCurvaProducao

  let resultado = { tecnica: 'fator' } // default seguro — nunca muda sozinho pra pior
  if (CALIBRACAO_CURVA_HABILITADA) {
    try {
      const oos = await validacaoOutOfSample()
      if (oos.suficiente && (oos.melhorTecnica === 'isotonic' || oos.melhorTecnica === 'platt')) {
        const curva = await treinarCurvaProducao()
        const minimo = oos.melhorTecnica === 'isotonic' ? CURVA_MIN_AMOSTRAS_ISOTONIC : CURVA_MIN_AMOSTRAS_PLATT
        if (curva && curva.n >= minimo) {
          const estresse = testeEstresseCurva(oos.melhorTecnica, curva[oos.melhorTecnica])
          if (estresse.ok) resultado = { tecnica: oos.melhorTecnica, curva }
          else console.warn(`[Calibration] curva ${oos.melhorTecnica} reprovada no teste de estresse (${estresse.motivo}) — usando fator.`)
        }
      }
    } catch (e) {
      console.warn('[Calibration] falha ao decidir técnica de produção, usando fator:', e.message)
    }
  }

  _cacheCurvaProducao = resultado
  _cacheCurvaProducaoExpiraEm = agora + CACHE_TTL_MS
  return resultado
}

/** Aplica a curva isotonic/Platt nos mesmos campos que aplicarCalibration() calibra.
 *  ✅ CORREÇÃO: (1) fora do domínio de treino devolve o valor BRUTO; (2) clamp 12–88 e teto
 *  de movimento (calibrarPorCurva); (3) Over e Under de cada linha são calibrados cada um
 *  pela sua prob. e depois rebalanceados pra somar 100 — antes só o Over era calibrado e o
 *  Under virava 100 − Over, então um Over errado destruía o Under. */
function aplicarCurvaProducao(probs, calibracaoProducao) {
  const { tecnica, curva } = calibracaoProducao
  const modelo = tecnica === 'isotonic' ? curva.isotonic : curva.platt
  const aplicar = (valor) => {
    if (valor == null || Number.isNaN(valor)) return valor
    return calibrarPorCurva(tecnica, modelo, valor).pct
  }
  const rebalancear = (o, u) => {
    if (o == null || u == null) return [o, u]
    const soma = o + u
    if (soma <= 0) return [o, u]
    const oNorm = Math.round((o / soma) * 100)
    return [oNorm, 100 - oNorm]
  }
  const [over15, under15] = rebalancear(aplicar(probs.over15), aplicar(probs.under15))
  const [over25, under25] = rebalancear(aplicar(probs.over25), aplicar(probs.under25))
  const [over35, under35] = rebalancear(aplicar(probs.over35), aplicar(probs.under35))
  return normalizarParesOverUnder({
    ...probs,
    over15, under15, over25, under25, over35, under35,
    btts: aplicar(probs.btts),
  })
}

/** ✅ NOVO — TRAVA DE SEGURANÇA final, vale pros dois caminhos (fator e curva).
 *  Compara cada probabilidade calibrada com a BRUTA e, se algo estiver fora do razoável,
 *  registra um aviso e usa a bruta:
 *   1) desvio > MAX_MOVIMENTO_CALIBRACAO_PP (+ folga de arredondamento) → par Over/Under volta pra bruta;
 *   2) linhas incoerentes (Over 1.5 ≥ Over 2.5 ≥ Over 3.5 violado) → tudo volta pra bruta;
 *   3) Over + Under ≠ 100 → reforça o espelho.
 *  Devolve as probs + `calibracaoAlertas` (lista de avisos) + `calibracaoTecnica`. */
function travaSeguranca(brutas, calibradas, tecnica) {
  const alertas = []
  const limite = MAX_MOVIMENTO_CALIBRACAO_PP + TOLERANCIA_TRAVA_PP
  let out = { ...calibradas }

  const PARES = [['over15', 'under15'], ['over25', 'under25'], ['over35', 'under35']]
  const num = v => typeof v === 'number' && !Number.isNaN(v)
  const reverterPar = (par) => { par.forEach(k => { if (num(brutas[k])) out[k] = brutas[k] }) }

  // 1) desvio grande demais vs. bruta
  for (const par of PARES) {
    const estoura = par.some(k => num(brutas[k]) && num(out[k]) && Math.abs(out[k] - brutas[k]) > limite)
    if (estoura) {
      alertas.push(`${par[0].replace('over', 'Over ')}: calibrada (${out[par[0]]}%) distante da bruta (${brutas[par[0]]}%) — usando a bruta`)
      reverterPar(par)
    }
  }
  if (num(brutas.btts) && num(out.btts) && Math.abs(out.btts - brutas.btts) > limite) {
    alertas.push(`BTTS: calibrada (${out.btts}%) distante da bruta (${brutas.btts}%) — usando a bruta`)
    out.btts = brutas.btts
  }

  // 3) espelho Over + Under = 100 (antes da checagem de linhas, que usa só os Over)
  out = normalizarParesOverUnder(out)

  // 2) coerência entre linhas: Over 1.5 ≥ Over 2.5 ≥ Over 3.5
  const { over15, over25, over35 } = out
  if (num(over15) && num(over25) && num(over35) && !(over15 >= over25 && over25 >= over35)) {
    alertas.push(`linhas incoerentes após calibração (Over 1.5=${over15}%, 2.5=${over25}%, 3.5=${over35}%) — usando as brutas`)
    PARES.forEach(reverterPar)
    out = normalizarParesOverUnder(out)
  }

  if (alertas.length) console.warn(`[Calibration/trava] técnica=${tecnica}:`, alertas.join(' | '))
  return { ...out, calibracaoAlertas: alertas, calibracaoTecnica: tecnica }
}

/**
 * ✅ NOVO — item 39: ponto único de entrada da calibração em produção.
 * Substitui a chamada direta a aplicarCalibration() no groqService — troca
 * sozinha entre fator (padrão) e isotonic/Platt (só se CALIBRACAO_CURVA_HABILITADA
 * e a validação aprovar). `fatoresCalib` continua sendo passado/usado mesmo quando a
 * técnica ativa é isotonic/Platt, porque o ranking e o texto de calibração
 * (notaCalib) ainda dependem dele.
 * ✅ CORREÇÃO: o resultado de QUALQUER técnica passa pela trava de segurança.
 */
export async function aplicarMelhorCalibracao(probs, fatoresCalib) {
  const producao = await obterCalibracaoProducao()
  const calibradas = producao.tecnica === 'fator'
    ? aplicarCalibration(probs, fatoresCalib)
    : aplicarCurvaProducao(probs, producao)
  return travaSeguranca(probs, calibradas, producao.tecnica)
}

export async function resumoCalibration() {
  const fatores  = await calcFatoresCalibration()
  const entradas = await lerEntradasCalibracao()
  const finalizados = entradas.filter(e => isAcerto(e.resultado) !== null)
  return {
    totalEntradas: entradas.length,
    totalFinalizados: finalizados.length,
    fatores,
    mercadosCalibrados: Object.entries(fatores).filter(([k, f]) => !k.startsWith('_n_') && f !== 1.0).map(([k, v]) => ({ mercado: k, fator: v })),
  }
}

/**
 * ✅ NOVO — Fase 1, item 4: agrupa entradas finalizadas por VERSÃO DO MOTOR
 * que gerou a previsão (campo `motorVersao`, gravado desde que o
 * versionamento foi introduzido — entradas anteriores a isso não têm o
 * campo e caem em 'sem versão (anterior ao versionamento)').
 * Serve pra responder "essa queda de acerto foi uma mudança de lógica do
 * motor ou só ruído de amostra?" — comparando greens/reds/Brier entre
 * versões em vez de misturar tudo numa métrica só. Base pras Fases 4 e 7
 * (drift, backtesting por versão).
 */
function agruparPorVersaoMotor(itens) {
  const EPS = 1e-6
  const porVersao = {}
  for (const it of itens) {
    const versao = it.motorVersao || 'sem versão (anterior ao versionamento)'
    if (!porVersao[versao]) porVersao[versao] = { n: 0, greens: 0, reds: 0, somaProb: 0, somaBrier: 0, somaLogLoss: 0 }
    const g = porVersao[versao]
    g.n++
    g.somaProb += it.prob
    if (it.acerto) g.greens++
    else g.reds++
    g.somaBrier += (it.prob / 100 - (it.acerto ? 1 : 0)) ** 2
    // ✅ NOVO — Fase 7, item 34: Log Loss ao lado do Brier, por versão do motor
    const p = Math.min(1 - EPS, Math.max(EPS, it.prob / 100))
    g.somaLogLoss += it.acerto ? -Math.log(p) : -Math.log(1 - p)
  }
  return Object.entries(porVersao)
    .map(([motorVersao, g]) => ({
      motorVersao,
      n: g.n,
      greens: g.greens,
      reds: g.reds,
      previsto: Math.round((g.somaProb / g.n) * 10) / 10,
      real: Math.round((g.greens / g.n) * 1000) / 10,
      brierScore: Math.round((g.somaBrier / g.n) * 1000) / 1000,
      logLoss: Math.round((g.somaLogLoss / g.n) * 1000) / 1000,
    }))
    .sort((a, b) => b.n - a.n)
}

// ═══════ ✅ NOVO — Fase 4: MONITORAMENTO DE DRIFT ═══════
// Compara a taxa de acerto da JANELA ROLANTE mais recente (últimas 30
// entradas finalizadas) contra o histórico anterior a essa janela, usando o
// IC de Wilson da própria janela pra separar queda real de ruído de amostra
// pequena. Roda geral e por versão do motor (mesmo agrupamento de
// `agruparPorVersaoMotor`, mas comparando janela × histórico em vez de
// previsto × real).
const JANELA_DRIFT = 30
const MIN_PARA_COMPARAR_DRIFT = JANELA_DRIFT + 10 // exige histórico anterior à janela com tamanho razoável

function calcularDrift(itens) {
  if (itens.length < MIN_PARA_COMPARAR_DRIFT) return null

  const ordenados = [...itens].sort((a, b) => new Date(a.criadoEm || 0) - new Date(b.criadoEm || 0))
  const janela = ordenados.slice(-JANELA_DRIFT)
  const historico = ordenados.slice(0, -JANELA_DRIFT)

  const acertosJanela = janela.filter(i => i.acerto).length
  const taxaJanela = acertosJanela / janela.length
  const taxaHistorico = historico.filter(i => i.acerto).length / historico.length

  const ic = wilsonInterval(acertosJanela, janela.length)
  // histórico acima do teto do IC da janela recente = queda real, não ruído
  const alerta = ic ? taxaHistorico > ic.high : false

  return {
    n: janela.length,
    nHistorico: historico.length,
    taxaJanela: Math.round(taxaJanela * 1000) / 10,
    taxaHistorico: Math.round(taxaHistorico * 1000) / 10,
    icBaixo: ic ? Math.round(ic.low * 1000) / 10 : null,
    icAlto: ic ? Math.round(ic.high * 1000) / 10 : null,
    status: alerta ? 'drift' : 'estável',
  }
}

/**
 * ✅ NOVO — Fase 4: relatório de drift pro painel — geral + por versão do
 * motor. `geral` ou uma entrada de `porVersaoMotor` vêm `null` quando ainda
 * não há amostra suficiente (histórico curto) pra comparar com confiança.
 */
export async function relatorioDrift() {
  const entradas = await lerEntradasCalibracao()
  const finalizados = entradas
    .map(e => ({ ...e, acerto: isAcerto(e.resultado), criadoEm: e.criadoEm || e.marcadoEm }))
    .filter(e => e.acerto !== null)

  const porVersao = {}
  for (const it of finalizados) {
    const v = it.motorVersao || 'sem versão (anterior ao versionamento)'
    ;(porVersao[v] ||= []).push(it)
  }

  return {
    geral: calcularDrift(finalizados),
    porVersaoMotor: Object.entries(porVersao)
      .map(([motorVersao, itens]) => ({ motorVersao, drift: calcularDrift(itens) }))
      .filter(x => x.drift !== null),
    geradoEm: new Date().toISOString(),
  }
}


// ═══════ ✅ NOVO — Fase 7, item 41: DRIFT NA DISTRIBUIÇÃO DAS FEATURES ═══════
// O drift da Fase 4 (calcularDrift, acima) só olha a TAXA DE ACERTO — isso
// avisa DEPOIS que a performance já caiu. Aqui comparamos a distribuição de
// uma feature NUMÉRICA (não o resultado) entre a janela recente e o
// histórico, pra pegar o sinal mais cedo — ex.: uma liga passa a ter mais
// gols na 2ª metade da temporada, e isso já empurra o modelo antes da taxa
// de acerto cair de forma visível.
function calcularDriftFeature(itens, extrator, janela = JANELA_DRIFT) {
  const ordenados = [...itens].sort((a, b) => new Date(a.criadoEm || 0) - new Date(b.criadoEm || 0))
  const valores = ordenados.map(extrator).filter(v => v != null && Number.isFinite(v))
  if (valores.length < janela + 10) return null

  const janelaVals    = valores.slice(-janela)
  const historicoVals = valores.slice(0, -janela)
  const media  = arr => arr.reduce((s, v) => s + v, 0) / arr.length
  const desvio = (arr, m) => Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, arr.length - 1))

  const mediaJanela     = media(janelaVals)
  const mediaHistorico  = media(historicoVals)
  const desvioHistorico = desvio(historicoVals, mediaHistorico)
  const erroPadrao      = desvioHistorico / Math.sqrt(janelaVals.length)
  const zScore = erroPadrao > 0 ? (mediaJanela - mediaHistorico) / erroPadrao : 0
  const alerta = Math.abs(zScore) >= 2 // ~95% de confiança de que não é só ruído de amostra

  return {
    n: janelaVals.length,
    nHistorico: historicoVals.length,
    mediaJanela:    Math.round(mediaJanela * 1000) / 1000,
    mediaHistorico: Math.round(mediaHistorico * 1000) / 1000,
    zScore: Math.round(zScore * 100) / 100,
    status: alerta ? 'drift' : 'estável',
  }
}

/** ✅ NOVO — Fase 7, item 41: drift de features por liga, usando os campos
 *  que já são salvos em CADA entrada do tracker (sem precisar de coleta
 *  nova):
 *   • lambdaEsperado — proxy direto de "a liga está saindo mais/menos
 *     ofensiva do que o histórico" (gols esperados que o motor calculou).
 *   • odd → probabilidade implícita — proxy de "o mercado está precificando
 *     os jogos diferente do que precificava antes".
 *  Roda só no mercado "Gols" pra manter as unidades comparáveis entre
 *  entradas do mesmo tipo. */
export async function relatorioDriftFeatures() {
  const entradas = await lerEntradasCalibracao()
  const gols = entradas.filter(e => e.mercado === 'Gols' && !ehEntradaTenis(e))

  const porLiga = {}
  for (const e of gols) { (porLiga[e.liga || 'Outro'] ||= []).push(e) }

  const porLigaResultado = Object.entries(porLiga)
    .map(([liga, itens]) => ({
      liga,
      lambdaEsperado: calcularDriftFeature(itens, e => e.lambdaEsperado),
      oddImplicita:   calcularDriftFeature(itens, e => (e.odd && e.odd > 1) ? 1 / e.odd : null),
    }))
    .filter(x => x.lambdaEsperado || x.oddImplicita)

  return { porLiga: porLigaResultado, geradoEm: new Date().toISOString() }
}
/**
 * Relatório previsto × real para o painel de calibração.
 * Usa entradas finalizadas (green/red) do Tracker.
 */
export async function relatorioCalibracaoCompleto() {
  const entradas = await lerEntradasCalibracao()
  const finalizados = []

  for (const e of entradas) {
    const acerto = isAcerto(e.resultado)
    if (acerto === null) continue
        if (ehEntradaTenis(e)) continue // tênis tem relatório próprio: relatorioCalibracaoTenis()
    const mercado = normalizarMercado(e.mercado)
    if (!mercado) continue
    const prob = extrairProbPrevista(e, mercado)
    
    finalizados.push({
      mercado,
      prob,
      acerto,
      mandante: e.mandante,
      visitante: e.visitante,
      criadoEm: e.criadoEm || e.marcadoEm,
      motorVersao: e.motorVersao || null, // ✅ NOVO — Fase 1, item 4
      liga: e.liga || null, // ✅ NOVO — Fase 7, item 40
    })
  }

  const fatores = await calcFatoresCalibration()

  // Por mercado
  const porMercado = {}
  MERCADOS_ALVO.forEach(m => {
    porMercado[m] = { n: 0, acertos: 0, somaProb: 0, greens: 0, reds: 0 }
  })
  for (const f of finalizados) {
    if (!porMercado[f.mercado]) continue
    porMercado[f.mercado].n++
    porMercado[f.mercado].somaProb += f.prob
    if (f.acerto) { porMercado[f.mercado].acertos++; porMercado[f.mercado].greens++ }
    else porMercado[f.mercado].reds++
  }

  const mercados = Object.entries(porMercado)
    .filter(([, g]) => g.n > 0)
    .map(([mercado, g]) => {
      const previsto = g.somaProb / g.n
      const real = (g.acertos / g.n) * 100
      const erro = real - previsto // positivo = modelo subestimou
      const ic = wilsonInterval(g.acertos, g.n) // ✅ NOVO — Fase 3, item 11
      const dentroDoIC = ic ? (previsto / 100) >= ic.low && (previsto / 100) <= ic.high : false
      return {
        mercado,
        n: g.n,
        greens: g.greens,
        reds: g.reds,
        previsto: Math.round(previsto * 10) / 10,
        real: Math.round(real * 10) / 10,
        erro: Math.round(erro * 10) / 10,
        icBaixo: ic ? Math.round(ic.low * 1000) / 10 : null,
        icAlto:  ic ? Math.round(ic.high * 1000) / 10 : null,
        fator: fatores[mercado] ?? 1,
        // ✅ REVISADO — Fase 3, item 11: "calibrado" agora é "previsto cai dentro
        // do IC de Wilson da taxa real", não mais um ±5pp fixo (que classificava
        // errado amostras pequenas como desviadas quando era só ruído).
        status: g.n < 5 ? 'poucos dados'
          : dentroDoIC ? 'calibrado'
          : erro > 5 ? 'subestima'
          : 'superestima',
      }
    })
    .sort((a, b) => b.n - a.n)

  // Por faixa de probabilidade prevista — ✅ REVISADO Fase 7, item 40:
  // agora reutilizável por subconjunto, pra segmentar por mercado e por liga.
  const FAIXAS_DEF = [
    { id: '50-58', min: 50, max: 58 },
    { id: '58-65', min: 58, max: 65 },
    { id: '65-72', min: 65, max: 72 },
    { id: '72-80', min: 72, max: 80 },
    { id: '80+',   min: 80, max: 101 },
  ]
  const MIN_N_SEGMENTO = 15 // abaixo disso, o segmento nem entra na lista

  function calcularFaixas(subset) {
    return FAIXAS_DEF.map(fx => {
      const sub = subset.filter(f => f.prob >= fx.min && f.prob < fx.max)
      if (!sub.length) return { faixa: fx.id, n: 0, previsto: null, real: null, erro: null }
      const previsto = sub.reduce((s, f) => s + f.prob, 0) / sub.length
      const real = (sub.filter(f => f.acerto).length / sub.length) * 100
      return {
        faixa: fx.id,
        n: sub.length,
        previsto: Math.round(previsto * 10) / 10,
        real: Math.round(real * 10) / 10,
        erro: Math.round((real - previsto) * 10) / 10,
      }
    })
  }

  const faixas = calcularFaixas(finalizados) // global — mantido

  const faixasPorMercado = {}
  for (const mercado of new Set(finalizados.map(f => f.mercado))) {
    const subset = finalizados.filter(f => f.mercado === mercado)
    if (subset.length >= MIN_N_SEGMENTO) faixasPorMercado[mercado] = calcularFaixas(subset)
  }

  const faixasPorLiga = {}
  for (const liga of new Set(finalizados.map(f => f.liga).filter(Boolean))) {
    const subset = finalizados.filter(f => f.liga === liga)
    if (subset.length >= MIN_N_SEGMENTO) faixasPorLiga[liga] = calcularFaixas(subset)
  }

  const total = finalizados.length
  const acertosTotal = finalizados.filter(f => f.acerto).length
  const taxaGeral = total ? Math.round((acertosTotal / total) * 1000) / 10 : null
  const brier = total
    ? finalizados.reduce((s, f) => {
        const p = f.prob / 100
        const o = f.acerto ? 1 : 0
        return s + (p - o) ** 2
      }, 0) / total
    : null

  return {
    totalFinalizados: total,
    arquivadas: _cacheArquivo.length, // green/red de antes do "Zerar histórico" (já incluídos no total acima)
    taxaAcertoGeral: taxaGeral,
    brierScore: brier != null ? Math.round(brier * 1000) / 1000 : null, // menor = melhor (0 = perfeito)
    mercados,
    faixas,
    faixasPorMercado, // ✅ NOVO — Fase 7, item 40
    faixasPorLiga,     // ✅ NOVO — Fase 7, item 40
    fatores,
    // ✅ NOVO — Fase 1, item 4: acerto/Brier separado por versão do motor
    porVersaoMotor: agruparPorVersaoMotor(finalizados),
    geradoEm: new Date().toISOString(),
  }
}

/**
 * ✅ NOVO — Relatório unificado por CONTEXTO (esporte, clima, altitude, liga),
 * cobrindo TODOS os esportes salvos no tracker — não só os mercados de gols/
 * cartões/escanteios do futebol que `relatorioCalibracaoCompleto` cobre.
 * Serve pra responder "onde eu erro e por quê" de forma cruzada — ex.:
 * "green% cai muito em jogos com chuva" ou "tênis em altitude alta tem mais red".
 */
export async function relatorioPorContexto() {
  const entradas = await lerEntradas()
  const finalizados = entradas.filter(e => isAcerto(e.resultado) !== null)

  const detectarEsporteLocal = (liga) => {
    const l = String(liga || '').toLowerCase()
    if (['atp', 'wta', 'itf', 'challenger'].some(k => l.includes(k))) return 'Tênis'
    if (['nba', 'euroleague', 'nbb', 'wnba', 'basquete'].some(k => l.includes(k))) return 'Basquete'
    return 'Futebol'
  }

  const agrupar = (extrairChave) => {
    const mapa = {}
    for (const e of finalizados) {
      const chave = extrairChave(e)
      if (!chave) continue
      if (!mapa[chave]) mapa[chave] = { n: 0, greens: 0 }
      mapa[chave].n++
      if (isAcerto(e.resultado)) mapa[chave].greens++
    }
    return Object.entries(mapa)
      .map(([chave, v]) => ({
        chave, n: v.n, greens: v.greens, reds: v.n - v.greens,
        pctAcerto: Math.round((v.greens / v.n) * 1000) / 10,
      }))
      .sort((a, b) => b.n - a.n)
  }

  return {
    totalFinalizados: finalizados.length,
    porEsporte:  agrupar(e => e.esporte || detectarEsporteLocal(e.liga)),
    porClima:    agrupar(e => categoriaClima(e)),      // ✅ FIX: entradas automáticas gravam clima como objeto
    porAltitude: agrupar(e => categoriaAltitude(e)),   // ✅ FIX: idem (altitude vem dentro de clima)
    porLiga:     agrupar(e => e.liga || null),
    geradoEm: new Date().toISOString(),
  }
}

// ═══════════════ ✅ NOVO — CALIBRAÇÃO DO TÊNIS ═══════════════

// ✅ NOVO — limiares padrão de recomendação de entrada do tênis (antes viviam
// hardcoded em tennisScraper.js como LIMIAR_VITORIA_MIN/LIMIAR_SD_PROB/
// LIMIAR_SD_CONCENT). Continuam existindo como PISO/fallback — quando ainda
// não há amostra suficiente no Tracker pra calibrar com dado real, o sistema
// cai neles, exatamente como antes.
const LIMIAR_VITORIA_MIN_PADRAO = 0.60
const LIMIAR_SD_PROB_PADRAO     = 0.60
// ⚠️ Este limiar NÃO é auto-ajustável hoje: é uma RAZÃO (sets diretos ÷
// vitória), e o Tracker grava só a probabilidade do mercado que foi marcado
// (green/red), não o par "prob. sets diretos + prob. vitória geral daquele
// mesmo jogo" necessário pra reconstruir a razão real. Sem esse dado pareado,
// calibrar essa razão específica exigiria mudar o que o Tracker grava — fica
// fixo até lá.
const LIMIAR_SD_CONCENT_PADRAO  = 0.68
const AMOSTRA_MIN_FAIXA_LIMIAR  = 8  // nº mínimo de entradas na faixa pra confiar nela
const META_GREEN_PCT_LIMIAR     = 55 // green% real mínimo pra "liberar" uma faixa como limiar

// Mesmas faixas de probabilidade que relatorioCalibracaoCompleto (futebol) já usa.
const FAIXAS_PROB_DEF = [
  { id: '50-58', min: 50, max: 58 },
  { id: '58-65', min: 58, max: 65 },
  { id: '65-72', min: 65, max: 72 },
  { id: '72-80', min: 72, max: 80 },
  { id: '80+',   min: 80, max: 101 },
]

/** Agrupa itens [{prob, acerto}] nas FAIXAS_PROB_DEF — n/previsto/real/erro por faixa. */
function bucketizarPorFaixa(itens) {
  return FAIXAS_PROB_DEF.map(fx => {
    const sub = itens.filter(it => it.prob >= fx.min && it.prob < fx.max)
    if (!sub.length) return { faixa: fx.id, min: fx.min, n: 0, previsto: null, real: null, erro: null }
    const previsto = sub.reduce((s, it) => s + it.prob, 0) / sub.length
    const real = (sub.filter(it => it.acerto).length / sub.length) * 100
    return {
      faixa: fx.id, min: fx.min, n: sub.length,
      previsto: Math.round(previsto * 10) / 10,
      real: Math.round(real * 10) / 10,
      erro: Math.round((real - previsto) * 10) / 10,
    }
  })
}

/** Menor faixa (crescente) com amostra suficiente e green% real >= metaPct.
 *  Devolve fx.min/100 (0-1, mesma escala das constantes LIMIAR_*) ou null se
 *  nenhuma faixa tiver amostra/qualidade suficiente ainda. */
function limiarPelaFaixa(faixas, metaPct) {
  const qualificadas = faixas
    .filter(fx => fx.n >= AMOSTRA_MIN_FAIXA_LIMIAR && fx.real != null && fx.real >= metaPct)
    .sort((a, b) => a.min - b.min)
  return qualificadas.length ? qualificadas[0].min / 100 : null
}

/** Núcleo síncrono (recebe `entradas` já lidas) — usado tanto por
 *  calcLimiaresTenisCalibrados() (busca sozinho) quanto por
 *  relatorioCalibracaoTenis() (reaproveita a leitura que já fez, evitando
 *  bater 2x no /api/tracker/calibracao-dados na mesma chamada). */
function calcularLimiaresDeEntradas(entradas) {
  const doMercado = (mercadoAlvo) => entradas
    .filter(e => ehEntradaTenis(e) && normalizarMercadoTenis(e.mercado) === mercadoAlvo)
    .map(e => ({ prob: extrairProbTenis(e), acerto: isAcerto(e.resultado) }))
    .filter(it => it.prob != null && it.acerto !== null)

  const faixasVitoria     = bucketizarPorFaixa(doMercado('Tênis:Vencedor'))
  const faixasSetsDiretos = bucketizarPorFaixa(doMercado('Tênis:Sets Diretos'))

  const limiarVitoriaMin      = limiarPelaFaixa(faixasVitoria, META_GREEN_PCT_LIMIAR) ?? LIMIAR_VITORIA_MIN_PADRAO
  const limiarSetsDiretosProb = limiarPelaFaixa(faixasSetsDiretos, META_GREEN_PCT_LIMIAR) ?? LIMIAR_SD_PROB_PADRAO

  return {
    limiarVitoriaMin,
    limiarSetsDiretosProb,
    limiarSetsDiretosConcentracao: LIMIAR_SD_CONCENT_PADRAO, // fixo — ver comentário na constante
    fonteVitoria:     limiarVitoriaMin      !== LIMIAR_VITORIA_MIN_PADRAO ? 'calibrado' : 'padrao',
    fonteSetsDiretos: limiarSetsDiretosProb !== LIMIAR_SD_PROB_PADRAO    ? 'calibrado' : 'padrao',
    faixasVitoria,
    faixasSetsDiretos,
  }
}

/**
 * ✅ NOVO — Auto-ajusta os limiares de recomendação de entrada do tênis
 * (antes hardcoded em tennisScraper.js) usando o green% REAL por faixa de
 * probabilidade que o próprio Tracker vem registrando, em vez de um valor
 * fixo escrito no código:
 *   - limiarVitoriaMin: a menor faixa de prob. de "Tênis:Vencedor" que já
 *     bateu >= 55% de acerto real (com amostra >= 8) vira o novo piso.
 *   - limiarSetsDiretosProb: mesma lógica pra "Tênis:Sets Diretos".
 * Cai pro valor padrão (idêntico ao hardcoded de antes) enquanto a amostra
 * daquela faixa ainda for pequena — nada quebra, a recomendação nunca fica
 * sem limiar.
 */
export async function calcLimiaresTenisCalibrados() {
  try {
    const entradas = await lerEntradasCalibracao()
    return calcularLimiaresDeEntradas(entradas)
  } catch (e) {
    console.warn('[Calibration] tênis: falha ao calcular limiares calibrados, usando padrão:', e.message)
    return {
      limiarVitoriaMin: LIMIAR_VITORIA_MIN_PADRAO,
      limiarSetsDiretosProb: LIMIAR_SD_PROB_PADRAO,
      limiarSetsDiretosConcentracao: LIMIAR_SD_CONCENT_PADRAO,
      fonteVitoria: 'padrao', fonteSetsDiretos: 'padrao',
      faixasVitoria: [], faixasSetsDiretos: [],
    }
  }
}

/** Reconstrói recomendacaoEntrada com os limiares calibrados, a partir dos
 *  campos que o próprio jogo (já calibrado nos passos 1/2 acima) expõe —
 *  mesma fórmula de tennisScraper.js, só que com limiares dinâmicos. */
function recalcularRecomendacaoEntrada(jogo, limiares) {
  if (jogo.prob_mandante == null || jogo.prob_visitante == null) return jogo.recomendacaoEntrada

  const favoritoMandante    = jogo.prob_mandante >= jogo.prob_visitante
  const nomeFavorito        = favoritoMandante ? jogo.mandante : jogo.visitante
  const probVitoriaFavorito = Math.max(jogo.prob_mandante, jogo.prob_visitante) / 100

  const sd = jogo.mercadoStraightSets
  const probSetsDiretosFavorito = (sd && sd.jogador === nomeFavorito) ? sd.prob / 100 : 0
  const concentracaoSD = probVitoriaFavorito > 0 ? probSetsDiretosFavorito / probVitoriaFavorito : 0

  const { limiarVitoriaMin, limiarSetsDiretosProb, limiarSetsDiretosConcentracao } = limiares

  if (probVitoriaFavorito < limiarVitoriaMin) {
    return { tipo: 'evitar', motivo: `Favoritismo fraco (${Math.round(probVitoriaFavorito * 100)}%) — confiança baixa pra qualquer entrada (limiar calibrado: ${Math.round(limiarVitoriaMin * 100)}%).` }
  }
  if (probSetsDiretosFavorito >= limiarSetsDiretosProb && concentracaoSD >= limiarSetsDiretosConcentracao) {
    return { tipo: 'sets_diretos', motivo: `Sets diretos concentra ${Math.round(concentracaoSD * 100)}% da prob. de vitória (${Math.round(probSetsDiretosFavorito * 100)}% própria) — baixo risco do adversário levar set (limiar calibrado: ${Math.round(limiarSetsDiretosProb * 100)}%).` }
  }
  return { tipo: 'vitoria', motivo: `Vitória (ML) é mais segura: sets diretos só ${Math.round(probSetsDiretosFavorito * 100)}% vs ${Math.round(probVitoriaFavorito * 100)}% de vitória — chance real de ir a 3 sets.` }
}

/**
 * Aplica os fatores do Tracker nas probabilidades de UM jogo de tênis.
 * - Vencedor: o fator é do lado FAVORITO (é o que o Tracker grava); o outro lado = 100 - favorito.
 * - Sets diretos e Over/Under Games: fator do respectivo mercado.
 * Guarda a prob. original em probBruta (é ela que deve ir pro Tracker, pra não corrigir em cima do corrigido).
 * ✅ NOVO — recebe `limiares` (opcional, de calcLimiaresTenisCalibrados()) e,
 * se vier, RECALCULA recomendacaoEntrada com os limiares calibrados em vez
 * dos valores fixos que o backend usou. Guarda a decisão original em
 * recomendacaoEntradaBruta pra transparência.
 */
export function aplicarCalibracaoTenis(jogo, fatores, limiares = null) {
  if (!jogo || !fatores) return jogo
  const out = { ...jogo }

  // 1) Vencedor
  if (jogo.prob_mandante != null && jogo.prob_visitante != null) {
    out.probBruta = { mandante: jogo.prob_mandante, visitante: jogo.prob_visitante }
    const fV = fatores['Tênis:Vencedor'] ?? 1
    if (fV !== 1) {
      const mandanteFav = jogo.prob_mandante >= jogo.prob_visitante
      const favBruta = mandanteFav ? jogo.prob_mandante : jogo.prob_visitante
      const favCal = Math.round(Math.min(92, Math.max(50, favBruta * fV)))
      out.prob_mandante  = mandanteFav ? favCal : 100 - favCal
      out.prob_visitante = mandanteFav ? 100 - favCal : favCal
      out.confianca = favCal >= 70 ? 'Alta' : favCal >= 58 ? 'Média' : 'Baixa'
      if (typeof jogo.analise === 'string') {
        out.analise = jogo.analise.replace(/favorito com \d+%/, `favorito com ${favCal}%`)
      }
      out.calibradoTenis = { fator: fV, favBruta, favCal }
    }
  }

  // 2) Sets diretos
  const fSD = fatores['Tênis:Sets Diretos'] ?? 1
  if (jogo.mercadoStraightSets?.prob != null && fSD !== 1) {
    out.mercadoStraightSets = {
      ...jogo.mercadoStraightSets,
      probBruta: jogo.mercadoStraightSets.prob,
      prob: Math.round(Math.min(90, Math.max(10, jogo.mercadoStraightSets.prob * fSD))),
    }
  }

  // 3) Over/Under Games (calibra os dois lados e renormaliza pra somar 100)
  const fO = fatores['Tênis:Over Games'] ?? 1
  const fU = fatores['Tênis:Under Games'] ?? 1
  if (Array.isArray(jogo.mercadoTotalGames) && (fO !== 1 || fU !== 1)) {
    out.mercadoTotalGames = jogo.mercadoTotalGames.map(l => {
      const o = Math.max(1, l.over * fO)
      const u = Math.max(1, l.under * fU)
      const over = Math.round((o / (o + u)) * 1000) / 10
      return { ...l, overBruta: l.over, underBruta: l.under, over, under: Math.round((100 - over) * 10) / 10 }
    })
  }

  // 4) ✅ NOVO — recomendação de entrada com limiares calibrados (item 4)
  if (limiares) {
    const nova = recalcularRecomendacaoEntrada(out, limiares)
    if (nova !== jogo.recomendacaoEntrada) {
      out.recomendacaoEntradaBruta = jogo.recomendacaoEntrada
      out.recomendacaoEntrada = nova
    }
  }

  return out
}

/** Recebe { total, jogos } do modelo de tênis e devolve o mesmo formato já calibrado. */
export async function calibrarJogosTenis(data) {
  if (!data?.jogos?.length) return data
  try {
    const [fatores, limiares] = await Promise.all([
      calcFatoresCalibration(),
      calcLimiaresTenisCalibrados(), // ✅ NOVO (item 4)
    ])
    return { ...data, jogos: data.jogos.map(j => aplicarCalibracaoTenis(j, fatores, limiares)) }
  } catch (e) {
    console.warn('[Calibration] tênis: falha ao calibrar, usando prob. bruta:', e.message)
    return data
  }
}

/** Relatório previsto × real SÓ do tênis (mesmo formato de `mercados` do relatório de futebol). */
export async function relatorioCalibracaoTenis() {
  const entradas = await lerEntradasCalibracao()
  const fatores  = await calcFatoresCalibration()
  const porMercado = {}
  let total = 0, acertosTotal = 0, somaBrier = 0
  const finalizadosVersao = [] // ✅ NOVO — Fase 1, item 4

  for (const e of entradas) {
    const acerto = isAcerto(e.resultado)
    if (acerto === null || !ehEntradaTenis(e)) continue
    const mercado = normalizarMercadoTenis(e.mercado)
    const prob = extrairProbTenis(e)
    if (!mercado || prob == null) continue

    if (!porMercado[mercado]) porMercado[mercado] = { n: 0, acertos: 0, somaProb: 0 }
    porMercado[mercado].n++
    porMercado[mercado].somaProb += prob
    if (acerto) porMercado[mercado].acertos++

    total++
    if (acerto) acertosTotal++
    somaBrier += (prob / 100 - (acerto ? 1 : 0)) ** 2
    finalizadosVersao.push({ prob, acerto, motorVersao: e.motorVersao || null })
  }

  const mercados = Object.entries(porMercado)
    .map(([mercado, g]) => {
      const previsto = g.somaProb / g.n
      const real = (g.acertos / g.n) * 100
      const erro = real - previsto
      return {
        mercado, n: g.n, greens: g.acertos, reds: g.n - g.acertos,
        previsto: Math.round(previsto * 10) / 10,
        real: Math.round(real * 10) / 10,
        erro: Math.round(erro * 10) / 10,
        fator: fatores[mercado] ?? 1,
        status: g.n < 5 ? 'poucos dados' : Math.abs(erro) <= 5 ? 'calibrado' : erro > 5 ? 'subestima' : 'superestima',
      }
    })
    .sort((a, b) => b.n - a.n)

  return {
    totalFinalizados: total,
    taxaAcertoGeral: total ? Math.round((acertosTotal / total) * 1000) / 10 : null,
    brierScore: total ? Math.round((somaBrier / total) * 1000) / 1000 : null,
    mercados,
    // ✅ NOVO (item 4 do ScoutTracker) — limiares de recomendação atualmente em vigor
    // (calibrados pelo green% real, ou padrão se a amostra ainda for pequena),
    // junto com as faixas que embasaram o cálculo — pra exibir no ScoutTracker.
    limiaresSugeridos: calcularLimiaresDeEntradas(entradas),
    // ✅ NOVO — Fase 1, item 4 do roadmap: acerto/Brier por versão do motor
    porVersaoMotor: agruparPorVersaoMotor(finalizadosVersao),
    geradoEm: new Date().toISOString(),
  }
}
// ✅ NOVO — peças internas expostas SÓ pro script de verificação (testeCalibracao.mjs).
// Não são usadas pelo app.
export const __teste = {
  fitIsotonic, fitPlatt, applyIsotonic, applyPlatt, calibrarPorCurva, paresParaCurva,
  testeEstresseCurva, limitarMovimento, travaSeguranca, aplicarCurvaProducao,
  MAX_MOVIMENTO_CALIBRACAO_PP, CALIBRACAO_CURVA_HABILITADA,
}