// multiplaService.js — lógica da MÚLTIPLA SUGERIDA e das mensagens do Telegram.
// ─────────────────────────────────────────────────────────────
// Extraído do App.jsx pra ser usado pelos DOIS lados com o mesmo código:
//   • o site (App.jsx importa daqui)
//   • o bot do Telegram no servidor (server/telegramAnalise.js importa daqui)
// Sem React, sem window, sem localStorage — só funções puras.
// ─────────────────────────────────────────────────────────────

/** ✅ NOVO — coleta TODAS as entradas candidatas de um jogo (gols, cartões e
 *  escanteios), já marcadas com a categoria e os dados do jogo */
export function coletarCandidatosJogo(jogo) {
  const candidatos = []

  if (jogo.melhor_entrada_over_gols)  candidatos.push({ categoria: 'gols', tipo: '⚽ Gols', ...jogo.melhor_entrada_over_gols })
  if (jogo.melhor_entrada_under_gols) candidatos.push({ categoria: 'gols', tipo: '⚽ Gols', ...jogo.melhor_entrada_under_gols })

  const meCE = jogo.mercado_cartoes_escanteios?.melhorEntrada
  if (meCE?.cartoesOver)     candidatos.push({ categoria: 'cartoes',    tipo: '🟨 Cartões',    ...meCE.cartoesOver })
  if (meCE?.cartoesUnder)    candidatos.push({ categoria: 'cartoes',    tipo: '🟨 Cartões',    ...meCE.cartoesUnder })
  if (meCE?.escanteiosOver)  candidatos.push({ categoria: 'escanteios', tipo: '🚩 Escanteios', ...meCE.escanteiosOver })
  if (meCE?.escanteiosUnder) candidatos.push({ categoria: 'escanteios', tipo: '🚩 Escanteios', ...meCE.escanteiosUnder })

  return candidatos.map(c => ({
    ...c,
    mandante: jogo.mandante,
    visitante: jogo.visitante,
    competicao: jogo.competicao,
    horario: jogo.horario,
  }))
}

// ✅ NOVO — ranking de confiança pra poder filtrar e ordenar candidatos
export const CONFIANCA_RANK = { Alta: 3, 'Média': 2, Baixa: 1 }

export function scoreCandidato(c) {
  return (CONFIANCA_RANK[c.confianca] ?? 0) * 1000 + (c.prob ?? 0)
}

/** Escolhe o melhor de uma lista de candidatos: prioriza quem está na
 *  "zona útil" (55–75%), depois a maior probabilidade */
export function melhorCandidato(lista) {
  if (!lista.length) return null
  return lista.reduce((a, b) => {
    if (a.naZonaUtil && !b.naZonaUtil) return a
    if (b.naZonaUtil && !a.naZonaUtil) return b
    return (b.prob ?? 0) > (a.prob ?? 0) ? b : a
  })
}



/** ✅ NOVO — monta a múltipla garantindo 1 entrada de Gols + 1 de Cartões +
 *  1 de Escanteios, cada uma sendo a melhor entre TODOS os jogos pesquisados
 *  naquela categoria. Se uma categoria não tiver dado em nenhum jogo, ela
 *  fica de fora (a múltipla sai com menos de 3 pernas nesse caso). */
export function montarMultiplaSugerida(jogos, opts = {}) {
  const {
    maxPernasPorJogo = 1,
    maxPernasTotal   = 4,
  } = opts

  if (!jogos?.length) return { grupos: [], confiancaUsada: null }

  // ✅ Fix: antes só tentava com confiança "Alta" — se nenhum jogo tivesse
  // pelo menos 1 mercado Alta, a lista ficava vazia e o botão flutuante
  // sumia inteiro, sem nenhum aviso. Agora tenta Alta → Média → Baixa,
  // nessa ordem, e devolve qual piso foi realmente usado, pra podermos
  // avisar o usuário em vez de esconder tudo.
  const ORDEM_CONFIANCA = ['Alta', 'Média', 'Baixa']

  for (const confiancaMinima of ORDEM_CONFIANCA) {
    const rankMinimo = CONFIANCA_RANK[confiancaMinima]

    const porJogo = jogos.map(jogo => {
      const candidatos = coletarCandidatosJogo(jogo)
        .filter(c => (CONFIANCA_RANK[c.confianca] ?? 0) >= rankMinimo)
      if (!candidatos.length) return null

      const melhorGols       = melhorCandidato(candidatos.filter(c => c.categoria === 'gols'))
      const melhorCartoes    = melhorCandidato(candidatos.filter(c => c.categoria === 'cartoes'))
      const melhorEscanteios = melhorCandidato(candidatos.filter(c => c.categoria === 'escanteios'))

      const pernas = [melhorGols, melhorCartoes, melhorEscanteios]
        .filter(Boolean)
        .sort((a, b) => scoreCandidato(b) - scoreCandidato(a))
        .slice(0, maxPernasPorJogo)

      if (!pernas.length) return null
      return { mandante: jogo.mandante, visitante: jogo.visitante, competicao: jogo.competicao, horario: jogo.horario, pernas }
    }).filter(Boolean)

    if (!porJogo.length) continue // nada nesse piso — tenta o próximo, mais permissivo

    const primeiras = porJogo.map(g => g.pernas[0])
    const extras    = porJogo.flatMap(g => g.pernas.slice(1))

    let selecionadas = [...primeiras]
      .sort((a, b) => scoreCandidato(b) - scoreCandidato(a))
      .slice(0, maxPernasTotal)

    const vagas = maxPernasTotal - selecionadas.length
    if (vagas > 0 && extras.length) {
      const extrasOrdenadas = [...extras].sort((a, b) => scoreCandidato(b) - scoreCandidato(a))
      selecionadas = [...selecionadas, ...extrasOrdenadas.slice(0, vagas)]
    }

    const grupos = porJogo
      .map(g => ({ ...g, pernas: g.pernas.filter(p => selecionadas.includes(p)) }))
      .filter(g => g.pernas.length)

    if (grupos.length) return { grupos, confiancaUsada: confiancaMinima }
  }

  return { grupos: [], confiancaUsada: null }
}

/** ✅ NOVO — chave estável pra identificar uma entrada/candidato dentro da múltipla */
export function idCandidato(c) {
  return `${c.mandante}|${c.visitante}|${c.categoria}|${c.nome}`
}

/** ✅ NOVO — Fase 7, item 43: correlação entre mercados do MESMO confronto.
 *  Multiplicar probabilidades independentes superestima o risco de falhar
 *  quando os mercados tendem a acontecer juntos (jogo aberto = mais gols E
 *  mais cartões E mais escanteios). Os valores abaixo são ponto de partida —
 *  ajustar depois com dados reais do ScoutTracker (comparar taxa de acerto
 *  conjunta observada vs. a que a independência preveria, por par de
 *  categoria — isso vira o próximo refino, quando tiver amostra suficiente).
 *  ρ = coeficiente de correlação entre dois eventos binários (phi
 *  coefficient rearranjado). */
export const RHO_CORRELACAO_CATEGORIAS = {
  'gols|cartoes':       0.18,
  'gols|escanteios':    0.22,
  'cartoes|escanteios': 0.12,
}

export function chaveCorrelacao(catA, catB) {
  return [catA, catB].sort().join('|')
}

export function rhoEntreCategorias(catA, catB, direcaoA, direcaoB) {
  if (catA === catB) return null // tratado à parte (linhas da mesma estatística)
  const base = RHO_CORRELACAO_CATEGORIAS[chaveCorrelacao(catA, catB)] ?? 0.10 // fallback conservador
  // ✅ FIX — item 13: a tabela acima assume "jogo aberto = mais gols E mais
  // cartões E mais escanteios" (por isso ρ positivo). Isso só vale quando as
  // duas pernas apontam pro mesmo tipo de jogo (as duas Over, ou as duas
  // Under). Under gols + Over cartões é o padrão OPOSTO (jogo truncado/
  // brigado, não aberto) — sem inverter o sinal, o modelo tratava essa
  // combinação como se fosse tão correlacionada quanto Over+Over.
  const direcoesDivergem = direcaoA && direcaoB && direcaoA !== direcaoB
  return direcoesDivergem ? -base : base
}

/** Funde pernas da MESMA categoria (ex.: duas linhas de Cartões) num único
 *  "leg efetivo": se apontam em direções opostas (uma Over, outra Under) são
 *  mutuamente exclusivas (probabilidade 0); se apontam na mesma direção, a
 *  conjunta é a mais restritiva (probabilidade mínima entre elas). Isso
 *  reduz o grupo a legs de categorias DIFERENTES, que é o que a simulação
 *  de cópula abaixo espera. */
export function mesclarPernasMesmaCategoria(pernas) {
  const porCategoria = {}
  pernas.forEach(p => { (porCategoria[p.categoria] ||= []).push(p) })

  const efetivas = []
  for (const grupo of Object.values(porCategoria)) {
    if (grupo.length === 1) { efetivas.push(grupo[0]); continue }
    const direcoes = grupo.map(p => (/under/i.test(p.nome) ? 'under' : 'over'))
    if (new Set(direcoes).size > 1) {
      efetivas.push({ ...grupo[0], prob: 0, nome: 'combinação impossível (linhas conflitantes)' })
      continue
    }
    efetivas.push(grupo.reduce((min, p) => (p.prob < min.prob ? p : min), grupo[0]))
  }
  return efetivas
}

// ── Cholesky + normal padrão, base da simulação de cópula gaussiana ──
export function cholesky(matriz) {
  const n = matriz.length
  const L = Array.from({ length: n }, () => new Array(n).fill(0))
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let soma = 0
      for (let k = 0; k < j; k++) soma += L[i][k] * L[j][k]
      if (i === j) {
        L[i][j] = Math.sqrt(Math.max(matriz[i][i] - soma, 1e-9)) // jitter se a matriz não for PSD
      } else {
        L[i][j] = (matriz[i][j] - soma) / (L[j][j] || 1e-9)
      }
    }
  }
  return L
}

export function amostraNormal() {
  let u = 0, v = 0
  while (u === 0) u = Math.random()
  while (v === 0) v = Math.random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

// Φ(x) — CDF da normal padrão (Abramowitz-Stegun, mesma aproximação já usada em tennisScraper.js)
export function normalCdf(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911
  const sinal = x < 0 ? -1 : 1
  const ax = Math.abs(x) / Math.SQRT2
  const t = 1 / (1 + p * ax)
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax)
  return 0.5 * (1 + sinal * y)
}

/** ✅ NOVO — Fase 7, item 43: SIMULAÇÃO CONJUNTA via cópula gaussiana.
 *  Substitui o encadeamento par-a-par antigo (que só corrigia DUAS pernas
 *  por vez, em sequência) por uma simulação Monte Carlo com TODAS as pernas
 *  ao mesmo tempo, usando a matriz de correlação completa entre elas — é
 *  isso que o roadmap chama de "simulação conjunta", em vez de uma
 *  aproximação encadeada. */
export function simularProbabilidadeConjunta(pernasEfetivas, nSim = 20000) {
  const n = pernasEfetivas.length
  if (n === 0) return 0
  if (n === 1) return pernasEfetivas[0].prob / 100

  const matriz = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => {
      if (i === j) return 1
      const dirI = /under/i.test(pernasEfetivas[i].nome) ? 'under' : 'over'
      const dirJ = /under/i.test(pernasEfetivas[j].nome) ? 'under' : 'over'
      return rhoEntreCategorias(pernasEfetivas[i].categoria, pernasEfetivas[j].categoria, dirI, dirJ) ?? 0.10
    })
  )
  const L = cholesky(matriz)
  const probs = pernasEfetivas.map(p => p.prob / 100)

  let acertos = 0
  for (let s = 0; s < nSim; s++) {
    const z = Array.from({ length: n }, () => amostraNormal())
    let ok = true
    for (let i = 0; i < n; i++) {
      let zi = 0
      for (let k = 0; k <= i; k++) zi += L[i][k] * z[k]
      if (normalCdf(zi) >= probs[i]) { ok = false; break }
    }
    if (ok) acertos++
  }
  return acertos / nSim
}

/** Probabilidade conjunta de TODAS as pernas de um mesmo jogo — funde legs
 *  da mesma categoria e depois roda a simulação conjunta entre categorias
 *  diferentes. */
export function probabilidadeConjuntaGrupo(pernas) {
  if (!pernas.length) return 0
  if (pernas.length === 1) return pernas[0].prob / 100
  const efetivas = mesclarPernasMesmaCategoria(pernas)
  if (efetivas.some(p => p.prob === 0)) return 0
  return simularProbabilidadeConjunta(efetivas)
}

/** Probabilidade combinada de TODA a múltipla: dentro de um jogo, aplica a
 *  correlação (probabilidadeConjuntaGrupo); entre jogos diferentes, mantém
 *  multiplicação simples — partidas diferentes são independentes entre si. */
export function calcularProbabilidadeCombinada(grupos) {
  const gruposComPernas = grupos.filter(g => g.pernas.length)
  if (!gruposComPernas.length) return 0
  return gruposComPernas.reduce((acc, g) => acc * probabilidadeConjuntaGrupo(g.pernas), 1) * 100
}

// ═════════════════════════════════════════════════════════════
// MENSAGENS PRO TELEGRAM (usadas pelo site após a Etapa 3 E pelo comando
// /jogos do bot — mesma função, então o texto nunca diverge)
// ═════════════════════════════════════════════════════════════

const fmtAgoraBRT = () => new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })

/** Melhor entrada de CADA categoria (gols, cartões, escanteios) de um jogo —
 *  mesma regra de escolha da múltipla (melhorCandidato). */
export function melhoresPorCategoria(jogo) {
  const cands      = coletarCandidatosJogo(jogo)
  const gols       = melhorCandidato(cands.filter(c => c.categoria === 'gols'))
  const cartoes    = melhorCandidato(cands.filter(c => c.categoria === 'cartoes'))
  const escanteios = melhorCandidato(cands.filter(c => c.categoria === 'escanteios'))
  // "Melhor entrada" do jogo = a melhor das três categorias, pelo MESMO critério
  // que a múltipla usa pra ordenar as pernas (confiança primeiro, depois probabilidade)
  const geral = [gols, cartoes, escanteios].filter(Boolean)
    .sort((a, b) => scoreCandidato(b) - scoreCandidato(a))[0] ?? null
  return { geral, gols, cartoes, escanteios }
}

/** Texto (Markdown) do futebol: cada jogo separado, com a melhor entrada
 *  geral + a melhor de Gols, Cartões e Escanteios, e no final a múltipla
 *  sugerida somando as melhores entradas entre TODOS os jogos. */
export function montarMensagemTelegram(jogos) {
  if (!jogos?.length) return ''

  const linhas = [`🤖 *FOOTBALL SCOUT IA*`, `🕒 ${fmtAgoraBRT()}`, '']
  const fmtCat = (icone, rotulo, c) =>
    c ? `${icone} ${rotulo}: ${c.nome} (${c.prob}% · ${c.confianca})` : `${icone} ${rotulo}: sem dado suficiente`

  jogos.forEach(jogo => {
    const m = melhoresPorCategoria(jogo)

    linhas.push('━━━━━━━━━━━━━━━━━━━')
    linhas.push(`⚽ *${jogo.mandante} × ${jogo.visitante}*`)
    linhas.push(`🏆 ${jogo.competicao || '—'} | 🕒 ${jogo.horario || '—'} (${jogo.dataJogo || '—'})`)
    linhas.push(`📊 ${jogo.mandante} ${jogo.prob_mandante ?? '—'}% · Empate ${jogo.prob_empate ?? '—'}% · ${jogo.visitante} ${jogo.prob_visitante ?? '—'}% → *${jogo.mercado_resultado ?? '—'}* (confiança ${jogo.confianca ?? '—'})`)
    if (jogo.mercado_gols_limpo) {
      linhas.push(`📈 Modelo de gols: ${jogo.mercado_gols_limpo}${jogo.media_gols_esperada != null ? ` (λ ${jogo.media_gols_esperada})` : ''}`)
    }
    linhas.push(
      m.geral
        ? `🎯 *Melhor entrada:* ${m.geral.tipo} — ${m.geral.nome} (${m.geral.prob}% · confiança ${m.geral.confianca})`
        : `🎯 Melhor entrada: sem dado suficiente para esse jogo.`
    )
    linhas.push(fmtCat('⚽', 'Gols', m.gols))
    linhas.push(fmtCat('🟨', 'Cartões', m.cartoes))
    linhas.push(fmtCat('🚩', 'Escanteios', m.escanteios))
  })

  const { grupos, confiancaUsada } = montarMultiplaSugerida(jogos)
  linhas.push('━━━━━━━━━━━━━━━━━━━')
  if (grupos.length) {
    const probCombinada = calcularProbabilidadeCombinada(grupos)
    linhas.push(`🎰 *MÚLTIPLA SUGERIDA* (confiança mínima usada: ${confiancaUsada})`)
    grupos.forEach(g => {
      g.pernas.forEach(p => {
        linhas.push(`• ${g.mandante} × ${g.visitante}: ${p.tipo} — ${p.nome} (${p.prob}%)`)
      })
    })
    linhas.push(`✅ Probabilidade combinada da múltipla: ${probCombinada.toFixed(1)}%`)
  } else {
    linhas.push(`🎰 Múltipla: nenhuma entrada com confiança suficiente nos jogos pesquisados.`)
  }

  return linhas.join('\n')
}

// ═════════════════════════════════════════════════════════════
// TÊNIS — melhor entrada por jogo + múltipla
// (o site não tem múltipla de tênis; aqui ela usa a MESMA recomendação de
// entrada que o card de tênis já mostra: Vitória (ML) ou Sets Diretos.
// Partidas diferentes são independentes → probabilidade = produto.)
// ═════════════════════════════════════════════════════════════

export const MAX_PERNAS_MULTIPLA_TENIS = 3

/** Melhor linha de Over/Under de games: prioriza a "zona útil" (55–75%),
 *  como nos cartões/escanteios; se nenhuma cair nela, pega a mais próxima. */
function melhorLinhaGamesTenis(jogo) {
  const linhas = Array.isArray(jogo.mercadoTotalGames) ? jogo.mercadoTotalGames : []
  const cands = linhas.flatMap(l => [
    { nome: `Over ${l.linha} games`,  prob: l.over },
    { nome: `Under ${l.linha} games`, prob: l.under },
  ]).filter(c => Number.isFinite(c.prob))
  if (!cands.length) return null
  const zona = cands.filter(c => c.prob >= 55 && c.prob <= 75)
  if (zona.length) return zona.reduce((a, b) => (b.prob > a.prob ? b : a))
  return cands.reduce((a, b) => (Math.abs(b.prob - 65) < Math.abs(a.prob - 65) ? b : a))
}

/** Entrada principal do jogo de tênis (a mesma do card do site). */
export function melhorEntradaTenis(jogo) {
  const mandanteFav = (jogo.prob_mandante ?? 0) >= (jogo.prob_visitante ?? 0)
  const fav     = mandanteFav ? jogo.mandante : jogo.visitante
  const probFav = mandanteFav ? jogo.prob_mandante : jogo.prob_visitante
  const rec = jogo.recomendacaoEntrada

  if (rec?.tipo === 'evitar') return { tipo: 'evitar', nome: 'Evitar', prob: probFav, motivo: rec.motivo }
  if (rec?.tipo === 'sets_diretos' && jogo.mercadoStraightSets?.prob != null) {
    const sd = jogo.mercadoStraightSets
    return { tipo: 'sets_diretos', nome: `Sets diretos — ${sd.jogador} ${sd.placar}`, prob: sd.prob, motivo: rec.motivo }
  }
  return { tipo: 'vitoria', nome: `Vitória (ML) — ${fav}`, prob: probFav, motivo: rec?.motivo ?? null }
}

export function montarMultiplaTenis(jogos) {
  const pernas = (jogos || [])
    .map(j => ({ jogo: j, entrada: melhorEntradaTenis(j) }))
    .filter(x => x.entrada.tipo !== 'evitar' && Number.isFinite(x.entrada.prob))
    .sort((a, b) => b.entrada.prob - a.entrada.prob)
    .slice(0, MAX_PERNAS_MULTIPLA_TENIS)
  const probCombinada = pernas.reduce((acc, x) => acc * (x.entrada.prob / 100), 1) * 100
  return { pernas, probCombinada: pernas.length ? probCombinada : 0 }
}

export function montarMensagemTelegramTenis(jogos) {
  if (!jogos?.length) return ''
  const linhas = [`🎾 *FOOTBALL SCOUT IA — TÊNIS*`, `🕒 ${fmtAgoraBRT()}`, '']

  jogos.forEach(jogo => {
    const e = melhorEntradaTenis(jogo)
    const g = melhorLinhaGamesTenis(jogo)
    linhas.push('━━━━━━━━━━━━━━━━━━━')
    linhas.push(`🎾 *${jogo.mandante} × ${jogo.visitante}*`)
    linhas.push(`🏆 ${jogo.competicao || '—'} · melhor de ${jogo.bestOf ?? 3} | 🕒 ${jogo.horario || '—'}`)
    linhas.push(`📊 ${jogo.mandante} ${jogo.prob_mandante ?? '—'}% × ${jogo.prob_visitante ?? '—'}% ${jogo.visitante} (confiança ${jogo.confianca ?? '—'})`)
    linhas.push(
      e.tipo === 'evitar'
        ? `⚠️ *Melhor entrada:* evitar — ${e.motivo ?? 'favoritismo fraco'}`
        : `🎯 *Melhor entrada:* ${e.nome} (${e.prob}%)`
    )
    if (jogo.melhorPlacar?.placar) {
      linhas.push(`🔢 Placar mais provável: ${jogo.melhorPlacar.jogador} ${jogo.melhorPlacar.placar} (${jogo.melhorPlacar.prob}%)`)
    }
    if (jogo.totalGamesEstimado?.estimado != null) {
      linhas.push(`🎮 Games: ~${jogo.totalGamesEstimado.estimado} (faixa ${jogo.totalGamesEstimado.faixaMin}-${jogo.totalGamesEstimado.faixaMax})${g ? ` → ${g.nome} (${g.prob}%)` : ''}`)
    }
  })

  const { pernas, probCombinada } = montarMultiplaTenis(jogos)
  linhas.push('━━━━━━━━━━━━━━━━━━━')
  if (pernas.length) {
    linhas.push(`🎰 *MÚLTIPLA SUGERIDA (tênis)*`)
    pernas.forEach(({ jogo, entrada }) => {
      linhas.push(`• ${jogo.mandante} × ${jogo.visitante}: ${entrada.nome} (${entrada.prob}%)`)
    })
    linhas.push(`✅ Probabilidade combinada da múltipla: ${probCombinada.toFixed(1)}%`)
  } else {
    linhas.push(`🎰 Múltipla: nenhuma entrada com confiança suficiente nos jogos pesquisados.`)
  }
  return linhas.join('\n')
}


// ═════════════════════════════════════════════════════════════
// TÊNIS e BASQUETE — múltipla com UMA perna por jogo
// (uma perna por jogo = jogos independentes → probabilidade = produto simples)
// ═════════════════════════════════════════════════════════════

/** Pernas possíveis de um jogo de tênis: Vitória (ML), Sets diretos e a melhor linha de games. */
export function candidatosTenis(jogo) {
  const mandanteFav = (jogo.prob_mandante ?? 0) >= (jogo.prob_visitante ?? 0)
  const fav     = mandanteFav ? jogo.mandante : jogo.visitante
  const probFav = mandanteFav ? jogo.prob_mandante : jogo.prob_visitante
  const conf = jogo.confianca ?? 'Baixa'
  const cands = []
  if (Number.isFinite(probFav)) cands.push({ tipo: '🎾 Vitória', nome: `Vitória (ML) — ${fav}`, prob: probFav, confianca: conf })
  const sd = jogo.mercadoStraightSets
  if (sd?.prob != null && Number.isFinite(sd.prob)) {
    cands.push({ tipo: '🎾 Sets diretos', nome: `Sets diretos — ${sd.jogador} ${sd.placar}`, prob: sd.prob, confianca: conf })
  }
  const g = melhorLinhaGamesTenis(jogo)
  if (g) cands.push({ tipo: '🎮 Games', nome: g.nome, prob: g.prob, confianca: conf })
  return cands
}

/** Pernas possíveis de um jogo de basquete: Vitória e a melhor linha de total de pontos. */
export function candidatosBasquete(jogo) {
  const cands = []
  const pm = jogo.prob_mandante, pv = jogo.prob_visitante
  if (Number.isFinite(pm) && Number.isFinite(pv)) {
    const mand = pm >= pv
    cands.push({
      tipo: '🏀 Vitória',
      nome: `Vitória — ${mand ? jogo.mandante : jogo.visitante}`,
      prob: mand ? pm : pv,
      confianca: jogo.confianca ?? 'Baixa',
    })
  }
  const linhas = Array.isArray(jogo.thresholds) ? jogo.thresholds : []
  const totais = linhas.flatMap(t => [
    { nome: `Over ${t.threshold} pts`,  prob: t.over },
    { nome: `Under ${t.threshold} pts`, prob: t.under },
  ]).filter(c => Number.isFinite(c.prob))
  if (totais.length) {
    const zona = totais.filter(c => c.prob >= 55 && c.prob <= 75)
    const melhor = zona.length
      ? zona.reduce((a, b) => (b.prob > a.prob ? b : a))
      : totais.reduce((a, b) => (Math.abs(b.prob - 65) < Math.abs(a.prob - 65) ? b : a))
    cands.push({ tipo: '📊 Total de pontos', ...melhor, confianca: jogo.confiancaTotais ?? 'Baixa' })
  }
  return cands
}

export function candidatosPorEsporte(esporte, jogo) {
  return esporte === 'tenis' ? candidatosTenis(jogo) : candidatosBasquete(jogo)
}

/** Melhor entrada de UM jogo (a mesma que entra na múltipla sugerida). */
export function melhorEntradaPorEsporte(esporte, jogo) {
  const cands = candidatosPorEsporte(esporte, jogo).filter(c => Number.isFinite(c.prob))
  if (!cands.length) return null
  if (esporte === 'tenis') {
    const e = melhorEntradaTenis(jogo) // respeita a recomendação do card (ML / sets diretos / evitar)
    if (e.tipo === 'evitar') return null
    return cands.find(c => c.nome === e.nome) ?? cands[0]
  }
  return cands.reduce((a, b) => (scoreCandidato(b) > scoreCandidato(a) ? b : a))
}

/** Múltipla sugerida: a melhor entrada de cada jogo, ordenadas e limitadas a maxPernas. */
export function montarMultiplaSimples(esporte, jogos, maxPernas = 3) {
  const chave = c => (esporte === 'tenis' ? c.prob : scoreCandidato(c))
  const pernas = (jogos || [])
    .map((jogo, i) => ({ jogoIdx: i, jogo, cand: melhorEntradaPorEsporte(esporte, jogo) }))
    .filter(x => x.cand && (esporte === 'tenis' || x.cand.prob >= 55)) // basquete: só pernas com ≥55%
    .sort((a, b) => chave(b.cand) - chave(a.cand))
    .slice(0, maxPernas)
  const probCombinada = pernas.length ? pernas.reduce((acc, x) => acc * (x.cand.prob / 100), 1) * 100 : 0
  return { pernas, probCombinada }
}

export function montarMensagemTelegramBasquete(jogos) {
  if (!jogos?.length) return ''
  const linhas = [`🏀 *FOOTBALL SCOUT IA — BASQUETE*`, `🕒 ${fmtAgoraBRT()}`, '']

  jogos.forEach(jogo => {
    const cands = candidatosBasquete(jogo)
    const vit = cands.find(c => c.tipo === '🏀 Vitória')
    const tot = cands.find(c => c.tipo === '📊 Total de pontos')
    const melhor = melhorEntradaPorEsporte('basquete', jogo)
    linhas.push('━━━━━━━━━━━━━━━━━━━')
    linhas.push(`🏀 *${jogo.mandante} × ${jogo.visitante}*`)
    linhas.push(`🏆 ${jogo.competicao || '—'} | 🕒 ${jogo.horario || '—'}`)
    linhas.push(`📊 ${jogo.mandante} ${jogo.prob_mandante ?? '—'}% × ${jogo.prob_visitante ?? '—'}% ${jogo.visitante} (confiança ${jogo.confianca ?? '—'})`)
    if (jogo.mediaEsperada != null) linhas.push(`📈 Total esperado: ~${jogo.mediaEsperada} pts`)
    linhas.push(melhor
      ? `🎯 *Melhor entrada:* ${melhor.nome} (${melhor.prob}% · confiança ${melhor.confianca})`
      : `🎯 Melhor entrada: sem dado suficiente para esse jogo.`)
    if (vit) linhas.push(`🏀 Resultado: ${vit.nome} (${vit.prob}%)`)
    if (tot) linhas.push(`📊 Total: ${tot.nome} (${tot.prob}% · confiança ${tot.confianca})`)
  })

  const { pernas, probCombinada } = montarMultiplaSimples('basquete', jogos)
  linhas.push('━━━━━━━━━━━━━━━━━━━')
  if (pernas.length) {
    linhas.push(`🎰 *MÚLTIPLA SUGERIDA (basquete)*`)
    pernas.forEach(({ jogo, cand }) => linhas.push(`• ${jogo.mandante} × ${jogo.visitante}: ${cand.nome} (${cand.prob}%)`))
    linhas.push(`✅ Probabilidade combinada da múltipla: ${probCombinada.toFixed(1)}%`)
  } else {
    linhas.push(`🎰 Múltipla: nenhuma entrada com confiança suficiente nos jogos pesquisados.`)
  }
  return linhas.join('\n')
}