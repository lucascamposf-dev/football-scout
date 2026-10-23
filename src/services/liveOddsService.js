// src/services/liveOddsService.js
// ✅ NOVO — camada de acesso às rotas /api/sportsdata/jogos/ao-vivo*
// e /api/sportsdata/jogos/odds*. Mesmo padrão dos outros services:
// em dev aponta pro localhost:3001, em prod usa rota relativa.
// ─────────────────────────────────────────────────────────────

import { callGroqComWebSearch } from './groqService.js'
import { calcFatoresCalibration, aplicarCalibracaoTenis } from './calibrationService.js'
import { edgeMinimoPara, calcEdgePP, APLICAR_EDGE_MINIMO_AO_VIVO } from './valueConfig.js'
// ✅ NOVO — Fase 1, item 4 do roadmap: versionamento do motor
import { MOTOR_TENIS_AOVIVO, versaoAtual } from './modelVersion.js'

const IS_PROD  = typeof window !== 'undefined' && window.location.hostname !== 'localhost'
const API_BASE = IS_PROD ? '' : 'http://localhost:3001'
const BASE     = `${API_BASE}/api/sportsdata/jogos`


function authHeaders(extra = {}) {
  const token = typeof localStorage !== 'undefined' ? localStorage.getItem('scout_token') : null
  return token ? { ...extra, 'x-auth-token': token } : extra
}

async function getJson(url) {
  const res  = await fetch(url, { headers: authHeaders() })
  const body = await res.json().catch(() => null)

  if (!res.ok || body?.status === 'erro') {
    throw new Error(body?.mensagem || `Falha na requisição (HTTP ${res.status})`)
  }
  return body?.data ?? body
}

// ── Mapa: nome da liga usado no <select> do App → código da rota ──
// Precisa bater com o LIGA_MAP do server/sportsDataRoutes.js.
export const LIGAS_COBERTURA = [
  { value: 'brasileirao',      label: '🇧🇷 Brasileirão Série A' },
  { value: 'serie_b',          label: '🇧🇷 Brasileirão Série B' },
  { value: 'sudamericana',     label: '🏆 Copa Sul-Americana' },
  { value: 'champions_league', label: '⭐ UEFA Champions League' },
  { value: 'europa_league',    label: '🟠 UEFA Europa League' },
  { value: 'premier_league',   label: '🏴 Premier League' },
  { value: 'la_liga',          label: '🇪🇸 La Liga' },
  { value: 'serie_a',          label: '🇮🇹 Serie A (Itália)' },
  { value: 'bundesliga',       label: '🇩🇪 Bundesliga' },
  { value: 'ligue_1',          label: '🇫🇷 Ligue 1' },
  { value: 'libertadores',     label: '🏆 Copa Libertadores' },
  { value: 'amistosos',        label: '🌍 Amistosos Internacionais' },
  { value: 'nations_league',   label: '🇪🇺 UEFA Nations League' },
  { value: 'copa_mundo',       label: '🌎 Copa do Mundo' },
  { value: 'eliminatorias',    label: '🌎 Eliminatórias da Copa' },
  { value: 'copa_america',     label: '🏆 Copa América' },
]

// ═══════════════════ JOGOS AO VIVO ═══════════════════

/** Lista os jogos em andamento agora.
 *  @param {boolean} todasLigas true = mundo inteiro; false = só ligas suportadas */
export async function buscarJogosAoVivo(todasLigas = false) {
  const data = await getJson(`${BASE}/ao-vivo${todasLigas ? '?todas=1' : ''}`)
  return { jogos: data?.jogos ?? [], total: data?.total ?? 0, cache: data?._cache }
}

/** Estatísticas ao vivo de uma partida (posse, chutes, cartões, escanteios...) */
export async function buscarEstatisticasAoVivo(matchId) {
  return getJson(`${BASE}/ao-vivo/${matchId}`)
}

// ✅ NOVO — TÊNIS. Rotas já existiam no backend (getJogosTenisAoVivo /
// getEstatisticasTenisAoVivo em tennisScraper.js), mas essas duas funções de
// serviço nunca tinham sido escritas — era por isso que a aba "🎾 Tênis" do
// JogosAoVivo.jsx quebrava (importava algo que não existia neste arquivo).

/** Lista os jogos de tênis (ATP/WTA principal) em andamento agora. */
export async function buscarJogosTenisAoVivo() {
  const data = await getJson(`${BASE}/tenis/ao-vivo`)
  return { jogos: data?.jogos ?? [], total: data?.total ?? 0, cache: data?._cache }
}

/** Estatísticas ao vivo (placar por set + games do set atual) de uma partida de tênis. */
export async function buscarEstatisticasTenisAoVivo(matchId) {
  return getJson(`${BASE}/tenis/ao-vivo/${matchId}`)
}

// ═══════════════════ ODDS ═══════════════════

/** Odds dos próximos jogos de uma liga inteira (lote). */
export async function buscarOddsLiga(liga, limite = 12) {
  const data = await getJson(`${BASE}/odds/liga/${liga}?limite=${limite}`)
  return {
    jogos:   data?.jogos ?? [],
    total:   data?.total ?? 0,
    comOdds: data?.comOdds ?? 0,
    semOdds: data?.semOdds ?? 0,
    cache:   data?._cache,
  }
}

/** Todos os mercados de odds de uma partida específica. */
export async function buscarOddsPartida(matchId, esporte = 'futebol') {
  return getJson(`${BASE}/odds/${matchId}${esporte === 'tenis' ? '?esporte=tenis' : ''}`)
}

// ✅ NOVO — Fase 6: histórico de odds (line movement / steam detection).
// Nota: essa rota é `/api/odds/historico`, direto (não `/api/sportsdata/...`),
// por isso monta a URL sem usar a constante BASE deste arquivo.
export async function buscarLineMovement(mandante, visitante) {
  const url = `${API_BASE}/api/odds/historico?mandante=${encodeURIComponent(mandante)}&visitante=${encodeURIComponent(visitante)}`
  const res = await fetch(url, { headers: authHeaders() })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(body?.error || `Falha ao buscar histórico (HTTP ${res.status})`)
  const historico = body?.historico ?? []
  if (historico.length < 2) return { historico, steamMove: null }

  const abertura = historico[0]
  const atual    = historico[historico.length - 1]
  const deltaM = atual.prob_mandante  - abertura.prob_mandante
  const deltaV = atual.prob_visitante - abertura.prob_visitante
  const maior = Math.abs(deltaM) >= Math.abs(deltaV) ? { lado: 'mandante', delta: deltaM } : { lado: 'visitante', delta: deltaV }

  return { historico, steamMove: Math.abs(maior.delta) >= 4 ? maior : null }
}

// ═══════════════════ HELPERS DE CÁLCULO ═══════════════════

/** Probabilidade implícita (%) de uma odd decimal. */
export const oddParaProb = odd => (odd && odd > 1 ? Math.round((1 / odd) * 1000) / 10 : null)

/** Remove a margem da casa ("vig") e devolve as probabilidades justas. */
export function probabilidadesJustas(odds = []) {
  const validas = odds.filter(o => o && o > 1)
  if (validas.length < 2) return null
  const soma = validas.reduce((s, o) => s + 1 / o, 0)
  return validas.map(o => Math.round(((1 / o) / soma) * 1000) / 10)
}

/** EV (%) de apostar numa odd, dada a SUA probabilidade estimada (0–100). */
export function calcularEV(probEstimada, odd) {
  if (!odd || odd <= 1 || probEstimada == null) return null
  const p = probEstimada / 100
  return Math.round((p * odd - 1) * 1000) / 10
}

/** Formata um timestamp unix (segundos) em "dd/mm às HH:MM" no fuso de SP. */
export function formatarDataJogo(ts) {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  const data = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' })
  const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })
  return `${data} às ${hora}`
}

// ═══════════════════ MELHOR ENTRADA AO VIVO ═══════════════════

const LINHAS_ESCANTEIOS = [7.5, 8.5, 9.5, 10.5, 11.5, 12.5]
const LINHAS_CARTOES    = [3.5, 4.5, 5.5, 6.5]
const LINHAS_GOLS       = [1.5, 2.5, 3.5, 4.5]
const ZONA_MIN = 80   // ✅ pedido do usuário: só mostrar entradas com >= 80% de confiança
const ZONA_MAX = 98   // acima disso a odd oferecida não compensa mais o risco

// ✅ NOVO — FIX do "ruído do início do jogo": com poucos minutos de bola
// rolando, `atual / minutoAtual` é uma taxa calculada em cima de amostra
// minúscula (1 escanteio no minuto 4 já virava 21+ escanteios projetados pro
// jogo inteiro). Duas camadas de proteção:
//  1) MINUTO_MINIMO_ENTRADA — antes disso nem calcula candidato (a partida
//     ainda não tem contagem suficiente pra dizer nada).
//  2) Blend da taxa observada com uma média histórica de jogo completo
//     (MEDIA_BASE_JOGO), com peso crescendo conforme os minutos passam —
//     mesma ideia do shrinkage que o pré-jogo já usa (pesoPoissonPorAmostra).
//     Aos poucos minutos, o modelo confia quase só na média; depois do
//     minuto ~25 já confia soomente na taxa real observada do próprio jogo.
const MINUTO_MINIMO_ENTRADA = 10
const MINUTO_CONFIANCA_TOTAL = 25   // a partir daqui, 100% de peso na taxa observada
// Média global de referência pra 90min — é uma ASSUNÇÃO (não vem de liga
// específica ainda, já que esse serviço não recebe o código da liga hoje).
// Serve só de "âncora" nos primeiros minutos, quando ainda não há dado
// suficiente do próprio jogo.
const MEDIA_BASE_JOGO = { Gols: 2.6, Escanteios: 10.0, 'Cartões': 4.0 }

function minutoParaNumero(minuto) {
  if (minuto == null) return 45
  const n = parseInt(String(minuto).replace('+', ''))
  return Number.isFinite(n) ? n : 45
}

/** P(X > k) para uma Poisson(lambda) — usada pra projetar o que falta do jogo. */
function poissonProbMaiorQue(lambda, k) {
  if (lambda <= 0) return k < 0 ? 1 : 0
  const kk = Math.floor(k)
  let cum = 0
  let termo = Math.exp(-lambda)
  for (let i = 0; i <= kk; i++) {
    if (i > 0) termo *= lambda / i
    cum += termo
  }
  return Math.max(0, Math.min(1, 1 - cum))
}

/** Projeta Over/Under de um mercado (escanteios, cartões, gols) pro resto do jogo.
 *  ✅ CALIBRADO: `calib` = { fatores, pesoTempo }. Aplica o mesmo fator histórico do Tracker que o
 *  pré-jogo usa (só no lado Over; o Under é o espelho). O fator é diluído conforme o jogo avança
 *  (pesoTempo = minutos restantes / 90): no fim do jogo o resultado já está quase decidido pela
 *  contagem atual, então a correção histórica quase não pesa. Só usa fator com >= 10 amostras (da própria linha OU do grupo da categoria, no caso de Cartões/Escanteios).
 *  ✅ FIX: antes do MINUTO_MINIMO_ENTRADA não gera candidato nenhum, e a taxa
 *  usada pra projetar é um blend entre o ritmo observado no próprio jogo e a
 *  média histórica (MEDIA_BASE_JOGO) — o peso do ritmo observado cresce até
 *  MINUTO_CONFIANCA_TOTAL. Isso evita que 1 evento isolado nos primeiros
 *  minutos vire uma entrada de "95% de confiança" só por ruído. */
function projetarMercado(atual, minutoAtual, minutosRestantes, linhas, prefixo, calib = null) {
  if (minutoAtual < MINUTO_MINIMO_ENTRADA) return []

  const taxaObservada = minutoAtual > 0 ? atual / minutoAtual : 0
  const taxaBase = (MEDIA_BASE_JOGO[prefixo] ?? MEDIA_BASE_JOGO.Gols) / 90
  const pesoObservado = Math.min(1, minutoAtual / MINUTO_CONFIANCA_TOTAL)
  const taxa = taxaObservada * pesoObservado + taxaBase * (1 - pesoObservado)

  const lambdaRestante = taxa * minutosRestantes
  const candidatos = []

  for (const linha of linhas) {
    const faltam = linha - atual
    if (faltam < 0) continue // linha já ultrapassada, não é mais uma "entrada" ao vivo válida
    const pOverBruta = poissonProbMaiorQue(lambdaRestante, faltam) * 100

    const chave = `${prefixo}:Over ${linha}`
    // ✅ HERANÇA DE FORÇA (Cartões/Escanteios): a linha sozinha raramente chega a 10 amostras.
    // Se o GRUPO (todas as linhas Over da categoria) tem >= 10, usa o fator da linha — que
    // já vem do calcFatoresCalibration() como "herdado do grupo" (linha com pouca amostra)
    // ou "puxado do grupo em direção ao próprio dado" (linha com amostra própria).
    // Linha fora de MERCADOS_ALVO cai no fator do grupo. Gols não tem grupo → regra antiga.
    const fats = calib?.fatores
    const nAmostra = fats?.[`_n_${chave}`] ?? 0
    const nGrupo   = fats?.[`_n_grupo_${prefixo}:Over`] ?? 0
    const fatorLinha = fats?.[chave] ?? fats?.[`${prefixo}:Over (grupo)`] ?? 1
    const fatorBruto = (nAmostra >= 10 || nGrupo >= 10) ? fatorLinha : 1
    const fatorEfetivo = 1 + (fatorBruto - 1) * (calib?.pesoTempo ?? 0)
    const pOver = Math.min(99, Math.max(1, pOverBruta * fatorEfetivo))

    const extra = { fatorCalib: Math.round(fatorEfetivo * 1000) / 1000 }
    candidatos.push({ mercado: `${prefixo} Over ${linha}`, prob: Math.round(pOver * 10) / 10, probBruta: Math.round(pOverBruta * 10) / 10, direcao: 'over', linha, ...extra })
    candidatos.push({ mercado: `${prefixo} Under ${linha}`, prob: Math.round((100 - pOver) * 10) / 10, probBruta: Math.round((100 - pOverBruta) * 10) / 10, direcao: 'under', linha, ...extra })
  }
  return candidatos
}

// Nomes de mercado que o backend devolve (já traduzidos pelo backend) pra cada categoria —
// usados pra casar o mercado projetado com a odd REAL da casa de apostas.
const NOMES_MERCADO_ODDS = {
  escanteios: ['escanteios', 'total de escanteios'],
  cartoes:    ['cartões', 'cartoes', 'total de cartões', 'total de cartoes'],
  gols:       ['total de gols', 'total de gols da partida'],
}

/** Procura, dentro dos mercados de odds reais da partida, a odd que corresponde
 *  exatamente à linha/direção de um candidato (ex.: "Escanteios Over 9.5"). */
function buscarOddReal(mercadosOdds, categoria, direcao, linha) {
  if (!Array.isArray(mercadosOdds) || !mercadosOdds.length) return null
  const nomesAceitos = NOMES_MERCADO_ODDS[categoria] ?? []
  const prefixoOpcao = direcao === 'over' ? 'mais de' : 'menos de'

  // prioriza mercado marcado como "ao vivo" (aoVivo:true); senão pega o pré-jogo
  const mercadosDaCategoria = mercadosOdds
    .filter(m => nomesAceitos.includes(String(m.nome ?? '').toLowerCase()))
    .filter(m => parseFloat(m.linha) === linha)
    .sort((a, b) => (b.aoVivo ? 1 : 0) - (a.aoVivo ? 1 : 0))

  for (const m of mercadosDaCategoria) {
    const opcao = (m.opcoes ?? []).find(o => String(o.nome ?? '').toLowerCase().startsWith(prefixoOpcao))
    if (opcao?.odd) return { odd: opcao.odd, probImplicita: opcao.probImplicita ?? oddParaProb(opcao.odd), aoVivo: !!m.aoVivo }
  }
  return null
}

/** Dentro de uma categoria (gols/escanteios/cartões), escolhe a melhor linha:
 *  só considera candidatos com prob dentro da ZONA (>=80% e <=98%), busca a
 *  odd real de cada um e prioriza quem tem VALOR (odd melhor do que a "odd
 *  justa" pela nossa probabilidade, com EV positivo E edge >= mínimo da categoria).
 *  Se nenhuma tiver
 *  odd disponível, cai pra maior probabilidade mesmo assim. */
function escolherMelhorPorCategoria(candidatos, mercadosOdds, categoria) {
  const naZona = candidatos.filter(c => c.prob >= ZONA_MIN && c.prob <= ZONA_MAX)
  if (!naZona.length) return null

  const enriquecidos = naZona.map(c => {
    const oddInfo = buscarOddReal(mercadosOdds, categoria, c.direcao, c.linha)
    const ev = oddInfo ? calcularEV(c.prob, oddInfo.odd) : null
    // ✅ edge mínimo por CATEGORIA (gols / escanteios / cartões) + faixa de odd — valueConfig.js
    const edge       = oddInfo ? calcEdgePP(c.prob, oddInfo.odd) : null
    const edgeMinimo = edgeMinimoPara(categoria, oddInfo?.odd)
    const passaEdge  = !APLICAR_EDGE_MINIMO_AO_VIVO || (edge != null && edge >= edgeMinimo)
    return {
      ...c,
      odd:            oddInfo?.odd ?? null,
      probImplicita:  oddInfo?.probImplicita ?? null,
      oddAoVivo:      oddInfo?.aoVivo ?? null,
      oddJusta:       Math.round((100 / c.prob) * 100) / 100, // odd mínima pra valer a pena, dada nossa prob.
      ev,
      edge,
      edgeMinimo,
      valueBet: ev != null && ev > 0 && passaEdge,
    }
  })

  enriquecidos.sort((a, b) => {
    if (a.valueBet !== b.valueBet) return a.valueBet ? -1 : 1
    if (a.ev != null && b.ev != null && a.ev !== b.ev) return b.ev - a.ev
    return b.prob - a.prob
  })
  return enriquecidos[0]
}

/** ✅ NOVO — Calcula a melhor entrada ao vivo pra uma partida específica.
 *  Chamado SOB DEMANDA (botão), nunca no auto-refresh, pra não gastar
 *  chamada de IA à toa. Números vêm do modelo (Poisson pelo ritmo do jogo);
 *  a IA só comenta riscos, nunca inventa probabilidade. */
export async function analisarMelhorEntradaAoVivo(matchId, contexto = {}) {
  const stats = await buscarEstatisticasAoVivo(matchId)
  if (stats?.erro) throw new Error(stats.erro)

  const minutoAtual      = minutoParaNumero(stats.minuto)
  const minutosRestantes = Math.max(90 - minutoAtual, 3)

  const escanteiosAtual = (stats.escanteios_casa ?? 0) + (stats.escanteios_fora ?? 0)
  const cartoesAtual    = (stats.cartoes_amarelos_casa ?? 0) + (stats.cartoes_amarelos_fora ?? 0)
  const golsAtual       = (stats.placarMandante ?? 0) + (stats.placarVisitante ?? 0)

  // ✅ CALIBRAÇÃO — mesmos fatores do pré-jogo (histórico green/red do Tracker)
  let fatoresCalib = null
  try { fatoresCalib = await calcFatoresCalibration() }
  catch (e) { console.warn('[ao-vivo] calibração indisponível (seguindo com prob. bruta):', e.message) }
  const calib = fatoresCalib ? { fatores: fatoresCalib, pesoTempo: Math.min(1, minutosRestantes / 90) } : null

  const candidatosGols       = projetarMercado(golsAtual,       minutoAtual, minutosRestantes, LINHAS_GOLS,       'Gols',       calib)
  const candidatosEscanteios = projetarMercado(escanteiosAtual, minutoAtual, minutosRestantes, LINHAS_ESCANTEIOS, 'Escanteios', calib)
  const candidatosCartoes    = projetarMercado(cartoesAtual,    minutoAtual, minutosRestantes, LINHAS_CARTOES,    'Cartões',    calib)

  // ✅ busca as odds REAIS da partida (se a casa tiver mercado aberto) pra
  // comparar com a probabilidade calculada e saber se a odd "compensa".
  let mercadosOdds = []
  try {
    const oddsData = await buscarOddsPartida(matchId)
    mercadosOdds = oddsData?.mercados ?? []
  } catch (e) {
    console.warn('[ao-vivo] odds reais indisponíveis (seguindo só com probabilidade):', e.message)
  }

  // ✅ agora gera UMA melhor entrada POR CATEGORIA (gols, escanteios, cartões)
  // em vez de escolher só a "melhor geral" — assim o usuário vê as 3 análises.
  const entradas = {
    gols:       escolherMelhorPorCategoria(candidatosGols,       mercadosOdds, 'gols'),
    escanteios: escolherMelhorPorCategoria(candidatosEscanteios, mercadosOdds, 'escanteios'),
    cartoes:    escolherMelhorPorCategoria(candidatosCartoes,    mercadosOdds, 'cartoes'),
  }

  const todasEntradas = Object.values(entradas).filter(Boolean)
  // "melhor geral" mantido só por compatibilidade com quem já usa esse campo
  const melhor = [...todasEntradas].sort((a, b) => {
    if (a.valueBet !== b.valueBet) return a.valueBet ? -1 : 1
    return b.prob - a.prob
  })[0] ?? null

  const candidatos = [...candidatosGols, ...candidatosEscanteios, ...candidatosCartoes].sort((a, b) => b.prob - a.prob)

  let analiseIA = null
  try {
    const resumoEntradas = todasEntradas.length
      ? todasEntradas.map(e =>
          `${e.mercado}: ${e.prob}% até o fim` +
          (e.odd ? ` (odd real ${e.odd}, odd justa seria ${e.oddJusta}${e.valueBet ? ' → tem valor' : ' → odd não compensa'})` : ' (sem odd disponível agora)')
        ).join(' | ')
      : 'nenhum mercado passou de 80% de confiança agora'

    const prompt =
      `Jogo AO VIVO: ${contexto.mandante ?? stats.mandante} ${stats.placarMandante}x${stats.placarVisitante} ${contexto.visitante ?? stats.visitante}, minuto ${minutoAtual}'.\n` +
      `Escanteios: ${stats.escanteios_casa ?? 0}-${stats.escanteios_fora ?? 0}. ` +
      `Cartões amarelos: ${stats.cartoes_amarelos_casa ?? 0}-${stats.cartoes_amarelos_fora ?? 0}. ` +
      `Cartões vermelhos: ${stats.cartoes_vermelhos_casa ?? 0}-${stats.cartoes_vermelhos_fora ?? 0}. ` +
      `Posse de bola: ${stats.posse_casa ?? '?'}%-${stats.posse_fora ?? '?'}%.\n` +
      `Modelo estatístico aponta como melhores entradas (uma por categoria): ${resumoEntradas}.\n\n` +
      `Com base SOMENTE nesses dados ao vivo, responda em JSON puro:\n` +
      `{"alertas": ["fator 1", "fator 2"], "nivel_risco": "baixo|medio|alto", "comentario": "1-2 frases"}\n` +
      `"alertas" = fatores que podem invalidar essas entradas NO RESTANTE do jogo (cartão vermelho recente, time já satisfeito ` +
      `com o resultado, pressão ofensiva desequilibrada, substituições, jogo truncado). ` +
      `Se não houver risco relevante, devolva alertas vazio e nivel_risco "baixo".`

    analiseIA = await callGroqComWebSearch(null, prompt, 300)
  } catch (e) {
    console.warn('[ao-vivo] análise de IA falhou (seguindo só com o modelo):', e.message)
  }

  return {
    minutoAtual,
    minutosRestantes,
    entradas,            // ✅ NOVO: { gols, escanteios, cartoes } — cada um com odd/EV ou null
    melhorEntrada: melhor,
        calibracaoAtiva: !!calib && Object.entries(fatoresCalib).some(([k, v]) => !k.startsWith('_n_') && v !== 1),
    todosMercados: candidatos,
    alertas:     Array.isArray(analiseIA?.alertas) ? analiseIA.alertas.slice(0, 5) : [],
    nivelRisco:  ['baixo', 'medio', 'alto'].includes(analiseIA?.nivel_risco) ? analiseIA.nivel_risco : 'baixo',
    comentario:  analiseIA?.comentario ?? null,
    atualizadoEm: new Date(),
  }
}

// ═══════════════════ MELHOR ENTRADA AO VIVO — TÊNIS ═══════════════════
// ✅ NOVO — mesma ideia do futebol (projeção estatística sob demanda), mas
// adaptada pra tênis: não existe "minuto de jogo" nem posse de bola — o que
// dá pra medir é o placar de SETS e o placar de games do set em andamento.
// É uma APROXIMAÇÃO (é por isso que a UI do TenisAoVivo já avisa o usuário
// disso) — não tem o mesmo lastro estatístico que o modelo de gols do
// pré-jogo. Sem chamada de IA aqui (o card de tênis não exibe alertas/
// comentário hoje — ver JogosAoVivo.jsx → TenisAoVivo), só o número.

const TENIS_ZONA_MIN = 80   // mesmo critério do futebol: só mostra com >= 80% de confiança
const TENIS_ZONA_MAX = 98
// Média de games por set ATP/WTA — é uma ASSUNÇÃO de mercado (não vem do seu
// histórico ainda). Conforme o Tracker acumular jogos de tênis finalizados,
// dá pra trocar isso por uma média real calculada em cima do próprio dataset.
const MEDIA_GAMES_POR_SET_TENIS = 9.4

/** Separa os sets já FINALIZADOS do set em ANDAMENTO (se houver), a partir
 *  do placarSets. Os N primeiros sets da lista sempre correspondem aos sets
 *  já ganhos por alguém (setsGanhosMandante + setsGanhosVisitante); se
 *  sobrar mais um item na lista, é o set que está rolando agora. */
function separarSetsTenis(placarSets, setsGanhosMandante, setsGanhosVisitante) {
  const sets = placarSets?.sets ?? []
  const setsCompletos = setsGanhosMandante + setsGanhosVisitante
  return {
    finalizados: sets.slice(0, setsCompletos),
    atual: sets[setsCompletos] ?? null,
  }
}

/** C(n, k) — combinação simples, usada na fórmula de "corrida até N vitórias". */
function combinacaoTenis(n, k) {
  if (k < 0 || k > n) return 0
  let r = 1
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1)
  return r
}

/** Probabilidade de "A" vencer a corrida até faltar 0 sets pra A, dado que A
 *  ainda precisa ganhar `faltamA` sets e o oponente precisa de `faltamB`, com
 *  p = probabilidade de A vencer 1 set qualquer (binomial negativa — fórmula
 *  padrão de "melhor de N sets" usada em modelos de tênis). */
function probVenceRaceSets(faltamA, faltamB, p) {
  if (faltamA <= 0) return 1
  if (faltamB <= 0) return 0
  let soma = 0
  for (let k = 0; k < faltamB; k++) {
    soma += combinacaoTenis(faltamA - 1 + k, k) * Math.pow(p, faltamA) * Math.pow(1 - p, k)
  }
  return Math.max(0, Math.min(1, soma))
}

/** Número esperado de sets adicionais até a partida acabar (conta o set em
 *  andamento como 1 desses, se houver). Espaço de estados é minúsculo
 *  (no máx. 3 faltando de cada lado, bo5), recursão direta sem memoização. */
function setsRestantesEsperados(faltamA, faltamB, p) {
  if (faltamA <= 0 || faltamB <= 0) return 0
  return 1
    + p * setsRestantesEsperados(faltamA - 1, faltamB, p)
    + (1 - p) * setsRestantesEsperados(faltamA, faltamB - 1, p)
}

/** Estima p = probabilidade do mandante vencer 1 set, combinando:
 *  (a) o retrospecto de sets já ganhos NESSA partida (com shrinkage — poucos
 *      sets completos pesam pouco), e
 *  (b) o "momento" do set em andamento, pelo placar de games dele (também
 *      shrinkado — 1-2 games no set ainda não diz muita coisa). */
function estimarPSetMandante(setsGanhosMandante, setsGanhosVisitante, setAtual) {
  const setsCompletos = setsGanhosMandante + setsGanhosVisitante
  const ratioSets = setsCompletos > 0 ? setsGanhosMandante / setsCompletos : 0.5
  const pesoSets  = Math.min(0.6, setsCompletos * 0.3)

  const gamesM = setAtual?.casa ?? 0
  const gamesV = setAtual?.fora ?? 0
  const gamesNoSet   = gamesM + gamesV
  const momento      = gamesNoSet > 0 ? 0.5 + 0.5 * Math.max(-1, Math.min(1, (gamesM - gamesV) / 6)) : 0.5
  const pesoMomento  = gamesNoSet >= 2 ? Math.min(0.5, gamesNoSet * 0.08) : 0

  const pesoPrior = Math.max(0, 1 - pesoSets - pesoMomento)
  const p = ratioSets * pesoSets + momento * pesoMomento + 0.5 * pesoPrior
  return Math.max(0.06, Math.min(0.94, p))
}

// ═══════════════════ ✅ NOVO (item 3) — ODDS + EV PRÉ-JOGO — TÊNIS ═══════════════════
// Futebol já cruza probabilidade × odd real (escolherMelhorPorCategoria, mais acima,
// e o próprio PainelOdds.jsx no pré-jogo). Tênis não tinha nada equivalente — dava
// pra saber que o modelo achava um jogador "favorito a 65%", mas não se a odd
// oferecida pela casa REALMENTE compensava esse risco (podia ser 1.15, sem valor
// nenhum). getOddsEvento (flashscoreScraper.js) já é sport-agnóstico — o mesmo
// endpoint /event/{id}/odds/1/all funciona pra tênis, só faltava alguém ler os
// nomes de mercado certos (Match Winner / Total Games / Set Betting) e cruzar
// com o que o modelo de tênis (calcularProbabilidadesTenis) já calcula.

/** Acha o mercado de "Vencedor da Partida" (Match Winner) e devolve a odd do
 *  lado pedido ('mandante' -> escolha "1", 'visitante' -> escolha "2" — mesma
 *  convenção 1/2 usada pra qualquer esporte de 2 lados só). */
function buscarOddVencedorTenis(mercados, lado) {
  if (!Array.isArray(mercados) || !mercados.length) return null
  // exclui de propósito mercados de "vencedor do set" (ex.: "1st Set Winner"),
  // que também contêm a palavra winner mas não são o vencedor da PARTIDA
  const mercado = mercados.find(m =>
    /match winner|to win match|vencedor da partida/i.test(m.nome) && !/set/i.test(m.nome)
  )
  if (!mercado) return null
  const prefixo = lado === 'mandante' ? '1' : '2'
  const opcao = (mercado.opcoes ?? []).find(o => String(o.nome ?? '').startsWith(prefixo))
  return opcao?.odd ? { odd: opcao.odd, probImplicita: opcao.probImplicita ?? oddParaProb(opcao.odd) } : null
}

/** Acha, no mercado de Total de Games, a odd de uma linha/direção específica —
 *  mesma lógica de buscarOddReal (futebol), adaptada ao nome do mercado de tênis. */
function buscarOddTotalGamesTenis(mercados, linha, direcao) {
  if (!Array.isArray(mercados) || !mercados.length) return null
  const prefixoOpcao = direcao === 'over' ? 'mais de' : 'menos de'
  const candidatos = mercados
    .filter(m => /total games|total de games/i.test(m.nome) && parseFloat(m.linha) === linha)
  for (const m of candidatos) {
    const opcao = (m.opcoes ?? []).find(o => String(o.nome ?? '').toLowerCase().startsWith(prefixoOpcao))
    if (opcao?.odd) return { odd: opcao.odd, probImplicita: opcao.probImplicita ?? oddParaProb(opcao.odd) }
  }
  return null
}

/** Acha, no mercado de Placar de Sets (Set Betting), a odd do placar exato
 *  em formato "mandante:visitante" (ex.: "2:0"). As opções desse mercado não
 *  batem em nenhum caso especial de rotuloOpcao (não são "1"/"X"/"2"/"Over"/
 *  "Under"), então chegam com o nome cru da API — normaliza separador antes
 *  de comparar ("2-0"/"2 - 0"/"2:0" tudo vira "2:0"). */
function buscarOddSetsDiretos(mercados, placarMandanteVisitante) {
  if (!Array.isArray(mercados) || !mercados.length) return null
  const mercado = mercados.find(m => /set betting|placar de sets|correct score \(sets\)/i.test(m.nome))
  if (!mercado) return null
  const opcao = (mercado.opcoes ?? []).find(o => {
    const nome = String(o.nome ?? '').replace(/\s+/g, '').replace('-', ':')
    return nome === placarMandanteVisitante
  })
  return opcao?.odd ? { odd: opcao.odd, probImplicita: opcao.probImplicita ?? oddParaProb(opcao.odd) } : null
}

// pontos percentuais mínimos de edge (prob. do modelo − prob. implícita da odd)
// pra considerar "valor real" — mesmo espírito do edge mínimo do futebol (valueConfig.js),
// só que fixo aqui por enquanto (tênis ainda não tem amostra própria de EV no Tracker
// pra calibrar esse mínimo por faixa de odd, como o futebol já faz).
const TENIS_EDGE_MINIMO_PP = 3

/** Empacota prob. do modelo + odd real (se houver) num objeto com EV/edge/valueBet. */
function enriquecerComOdd(prob, oddInfo) {
  const base = {
    prob,
    oddJusta: prob > 0 ? Math.round((100 / prob) * 100) / 100 : null,
    odd: null, probImplicita: null, ev: null, edge: null, valueBet: false,
  }
  if (!oddInfo?.odd) return base
  const ev   = calcularEV(prob, oddInfo.odd)
  const edge = oddInfo.probImplicita != null ? Math.round((prob - oddInfo.probImplicita) * 10) / 10 : null
  return {
    ...base,
    odd: oddInfo.odd,
    probImplicita: oddInfo.probImplicita,
    ev,
    edge,
    valueBet: ev != null && ev > 0 && edge != null && edge >= TENIS_EDGE_MINIMO_PP,
  }
}

/** ✅ NOVO (item 3) — cruza as probabilidades do MODELO PRÉ-JOGO de tênis
 *  (saída de calcularProbabilidadesTenis, idealmente já passada por
 *  calibrarJogosTenis) com as odds reais da FlashLive pra essa partida.
 *  Cobre os 3 mercados que o próprio modelo de tênis calcula — Vencedor (ML),
 *  Sets Diretos e Total de Games — pra responder "essa entrada recomendada
 *  tem valor real, ou só concorda com o favoritismo óbvio do mercado?".
 *  `oddsData` = resultado de buscarOddsPartida(jogo.id) (ou null/erro — nesse
 *  caso devolve tudo com odd: null, sem quebrar). */
export function cruzarOddsTenis(jogo, oddsData) {
  const mercados = Array.isArray(oddsData?.mercados) ? oddsData.mercados : []
  const semOdds  = !mercados.length

  // ── Vencedor (ML) — sempre do lado favorito do modelo ──
  const probMandante  = jogo.prob_mandante  ?? null
  const probVisitante = jogo.prob_visitante ?? null
  let vencedor = null
  if (probMandante != null && probVisitante != null) {
    const favoritoMandante = probMandante >= probVisitante
    const probFavorito     = Math.max(probMandante, probVisitante)
    const nomeFavorito     = favoritoMandante ? jogo.mandante : jogo.visitante
    const oddVencedor      = semOdds ? null : buscarOddVencedorTenis(mercados, favoritoMandante ? 'mandante' : 'visitante')
    vencedor = { jogador: nomeFavorito, ...enriquecerComOdd(probFavorito, oddVencedor) }
  }

  // ── Sets diretos (só existe quando o modelo achou um placar de sets diretos pro favorito) ──
  let setsDiretos = null
  const sd = jogo.mercadoStraightSets
  if (sd?.prob != null) {
    const [setsVencedor, setsPerdedor] = String(sd.placar).split('-').map(Number)
    const jogadorEhMandante = sd.jogador === jogo.mandante
    // placarStraightSets vem em "vencedor-perdedor"; o mercado de odds espera
    // "mandante:visitante" — inverte quando quem venceu foi o visitante
    const placarMV = jogadorEhMandante ? `${setsVencedor}:${setsPerdedor}` : `${setsPerdedor}:${setsVencedor}`
    const oddSD = semOdds ? null : buscarOddSetsDiretos(mercados, placarMV)
    setsDiretos = { jogador: sd.jogador, placar: sd.placar, ...enriquecerComOdd(sd.prob, oddSD) }
  }

  // ── Total de Games — cruza CADA linha que o modelo calculou, fica com a de maior valor ──
  let totalGames = null
  if (Array.isArray(jogo.mercadoTotalGames) && jogo.mercadoTotalGames.length) {
    const candidatos = jogo.mercadoTotalGames.flatMap(l => {
      const oddOver  = semOdds ? null : buscarOddTotalGamesTenis(mercados, l.linha, 'over')
      const oddUnder = semOdds ? null : buscarOddTotalGamesTenis(mercados, l.linha, 'under')
      return [
        { linha: l.linha, direcao: 'over',  ...enriquecerComOdd(l.over,  oddOver) },
        { linha: l.linha, direcao: 'under', ...enriquecerComOdd(l.under, oddUnder) },
      ]
    })
    candidatos.sort((a, b) => {
      if (a.valueBet !== b.valueBet) return a.valueBet ? -1 : 1
      if (a.ev != null && b.ev != null && a.ev !== b.ev) return b.ev - a.ev
      return b.prob - a.prob
    })
    totalGames = candidatos[0] ?? null
  }

  return { vencedor, setsDiretos, totalGames, semOdds }
}

/** ✅ NOVO (item 3) — versão em lote: busca a odd real de cada jogo (com
 *  intervalo entre chamadas pra não tomar rate-limit, mesmo cuidado de
 *  getOddsLiga no futebol) e devolve os jogos já enriquecidos com
 *  `analiseOdds`. Pensado pra rodar sobre a saída de calibrarJogosTenis. */
export async function cruzarOddsTenisLote(jogosTenis) {
  const jogos = []
  for (const jogo of (jogosTenis ?? [])) {
    let oddsData = null
    try {
      oddsData = await buscarOddsPartida(jogo.id, 'tenis')
    } catch (e) {
      console.warn(`[odds tênis] sem odds pra partida ${jogo.id}:`, e.message)
    }
    jogos.push({ ...jogo, analiseOdds: cruzarOddsTenis(jogo, oddsData) })
    await new Promise(r => setTimeout(r, 180))
  }
  const comOdds = jogos.filter(j => !j.analiseOdds.semOdds).length
  return { jogos, total: jogos.length, comOdds, semOdds: jogos.length - comOdds }
}

/** ✅ NOVO — Calcula a melhor entrada ao vivo pra uma partida de tênis
 *  específica (Vencedor da partida + Total de Games). Chamado sob demanda
 *  (botão "🎯 Calcular Melhor Entrada"), igual ao futebol. */
export async function analisarMelhorEntradaTenisAoVivo(matchId, contexto = {}) {
  const stats = await buscarEstatisticasTenisAoVivo(matchId)
  if (stats?.erro) throw new Error(stats.erro)

  const bestOf = (contexto.bestOf ?? stats.bestOf) === 5 ? 5 : 3
  const neededSets = Math.ceil(bestOf / 2)
  const setsGanhosMandante  = stats.setsMandante  ?? 0
  const setsGanhosVisitante = stats.setsVisitante ?? 0

  const { finalizados, atual } = separarSetsTenis(stats.placarSets, setsGanhosMandante, setsGanhosVisitante)
  const pMandante = estimarPSetMandante(setsGanhosMandante, setsGanhosVisitante, atual)
  const faltamM = Math.max(0, neededSets - setsGanhosMandante)
  const faltamV = Math.max(0, neededSets - setsGanhosVisitante)

  // ✅ CALIBRAÇÃO — mesmos fatores do Tracker usados no futebol (ver o FIX
  // de extrairProbTenis: as entradas salvas aqui gravam `probabilidade`,
  // que agora entra na conta de calibração de tênis).
  let fatoresCalib = null
  try { fatoresCalib = await calcFatoresCalibration() }
  catch (e) { console.warn('[ao-vivo tênis] calibração indisponível (seguindo com prob. bruta):', e.message) }

  // ── Vencedor da partida ──
  const probMandanteBruta  = probVenceRaceSets(faltamM, faltamV, pMandante) * 100
  const favoritoMandante   = probMandanteBruta >= 50
  const probFavoritoBruta  = favoritoMandante ? probMandanteBruta : 100 - probMandanteBruta

  const nVencedor     = fatoresCalib?.['_n_Tênis:Vencedor'] ?? 0
  const fatorVencedor = nVencedor >= 10 ? (fatoresCalib['Tênis:Vencedor'] ?? 1) : 1
  const probFavorito  = Math.round(Math.min(98, Math.max(50, probFavoritoBruta * fatorVencedor)))

  let entradaVencedor = null
  if (probFavorito >= TENIS_ZONA_MIN && probFavorito <= TENIS_ZONA_MAX) {
    const nomeFavorito = favoritoMandante
      ? (contexto.mandante ?? stats.mandante)
      : (contexto.visitante ?? stats.visitante)
    entradaVencedor = { mercado: `Vencedor: ${nomeFavorito}`, prob: probFavorito, direcao: null, linha: null }
  }

  // ── Total de Games ──
  const mediaGamesJogo = finalizados.length
    ? finalizados.reduce((s, st) => s + (st.casa ?? 0) + (st.fora ?? 0), 0) / finalizados.length
    : null
  const pesoMediaJogo = Math.min(0.7, finalizados.length * 0.35)
  const mediaGamesPorSet = mediaGamesJogo != null
    ? mediaGamesJogo * pesoMediaJogo + MEDIA_GAMES_POR_SET_TENIS * (1 - pesoMediaJogo)
    : MEDIA_GAMES_POR_SET_TENIS

  const gamesJaJogados =
    finalizados.reduce((s, st) => s + (st.casa ?? 0) + (st.fora ?? 0), 0) +
    (atual ? (atual.casa ?? 0) + (atual.fora ?? 0) : 0)

  const setsFuturos           = setsRestantesEsperados(faltamM, faltamV, pMandante)
  const gamesFaltantesSetAtual = atual ? Math.max(0, mediaGamesPorSet - ((atual.casa ?? 0) + (atual.fora ?? 0))) : 0
  const setsFuturosSemAtual    = Math.max(0, setsFuturos - (atual ? 1 : 0))
  const gamesRestantesEsperados = gamesFaltantesSetAtual + setsFuturosSemAtual * mediaGamesPorSet

  const linhaBase  = Math.round(gamesJaJogados + gamesRestantesEsperados) - 2
  const linhasGames = [0, 1, 2, 3, 4].map(i => linhaBase + i + 0.5).filter(l => l > gamesJaJogados)

  const nOver  = fatoresCalib?.['_n_Tênis:Over Games']  ?? 0
  const nUnder = fatoresCalib?.['_n_Tênis:Under Games'] ?? 0
  const fatorOver  = nOver  >= 10 ? (fatoresCalib['Tênis:Over Games']  ?? 1) : 1
  const fatorUnder = nUnder >= 10 ? (fatoresCalib['Tênis:Under Games'] ?? 1) : 1

  const candidatosGames = linhasGames.flatMap(linha => {
    const faltam = linha - gamesJaJogados
    const pOverBruta = poissonProbMaiorQue(Math.max(0.01, gamesRestantesEsperados), faltam) * 100
    const pOver  = Math.min(99, Math.max(1, pOverBruta * fatorOver))
    const pUnder = Math.min(99, Math.max(1, (100 - pOverBruta) * fatorUnder))
    return [
      { mercado: `Total de Games Over ${linha}`,  prob: Math.round(pOver  * 10) / 10, direcao: 'over',  linha },
      { mercado: `Total de Games Under ${linha}`, prob: Math.round(pUnder * 10) / 10, direcao: 'under', linha },
    ]
  })

  const naZonaGames  = candidatosGames.filter(c => c.prob >= TENIS_ZONA_MIN && c.prob <= TENIS_ZONA_MAX)
  const entradaGames = naZonaGames.length ? naZonaGames.sort((a, b) => b.prob - a.prob)[0] : null

  return {
    entradas: { vencedor: entradaVencedor, games: entradaGames },
    calibracaoAtiva: !!fatoresCalib && Object.entries(fatoresCalib).some(([k, v]) => !k.startsWith('_n_') && v !== 1),
    atualizadoEm: new Date(),
    // ✅ NOVO — Fase 1, item 4: qual versão do motor gerou esta previsão
    motorVersao: versaoAtual(MOTOR_TENIS_AOVIVO),
  }
}