// server/scrapers/tennisScraper.js
// Motor de previsão PRÉ-JOGO de tênis (probabilidades, fadiga, risco de desistência).
// Todos os dados de jogos/histórico/H2H vêm da FlashLive (flashscoreTennisScraper.js);
// este módulo não faz nenhuma requisição ao SofaScore.

import { enriquecerJogoTenis } from './allSportsTennisEnrich.js'
// ✅ FIX 25/09/2026 — jogo.mandanteId/visitanteId/id já vêm da FlashLive
// (Etapa 0/1). Buscar histórico/H2H em outra fonte com esses IDs sempre dá
// vazio (fontes diferentes) — é isso que causa o 50%/50% em todo jogo.
import {
  getHistoricoJogadorTenis as getHistoricoJogadorTenisFL, getH2HTenis as getH2HTenisFL,
  getIndiceRankingTenis, rankingDoJogador,
} from './flashscoreTennisScraper.js'
// ✅ NOVO — Fase 1, item 4 do roadmap: versionamento do motor
import { MOTOR_TENIS_PREJOGO, versaoAtual } from '../modelVersion.js'

// Cada jogo/confronto mais antigo pesa DECAY_FORMA% do jogo anterior a ele.
// Usada por taxaSetAjustada (mesma constante, um só lugar de verdade).
const DECAY_FORMA = 0.85

export async function getHistoricosJogosTenis(jogos) {
  const jogosParaProcessar = (jogos ?? []).slice(0, 3)
  // ✅ Ranking ATP/WTA via FlashLive (1 índice em memória, 6h)
  const indiceRanking = await getIndiceRankingTenis()

  // Um jogo por vez (e não os 3 em paralelo) pra não estourar o limite da RapidAPI (429)
  const resultado = []
  for (const jogo of jogosParaProcessar) {
    const [historicoMandante, historicoVisitante, h2h] = await Promise.all([
      getHistoricoJogadorTenisFL(jogo.mandanteId, 8),
      getHistoricoJogadorTenisFL(jogo.visitanteId, 8),
      getH2HTenisFL(jogo.id),
    ])

    const jogoComHistorico = {
      ...jogo, historicoMandante, historicoVisitante, h2h,
      // propriedade de ARRAY some no JSON (cache/front) — por isso o risco de desistência vai também no jogo
      riscoDesistenciaMandante:  historicoMandante?.riscoDesistencia  ?? null,
      riscoDesistenciaVisitante: historicoVisitante?.riscoDesistencia ?? null,
      rankingMandante:  rankingDoJogador(indiceRanking, jogo.mandanteId,  jogo.mandante),
      rankingVisitante: rankingDoJogador(indiceRanking, jogo.visitanteId, jogo.visitante),
    }

    // Enriquecimento AllSports — nunca lança erro, e some sozinho se ALLSPORTS_KEY não estiver configurada
    resultado.push(await enriquecerJogoTenis(jogoComHistorico))
  }

  return resultado
}

// ─────────────────────────────────────────────────────────────
// ETAPA 3 — CÁLCULO DE PROBABILIDADES
//
// Modelo base (sempre disponível): taxa de sets ganhos (últimos 8
// jogos) com shrinkage bayesiano + Bradley-Terry + blend com H2H.
//
// Modelo evoluído (quando o AllSportsAPI encontrou o jogador):
// soma 2 sinais extras ao blend, cada um com peso proporcional à
// confiança que dá pra ter neles:
//   - ranking oficial ATP/WTA (via função logística tipo Elo)
//   - taxa de vitória na SUPERFÍCIE do jogo (últimos 2 anos)
// Se o jogo/jogador não tiver esses dados, o peso deles vai a zero
// e o resultado final é idêntico ao modelo antigo — nada quebra.
// ─────────────────────────────────────────────────────────────
const SHRINKAGE_SETS_K = 6   // "pontos" de sets neutros pro shrinkage (~4 partidas de bo3)
const SHRINKAGE_H2H_K  = 6    // jogos de H2H neutros pro shrinkage (era 3 — H2H sem dado de recência ganhava peso demais com só 1 confronto)
const K_RANKING        = 6    // sensibilidade da curva de ranking (quanto menor, mais peso pra diferença de ranking)
const PESO_RANKING     = 0.35 // peso máximo do sinal de ranking no blend final (era 0.20)
const PESO_SUPERFICIE  = 0.22 // peso máximo do sinal de superfície no blend final (era 0.20)

function combinacao(n, k) {
  if (k < 0 || k > n) return 0
  let r = 1
  for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1)
  return r
}

function taxaSetAjustada(historico) {
  if (!historico?.length) return { taxa: 0.5, amostra: 0 }
  // pesos por recência NORMALIZADOS (média 1): o decaimento só redistribui a importância
  // entre os jogos, sem encolher o total e deixar o shrinkage dominar.
  const pesosBrutos = historico.map((_, i) => Math.pow(DECAY_FORMA, i))
  const escala = historico.length / pesosBrutos.reduce((a, b) => a + b, 0)

  let setsGanhosPond = 0, setsTotalPond = 0
  let setsGanhos = 0, setsTotal = 0
  historico.forEach((m, i) => {
    const peso = pesosBrutos[i] * escala
    const ganhos = m.setsGanhos ?? 0
    const perdidos = m.setsPerdidos ?? 0
    setsGanhosPond += ganhos * peso
    setsTotalPond  += (ganhos + perdidos) * peso
    setsGanhos += ganhos
    setsTotal  += ganhos + perdidos
  })
  if (setsTotalPond === 0) return { taxa: 0.5, amostra: 0 }
  const taxaAjustada = (setsGanhosPond + 0.5 * SHRINKAGE_SETS_K) / (setsTotalPond + SHRINKAGE_SETS_K)
  return { taxa: taxaAjustada, amostra: setsTotal, setsGanhos, setsTotal }
}

// ─────────────────────────────────────────────────────────────
// ✅ NOVO — Forma recente filtrada por SUPERFÍCIE do jogo de hoje.
// Antes, taxaSetAjustada usava os últimos 8 jogos do jogador não importa o
// piso — um jogador vindo de saibro jogando hoje em quadra dura tinha a
// "forma" contaminada por um contexto diferente. Agora: blend entre a forma
// geral (todos os pisos, mais amostra) e a forma só nos jogos daquele piso
// (mais específica, mas geralmente pouca amostra), com peso crescendo
// conforme a amostra na superfície aumenta — mesmo espírito de shrinkage já
// usado em SHRINKAGE_SETS_K/SHRINKAGE_H2H_K, só que aqui pesando dois sinais
// em vez de encolher um sinal rumo a 50%.
// Se o jogo não tiver piso conhecido, ou o jogador não tiver nenhum jogo
// registrado naquele piso, cai de volta pra forma geral — nada quebra.
// ─────────────────────────────────────────────────────────────
const PESO_MAX_FORMA_SUPERFICIE = 0.35 // teto do peso que a forma-na-superfície pode ganhar no blend
const K_FORMA_SUPERFICIE        = 10   // "sets" na superfície neutros pra essa ponderação crescer

function taxaSetAjustadaComSuperficie(historicoCompleto, piso) {
  const geral = taxaSetAjustada(historicoCompleto)
  if (!piso) return { ...geral, amostraSuperficie: 0, pesoSuperficieForma: 0 }

  const doPiso = (historicoCompleto ?? []).filter(m => m.piso === piso)
  if (!doPiso.length) return { ...geral, amostraSuperficie: 0, pesoSuperficieForma: 0 }

  // decaimento por recência aplicado DENTRO do próprio recorte de superfície
  // (o jogo mais recente naquele piso pesa mais que os antigos no mesmo piso)
  const supTaxa = taxaSetAjustada(doPiso)
  if (supTaxa.amostra === 0) return { ...geral, amostraSuperficie: 0, pesoSuperficieForma: 0 }

  const pesoSup   = Math.min(supTaxa.amostra / (supTaxa.amostra + K_FORMA_SUPERFICIE), PESO_MAX_FORMA_SUPERFICIE)
  const taxaFinal = (1 - pesoSup) * geral.taxa + pesoSup * supTaxa.taxa

  return {
    taxa: taxaFinal,
    amostra: geral.amostra,           // sets no total (geral) — mantém compatibilidade com quem já lê `amostra`
    amostraSuperficie: doPiso.length, // nº de PARTIDAS (não sets) naquele piso, pros avisos
    taxaSuperficie: supTaxa.taxa,
    pesoSuperficieForma: Math.round(pesoSup * 100) / 100,
  }
}

// ── Média de games por set, a partir do histórico de sets de cada jogador ──
// Usa o mesmo setsDetalhe que já vem populado em getHistoricoJogadorTenis
// (jogador/adversario = games do set, não sets do jogo).
function mediaGamesPorSet(historico) {
  if (!historico?.length) return { media: null, amostraSets: 0 }
  let totalGames = 0
  let totalSets = 0
  historico.forEach(m => {
    ;(m.setsDetalhe ?? []).forEach(s => {
      const a = Number(s.jogador), b = Number(s.adversario) // blindagem: histórico antigo em cache tem string
      if (s.jogador != null && s.adversario != null && Number.isFinite(a) && Number.isFinite(b)) {
        totalGames += (a + b)
        totalSets += 1
      }
    })
  })
  if (totalSets === 0) return { media: null, amostraSets: 0 }
  return { media: totalGames / totalSets, amostraSets: totalSets }
}

// fallback quando um dos dois jogadores não tem setsDetalhe suficiente —
// média histórica aproximada de games por set no circuito ATP/WTA
const MEDIA_GAMES_POR_SET_FALLBACK = 9.2

// probabilidade do mandante vencer baseada só na diferença de ranking oficial
// (função logística — mesmo espírito de uma curva Elo, calibrada pra ranking ATP/WTA)
function probPorRanking(rankMandante, rankVisitante) {
  if (!rankMandante || !rankVisitante) return null
  // usa log do ranking (diferença entre #3 e #8 importa muito mais que entre #103 e #108)
  const diff = Math.log(rankVisitante) - Math.log(rankMandante)
  return 1 / (1 + Math.exp(-diff * K_RANKING / 2))
}

// distribuição de placar dado p = prob. de vencer 1 set e o formato do jogo (bo3/bo5)
// Mantida para compatibilidade — é o caso particular de distribuicaoPlacarComEstado
// com sM = sV = 0 (jogo ainda não começou).
function distribuicaoPlacar(p, bestOf) {
  const majority = Math.ceil(bestOf / 2)   // 2 (bo3) ou 3 (bo5)
  const placares = []
  for (let k = 0; k < majority; k++) {
    const probVencedor = combinacao(majority - 1 + k, k) * Math.pow(p, majority) * Math.pow(1 - p, k)
    placares.push({ setsVencedor: majority, setsPerdedor: k, prob: probVencedor })
  }
  return placares
}

// ⚠️ CORREÇÃO: antes o modelo sempre previa o placar como se o jogo começasse
// do 0-0, ignorando sets que JÁ tinham sido jogados. Resultado: jogo já 1x0
// pro visitante e o sistema ainda saía anunciando "mandante vence 2-0".
// Essa função resolve o "problema dos pontos" (problem of points) a partir do
// placar ATUAL de sets (sM = sets já ganhos pelo mandante, sV = já ganhos pelo
// visitante), assumindo p = probabilidade do mandante fechar cada set restante
// (aproximação padrão em modelagem de tênis: p constante por set — o sistema
// não recebe dados de "ao vivo, ponto a ponto" pra recalibrar durante o set).
// Com sM = sV = 0 o resultado é idêntico ao de distribuicaoPlacar (mesma fórmula).
function distribuicaoPlacarComEstado(p, sM, sV, bestOf) {
  const majority = Math.ceil(bestOf / 2)
  const faltamMandante  = majority - sM
  const faltamVisitante = majority - sV

  // alguém já fechou o jogo (placar da API desatualizado ou jogo finished)
  if (faltamMandante <= 0) return [{ setsVencedor: sM, setsPerdedor: sV, prob: 1, jogador: 'mandante' }]
  if (faltamVisitante <= 0) return [{ setsVencedor: sV, setsPerdedor: sM, prob: 1, jogador: 'visitante' }]

  const placares = []
  // mandante fecha vencendo os "faltamMandante" sets que precisa, tendo perdido k sets extras no caminho
  for (let k = 0; k < faltamVisitante; k++) {
    const prob = combinacao(faltamMandante - 1 + k, k) * Math.pow(p, faltamMandante) * Math.pow(1 - p, k)
    placares.push({ setsVencedor: sM + faltamMandante, setsPerdedor: sV + k, prob, jogador: 'mandante' })
  }
  // visitante fecha vencendo os "faltamVisitante" sets que precisa
  for (let k = 0; k < faltamMandante; k++) {
    const prob = combinacao(faltamVisitante - 1 + k, k) * Math.pow(1 - p, faltamVisitante) * Math.pow(p, k)
    placares.push({ setsVencedor: sV + faltamVisitante, setsPerdedor: sM + k, prob, jogador: 'visitante' })
  }
  return placares
}

// ─────────────────────────────────────────────────────────────
// MERCADO DE TOTAL DE GAMES (Over/Under) — equivalente tenístico do
// Over/Under de gols do futebol.
// ─────────────────────────────────────────────────────────────
function erf(x) {
  const sinal = x < 0 ? -1 : 1
  x = Math.abs(x)
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911
  const t = 1 / (1 + p * x)
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x)
  return sinal * y
}

function probNormalMaiorQue(linha, mu, sigma) {
  if (sigma <= 0) return linha < mu ? 1 : 0
  const z = (linha - mu) / (sigma * Math.SQRT2)
  return 0.5 * (1 - erf(z))
}

function mercadoOverUnderGames(mediaEstimada, faixaMin, faixaMax) {
  if (mediaEstimada == null) return []
  const sigma = Math.max((faixaMax - faixaMin) / (2 * 1.645), 1.2)
  const centro = Math.floor(mediaEstimada) + 0.5
  const linhas = [centro - 2, centro - 1, centro, centro + 1, centro + 2]

  return linhas.map(linha => {
    const probOver = probNormalMaiorQue(linha, mediaEstimada, sigma)
    return {
      linha,
      over:  Math.round(probOver * 1000) / 10,
      under: Math.round((1 - probOver) * 1000) / 10,
    }
  })
}


// ─────────────────────────────────────────────────────────────
// SINAL: FADIGA / SEQUÊNCIA DE JOGOS (nice-to-have #5)
// Usa o histórico já buscado (getHistoricoJogadorTenis) — zero chamadas
// extras. Score 0 (descansado) a 1 (fadiga alta), combinando:
//   - descanso curto desde o último jogo (≤1 dia pesa mais que 2 dias)
//   - jogos extras disputados nos últimos 5 dias
//   - último jogo decisivo (3+ sets) com descanso curto
// ─────────────────────────────────────────────────────────────
function calcularFadiga(historico) {
  if (!historico?.length) return { diasDescanso: null, jogosUltimos5Dias: 0, jogoDecisivoRecente: false, score: 0 }

  const agora = Date.now() / 1000
  const ultimo = historico[0] // já vem ordenado por data desc
  const diasDescanso = ultimo?.data != null ? Math.floor((agora - ultimo.data) / 86400) : null
  const jogosUltimos5Dias = historico.filter(h => h.data != null && (agora - h.data) <= 5 * 86400).length
  const jogoDecisivoRecente = diasDescanso != null && diasDescanso <= 1 &&
    (ultimo.setsGanhos + ultimo.setsPerdidos) >= 3

  let score = 0
  if (diasDescanso != null) {
    if (diasDescanso <= 1) score += 0.5
    else if (diasDescanso === 2) score += 0.2
  }
  score += Math.max(0, jogosUltimos5Dias - 1) * 0.15
  if (jogoDecisivoRecente) score += 0.15

  return { diasDescanso, jogosUltimos5Dias, jogoDecisivoRecente, score: Math.min(score, 1) }
}

export function calcularProbabilidadesTenis(jogosComHistorico) {
  const analisados = (jogosComHistorico ?? []).map(jogo => {
    const bestOf = jogo.bestOf ?? 3

    // ✅ NOVO — forma recente já vem filtrada/blendada por superfície (jogo.piso)
    // quando há amostra suficiente naquele piso; cai pra forma geral senão.
    const m = taxaSetAjustadaComSuperficie(jogo.historicoMandante, jogo.piso)
    const v = taxaSetAjustadaComSuperficie(jogo.historicoVisitante, jogo.piso)

    // ── Sinal base: Bradley-Terry combinando as duas "forças" de sets ──
    let pMandante = m.taxa / (m.taxa + v.taxa || 1)
    let pesoUsado = { sets: 1, h2h: 0, ranking: 0, superficie: 0, formaSuperficie: 0, fadiga: 0 } // só pra debug/transparência
    // maior dos dois pesos (mandante/visitante) só pra sinalizar nas fontesUsadas/avisos
    pesoUsado.formaSuperficie = Math.max(m.pesoSuperficieForma ?? 0, v.pesoSuperficieForma ?? 0)

    // ── Blend com H2H, se houver amostra (shrinkage também aqui) ──
    const h2h = jogo.h2h
    if (h2h && !h2h.semDados && h2h.totalJogos > 0) {
      // peso do sinal H2H no blend geral continua baseado na amostra BRUTA
      // (quantos confrontos existem) — isso é uma pergunta de "confiança",
      // separada de "qual foi o resultado desses confrontos".
      const pesoH2H = h2h.totalJogos / (h2h.totalJogos + SHRINKAGE_H2H_K)
      // ⚠️ Fix: probMandanteH2H era usado cru (ex: 3-0 = 100% = certeza absoluta).
      // Agora aplica o mesmo shrinkage bayesiano rumo a 50% que já existe em
      // taxaSetAjustada — evita que um H2H pequeno (3 jogos) empurre o modelo
      // quase pra certeza, mesmo com peso pequeno no blend.
      // ✅ NOVO — usa vitoriasMandantePonderada/totalJogosPonderado (decaimento
      // por recência) em vez do placar cru: um confronto de 2019 já não pesa
      // igual a um de 2025 na estimativa do PLACAR do H2H.
      const vitPond   = h2h.resumo.vitoriasMandantePonderada ?? h2h.resumo.vitoriasMandante
      const totalPond = h2h.resumo.totalJogosPonderado ?? h2h.totalJogos
      const pH2H = (vitPond + 0.5 * SHRINKAGE_H2H_K) / (totalPond + SHRINKAGE_H2H_K)
      pMandante = (1 - pesoH2H) * pMandante + pesoH2H * pH2H
      pesoUsado.h2h = Math.round(pesoH2H * 100) / 100
    }

    // ── Sinal evoluído: ranking oficial ATP/WTA ──
    // ✅ Fix (auditoria 09/08/2026): antes dependia 100% do AllSportsAPI
    // (matching por nome + chave válida). Agora usa o ranking que o próprio
    // A FlashLive já manda em cada evento (jogo.rankingMandante/Visitante,
    // vindo direto de getJogosTenisHoje — zero chamadas extras, zero
    // dependência de chave externa) como fonte PRIMÁRIA. O AllSportsAPI
    // só entra como fallback se a FlashLive não tiver o dado (raro — só
    // acontece com jogador fora da lista de ranking ativa).
    const rankM = jogo.rankingMandante  ?? jogo.enriquecimentoMandante?.ranking  ?? null
    const rankV = jogo.rankingVisitante ?? jogo.enriquecimentoVisitante?.ranking ?? null
    const pRanking = probPorRanking(rankM, rankV)
    if (pRanking != null) {
      pMandante = (1 - PESO_RANKING) * pMandante + PESO_RANKING * pRanking
      pesoUsado.ranking = PESO_RANKING
    }

    // ── Sinal evoluído: taxa de vitória na superfície do jogo (últimos 2 anos) ──
    const supM = jogo.enriquecimentoMandante?.superficie
    const supV = jogo.enriquecimentoVisitante?.superficie
    // ⚠️ Fix: taxa 0-0 (ninguém venceu nesse piso ainda) virava "0 || 1 = 1" e
    // derrubava pSuperficie pra 0 (100% visitante "de graça"). Se vier NaN/undefined
    // do enriquecimento, o sinal contaminava pMandante inteiro. Agora: 0-0 vira
    // neutro (0.5) e taxa inválida faz o sinal ser ignorado, não corrompido.
    if (supM && supV && Number.isFinite(supM.taxa) && Number.isFinite(supV.taxa)) {
      const somaTaxas = supM.taxa + supV.taxa
      const pSuperficie = somaTaxas > 0 ? supM.taxa / somaTaxas : 0.5
      pMandante = (1 - PESO_SUPERFICIE) * pMandante + PESO_SUPERFICIE * pSuperficie
      pesoUsado.superficie = PESO_SUPERFICIE
    }

    // ── Sinal: fadiga/sequência de jogos ──
    const PESO_FADIGA = 0.08 // peso baixo — sinal secundário, nice-to-have
    const fadigaM = calcularFadiga(jogo.historicoMandante)
    const fadigaV = calcularFadiga(jogo.historicoVisitante)
    if (fadigaM.score > 0 || fadigaV.score > 0) {
      const diffFadiga = fadigaV.score - fadigaM.score // >0 = visitante mais cansado, favorece mandante
      pMandante = Math.min(Math.max(pMandante + diffFadiga * PESO_FADIGA, 0.02), 0.98)
      pesoUsado.fadiga = Math.round(Math.abs(diffFadiga) * PESO_FADIGA * 100) / 100
    }

    const pVisitante = 1 - pMandante

    // ── Estado atual do jogo: sets já ganhos por cada lado, se já começou ──
    // Na FlashLive, pra tênis, homeScore.current/awayScore.current já É a
    // contagem de sets vencidos (não pontos/games) — mesma convenção usada
    // em getHistoricoJogadorTenis mais acima.
    const setsMandanteAgora  = jogo.placarSets?.totalCasa ?? 0
    const setsVisitanteAgora = jogo.placarSets?.totalFora ?? 0
    const jogoEmAndamento = jogo.status === 'inprogress' && (setsMandanteAgora > 0 || setsVisitanteAgora > 0)

    // todosPlacares já sai em "sets totais do jogo" (não só os que faltam),
    // então o placar previsto respeita sets que já foram perdidos/ganhos.
    const todosPlacares = distribuicaoPlacarComEstado(pMandante, setsMandanteAgora, setsVisitanteAgora, bestOf)
      .sort((a, b) => b.prob - a.prob)

    // ── Estimativa de total de games do jogo ──
    const gamesMandante  = mediaGamesPorSet(jogo.historicoMandante)
    const gamesVisitante = mediaGamesPorSet(jogo.historicoVisitante)

    let mediaGamesPorSetCombinada
    if (gamesMandante.media != null && gamesVisitante.media != null) {
      mediaGamesPorSetCombinada = (gamesMandante.media + gamesVisitante.media) / 2
    } else {
      mediaGamesPorSetCombinada = gamesMandante.media ?? gamesVisitante.media ?? MEDIA_GAMES_POR_SET_FALLBACK
    }

    // ── Ajuste por desequilíbrio: jogo muito lopsided tende a ter sets mais
    // "secos" (6-2, 6-3) do que um jogo parelho (6-4, 7-5) — o jogador mais
    // fraco quebra menos e segura menos o próprio saque. Sem isso, a média
    // histórica bruta faz jogos com favoritismos bem diferentes (ex: 78% x
    // 60%) darem quase o mesmo total de games estimado, o que é pouco realista.
    // desequilibrio vai de 0 (50-50, jogo parelho) a 1 (100-0, blowout total).
    const desequilibrio = Math.abs(pMandante - 0.5) * 2
    const FATOR_MAX_REDUCAO = 0.15 // teto de 15% de redução mesmo no blowout mais extremo
    const fatorAjusteDesequilibrio = 1 - desequilibrio * FATOR_MAX_REDUCAO
    mediaGamesPorSetCombinada *= fatorAjusteDesequilibrio

    // games já disputados de verdade, se o jogo já começou
    const gamesJaJogados = (jogo.placarSets?.sets ?? [])
      .filter(s => s.casa != null && s.fora != null)
      .reduce((soma, s) => soma + s.casa + s.fora, 0)

    // nº de sets esperado pro jogo TODO, ponderado pela distribuição de placares
    const setsJaDisputados = setsMandanteAgora + setsVisitanteAgora
    const numSetsEsperadoTotal = todosPlacares.reduce(
      (soma, x) => soma + (x.setsVencedor + x.setsPerdedor) * x.prob, 0
    )
    const setsRestantesEsperado = Math.max(0, numSetsEsperadoTotal - setsJaDisputados)

    const totalGamesEstimado = Math.round(gamesJaJogados + setsRestantesEsperado * mediaGamesPorSetCombinada)
    const totalGamesMin = Math.round(gamesJaJogados + setsRestantesEsperado * Math.max(mediaGamesPorSetCombinada - 1.5, 6))
    const totalGamesMax = Math.round(gamesJaJogados + setsRestantesEsperado * (mediaGamesPorSetCombinada + 1.5))

    const probMandanteVence  = todosPlacares.filter(x => x.jogador === 'mandante').reduce((s, x) => s + x.prob, 0)
    const probVisitanteVence = todosPlacares.filter(x => x.jogador === 'visitante').reduce((s, x) => s + x.prob, 0)

    const placarMandante  = todosPlacares.filter(x => x.jogador === 'mandante')
    const placarVisitante = todosPlacares.filter(x => x.jogador === 'visitante')

    // "straight sets" = vencedor não perde NENHUM set no jogo inteiro — se ele já
    // perdeu um set hoje, deixa automaticamente de existir no lado dele (setsPerdedor nunca dá 0)
    const placarStraightSets = todosPlacares
      .filter(x => x.setsPerdedor === 0)
      .sort((a, b) => b.prob - a.prob)[0]

    const confianca =
      Math.max(probMandanteVence, probVisitanteVence) >= 0.70 ? 'Alta' :
      Math.max(probMandanteVence, probVisitanteVence) >= 0.58 ? 'Média' : 'Baixa'

    // ── Recomendação de melhor entrada: Vitória (ML) vs Sets Diretos ──
    // Sets diretos é quase sempre o placar de MAIOR prob. individual quando
    // p > 50% (é a moda da distribuição) — não significa que seja a entrada
    // mais segura. Compara quanto da prob. de vitória está "concentrada" em
    // sets diretos pra decidir o que recomendar.
    const probVitoriaFavorito = Math.max(probMandanteVence, probVisitanteVence)
    const favoritoLado = probMandanteVence >= probVisitanteVence ? 'mandante' : 'visitante'
    const probSetsDiretosFavorito = (placarStraightSets && placarStraightSets.jogador === favoritoLado)
      ? placarStraightSets.prob : 0
    const concentracaoSD = probVitoriaFavorito > 0 ? probSetsDiretosFavorito / probVitoriaFavorito : 0

    // ⚙️ pontos de partida — ajuste conforme o Tracker mostrar (mesmo espírito do valueConfig.js)
    const LIMIAR_VITORIA_MIN = 0.60
    const LIMIAR_SD_PROB     = 0.60
    const LIMIAR_SD_CONCENT  = 0.68

    let recomendacaoEntrada
    if (probVitoriaFavorito < LIMIAR_VITORIA_MIN) {
      recomendacaoEntrada = { tipo: 'evitar', motivo: `Favoritismo fraco (${Math.round(probVitoriaFavorito * 100)}%) — confiança baixa pra qualquer entrada.` }
    } else if (probSetsDiretosFavorito >= LIMIAR_SD_PROB && concentracaoSD >= LIMIAR_SD_CONCENT) {
      recomendacaoEntrada = { tipo: 'sets_diretos', motivo: `Sets diretos concentra ${Math.round(concentracaoSD * 100)}% da prob. de vitória (${Math.round(probSetsDiretosFavorito * 100)}% própria) — baixo risco do adversário levar set.` }
    } else {
      recomendacaoEntrada = { tipo: 'vitoria', motivo: `Vitória (ML) é mais segura: sets diretos só ${Math.round(probSetsDiretosFavorito * 100)}% vs ${Math.round(probVitoriaFavorito * 100)}% de vitória — chance real de ir a 3 sets.` }
    }

    // fontes usadas nessa análise — transparência pro usuário ver o que entrou na conta
    const fontesUsadas = ['Forma recente (sets)']
    if (pesoUsado.formaSuperficie > 0) fontesUsadas.push(`Forma no piso (${jogo.piso})`)
    if (pesoUsado.h2h > 0) fontesUsadas.push('H2H')
    if (pesoUsado.ranking > 0) fontesUsadas.push(`Ranking oficial (#${rankM} x #${rankV})`)
    if (pesoUsado.superficie > 0) fontesUsadas.push(`Superfície (${supM.piso})`)
    if (pesoUsado.fadiga > 0) fontesUsadas.push('Fadiga/sequência de jogos')
    if (jogoEmAndamento) fontesUsadas.push(`Placar ao vivo (${setsMandanteAgora}-${setsVisitanteAgora})`)

    // ── Avisos de diagnóstico ──
    const avisos = []
    if (pesoUsado.ranking === 0) {
      avisos.push('⚠️ Ranking oficial não encontrado nem pela FlashLive nem pelo AllSportsAPI (jogador provavelmente fora do ranking ativo do circuito) — probabilidade baseada só em forma recente' + (pesoUsado.h2h > 0 ? ' + H2H' : '') + '.')
    } else if (pesoUsado.ranking > 0 && (!rankM || !rankV)) {
      avisos.push('⚠️ Ranking encontrado só para um dos jogadores — sinal de ranking ignorado nesse jogo.')
    }
    if (pesoUsado.superficie === 0) {
      avisos.push('ℹ️ Sem dado de aproveitamento por superfície pros dois jogadores nos últimos 2 anos.')
    }
    if (!h2h || h2h.semDados || h2h.totalJogos === 0) {
      avisos.push('ℹ️ Primeiro confronto entre os dois jogadores (sem histórico de H2H).')
    } else if (h2h.porSuperficie && Object.keys(h2h.porSuperficie).length > 1) {
      // ✅ NOVO — H2H com jogos em mais de um piso: mostra o recorte
      // (ex.: "H2H por piso: Clay 3-1 · Hard 0-2")
      const recorte = Object.entries(h2h.porSuperficie)
        .map(([piso, r]) => `${piso} ${r.vitoriasMandante}-${r.vitoriasVisitante}`)
        .join(' · ')
      avisos.push(`ℹ️ H2H por piso: ${recorte}.`)
    }
    if ((m.amostra ?? 0) < 6 || (v.amostra ?? 0) < 6) {
      avisos.push(`⚠️ Amostra de forma recente pequena (${jogo.mandante}: ${m.amostra ?? 0} sets · ${jogo.visitante}: ${v.amostra ?? 0} sets em até 8 jogos) — modelo menos confiável.`)
    }
    if (jogo.piso && pesoUsado.formaSuperficie === 0) {
      avisos.push(`ℹ️ Sem jogos recentes de nenhum dos dois jogadores no piso desta partida (${jogo.piso}) — forma baseada em todos os pisos.`)
    }
    if (fadigaM.score >= 0.5) {
      avisos.push(`⚠️ ${jogo.mandante} com sinal de fadiga (${fadigaM.diasDescanso ?? '?'}d de descanso, ${fadigaM.jogosUltimos5Dias} jogo(s) nos últimos 5 dias${fadigaM.jogoDecisivoRecente ? ', último foi decisivo' : ''}).`)
    }
    if (fadigaV.score >= 0.5) {
      avisos.push(`⚠️ ${jogo.visitante} com sinal de fadiga (${fadigaV.diasDescanso ?? '?'}d de descanso, ${fadigaV.jogosUltimos5Dias} jogo(s) nos últimos 5 dias${fadigaV.jogoDecisivoRecente ? ', último foi decisivo' : ''}).`)
    }

    // ── Risco de desistência (walkover/retirement) — nice-to-have #6 ──
    const riscoM = jogo.riscoDesistenciaMandante ?? jogo.historicoMandante?.riscoDesistencia
    const riscoV = jogo.riscoDesistenciaVisitante ?? jogo.historicoVisitante?.riscoDesistencia
    const LIMIAR_RISCO_DESISTENCIA = 0.15 // ~1 em cada 7 jogos recentes
    if (riscoM && riscoM.totalChecados >= 5 && riscoM.taxa >= LIMIAR_RISCO_DESISTENCIA) {
      avisos.push(`🚩 ${jogo.mandante} com histórico de desistência: ${riscoM.retirements} de ${riscoM.totalChecados} jogos recentes terminaram em retirement/walkover — risco pra entradas ao vivo.`)
    }
    if (riscoV && riscoV.totalChecados >= 5 && riscoV.taxa >= LIMIAR_RISCO_DESISTENCIA) {
      avisos.push(`🚩 ${jogo.visitante} com histórico de desistência: ${riscoV.retirements} de ${riscoV.totalChecados} jogos recentes terminaram em retirement/walkover — risco pra entradas ao vivo.`)
    }

    // ── Mercado de total de games (Over/Under) ──
    const mercadoTotalGames = mercadoOverUnderGames(totalGamesEstimado, totalGamesMin, totalGamesMax)

    return {
      ...jogo,
      // ✅ NOVO — Fase 1, item 4: qual versão do motor gerou esta previsão
      motor_versao: versaoAtual(MOTOR_TENIS_PREJOGO),
      prob_mandante:  Math.round(probMandanteVence * 100),
      prob_visitante: Math.round(probVisitanteVence * 100),
      placarMandante:  placarMandante.map(x  => ({ placar: `${x.setsVencedor}-${x.setsPerdedor}`, prob: Math.round(x.prob * 100) })),
      placarVisitante: placarVisitante.map(x => ({ placar: `${x.setsVencedor}-${x.setsPerdedor}`, prob: Math.round(x.prob * 100) })),
      melhorPlacar: {
        jogador: todosPlacares[0].jogador === 'mandante' ? jogo.mandante : jogo.visitante,
        placar:  `${todosPlacares[0].setsVencedor}-${todosPlacares[0].setsPerdedor}`,
        prob:    Math.round(todosPlacares[0].prob * 100),
      },
      // se o jogo já está em andamento e os dois lados já perderam sets, straight
      // sets deixou de ser possível — nesse caso não existe mercadoStraightSets
      mercadoStraightSets: placarStraightSets ? {
        jogador: placarStraightSets.jogador === 'mandante' ? jogo.mandante : jogo.visitante,
        placar:  `${placarStraightSets.setsVencedor}-${placarStraightSets.setsPerdedor}`,
        prob:    Math.round(placarStraightSets.prob * 100),
      } : null,
      confianca,
      recomendacaoEntrada,
      amostra: {
        mandante: m.amostra, visitante: v.amostra, h2h: h2h?.totalJogos ?? 0,
        // ✅ NOVO — amostra específica no piso do jogo de hoje (nº de partidas, não sets)
        mandanteNoPiso: m.amostraSuperficie ?? 0, visitanteNoPiso: v.amostraSuperficie ?? 0,
      },
      riscoDesistencia: {
        mandante: jogo.riscoDesistenciaMandante ?? jogo.historicoMandante?.riscoDesistencia ?? null,
        visitante: jogo.riscoDesistenciaVisitante ?? jogo.historicoVisitante?.riscoDesistencia ?? null,
      },
      totalGamesEstimado: {
        estimado: totalGamesEstimado,
        faixaMin: totalGamesMin,
        faixaMax: totalGamesMax,
        mediaGamesPorSetHistorico: Math.round(mediaGamesPorSetCombinada * 10) / 10,
        amostraSets: { mandante: gamesMandante.amostraSets, visitante: gamesVisitante.amostraSets },
      },
      fontesUsadas,
      avisos,
      mercadoTotalGames,
      rankingMandante: rankM ?? null,
      rankingVisitante: rankV ?? null,
      analise:
        `${jogo.mandante} x ${jogo.visitante} (melhor de ${bestOf}` +
        `${jogoEmAndamento ? `, já em ${setsMandanteAgora}-${setsVisitanteAgora}` : ''}): modelo aponta ` +
        `${probMandanteVence >= probVisitanteVence ? jogo.mandante : jogo.visitante} favorito com ` +
        `${Math.max(Math.round(probMandanteVence * 100), Math.round(probVisitanteVence * 100))}% de chance de vitória. ` +
        `Placar mais provável: ${todosPlacares[0].jogador === 'mandante' ? jogo.mandante : jogo.visitante} ${todosPlacares[0].setsVencedor}-${todosPlacares[0].setsPerdedor} ` +
        `(${Math.round(todosPlacares[0].prob * 100)}%). ` +
        `Total de games estimado: ~${totalGamesEstimado} (faixa ${totalGamesMin}-${totalGamesMax}). ` +
        `Fontes: ${fontesUsadas.join(' + ')}.` +
        (avisos.length ? ` ${avisos.join(' ')}` : ''),
    }
  })

  return { total: analisados.length, jogos: analisados }
}