// ligaStatsService.js — Média real de gols por liga (prior do modelo)
// Valores baseados em médias históricas típicas (gols por equipe / jogo)

const FALLBACK_MEDIA = {
  'BSA': 1.22, 'BL1': 1.48, 'PL': 1.42, 'PD': 1.28, 'SA': 1.30,
  'FL1': 1.35, 'DED': 1.40, 'PPL': 1.28, 'CLI': 1.20, 'CL': 1.38,
  'EL': 1.32,  'WC': 1.25,  'DEFAULT': 1.30,
}

// Banco em memória da sessão; em produção o ideal é persistir no Postgres
const _banco = {}  // { ligaCode: { total: N, gols: X } }

export function registrarJogo(ligaCode, golsMandante, golsVisitante) {
  if (!ligaCode) return
  if (golsMandante == null || golsVisitante == null) return
  if (!_banco[ligaCode]) _banco[ligaCode] = { total: 0, gols: 0 }
  _banco[ligaCode].total += 1
  _banco[ligaCode].gols  += Number(golsMandante) + Number(golsVisitante)
}

/**
 * Retorna média de gols POR EQUIPE (não total do jogo).
 * Com < 30 jogos no banco, usa fallback da liga (mais estável).
 */
export async function getMediaLiga(ligaCode) {
  const entrada = _banco[ligaCode]
  const fallback = FALLBACK_MEDIA[ligaCode] ?? FALLBACK_MEDIA.DEFAULT

  if (!entrada || entrada.total < 30) {
    // mistura leve se já tem alguns jogos
    if (entrada && entrada.total >= 10) {
      const emp = entrada.gols / entrada.total / 2 // por equipe
      const misturado = (entrada.total * emp + 30 * fallback) / (entrada.total + 30)
      return { marcados: parseFloat(misturado.toFixed(3)), totalJogos: entrada.total, fonte: 'misto' }
    }
    return { marcados: fallback, totalJogos: entrada?.total ?? 0, fonte: 'fallback' }
  }

  // total gols no jogo / 2 = média por equipe
  const media = parseFloat(((entrada.gols / entrada.total) / 2).toFixed(3))
  return { marcados: media, totalJogos: entrada.total, fonte: 'empirico' }
}

export function getFallbackMedia(ligaCode) {
  return FALLBACK_MEDIA[ligaCode] ?? FALLBACK_MEDIA.DEFAULT
}

// ─────────────────────────────────────────────────────────────
// ✅ NOVO — Médias reais de liga pra cartões e escanteios (mesmo padrão
// de getMediaLiga pra gols), usadas como prior no shrinkage bayesiano de
// calcMercadoCartoesEscanteios. Sem isso, a média dos últimos 6 jogos do
// time (amostra pequena, alta variância) ia direto pro lambda sem nenhuma
// regressão à média — um jogo com expulsão dupla distorcia tudo.
// ─────────────────────────────────────────────────────────────
const FALLBACK_CARTOES = {
  'BSA': 2.35, 'BL1': 1.95, 'PL': 1.75, 'PD': 2.30, 'SA': 2.15,
  'FL1': 2.05, 'DED': 1.85, 'PPL': 2.10, 'CLI': 2.20, 'CL': 1.90,
  'EL': 1.95,  'WC': 1.80,  'DEFAULT': 2.00,
}
const FALLBACK_ESCANTEIOS = {
  'BSA': 4.60, 'BL1': 5.10, 'PL': 5.30, 'PD': 4.90, 'SA': 4.70,
  'FL1': 5.00, 'DED': 5.20, 'PPL': 4.80, 'CLI': 4.50, 'CL': 5.10,
  'EL': 4.90,  'WC': 4.70,  'DEFAULT': 5.00,
}

// Bancos em memória da sessão; mesmo esquema do _banco de gols acima —
// em produção o ideal é persistir no Postgres junto com o outro.
const _bancoCartoes    = {}  // { ligaCode: { total: N, cartoes: X } }    — X = soma dos dois times no jogo
const _bancoEscanteios = {}  // { ligaCode: { total: N, escanteios: X } }

export function registrarJogoCartoesEscanteios(ligaCode, cartoesMandante, cartoesVisitante, escanteiosMandante, escanteiosVisitante) {
  if (!ligaCode) return
  if (cartoesMandante != null && cartoesVisitante != null) {
    if (!_bancoCartoes[ligaCode]) _bancoCartoes[ligaCode] = { total: 0, cartoes: 0 }
    _bancoCartoes[ligaCode].total   += 1
    _bancoCartoes[ligaCode].cartoes += Number(cartoesMandante) + Number(cartoesVisitante)
  }
  if (escanteiosMandante != null && escanteiosVisitante != null) {
    if (!_bancoEscanteios[ligaCode]) _bancoEscanteios[ligaCode] = { total: 0, escanteios: 0 }
    _bancoEscanteios[ligaCode].total      += 1
    _bancoEscanteios[ligaCode].escanteios += Number(escanteiosMandante) + Number(escanteiosVisitante)
  }
}

/**
 * Retorna média de cartões POR EQUIPE (não total do jogo).
 * Com < 30 jogos no banco, usa fallback da liga (mesmo padrão de getMediaLiga).
 */
export async function getMediaLigaCartoes(ligaCode) {
  const entrada  = _bancoCartoes[ligaCode]
  const fallback = FALLBACK_CARTOES[ligaCode] ?? FALLBACK_CARTOES.DEFAULT

  if (!entrada || entrada.total < 30) {
    if (entrada && entrada.total >= 10) {
      const emp       = entrada.cartoes / entrada.total / 2
      const misturado = (entrada.total * emp + 30 * fallback) / (entrada.total + 30)
      return { total: parseFloat(misturado.toFixed(3)), totalJogos: entrada.total, fonte: 'misto' }
    }
    return { total: fallback, totalJogos: entrada?.total ?? 0, fonte: 'fallback' }
  }

  const media = parseFloat(((entrada.cartoes / entrada.total) / 2).toFixed(3))
  return { total: media, totalJogos: entrada.total, fonte: 'empirico' }
}

/**
 * Retorna média de escanteios POR EQUIPE (não total do jogo).
 * Com < 30 jogos no banco, usa fallback da liga (mesmo padrão de getMediaLiga).
 */
export async function getMediaLigaEscanteios(ligaCode) {
  const entrada  = _bancoEscanteios[ligaCode]
  const fallback = FALLBACK_ESCANTEIOS[ligaCode] ?? FALLBACK_ESCANTEIOS.DEFAULT

  if (!entrada || entrada.total < 30) {
    if (entrada && entrada.total >= 10) {
      const emp       = entrada.escanteios / entrada.total / 2
      const misturado = (entrada.total * emp + 30 * fallback) / (entrada.total + 30)
      return { total: parseFloat(misturado.toFixed(3)), totalJogos: entrada.total, fonte: 'misto' }
    }
    return { total: fallback, totalJogos: entrada?.total ?? 0, fonte: 'fallback' }
  }

  const media = parseFloat(((entrada.escanteios / entrada.total) / 2).toFixed(3))
  return { total: media, totalJogos: entrada.total, fonte: 'empirico' }
}

// ─────────────────────────────────────────────────────────────
// ✅ NOVO — Fase 7: HOME ADVANTAGE calibrado por liga. Hoje o mando de campo
// só entra quando dá pra filtrar o histórico do time por localidade
// ("usou_localidade_mandante/visitante" em groqService.js) — quando isso
// falha (time sem jogos suficientes em casa/fora na janela), a vantagem de
// jogar em casa se perde. Aqui medimos a razão real gols-mandante /
// gols-visitante POR LIGA (Brasileirão tem mando de campo mais forte que a
// Champions, por exemplo) pra usar como correção nesses casos. Mesmo padrão
// de shrinkage/fallback do resto deste arquivo.
// ─────────────────────────────────────────────────────────────
const FALLBACK_HOME_ADVANTAGE = {
  'BSA': 1.35, 'BL1': 1.18, 'PL': 1.20, 'PD': 1.25, 'SA': 1.22,
  'FL1': 1.22, 'DED': 1.20, 'PPL': 1.25, 'CLI': 1.30, 'CL': 1.10,
  'EL': 1.12,  'WC': 1.05,  'DEFAULT': 1.20,
}
// valor = razão típica gols-mandante / gols-visitante; > 1 = vantagem real de jogar em casa

const _bancoMando = {}  // { ligaCode: { total: N, golsMandante: X, golsVisitante: Y } }

export function registrarJogoLocalidade(ligaCode, golsMandante, golsVisitante) {
  if (!ligaCode || golsMandante == null || golsVisitante == null) return
  if (!_bancoMando[ligaCode]) _bancoMando[ligaCode] = { total: 0, golsMandante: 0, golsVisitante: 0 }
  _bancoMando[ligaCode].total += 1
  _bancoMando[ligaCode].golsMandante += Number(golsMandante)
  _bancoMando[ligaCode].golsVisitante += Number(golsVisitante)
}

/** Razão gols-mandante/gols-visitante calibrada pra liga. Com < 30 jogos no
 *  banco, mistura com o fallback — mesmo padrão de getMediaLiga. */
export async function getHomeAdvantage(ligaCode) {
  const entrada = _bancoMando[ligaCode]
  const fallback = FALLBACK_HOME_ADVANTAGE[ligaCode] ?? FALLBACK_HOME_ADVANTAGE.DEFAULT

  if (!entrada || entrada.total < 30) {
    if (entrada && entrada.total >= 10 && entrada.golsVisitante > 0) {
      const emp = entrada.golsMandante / entrada.golsVisitante
      const misturado = (entrada.total * emp + 30 * fallback) / (entrada.total + 30)
      return { razao: parseFloat(misturado.toFixed(3)), totalJogos: entrada.total, fonte: 'misto' }
    }
    return { razao: fallback, totalJogos: entrada?.total ?? 0, fonte: 'fallback' }
  }

  const razao = entrada.golsVisitante > 0 ? entrada.golsMandante / entrada.golsVisitante : fallback
  return { razao: parseFloat(razao.toFixed(3)), totalJogos: entrada.total, fonte: 'empirico' }
}