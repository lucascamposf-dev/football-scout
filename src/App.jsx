import React, { useState, useCallback, useEffect, useMemo } from 'react'
import LoadingScreen from './components/LoadingScreen'
import { etapa1_buscarJogos, etapa2_buscarHistoricos, etapa3_calcularProbabilidades } from './services/groqService'
import { ts_buscarTorneiosAtivos, ts_buscarJogosTorneio, ts_buscarHistoricos, ts_calcularProbabilidades } from './services/tennisService'
import {
  LIGAS_BASQUETE,
  bs_etapa1_buscarJogos,
  bs_etapa2_buscarHistoricos,
  bs_etapa3_calcularProbabilidades,
} from './services/basketballService'
import {
  csa_etapa1_buscarJogos,
  csa_etapa2_buscarHistoricos,
  csa_etapa3_calcularProbabilidades,
} from './services/sudamericanaService'
import {
  sb_etapa1_buscarJogos,
  sb_etapa2_buscarHistoricos,
  sb_etapa3_calcularProbabilidades,
} from './services/serieBService'
import {
  el_etapa1_buscarJogos,
  el_etapa2_buscarHistoricos,
  el_etapa3_calcularProbabilidades,
} from './services/europaLeagueService'
import {
  nl_etapa1_buscarJogos,
  nl_etapa2_buscarHistoricos,
  nl_etapa3_calcularProbabilidades,
} from './services/nationsLeagueService'
import {
  am_etapa1_buscarJogos,
  am_etapa2_buscarHistoricos,
  am_etapa3_calcularProbabilidades,
} from './services/amistososService'
import ScoutTracker from './tracker/ScoutTracker'
// ✅ NOVO — telas "Jogos ao Vivo" e "Odds"
import JogosAoVivo from './components/JogosAoVivo'
import PainelOdds from './components/PainelOdds'
import LoginSite from './components/LoginSite'
import BottomNav from './components/BottomNav'
import { invalidarCacheCalibration, probDoMercado, normalizarMercado, calibrarJogosTenis } from './services/calibrationService'
import { enviarParaTelegram } from './services/telegramService'
import {
  coletarCandidatosJogo,
  scoreCandidato,
  idCandidato,
  montarMultiplaSugerida,
  calcularProbabilidadeCombinada,
  montarMensagemTelegram,
  montarMensagemTelegramTenis,
  montarMensagemTelegramBasquete,
  candidatosPorEsporte,
  montarMultiplaSimples,
} from './services/multiplaService'

const IS_PROD  = typeof window !== 'undefined' && window.location.hostname !== 'localhost'
const API_BASE = IS_PROD ? '' : 'http://localhost:3001'

// ── Helpers: copiar análise / salvar no Scout Tracker ─────────
function limparMercado(txt) {
  if (!txt) return '—'
  return String(txt).replace(/^[^\wÀ-ú]+/u, '').trim()
}

/** Texto limpo para colar no Bloco de Notas */
// ✅ Fix: jogos de tênis têm campos próprios (prob_mandante, mercadoStraightSets,
// melhorPlacar) — usar o formatador de futebol pra eles gerava "—" em tudo.
function formatarJogoTenisParaCopia(jogo) {
  const linhas = [
    `${jogo.mandante} × ${jogo.visitante}`,
    `Competição: ${jogo.competicao || '—'} · melhor de ${jogo.bestOf ?? 3}`,
    `Horário: ${jogo.horario || '—'} | Data: ${jogo.dataJogo || '—'}`,
    `Probabilidade: ${jogo.mandante} ${jogo.prob_mandante}% x ${jogo.prob_visitante}% ${jogo.visitante}`,
    `Confiança: ${jogo.confianca ?? '—'}`,
    `Placar mais provável: ${jogo.melhorPlacar?.jogador ?? '—'} ${jogo.melhorPlacar?.placar ?? '—'} (${jogo.melhorPlacar?.prob ?? '—'}%)`,
    `Sets diretos: ${jogo.mercadoStraightSets?.jogador ?? '—'} ${jogo.mercadoStraightSets?.placar ?? '—'} (${jogo.mercadoStraightSets?.prob ?? '—'}%)`,
    `Total de games estimado: ~${jogo.totalGamesEstimado?.estimado ?? '—'} (faixa ${jogo.totalGamesEstimado?.faixaMin ?? '—'}-${jogo.totalGamesEstimado?.faixaMax ?? '—'})`,
  ]
  linhas.push('─'.repeat(40))
  return linhas.join('\n')
}

function formatarJogoParaCopia(jogo) {
  // ✅ Fix: detecta jogo de tênis pela presença de prob_mandante (campo exclusivo
  // do calcularProbabilidadesTenis) e usa o formatador correto.
  if (jogo.prob_mandante != null && jogo.mercadoStraightSets) {
    return formatarJogoTenisParaCopia(jogo)
  }

  const mercado = limparMercado(jogo.mercado_gols_limpo || jogo.mercado_gols || jogo.mercadoTotais || jogo.mercado)
  const conf    = jogo.confianca_gols || jogo.confianca || '—'
  const lambda  = jogo.media_gols_esperada != null ? Number(jogo.media_gols_esperada).toFixed(2) : '—'
  const score   = jogo.score_composto != null ? jogo.score_composto : '—'
  const linhas = [
    `${jogo.mandante} × ${jogo.visitante}`,
    `Competição: ${jogo.competicao || '—'}`,
    `Horário: ${jogo.horario || '—'} | Data: ${jogo.dataJogo || '—'}`,
    `Melhor mercado (gols): ${mercado}`,
    `Confiança: ${conf}`,
    `λ esperado: ${lambda} gols | Score: ${score}`,
  ]
  if (jogo.over25_gols != null) {
    linhas.push(`Over 2.5: ${jogo.over25_gols}% | Under 2.5: ${jogo.under25_gols ?? '—'}% | BTTS: ${jogo.btts ?? '—'}%`)
  }
  if (jogo.melhor_entrada_over_gols || jogo.melhor_entrada_under_gols) {
    linhas.push(`Melhor Over (gols): ${jogo.melhor_entrada_over_gols?.nome ?? '—'} (${jogo.melhor_entrada_over_gols?.prob ?? '—'}%) | Melhor Under (gols): ${jogo.melhor_entrada_under_gols?.nome ?? '—'} (${jogo.melhor_entrada_under_gols?.prob ?? '—'}%)`)
  }
  const meCE = jogo.mercado_cartoes_escanteios?.melhorEntrada
  if (meCE) {
    linhas.push(`Cartões — Over: ${meCE.cartoesOver?.nome ?? '—'} (${meCE.cartoesOver?.prob ?? '—'}%) | Under: ${meCE.cartoesUnder?.nome ?? '—'} (${meCE.cartoesUnder?.prob ?? '—'}%)`)
    linhas.push(`Escanteios — Over: ${meCE.escanteiosOver?.nome ?? '—'} (${meCE.escanteiosOver?.prob ?? '—'}%) | Under: ${meCE.escanteiosUnder?.nome ?? '—'} (${meCE.escanteiosUnder?.prob ?? '—'}%)`)
  }
  if (jogo.odds_mercado?.melhorEV) {
    const ev = jogo.odds_mercado.melhorEV
    linhas.push(`Value bet: ${ev.nome} @ ${ev.odd} (EV +${Math.round(ev.ev * 100)}%)`)
  }
  linhas.push('─'.repeat(40))
  return linhas.join('\n')
}

function formatarListaParaCopia(jogos) {
  if (!jogos?.length) return ''
  const header = `FOOTBALL SCOUT IA — ${new Date().toLocaleString('pt-BR')}\n${'═'.repeat(40)}\n`
  return header + jogos.map(formatarJogoParaCopia).join('\n')
}

async function copiarTexto(texto) {
  try {
    await navigator.clipboard.writeText(texto)
    return true
  } catch {
    // Fallback para ambientes sem clipboard API
    const ta = document.createElement('textarea')
    ta.value = texto
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    try {
      document.execCommand('copy')
      return true
    } finally {
      document.body.removeChild(ta)
    }
  }
}

/** ✅ NOVO — agrupa TODOS os candidatos coletados por jogo (não só o melhor de
 *  cada categoria), pra alimentar a lista de seleção manual. Cada grupo já sai
 *  com as entradas ordenadas da melhor pra pior. */
function todosCandidatosPorJogo(jogos) {
  if (!jogos?.length) return []
  return jogos
    .map(jogo => {
      const candidatos = coletarCandidatosJogo(jogo)
        .sort((a, b) => scoreCandidato(b) - scoreCandidato(a))
      if (!candidatos.length) return null
      return { mandante: jogo.mandante, visitante: jogo.visitante, competicao: jogo.competicao, horario: jogo.horario, candidatos }
    })
    .filter(Boolean)
}

/** ✅ NOVO — botão flutuante com a múltipla: o sistema já vem com uma seleção
 *  sugerida marcada, mas o usuário pode marcar/desmarcar qualquer entrada.
 *  A probabilidade combinada é recalculada a cada mudança, e as entradas
 *  sempre aparecem agrupadas pelo confronto (mesmos dois times) a que pertencem. */
function MultiplaFlutuante({ jogos }) {
  const [aberto, setAberto] = useState(false)
  const [feedback, setFeedback] = useState('')

  const gruposTodos = todosCandidatosPorJogo(jogos)
  const { grupos: gruposSugeridos } = montarMultiplaSugerida(jogos)

  const [selecionados, setSelecionados] = useState(() => {
    const iniciais = new Set()
    gruposSugeridos.forEach(g => g.pernas.forEach(p => iniciais.add(idCandidato(p))))
    return iniciais
  })

  if (!gruposTodos.length) return null

  const toggleCandidato = (id) => {
    setSelecionados(prev => {
      const novo = new Set(prev)
      novo.has(id) ? novo.delete(id) : novo.add(id)
      return novo
    })
  }

  // ✅ sempre juntando as entradas do mesmo confronto (mesmo par de times) —
  // filtramos por jogo primeiro, e só depois pelas marcadas dentro dele.
  const gruposSelecionados = gruposTodos
    .map(g => ({ ...g, pernas: g.candidatos.filter(c => selecionados.has(idCandidato(c))) }))
    .filter(g => g.pernas.length)

  const todasPernasSelecionadas = gruposSelecionados.flatMap(g => g.pernas)

  // ✅ FIX — item 13: a simulação (20k iterações Monte Carlo) rodava direto
  // no corpo do componente sem useMemo, recalculando com números aleatórios
  // NOVOS em qualquer re-render (abrir o painel, digitar no feedback, etc.),
  // mesmo sem a seleção ter mudado — o % da múltipla mudava sozinho na tela.
  // A chave é uma string estável derivada da seleção (não a referência do
  // array, que muda a cada render), então só recalcula quando a seleção
  // realmente muda.
  const chaveSelecao = todasPernasSelecionadas
    .map(p => `${p.mandante}|${p.visitante}|${p.categoria}|${p.nome}|${p.prob}`)
    .sort()
    .join(';')
  const probCombinada = useMemo(
    () => calcularProbabilidadeCombinada(gruposSelecionados),
    [chaveSelecao]
  )

  const temCorrelacao = gruposSelecionados.some(g => g.pernas.length > 1)

  const handleCopiar = async () => {
    if (!gruposSelecionados.length) {
      setFeedback('⚠️ Selecione ao menos 1 entrada')
      setTimeout(() => setFeedback(''), 2000)
      return
    }
    const linhas = [
      '🎯 MINHA MÚLTIPLA — FOOTBALL SCOUT IA',
      '─'.repeat(40),
    ]
    gruposSelecionados.forEach((g, i) => {
      linhas.push(`${g.mandante} x ${g.visitante}`)
      g.pernas.forEach(p => linhas.push(`  • ${p.nome} (${p.prob}%, confiança ${p.confianca}, odd ≈ ${(100 / p.prob).toFixed(2)})`))
      if (i < gruposSelecionados.length - 1) linhas.push('')
    })
    linhas.push('─'.repeat(40))
    linhas.push(`Probabilidade combinada estimada: ${probCombinada.toFixed(1)}% (odd ≈ ${(100 / probCombinada).toFixed(2)})`)
    if (temCorrelacao) linhas.push('ℹ️ Probabilidade combinada já ajustada por correlação estimada entre mercados do mesmo confronto (não é apenas o produto simples das probabilidades).')

    const ok = await copiarTexto(linhas.join('\n'))
    setFeedback(ok ? '✅ Copiado!' : '❌ Falha ao copiar')
    setTimeout(() => setFeedback(''), 2000)
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setAberto(v => !v)}
        title="Múltipla: o sistema já sugere as melhores entradas marcadas, mas você pode marcar/desmarcar à vontade"
        className="fs-multipla-btn"
        style={{
          position: 'fixed', right: 24, bottom: 24, zIndex: 50,
          background: 'linear-gradient(135deg, #a064ff 0%, #7c3aed 100%)',
          border: 'none', borderRadius: 30, padding: '14px 20px',
          color: '#fff', fontWeight: 800, fontSize: 14, letterSpacing: 0.5,
          cursor: 'pointer', boxShadow: '0 6px 24px rgba(160,100,255,0.45)',
          fontFamily: "'Barlow Condensed', sans-serif",
        }}
      >
        🎯 Múltipla ({todasPernasSelecionadas.length})
      </button>

      {aberto && (
        <div className="fs-multipla-panel" style={{
          position: 'fixed', right: 24, bottom: 84, zIndex: 50, width: 340, maxWidth: '90vw',
          background: '#0f1724', border: '1px solid rgba(160,100,255,0.4)', borderRadius: 14,
          padding: 16, boxShadow: '0 10px 40px rgba(0,0,0,0.5)', maxHeight: '70vh', overflowY: 'auto',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 14, fontWeight: 800, color: '#a064ff', letterSpacing: 1 }}>
              🎯 MONTE SUA MÚLTIPLA
            </div>
            <button onClick={() => setAberto(false)} style={{ background: 'none', border: 'none', color: '#4a5a78', cursor: 'pointer', fontSize: 16 }}>✕</button>
          </div>

          <div style={{ fontSize: 10, color: '#4a5a78', marginBottom: 10, lineHeight: 1.4 }}>
            As melhores entradas já vêm marcadas. Marque ou desmarque à vontade — as entradas de um mesmo confronto ficam sempre juntas no mesmo bloco.
          </div>

          {gruposTodos.map((g, gi) => (
            <div key={gi} style={{
              background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 8, padding: '8px 10px', marginBottom: 8,
            }}>
              <div style={{ fontSize: 11, color: '#4a5a78', marginBottom: 6 }}>{g.mandante} x {g.visitante}</div>

              {g.candidatos.map((c, ci) => {
                const id = idCandidato(c)
                const marcado = selecionados.has(id)
                return (
                  <label
                    key={ci}
                    style={{
                      display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer',
                      marginBottom: ci < g.candidatos.length - 1 ? 8 : 0,
                      paddingBottom: ci < g.candidatos.length - 1 ? 8 : 0,
                      borderBottom: ci < g.candidatos.length - 1 ? '1px dashed rgba(255,255,255,0.08)' : 'none',
                      opacity: marcado ? 1 : 0.55,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={marcado}
                      onChange={() => toggleCandidato(id)}
                      style={{ marginTop: 3, cursor: 'pointer' }}
                    />
                    <div>
                      <div style={{ fontSize: 10, color: '#a064ff', fontWeight: 700, letterSpacing: 0.5, marginBottom: 2 }}>{c.tipo}</div>
                      <div style={{ fontSize: 13, color: '#e8eeff', fontWeight: 700 }}>{c.nome}</div>
                      <div style={{ fontSize: 11, color: '#00e676' }}>{c.prob}% · confiança {c.confianca} · odd ≈ {(100 / c.prob).toFixed(2)}</div>
                    </div>
                  </label>
                )
              })}
            </div>
          ))}

          <div style={{ fontSize: 12, color: '#8a9bb8', marginTop: 4, marginBottom: 10 }}>
            Probabilidade combinada estimada: <strong style={{ color: '#a064ff' }}>{probCombinada.toFixed(1)}%</strong>
            {todasPernasSelecionadas.length > 0 && <> (odd ≈ {(100 / probCombinada).toFixed(2)})</>}
          </div>

          <button
            type="button"
            onClick={handleCopiar}
            style={{
              width: '100%', background: 'rgba(160,100,255,0.15)', border: '1px solid rgba(160,100,255,0.5)',
              borderRadius: 8, padding: '8px 0', color: '#a064ff', cursor: 'pointer',
              fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800, fontSize: 13, letterSpacing: 1,
            }}
          >
            📋 COPIAR MÚLTIPLA
          </button>
          {feedback && <div style={{ fontSize: 11, color: '#00e676', marginTop: 6, textAlign: 'center' }}>{feedback}</div>}

          <div style={{ fontSize: 10, color: '#4a5a78', marginTop: 8, lineHeight: 1.4 }}>
            ⚠️ Combinar mercados aumenta o risco — analise antes de apostar.
            {temCorrelacao && <><br />ℹ️ Confrontos com mais de um mercado têm a probabilidade ajustada por simulação conjunta via cópula gaussiana (não apenas um fator de correlação isolado).</>}
          </div>
        </div>
      )}
    </>
  )
}

/** ✅ NOVO — múltipla de TÊNIS e BASQUETE: 1 entrada por jogo (as melhores já vêm marcadas),
 *  dá pra trocar a entrada de cada jogo ou tirá-lo da múltipla, copiar ou enviar pro Telegram. */
function MultiplaFlutuanteSimples({ jogos, esporte }) {
  const [aberto, setAberto] = useState(false)
  const [feedback, setFeedback] = useState('')

  const grupos = (jogos ?? [])
    .map((jogo, i) => ({ i, jogo, cands: candidatosPorEsporte(esporte, jogo).filter(c => Number.isFinite(c.prob)) }))
    .filter(g => g.cands.length)

  // jogoIdx → nome da entrada escolhida (ausente = jogo fora da múltipla)
  const [escolha, setEscolha] = useState(() => {
    const ini = {}
    montarMultiplaSimples(esporte, jogos).pernas.forEach(p => { ini[p.jogoIdx] = p.cand.nome })
    return ini
  })

  if (!grupos.length) return null

  const pernas = grupos
    .map(g => ({ g, cand: g.cands.find(c => c.nome === escolha[g.i]) }))
    .filter(x => x.cand)
  const probCombinada = pernas.length
    ? pernas.reduce((acc, x) => acc * (x.cand.prob / 100), 1) * 100
    : 0
  const icone = esporte === 'tenis' ? '🎾' : '🏀'

  const montarTexto = (md) => {
    const b = md ? '*' : ''
    const linhas = [`🎰 ${b}MINHA MÚLTIPLA (${esporte === 'tenis' ? 'tênis' : 'basquete'}) — FOOTBALL SCOUT IA${b}`, '']
    pernas.forEach(({ g, cand }) => {
      linhas.push(`• ${g.jogo.mandante} × ${g.jogo.visitante}: ${cand.nome} (${cand.prob}%, odd ≈ ${(100 / cand.prob).toFixed(2)})`)
    })
    linhas.push('')
    linhas.push(`✅ Probabilidade combinada: ${probCombinada.toFixed(1)}% (odd ≈ ${(100 / probCombinada).toFixed(2)})`)
    return linhas.join('\n')
  }

  const avisar = (msg) => { setFeedback(msg); setTimeout(() => setFeedback(''), 2500) }

  const handleCopiar = async () => {
    if (!pernas.length) return avisar('⚠️ Selecione ao menos 1 entrada')
    const ok = await copiarTexto(montarTexto(false))
    avisar(ok ? '✅ Copiado!' : '❌ Falha ao copiar')
  }

  const handleTelegram = async () => {
    if (!pernas.length) return avisar('⚠️ Selecione ao menos 1 entrada')
    const r = await enviarParaTelegram(montarTexto(true))
    avisar(r.ok ? '✅ Enviado pro Telegram!' : `❌ ${r.erro}`)
  }

  const estiloBtn = {
    width: '100%', background: 'rgba(160,100,255,0.15)', border: '1px solid rgba(160,100,255,0.5)',
    borderRadius: 8, padding: '8px 0', color: '#a064ff', cursor: 'pointer', marginBottom: 6,
    fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800, fontSize: 13, letterSpacing: 1,
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setAberto(v => !v)}
        className="fs-multipla-btn"
        style={{
          position: 'fixed', right: 24, bottom: 24, zIndex: 50,
          background: 'linear-gradient(135deg, #a064ff 0%, #7c3aed 100%)',
          border: 'none', borderRadius: 30, padding: '14px 20px',
          color: '#fff', fontWeight: 800, fontSize: 14, letterSpacing: 0.5,
          cursor: 'pointer', boxShadow: '0 6px 24px rgba(160,100,255,0.45)',
          fontFamily: "'Barlow Condensed', sans-serif",
        }}
      >
        🎯 Múltipla {icone} ({pernas.length})
      </button>

      {aberto && (
        <div className="fs-multipla-panel" style={{
          position: 'fixed', right: 24, bottom: 84, zIndex: 50, width: 340, maxWidth: '90vw',
          background: '#0f1724', border: '1px solid rgba(160,100,255,0.4)', borderRadius: 14,
          padding: 16, boxShadow: '0 10px 40px rgba(0,0,0,0.5)', maxHeight: '70vh', overflowY: 'auto',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 14, fontWeight: 800, color: '#a064ff', letterSpacing: 1 }}>
              🎯 MÚLTIPLA {esporte === 'tenis' ? 'DE TÊNIS' : 'DE BASQUETE'}
            </div>
            <button onClick={() => setAberto(false)} style={{ background: 'none', border: 'none', color: '#4a5a78', cursor: 'pointer', fontSize: 16 }}>✕</button>
          </div>

          <div style={{ fontSize: 10, color: '#4a5a78', marginBottom: 10, lineHeight: 1.4 }}>
            Uma entrada por jogo. As melhores já vêm marcadas — troque a entrada ou escolha "fora da múltipla".
          </div>

          {grupos.map(g => (
            <div key={g.i} style={{
              background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 8, padding: '8px 10px', marginBottom: 8,
            }}>
              <div style={{ fontSize: 11, color: '#4a5a78', marginBottom: 6 }}>{g.jogo.mandante} x {g.jogo.visitante}</div>
              {g.cands.map(c => (
                <label key={c.nome} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer', marginBottom: 6, opacity: escolha[g.i] === c.nome ? 1 : 0.6 }}>
                  <input
                    type="radio"
                    name={`mult-${esporte}-${g.i}`}
                    checked={escolha[g.i] === c.nome}
                    onChange={() => setEscolha(prev => ({ ...prev, [g.i]: c.nome }))}
                    style={{ marginTop: 3, cursor: 'pointer' }}
                  />
                  <div>
                    <div style={{ fontSize: 10, color: '#a064ff', fontWeight: 700, letterSpacing: 0.5, marginBottom: 2 }}>{c.tipo}</div>
                    <div style={{ fontSize: 13, color: '#e8eeff', fontWeight: 700 }}>{c.nome}</div>
                    <div style={{ fontSize: 11, color: '#00e676' }}>{c.prob}% · odd ≈ {(100 / c.prob).toFixed(2)}</div>
                  </div>
                </label>
              ))}
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', opacity: escolha[g.i] ? 0.6 : 1 }}>
                <input
                  type="radio"
                  name={`mult-${esporte}-${g.i}`}
                  checked={!escolha[g.i]}
                  onChange={() => setEscolha(prev => { const n = { ...prev }; delete n[g.i]; return n })}
                  style={{ cursor: 'pointer' }}
                />
                <span style={{ fontSize: 11, color: '#8a9bb8' }}>Fora da múltipla</span>
              </label>
            </div>
          ))}

          <div style={{ fontSize: 12, color: '#8a9bb8', marginTop: 4, marginBottom: 10 }}>
            Probabilidade combinada: <strong style={{ color: '#a064ff' }}>{probCombinada.toFixed(1)}%</strong>
            {pernas.length > 0 && <> (odd ≈ {(100 / probCombinada).toFixed(2)})</>}
          </div>

          <button type="button" onClick={handleCopiar} style={estiloBtn}>📋 COPIAR MÚLTIPLA</button>
          <button type="button" onClick={handleTelegram} style={estiloBtn}>📨 ENVIAR PRO TELEGRAM</button>
          {feedback && <div style={{ fontSize: 11, color: '#00e676', marginTop: 4, textAlign: 'center' }}>{feedback}</div>}

          <div style={{ fontSize: 10, color: '#4a5a78', marginTop: 8, lineHeight: 1.4 }}>
            ⚠️ Combinar jogos aumenta o risco — a probabilidade é o produto das entradas (jogos independentes). Analise antes de apostar.
          </div>
        </div>
      )}
    </>
  )
}

/** ✅ NOVO — balão de ajuda: aparece ao passar o mouse OU ao clicar (mobile) */
function Tooltip({ texto, children }) {
  const [show, setShow] = useState(false)
  return (
    <span
      style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
      onClick={() => setShow(v => !v)}
    >
      {children}
      {show && (
        <span style={{
          position: 'absolute', bottom: '125%', left: '50%', transform: 'translateX(-50%)',
          background: '#0f1724', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 8,
          padding: '6px 10px', fontSize: 11, color: '#e8eeff', width: 200,
          textAlign: 'center', zIndex: 100, boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
          lineHeight: 1.4, pointerEvents: 'none',
        }}>
          {texto}
          <span style={{
            position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)',
            borderWidth: 5, borderStyle: 'solid',
            borderColor: '#0f1724 transparent transparent transparent',
          }} />
        </span>
      )}
    </span>
  )
}

// ✅ NOVO — item 40: mapeia o mercado salvo pro campo de sub-modelos correspondente
const SUBMODELOS_POR_MERCADO = {
  'Over 1.5 Gols': 'over15_subModelos', 'Under 1.5 Gols': 'over15_subModelos',
  'Over 2.5 Gols': 'over25_subModelos', 'Under 2.5 Gols': 'over25_subModelos',
  'Over 3.5 Gols': 'over35_subModelos', 'Under 3.5 Gols': 'over35_subModelos',
  'BTTS Sim': 'btts_subModelos', 'BTTS Não': 'btts_subModelos',
}

/** Monta o objeto no formato do ScoutTracker e grava no backend */
async function salvarJogoNoTracker(jogo, token) {
  if (!token) throw new Error('Faça login para salvar no histórico')

  const mercado = limparMercado(jogo.mercado_gols_limpo || jogo.mercado_gols || jogo.mercadoTotais || 'Over 2.5 Gols')
  const conf    = jogo.confianca_gols || jogo.confianca || 'Média'
  const probs = {
    over15: jogo.over15_gols, under15: jogo.under15_gols,
    over25: jogo.over25_gols, under25: jogo.under25_gols,
    over35: jogo.over35_gols, under35: jogo.under35_gols,
    btts: jogo.btts,
  }
  const probPrevista = probDoMercado(probs, mercado)

  const base = {
    mandante: jogo.mandante,
    visitante: jogo.visitante,
    liga: jogo.competicao || 'Outro',
    criadoEm: new Date().toISOString(),
    resultado: null,
    origem: 'analise_ia',
    // ✅ NOVO — Fase 1, item 4: qual versão do motor gerou esta previsão
    motorVersao: jogo.motor_versao ?? null,
    // ✅ NOVO — Fase 7, item 41: snapshot dos fatores de calibração no
    // momento da previsão (não só a versão do motor) — sem isso não dá
    // pra auditar retroativamente qual fator estava valendo nessa entrada.
    fatoresCalibUsados: jogo.calibracao_fatores ?? jogo.calibracao?.fatores ?? null,
  }

  const registroGols = {
    ...base,
    id: Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    mercado,
    confianca: conf,
    probPrevista, // prob. exibida (já calibrada)
    // ✅ FIX — prob. ANTES da calibração: é a que a calibração automática deve usar
    probBruta: jogo.probs_brutas_gols ? probDoMercado(jogo.probs_brutas_gols, mercado) : null,
    odd: jogo.odds_mercado?.melhorEV?.odd || null,
    // ✅ REVISADO — item 40: cobre os 4 mercados de Gols com sub-modelos expostos
    subModelos: SUBMODELOS_POR_MERCADO[mercado] ? jogo[SUBMODELOS_POR_MERCADO[mercado]] ?? null : null,
    obs: [
      jogo.media_gols_esperada != null ? `λ=${Number(jogo.media_gols_esperada).toFixed(2)}` : null,
      jogo.score_composto != null ? `score=${jogo.score_composto}` : null,
      `p=${probPrevista}`,
      jogo.horario ? `horário ${jogo.horario}` : null,
      jogo.dataJogo || null,
    ].filter(Boolean).join(' · '),
  }

  const registros = [registroGols]

  // ✅ NOVO — melhor entrada de Cartões e de Escanteios também vão pro Tracker
  const mCE = jogo.mercado_cartoes_escanteios
  const melhorEntradaCE = mCE?.melhorEntrada
  if (melhorEntradaCE) {
    // Maior prob entre Over/Under, priorizando quem está na zona útil (55–75%)
    const escolherMelhor = (over, under) => {
      if (!over && !under) return null
      if (!under) return over
      if (!over) return under
      if (over.naZonaUtil && !under.naZonaUtil) return over
      if (under.naZonaUtil && !over.naZonaUtil) return under
      return over.prob >= under.prob ? over : under
    }

    const melhorCartoes = escolherMelhor(melhorEntradaCE.cartoesOver, melhorEntradaCE.cartoesUnder)
    if (melhorCartoes) {
      registros.push({
        ...base,
        id: Date.now() + '_' + Math.random().toString(36).slice(2, 7) + '_c',
        mercado: melhorCartoes.nome,
        confianca: melhorCartoes.confianca,
        probPrevista: melhorCartoes.prob,
        probBruta: melhorCartoes.probBruta ?? null,   // ✅ FIX
        odd: null,
        obs: [
          mCE.lambdaCartoes != null ? `λ=${mCE.lambdaCartoes}` : null,
          `p=${melhorCartoes.prob}`,
          jogo.horario ? `horário ${jogo.horario}` : null,
          jogo.dataJogo || null,
        ].filter(Boolean).join(' · '),
      })
    }

    const melhorEscanteios = escolherMelhor(melhorEntradaCE.escanteiosOver, melhorEntradaCE.escanteiosUnder)
    if (melhorEscanteios) {
      registros.push({
        ...base,
        id: Date.now() + '_' + Math.random().toString(36).slice(2, 7) + '_e',
        mercado: melhorEscanteios.nome,
        confianca: melhorEscanteios.confianca,
        probPrevista: melhorEscanteios.prob,
        probBruta: melhorEscanteios.probBruta ?? null,   // ✅ FIX
        odd: null,
        obs: [
          mCE.lambdaEscanteios != null ? `λ=${mCE.lambdaEscanteios}` : null,
          `p=${melhorEscanteios.prob}`,
          jogo.horario ? `horário ${jogo.horario}` : null,
          jogo.dataJogo || null,
        ].filter(Boolean).join(' · '),
      })
    }
  }

  const resGet = await fetch(`${API_BASE}/api/tracker`)
  const atuais = resGet.ok ? await resGet.json() : []
  const lista  = Array.isArray(atuais) ? atuais : []

  // Evita duplicar o mesmo confronto + mercado no mesmo dia — roda por
  // registro individual, então grava só os que ainda não existem hoje
  const hoje = new Date().toLocaleDateString('pt-BR')
  const novosValidos = registros.filter(novo => {
    const jaExiste = lista.some(j =>
      j.mandante === novo.mandante &&
      j.visitante === novo.visitante &&
      j.mercado === novo.mercado &&
      new Date(j.criadoEm).toLocaleDateString('pt-BR') === hoje
    )
    return !jaExiste
  })

  if (!novosValidos.length) throw new Error('Este(s) jogo(s)+mercado já está(ão) no tracker de hoje')

  const resPost = await fetch(`${API_BASE}/api/tracker`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token,
    },
    body: JSON.stringify([...novosValidos, ...lista]),
  })
  if (!resPost.ok) {
    const err = await resPost.json().catch(() => ({}))
    throw new Error(err.error || `Erro HTTP ${resPost.status} — só admin pode salvar`)
  }
  invalidarCacheCalibration() // próxima análise já usa o histórico atualizado
  return novosValidos
}

/** ✅ NOVO — monta a lista de entradas candidatas (gols + cartões + escanteios) */
function montarCandidatosTracker(jogo) {
  const candidatos = []

  if (jogo.melhor_entrada_over_gols) {
    candidatos.push({
      key: 'gols_over',
      grupo: '⚽ Gols',
      nome: jogo.melhor_entrada_over_gols.nome,
      prob: jogo.melhor_entrada_over_gols.prob,
      confianca: jogo.melhor_entrada_over_gols.confianca,
    })
  }
  if (jogo.melhor_entrada_under_gols) {
    candidatos.push({
      key: 'gols_under',
      grupo: '⚽ Gols',
      nome: jogo.melhor_entrada_under_gols.nome,
      prob: jogo.melhor_entrada_under_gols.prob,
      confianca: jogo.melhor_entrada_under_gols.confianca,
    })
  }

  const meCE = jogo.mercado_cartoes_escanteios?.melhorEntrada
  if (meCE?.cartoesOver) {
    candidatos.push({
      key: 'cartoes_over',
      grupo: '🟨 Cartões',
      nome: meCE.cartoesOver.nome,
      prob: meCE.cartoesOver.prob,
      confianca: meCE.cartoesOver.confianca,
    })
  }
  if (meCE?.cartoesUnder) {
    candidatos.push({
      key: 'cartoes_under',
      grupo: '🟨 Cartões',
      nome: meCE.cartoesUnder.nome,
      prob: meCE.cartoesUnder.prob,
      confianca: meCE.cartoesUnder.confianca,
    })
  }
  if (meCE?.escanteiosOver) {
    candidatos.push({
      key: 'escanteios_over',
      grupo: '🚩 Escanteios',
      nome: meCE.escanteiosOver.nome,
      prob: meCE.escanteiosOver.prob,
      confianca: meCE.escanteiosOver.confianca,
    })
  }
  if (meCE?.escanteiosUnder) {
    candidatos.push({
      key: 'escanteios_under',
      grupo: '🚩 Escanteios',
      nome: meCE.escanteiosUnder.nome,
      prob: meCE.escanteiosUnder.prob,
      confianca: meCE.escanteiosUnder.confianca,
    })
  }

  return candidatos
}

/** ✅ NOVO — salva no Tracker só as entradas marcadas pelo usuário (checkboxes) */
async function salvarEntradasNoTracker(jogo, token, candidatosSelecionados) {
  if (!token) throw new Error('Faça login para salvar no histórico')
  if (!candidatosSelecionados?.length) throw new Error('Marque ao menos uma entrada para salvar')

  const base = {
    mandante: jogo.mandante,
    visitante: jogo.visitante,
    liga: jogo.competicao || 'Outro',
    criadoEm: new Date().toISOString(),
    resultado: null,
    origem: 'analise_ia',
    // ✅ NOVO — Fase 1, item 4: qual versão do motor gerou esta previsão
    motorVersao: jogo.motor_versao ?? null,
  }

  const registros = candidatosSelecionados.map((c, i) => ({
    ...base,
    id: Date.now() + '_' + Math.random().toString(36).slice(2, 7) + '_' + i,
    mercado: c.nome,
    confianca: c.confianca ?? 'Média',
    probPrevista: c.prob,
    odd: jogo.odds_mercado?.melhorEV?.nome === c.nome ? jogo.odds_mercado.melhorEV.odd : null,
    obs: [
      `p=${c.prob}`,
      jogo.horario ? `horário ${jogo.horario}` : null,
      jogo.dataJogo || null,
    ].filter(Boolean).join(' · '),
  }))

  const resGet = await fetch(`${API_BASE}/api/tracker`)
  const atuais = resGet.ok ? await resGet.json() : []
  const lista  = Array.isArray(atuais) ? atuais : []

  const hoje = new Date().toLocaleDateString('pt-BR')
  const novosValidos = registros.filter(novo => {
    const jaExiste = lista.some(j =>
      j.mandante === novo.mandante &&
      j.visitante === novo.visitante &&
      j.mercado === novo.mercado &&
      new Date(j.criadoEm).toLocaleDateString('pt-BR') === hoje
    )
    return !jaExiste
  })

  if (!novosValidos.length) throw new Error('Este(s) mercado(s) já está(ão) no tracker de hoje')

  const resPost = await fetch(`${API_BASE}/api/tracker`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token,
    },
    body: JSON.stringify([...novosValidos, ...lista]),
  })
  if (!resPost.ok) {
    const err = await resPost.json().catch(() => ({}))
    throw new Error(err.error || `Erro HTTP ${resPost.status} — só admin pode salvar`)
  }
  invalidarCacheCalibration()
  return novosValidos
}

/** ✅ NOVO — texto enxuto só com o(s) mercado(s) que foram salvos */
function formatarEntradasSalvasParaCopia(jogo, registrosSalvos) {
  const linhas = [
    `${jogo.mandante} × ${jogo.visitante}`,
    `Competição: ${jogo.competicao || '—'}`,
    `Horário: ${jogo.horario || '—'} | Data: ${jogo.dataJogo || '—'}`,
    ...registrosSalvos.map(r => `${r.mercado} — ${r.probPrevista}% (confiança ${r.confianca})`),
  ]
  linhas.push('─'.repeat(40))
  return linhas.join('\n')
}

/** Mesma ideia, mas pro formato de jogo de tênis (mercado = vencedor da partida) */
async function salvarJogoTenisNoTracker(jogo, token) {
  if (!token) throw new Error('Faça login para salvar no histórico')

  const favorito = jogo.prob_mandante >= jogo.prob_visitante ? jogo.mandante : jogo.visitante
  const probPrevista = Math.max(jogo.prob_mandante, jogo.prob_visitante)
  const mercado = `${favorito} vencedor (ML)`
    // ✅ NOVO — prob. ANTES da calibração (a calibração do tênis usa esta, pra não "corrigir o já corrigido")
  const bruta = jogo.probBruta
  const probBruta = bruta ? (jogo.prob_mandante >= jogo.prob_visitante ? bruta.mandante : bruta.visitante) : probPrevista

  const novo = {
    id: Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    mandante: jogo.mandante,
    visitante: jogo.visitante,
    liga: jogo.competicao || 'Tênis',
    mercado,
    confianca: jogo.confianca ?? 'Média',
    esporte: 'Tênis',
    // ✅ NOVO — id do evento (FlashLive): sem isso o resolvedor automático
    // (item 6) não consegue conferir o resultado sozinho e a entrada fica
    // pendente pra sempre, exigindo baixa manual.
    eventoId: jogo.id ?? null,
    probPrevista,
    probBruta,
    odd: null,
    // ✅ NOVO — Fase 1, item 4: qual versão do motor gerou esta previsão
    motorVersao: jogo.motor_versao ?? null,
    obs: [
      jogo.melhorPlacar ? `placar ${jogo.melhorPlacar.jogador} ${jogo.melhorPlacar.placar} (${jogo.melhorPlacar.prob}%)` : null,
      jogo.mercadoStraightSets ? `sets diretos ${jogo.mercadoStraightSets.jogador} ${jogo.mercadoStraightSets.placar} (${jogo.mercadoStraightSets.prob}%)` : null,
      jogo.totalGamesEstimado ? `games ~${jogo.totalGamesEstimado.estimado} (${jogo.totalGamesEstimado.faixaMin}-${jogo.totalGamesEstimado.faixaMax})` : null,
      `p=${probPrevista}`,
      jogo.horario ? `horário ${jogo.horario}` : null,
      jogo.dataJogo || null,
    ].filter(Boolean).join(' · '),
    resultado: null,
    criadoEm: new Date().toISOString(),
    origem: 'analise_ia_tenis',
  }

  const resGet = await fetch(`${API_BASE}/api/tracker`)
  const atuais = resGet.ok ? await resGet.json() : []
  const lista  = Array.isArray(atuais) ? atuais : []

  const hoje = new Date().toLocaleDateString('pt-BR')
  const jaExiste = lista.some(j =>
    j.mandante === novo.mandante &&
    j.visitante === novo.visitante &&
    j.mercado === novo.mercado &&
    new Date(j.criadoEm).toLocaleDateString('pt-BR') === hoje
  )
  if (jaExiste) throw new Error('Este jogo já está no tracker de hoje')

  const resPost = await fetch(`${API_BASE}/api/tracker`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token,
    },
    body: JSON.stringify([novo, ...lista]),
  })
  if (!resPost.ok) {
    const err = await resPost.json().catch(() => ({}))
    throw new Error(err.error || `Erro HTTP ${resPost.status} — só admin pode salvar`)
  }
  invalidarCacheCalibration()
  return novo
}

/** ✅ NOVO — grava "Sets Diretos" como mercado PRÓPRIO no Tracker (gradeável
 *  independente do "Vencedor"), pra alimentar a calibração de 'Tênis:Sets Diretos'
 *  que antes nunca recebia dados (só existia como texto solto em obs). */
async function salvarSetsDiretosNoTracker(jogo, token) {
  if (!token) throw new Error('Faça login para salvar no histórico')
  if (!jogo.mercadoStraightSets) throw new Error('Sets diretos não é mais possível nesse jogo')

  const mercado = `${jogo.mercadoStraightSets.jogador} sets diretos (${jogo.mercadoStraightSets.placar})`
  const probPrevista = jogo.mercadoStraightSets.prob
  const probBruta = jogo.mercadoStraightSets.probBruta ?? probPrevista

  const novo = {
    id: Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    mandante: jogo.mandante,
    visitante: jogo.visitante,
    liga: jogo.competicao || 'Tênis',
    mercado,
    confianca: jogo.confianca ?? 'Média',
    esporte: 'Tênis',
    // ✅ NOVO — mesma lógica da entrada de "Vitória": guarda o id do evento
    // pra liquidação automática (item 6) conseguir conferir os sets sozinha.
    eventoId: jogo.id ?? null,
    probPrevista,
    probBruta,
    odd: null,
    // ✅ NOVO — Fase 1, item 4: qual versão do motor gerou esta previsão
    motorVersao: jogo.motor_versao ?? null,
    obs: [
      `p=${probPrevista}`,
      jogo.horario ? `horário ${jogo.horario}` : null,
      jogo.dataJogo || null,
    ].filter(Boolean).join(' · '),
    resultado: null,
    criadoEm: new Date().toISOString(),
    origem: 'analise_ia_tenis',
  }

  const resGet = await fetch(`${API_BASE}/api/tracker`)
  const atuais = resGet.ok ? await resGet.json() : []
  const lista  = Array.isArray(atuais) ? atuais : []

  const hoje = new Date().toLocaleDateString('pt-BR')
  const jaExiste = lista.some(j =>
    j.mandante === novo.mandante &&
    j.visitante === novo.visitante &&
    j.mercado === novo.mercado &&
    new Date(j.criadoEm).toLocaleDateString('pt-BR') === hoje
  )
  if (jaExiste) throw new Error('Este jogo já está no tracker de hoje')

  const resPost = await fetch(`${API_BASE}/api/tracker`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token,
    },
    body: JSON.stringify([novo, ...lista]),
  })
  if (!resPost.ok) {
    const err = await resPost.json().catch(() => ({}))
    throw new Error(err.error || `Erro HTTP ${resPost.status} — só admin pode salvar`)
  }
  invalidarCacheCalibration()
  return novo
}



// ── Estilos globais ──────────────────────────────────────────
const s = {
  wrap: { minHeight: '100vh', background: '#080d18', display: 'flex', flexDirection: 'column', fontFamily: "'Barlow', sans-serif" },
  header: {
  background: '#0a1120', borderBottom: '1px solid rgba(255,255,255,0.06)',
  padding: '10px 16px', display: 'flex', alignItems: 'center',
  justifyContent: 'space-between', position: 'sticky', top: 0, zIndex: 100,
  flexWrap: 'wrap', gap: 8,
  },
  logoWrap: { display: 'flex', alignItems: 'center', gap: 10 },
  logo: { fontFamily: "'Barlow Condensed', sans-serif", fontSize: 22, fontWeight: 900, color: '#e8eeff', letterSpacing: 1 },
  logoAccent: { color: '#00e676' },
  liveBadge: {
    background: 'rgba(0,230,118,0.1)', color: '#00e676',
    border: '1px solid rgba(0,230,118,0.25)', fontSize: 10,
    fontWeight: 700, padding: '3px 10px', borderRadius: 20, letterSpacing: 1.5,
  },
  dateChip: { background: '#18243a', color: '#6b7a99', fontSize: 12, fontWeight: 600, padding: '5px 12px', borderRadius: 8 },
  main: { flex: 1, maxWidth: 860, width: '100%', margin: '0 auto', padding: '16px 12px' },
  configBox: { background: '#0f1724', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 14, padding: '14px', marginBottom: 14 },
  sectionLabel: { fontFamily: "'Barlow Condensed', sans-serif", fontSize: 11, fontWeight: 700, letterSpacing: 2, color: '#4a5a78', textTransform: 'uppercase', marginBottom: 10 },
  apiRow: { display: 'flex', gap: 10, alignItems: 'center' },
  apiInput: { flex: 1, background: '#080d18', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: '10px 14px', color: '#e8eeff', fontSize: 13, outline: 'none', fontFamily: "'Barlow', sans-serif" },
  apiHelp: { fontSize: 11, color: '#4a5a78', marginTop: 8 },
  apiLink: { color: '#00b4d8', textDecoration: 'none' },
  filtersRow: { display: 'flex', gap: 10, marginBottom: 14, flexDirection: 'column' },
  filterCard: { flex: 1, background: '#0f1724', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 12, padding: '14px 16px' },
  filterLabel: { fontFamily: "'Barlow Condensed', sans-serif", fontSize: 11, fontWeight: 700, letterSpacing: 1.5, color: '#4a5a78', textTransform: 'uppercase', marginBottom: 8, display: 'block' },
  select: { width: '100%', background: '#080d18', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 7, padding: '8px 10px', color: '#e8eeff', fontSize: 13, outline: 'none', fontFamily: "'Barlow', sans-serif" },
  stepsWrap: { marginBottom: 24, display: 'flex', flexDirection: 'column', gap: 10 },
  stepRow: { display: 'flex', alignItems: 'center', gap: 12 },
  stepNum: { width: 28, height: 28, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 13, fontWeight: 900, flexShrink: 0 },
  stepBtn: { flex: 1, border: 'none', borderRadius: 10, padding: '13px 20px', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 16, fontWeight: 800, letterSpacing: 1.5, textTransform: 'uppercase', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, transition: 'opacity 0.2s, transform 0.15s', cursor: 'pointer' },
  
  stepDone: { background: 'rgba(0,230,118,0.08)', border: '1px solid rgba(0,230,118,0.25)', borderRadius: 8, padding: '8px 14px', fontSize: 12, color: '#00e676', fontWeight: 600, marginTop: 4, marginLeft: 40 },
  connector: { width: 2, height: 16, background: 'rgba(255,255,255,0.07)', marginLeft: 13 },
  errorBox: { background: 'rgba(255,82,82,0.08)', border: '1px solid rgba(255,82,82,0.2)', borderRadius: 10, padding: '16px 20px', color: '#ff5252', fontSize: 13, lineHeight: 1.7, marginBottom: 16, whiteSpace: 'pre-line' },
  infoBox: { background: 'rgba(0,180,216,0.06)', border: '1px solid rgba(0,180,216,0.15)', borderRadius: 10, padding: '12px 16px', fontSize: 12, color: '#7ab8cc', marginBottom: 16, lineHeight: 1.6 },
  resultsHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  resultsTitle: { fontFamily: "'Barlow Condensed', sans-serif", fontSize: 22, fontWeight: 700, color: '#e8eeff' },
  resumeBox: { background: 'rgba(0,230,118,0.05)', border: '1px solid rgba(0,230,118,0.12)', borderRadius: 10, padding: '12px 16px', fontSize: 13, color: '#7abf96', marginBottom: 20, lineHeight: 1.5 },
  card: { background: '#0f1724', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 16, padding: '20px', marginBottom: 14, overflow: 'hidden' },
  cardTop: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  competTag: { background: 'rgba(0,180,216,0.1)', color: '#00b4d8', border: '1px solid rgba(0,180,216,0.2)', fontSize: 10, fontWeight: 700, padding: '3px 10px', borderRadius: 20, letterSpacing: 1, fontFamily: "'Barlow Condensed', sans-serif", textTransform: 'uppercase' },
  horarioTag: { fontSize: 12, color: '#4a5a78', fontWeight: 600 },
  teamsRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, gap: 6 },
  teamName: { fontFamily: "'Barlow Condensed', sans-serif", fontSize: 16, fontWeight: 800, color: '#e8eeff', flex: 1, lineHeight: 1.2 },
  teamNameRight: { textAlign: 'right' },
  vsText: { color: '#4a5a78', fontSize: 13, fontWeight: 700, padding: '0 12px' },
  probSection: { marginBottom: 16 },
  probLabel: { fontSize: 10, fontWeight: 700, color: '#4a5a78', letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 8, fontFamily: "'Barlow Condensed', sans-serif" },
  probRow: { display: 'flex', gap: 8, marginBottom: 8 },
  probItem: { flex: 1, borderRadius: 10, padding: '10px 8px', textAlign: 'center' },
  probPct: { fontFamily: "'Barlow Condensed', sans-serif", fontSize: 22, fontWeight: 900, lineHeight: 1 },
  probSubLabel: { fontSize: 10, fontWeight: 600, marginTop: 3, opacity: 0.7 },
  barWrap: { height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.06)', overflow: 'hidden', display: 'flex', marginBottom: 16 },
  tabsRow: { display: 'flex', gap: 4, marginBottom: 14, background: 'rgba(255,255,255,0.03)', borderRadius: 10, padding: 4 },
  tab: { flex: 1, border: 'none', borderRadius: 7, padding: '8px 4px', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 13, fontWeight: 700, letterSpacing: 1, cursor: 'pointer', transition: 'all 0.2s', textTransform: 'uppercase' },
  marketBox: { borderRadius: 12, padding: '14px 16px', marginBottom: 14 },
  marketHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  marketLabel: { fontFamily: "'Barlow Condensed', sans-serif", fontSize: 11, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase' },
  marketValue: { fontFamily: "'Barlow Condensed', sans-serif", fontSize: 18, fontWeight: 900, marginBottom: 4 },
  marketMeta: { fontSize: 11, lineHeight: 1.5 },
  extrasRow: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 },
  extraChip: { flex: 1, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: '8px 10px', textAlign: 'center' },
  extraLabel: { fontSize: 10, color: '#4a5a78', fontWeight: 600, letterSpacing: 1, display: 'block', marginBottom: 3, fontFamily: "'Barlow Condensed', sans-serif" },
  extraVal: { fontFamily: "'Barlow Condensed', sans-serif", fontSize: 16, fontWeight: 800, color: '#e8eeff' },
  statsRow: { display: 'flex', gap: 8, marginBottom: 10 },
  statChip: { flex: 1, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 8, padding: '6px 8px', textAlign: 'center' },
  statLabel: { fontSize: 9, color: '#4a5a78', fontWeight: 700, letterSpacing: 0.8, display: 'block', marginBottom: 2, fontFamily: "'Barlow Condensed', sans-serif", textTransform: 'uppercase' },
  statVal: { fontFamily: "'Barlow Condensed', sans-serif", fontSize: 15, fontWeight: 800, color: '#e8eeff' },
  analiseBox: {
    background: 'rgba(255,255,255,0.03)',
    borderRadius: 8,
    padding: '14px 16px',
    fontSize: 12,
    color: '#6b7a99',
    lineHeight: 1.7,
    marginTop: 12,
    borderLeft: '3px solid rgba(0,230,118,0.3)'
  },
  confiancaBadge: { fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20, letterSpacing: 0.5 },
  emptyState: { textAlign: 'center', padding: '48px 20px', color: '#4a5a78' },
  resetBtn: { background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '9px 18px', color: '#6b7a99', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 14, fontWeight: 700, letterSpacing: 1, cursor: 'pointer', marginTop: 16 },
  divider: { height: 1, background: 'rgba(255,255,255,0.05)', margin: '14px 0' },
  amanhaRow: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, cursor: 'pointer', userSelect: 'none' },
  amanhaLabel: { fontSize: 12, color: '#9aaac4', fontWeight: 600 },
  selecaoBox: { background: '#0f1724', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 14, padding: '16px', marginBottom: 14 },
  selecaoTitulo: { fontFamily: "'Barlow Condensed', sans-serif", fontSize: 15, fontWeight: 800, color: '#e8eeff', marginBottom: 4 },
  selecaoSub: { fontSize: 12, color: '#6b7a99', marginBottom: 14, lineHeight: 1.5 },
  selecaoItem: { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 10, marginBottom: 8, border: '1px solid rgba(255,255,255,0.06)', cursor: 'pointer', transition: 'all 0.15s' },
  selecaoItemAtiva: { background: 'rgba(0,230,118,0.06)', border: '1px solid rgba(0,230,118,0.3)' },
  selecaoItemDesabilitada: { opacity: 0.4, cursor: 'not-allowed' },
  selecaoCheck: { width: 20, height: 20, borderRadius: 6, border: '1.5px solid rgba(255,255,255,0.2)', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 900 },
  confirmarBtn: { width: '100%', border: 'none', borderRadius: 10, padding: '13px 20px', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 15, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase', cursor: 'pointer', marginTop: 6 },
  rankingBox: { background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 10, padding: '12px 14px', marginBottom: 14 },
  rankingItem: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' },
}

const STEP_COLORS = ['#00b4d8', '#ffd60a', '#00e676']
const STEP_LABELS = [
  { icon: '🌐', text: 'ETAPA 1 — Buscar Jogos do Dia' },
  { icon: '📊', text: 'ETAPA 2 — Buscar Históricos' },
  { icon: '🧮', text: 'ETAPA 3 — Calcular Probabilidades' },
]

const LIGAS = [
  { value: 'Campeonato Brasileiro Serie A', label: '🇧🇷 Brasileirão Série A' },
  { value: 'Campeonato Brasileiro Serie B', label: '🇧🇷 Brasileirão Série B' },
  { value: 'Copa Libertadores',             label: '🌎 Copa Libertadores' },
  { value: 'Copa Sul-Americana',            label: '🏆 Copa Sul-Americana' },
  { value: 'UEFA Champions League',         label: '⭐ UEFA Champions League' },
  { value: 'UEFA Europa League',            label: '🇪🇺 UEFA Europa League' },
  { value: 'Premier League Inglaterra',     label: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League' },
  { value: 'La Liga Espanha',               label: '🇪🇸 La Liga' },
  { value: 'Serie A Italia',                label: '🇮🇹 Serie A (Itália)' },
  { value: 'Bundesliga Alemanha',           label: '🇩🇪 Bundesliga' },
  { value: 'Copa do Mundo',          label: '🏆 Copa do Mundo FIFA' },
  { value: 'Eliminatórias Copa',     label: '🌍 Eliminatórias Copa do Mundo' },
  { value: 'Copa América',           label: '🌎 Copa América' },
  { value: 'UEFA Nations League',    label: '🇪🇺 Nations League' },
  { value: 'Amistosos Internacionais', label: '🤝 Amistosos (Seleções)' },
]

function getTodayStr() {
  return new Date().toLocaleDateString('pt-BR', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
}

function confiancaCor(nivel) {
  if (nivel === 'Alta')  return '#00e676'
  if (nivel === 'Média') return '#ffd60a'
  return '#ff6b6b'
}

function ConfiancaBadge({ nivel }) {
  const cor  = confiancaCor(nivel)
  const icon = nivel === 'Alta' ? '🔥' : nivel === 'Média' ? '✅' : '⚠️'
  return (
    <span style={{ ...s.confiancaBadge, color: cor, background: `${cor}18`, border: `1px solid ${cor}40` }}>
      {icon} {nivel}
    </span>
  )
}

function ProbBar({ pm, pe, pv }) {
  return (
    <div style={s.barWrap}>
      <div style={{ width: `${pm}%`, background: '#00b4d8', transition: 'width 0.6s ease' }} />
      <div style={{ width: `${pe}%`, background: '#ffd60a', transition: 'width 0.6s ease' }} />
      <div style={{ width: `${pv}%`, background: '#ff6b6b', transition: 'width 0.6s ease' }} />
    </div>
  )
}

function oddParaProb(odd) {
  if (!odd || odd <= 1) return null
  return parseFloat((1 / odd * 100).toFixed(1))
}

function GaugeComparativo({ label, probModelo, probMercado, ev, odd }) {
  if (!probModelo || !probMercado) return null
  const diff     = probModelo - probMercado
  const temBorda = ev !== null && ev > 0
  const cor      = temBorda ? '#00e676' : diff > 0 ? '#ffd60a' : '#ff6b6b'
  const sinal    = diff > 0 ? '+' : ''
  const wModelo  = Math.min(100, (probModelo / Math.max(probModelo, probMercado, 1)) * 100)
  const wMercado = Math.min(100, (probMercado / Math.max(probModelo, probMercado, 1)) * 100)
  return (
    <div style={{ background: temBorda ? 'rgba(0,230,118,0.04)' : 'rgba(255,255,255,0.02)', border: `1px solid ${temBorda ? 'rgba(0,230,118,0.2)' : 'rgba(255,255,255,0.06)'}`, borderRadius: 10, padding: '10px 12px', flex: 1 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: '#4a5a78', fontFamily: "'Barlow Condensed', sans-serif", letterSpacing: 1, textTransform: 'uppercase' }}>{label}</span>
        {temBorda && (
          <span style={{ fontSize: 9, fontWeight: 800, color: '#00e676', background: 'rgba(0,230,118,0.12)', border: '1px solid rgba(0,230,118,0.3)', borderRadius: 20, padding: '2px 7px', fontFamily: "'Barlow Condensed', sans-serif" }}>
            EV+{Math.round(ev * 100)}%
          </span>
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 20, fontWeight: 900, color: cor, lineHeight: 1 }}>{probModelo}%</div>
          <div style={{ fontSize: 9, color: '#4a5a78', fontWeight: 600, marginTop: 2 }}>MODELO</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 13, fontWeight: 800, color: diff === 0 ? '#4a5a78' : cor }}>{sinal}{diff.toFixed(1)}pp</div>
          {odd && <div style={{ fontSize: 9, color: '#4a5a78', fontWeight: 600 }}>@{odd}</div>}
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 20, fontWeight: 900, color: '#6b7a99', lineHeight: 1 }}>{probMercado}%</div>
          <div style={{ fontSize: 9, color: '#4a5a78', fontWeight: 600, marginTop: 2 }}>MERCADO</div>
        </div>
      </div>
      <div style={{ position: 'relative', height: 5, borderRadius: 3, background: 'rgba(255,255,255,0.05)', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${wMercado}%`, background: 'rgba(107,122,153,0.4)', borderRadius: 3 }} />
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${wModelo}%`, background: cor, borderRadius: 3, opacity: 0.85 }} />
      </div>
    </div>
  )
}

function RankingMercados({ ranking }) {
  if (!ranking || ranking.length === 0) return null
  return (
    <div style={s.rankingBox}>
      <div style={{ ...s.probLabel, marginBottom: 10 }}>🏆 Ranking de Mercados de Gols (por probabilidade)</div>
      {ranking.map((m, i) => {
        const cor = confiancaCor(m.confianca)
        const isTop = i === 0
        return (
          <div key={m.nome} style={{
            ...s.rankingItem,
            background: isTop ? 'rgba(0,230,118,0.04)' : 'transparent',
            padding: '8px 4px',
            borderRadius: isTop ? 6 : 0,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 11, color: '#4a5a78', minWidth: 18 }}>#{i+1}</span>
              <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 14, fontWeight: isTop ? 800 : 600, color: isTop ? '#e8eeff' : '#a0b0c8' }}>
                {m.nome}
              </span>
              {isTop && (
                <span style={{ fontSize: 9, fontWeight: 800, color: '#00e676', background: 'rgba(0,230,118,0.12)', border: '1px solid rgba(0,230,118,0.3)', borderRadius: 20, padding: '2px 7px', fontFamily: "'Barlow Condensed', sans-serif" }}>
                  MELHOR ENTRADA
                </span>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 16, fontWeight: 900, color: isTop ? '#00e676' : '#e8eeff' }}>
                {m.prob}%
              </span>
              <span style={{ ...s.confiancaBadge, color: cor, background: `${cor}18`, border: `1px solid ${cor}40`, fontSize: 10 }}>
                {m.confianca}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function OddInline({ jogo }) {
  const [odd, setOdd] = useState('')
  const [salvo, setSalvo] = useState(false)

  const salvarOdd = async () => {
    if (!jogo.id || !odd) return
    await fetch(`${API_BASE}/api/tracker/auto-save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventoId: jogo.id, mandante: jogo.mandante, visitante: jogo.visitante,
        liga: jogo.competicao, mercado: jogo.mercado_gols_limpo, odd,
        clima: jogo.clima ?? null,
      }),
    }).catch(() => {})
    setSalvo(true)
    setTimeout(() => setSalvo(false), 2000)
  }

  if (!jogo.id) return null

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
      <input value={odd} onChange={e => setOdd(e.target.value)} placeholder="odd tomada"
        style={{ width: 70, background: '#080d18', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, padding: '4px 8px', color: '#e8eeff', fontSize: 12 }} />
      <button onClick={salvarOdd} style={{ fontSize: 11, color: '#ffd60a', background: 'none', border: '1px solid rgba(255,214,10,0.4)', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }}>
        {salvo ? '✅ salvo' : 'salvar odd'}
      </button>
    </div>
  )
}

// ✅ NOVO — Fase 8, item 37: painel colapsável "por que essa previsão?"
// ✅ NOVO — item 40: marca claramente amostra pequena (poucos jogos no
// histórico) ou baixa liquidez (poucas casas de apostas no no-vig) — hoje
// esses dois só existiam calculados internamente e nunca chegavam na tela.
function AvisoAmostraELiquidez({ jogo }) {
  const amostraPequena = jogo.qualidade_dados === 'baixa'
  const nBooks = jogo.odds_mercado?.nBooksNoVig
  const baixaLiquidez = typeof nBooks === 'number' && nBooks < 3

  if (!amostraPequena && !baixaLiquidez) return null

  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
      {amostraPequena && (
        <div style={{ fontSize: 11, fontWeight: 700, color: '#ffc107', background: 'rgba(255,193,7,0.1)', border: '1px solid rgba(255,193,7,0.3)', borderRadius: 8, padding: '4px 10px' }}>
          ⚠️ Amostra pequena — poucos jogos no histórico de um dos times ({jogo.n_jogos_usados ?? '?'} jogos usados)
        </div>
      )}
      {baixaLiquidez && (
        <div style={{ fontSize: 11, fontWeight: 700, color: '#ffc107', background: 'rgba(255,193,7,0.1)', border: '1px solid rgba(255,193,7,0.3)', borderRadius: 8, padding: '4px 10px' }}>
          ⚠️ Baixa liquidez — só {nBooks} casa(s) de apostas no consenso no-vig
        </div>
      )}
    </div>
  )
}

function PainelExplicabilidade({ jogo }) {
  const [aberto, setAberto] = useState(false)
  const f = jogo.fatores_explicabilidade
  if (!f) return null
  return (
    <div style={{ background: 'rgba(107,122,153,0.06)', border: '1px solid rgba(107,122,153,0.2)', borderRadius: 10, padding: '10px 12px', marginBottom: 14 }}>
      <button onClick={() => setAberto(a => !a)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#8a9bb8', textTransform: 'uppercase', letterSpacing: 1, fontFamily: "'Barlow Condensed', sans-serif" }}>
          🔍 Por que essa previsão? — fatores usados
        </span>
        <span style={{ color: '#4a5a78', fontSize: 14 }}>{aberto ? '▲' : '▼'}</span>
      </button>
      {aberto && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: '#c8d4e8' }}>
          <div>📈 <strong>Poisson</strong> — λ {jogo.mandante} {Number(f.poisson.lambdaM).toFixed(2)} × λ {jogo.visitante} {Number(f.poisson.lambdaV).toFixed(2)}
            {f.poisson.dixonColesRho != null && <span style={{ color: '#6b7a99' }}> · ρ Dixon-Coles {Number(f.poisson.dixonColesRho).toFixed(3)} (corrige placares baixos)</span>}
          </div>
          <div>🤝 <strong>H2H</strong> — {f.h2h.usado ? `usado no blend (λ H2H ${Number(f.h2h.lambda).toFixed(2)})` : 'sem confrontos recentes suficientes — não entrou no blend'}</div>
          <div>🏆 <strong>ELO</strong> — {jogo.mandante} {(f.elo.fatorMandante ?? 1).toFixed(3)}x · {jogo.visitante} {(f.elo.fatorVisitante ?? 1).toFixed(3)}x força relativa</div>
          <div>🌦️ <strong>Clima</strong> — {f.clima.usado ? `considerado (${f.clima.resumo?.probabilidadeChuva ?? '?'}% chuva, ${f.clima.resumo?.ventoKmh ?? '?'}km/h vento)` : 'sem dado / não afetou o cálculo'}</div>
          {f.arbitro && <div>🧑‍⚖️ <strong>Árbitro</strong> — {f.arbitro.nome}{f.arbitro.sazonal ? ' (perfil sazonal aplicado)' : ''}</div>}
          {f.fadiga && (f.fadiga.mandante?.riscoRotacao || f.fadiga.visitante?.riscoRotacao) && (
            <div style={{ color: '#ffc107' }}>
              ⚠️ <strong>Risco de rotação</strong> —{' '}
              {f.fadiga.mandante?.riscoRotacao && `${jogo.mandante} jogou ${f.fadiga.mandante.competicaoAnterior} no meio da semana`}
              {f.fadiga.mandante?.riscoRotacao && f.fadiga.visitante?.riscoRotacao && ' · '}
              {f.fadiga.visitante?.riscoRotacao && `${jogo.visitante} jogou ${f.fadiga.visitante.competicaoAnterior} no meio da semana`}
            </div>
          )}
          <div>🎯 <strong>Calibração do Tracker</strong> — {Object.keys(f.calibracao.fatores || {}).filter(k => !k.startsWith('_n_')).length} mercado(s) com fator ajustado pelo histórico real de greens/reds</div>
          {f.calibracao.pesoStackingOver25 != null && (
            <div>⚖️ <strong>Stacking (Over 2.5)</strong> — peso Poisson aprendido: {f.calibracao.pesoStackingOver25}</div>
          )}
          {f.blendMercado.aplicado && <div>📡 <strong>Mercado</strong> — prob. final puxada 32% em direção ao consenso das odds</div>}
        </div>
      )}
    </div>
  )
}



// ✅ NOVO — banca atual (persistida por usuário no servidor). Store simples em
// módulo: todos os cards compartilham a mesma banca e só 1 GET é feito.
let _bancaCache = undefined   // undefined = ainda não carregou · null = sem banca salva · número = banca
let _bancaToken = null
let _bancaPromise = null
const _bancaListeners = new Set()
function _bancaSet(v) { _bancaCache = v; _bancaListeners.forEach(fn => fn(v)) }

function useBanca(authToken) {
  const [banca, setBanca] = useState(_bancaCache)
  useEffect(() => {
    _bancaListeners.add(setBanca)
    return () => { _bancaListeners.delete(setBanca) }
  }, [])
  useEffect(() => {
    if (!authToken) return
    if (_bancaToken !== authToken) { _bancaToken = authToken; _bancaPromise = null; _bancaSet(undefined) }
    if (_bancaCache !== undefined || _bancaPromise) return
    _bancaPromise = fetch(`${API_BASE}/api/banca`, { headers: { 'x-auth-token': authToken } })
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d) _bancaSet(d.valor ?? null) })
      .catch(() => {})
      .finally(() => { _bancaPromise = null })
  }, [authToken])
  const salvar = useCallback(async (valor) => {
    const r = await fetch(`${API_BASE}/api/banca`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-auth-token': authToken },
      body: JSON.stringify({ valor }),
    })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(d.error || `Erro HTTP ${r.status}`)
    _bancaSet(d.valor)
  }, [authToken])
  return { banca, salvar }
}

/** "1.500,50" (BR) ou "1500.50" → número; NaN se inválido. */
function lerValorBRL(txt) {
  const t = String(txt).trim().replace(/[^\d.,]/g, '')
  if (!t) return NaN
  if (t.includes(',')) return Number(t.replace(/\./g, '').replace(',', '.'))
  if (/^\d{1,3}(\.\d{3})+$/.test(t)) return Number(t.replace(/\./g, '')) // "2.000" = milhar
  return Number(t)
}
const fmtBRL = v => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

function BancaKelly({ pct, authToken }) {
  const { banca, salvar } = useBanca(authToken)
  const [editando, setEditando] = useState(false)
  const [txt, setTxt] = useState('')
  const [erro, setErro] = useState('')
  const [salvando, setSalvando] = useState(false)

  const stakeReais = banca != null && banca > 0 && pct > 0 ? Math.round(banca * pct) / 100 : null

  const confirmar = async () => {
    const v = lerValorBRL(txt)
    if (!Number.isFinite(v) || v <= 0) { setErro('Valor inválido'); return }
    setSalvando(true); setErro('')
    try { await salvar(v); setEditando(false) }
    catch (e) { setErro(e.message) }
    finally { setSalvando(false) }
  }

  return (
    <div style={{ fontSize: 11, color: '#ffd60a', marginTop: 4 }}>
      💰 Kelly fracionário (1/4): <strong>{pct}%</strong> da banca
      {pct === 0 ? ' (edge não sustenta stake)' : ` · teto ${5}% por entrada`}
      {stakeReais != null && <> → <strong>{fmtBRL(stakeReais)}</strong></>}
      {authToken && (
        <div style={{ marginTop: 3, color: '#8a9bb8' }}>
          {!editando ? (
            <>
              Minha banca: <strong style={{ color: '#e8eeff' }}>{banca != null ? fmtBRL(banca) : 'não definida'}</strong>{' '}
              <span onClick={() => { setTxt(banca != null ? String(banca).replace('.', ',') : ''); setErro(''); setEditando(true) }}
                style={{ cursor: 'pointer', textDecoration: 'underline' }}>
                {banca != null ? 'alterar' : 'definir'}
              </span>
            </>
          ) : (
            <>
              R${' '}
              <input value={txt} onChange={e => setTxt(e.target.value)} inputMode="decimal" autoFocus
                onKeyDown={e => { if (e.key === 'Enter') confirmar(); if (e.key === 'Escape') setEditando(false) }}
                style={{ width: 90, background: '#0f1724', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 4, color: '#e8eeff', padding: '2px 6px', fontSize: 11 }} />{' '}
              <span onClick={salvando ? undefined : confirmar} style={{ cursor: 'pointer', color: '#00e676' }}>{salvando ? 'salvando…' : 'salvar'}</span>{' '}
              <span onClick={() => setEditando(false)} style={{ cursor: 'pointer' }}>cancelar</span>
              {erro && <span style={{ color: '#ff4757' }}> · {erro}</span>}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function TabGols({ jogo, authToken }) {
  const { stats_mandante: sM, stats_visitante: sV, mandante, visitante } = jogo
  return (
    <div>
      <div style={{ ...s.marketBox, background: 'rgba(255,214,10,0.06)', border: '1px solid rgba(255,214,10,0.2)' }}>
        <div style={s.marketHeader}>
          <span style={{ ...s.marketLabel, color: '#ffd60a' }}>⚽ Mercado de Gols Recomendado</span>
          <ConfiancaBadge nivel={jogo.confianca_gols} />
        </div>
        <div style={{ ...s.marketValue, color: '#ffd60a' }}>{jogo.mercado_gols}</div>
        {jogo.media_gols_esperada !== null && (
          <div style={{ fontSize: 12, color: '#a89440', marginBottom: 4 }}>
            📈 λ Total: <strong style={{ color: '#ffd60a' }}>{Number(jogo.media_gols_esperada).toFixed(2)} gols</strong>
            {jogo.lambda_poisson != null && (
              <span style={{ color: '#6b7a99' }}> · Poisson puro: {Number(jogo.lambda_poisson).toFixed(2)}</span>
            )}
            {jogo.lambda_h2h != null && (
              <span style={{ color: jogo.temH2HNoCalculo ? '#00e676' : '#6b7a99' }}>
                {' '}· H2H: {Number(jogo.lambda_h2h).toFixed(2)} {jogo.temH2HNoCalculo ? '✓' : ''}
              </span>
            )}
          </div>
        )}
        <div style={{ ...s.marketMeta, color: '#a89440' }}>{jogo.descricao_mercado}</div>
        <OddInline jogo={jogo} />
      </div>
      {(jogo.melhor_entrada_over_gols || jogo.melhor_entrada_under_gols) && (
        <div style={{ background: 'rgba(0,230,118,0.06)', border: '1px solid rgba(0,230,118,0.25)', borderRadius: 12, padding: '12px 16px', marginBottom: 14 }}>
          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 11, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase', color: '#00e676', marginBottom: 6 }}>
            🎯 Melhores Entradas — Gols
          </div>
          <div style={{ fontSize: 13, color: '#e8eeff', lineHeight: 1.8 }}>
            {jogo.melhor_entrada_over_gols && (
              <div>⬆️ <strong>{jogo.melhor_entrada_over_gols.nome}</strong> — {jogo.melhor_entrada_over_gols.prob}% (confiança {jogo.melhor_entrada_over_gols.confianca})</div>
            )}
            {jogo.melhor_entrada_under_gols && (
              <div>⬇️ <strong>{jogo.melhor_entrada_under_gols.nome}</strong> — {jogo.melhor_entrada_under_gols.prob}% (confiança {jogo.melhor_entrada_under_gols.confianca})</div>
            )}
          </div>
        </div>
      )}
      <PainelExplicabilidade jogo={jogo} />
      <AvisoAmostraELiquidez jogo={jogo} />
      <div style={s.extrasRow}>
        <div style={s.extraChip}><span style={s.extraLabel}>OVER 1.5</span><span style={s.extraVal}>{jogo.over15_gols}%</span></div>
        <div style={s.extraChip}><span style={s.extraLabel}>UNDER 1.5</span><span style={s.extraVal}>{jogo.under15_gols}%</span></div>
        <div style={s.extraChip}><span style={s.extraLabel}>OVER 2.5</span><span style={s.extraVal}>{jogo.over25_gols}%</span></div>
        <div style={s.extraChip}><span style={s.extraLabel}>UNDER 2.5</span><span style={s.extraVal}>{jogo.under25_gols}%</span></div>
      </div>
      <div style={{ ...s.extrasRow, marginBottom: 14 }}>
        <div style={s.extraChip}><span style={s.extraLabel}>OVER 3.5</span><span style={s.extraVal}>{jogo.over35_gols}%</span></div>
        <div style={s.extraChip}><span style={s.extraLabel}>UNDER 3.5</span><span style={s.extraVal}>{jogo.under35_gols}%</span></div>
        <div style={s.extraChip}><span style={s.extraLabel}>BTTS</span><span style={s.extraVal}>{jogo.btts}%</span></div>
        <div style={s.extraChip}><span style={s.extraLabel}>RESULTADO</span><span style={{ ...s.extraVal, fontSize: 11 }}>{jogo.mercado_resultado}</span></div>
      </div>
      {jogo.odds_mercado && (
        <div style={{ marginBottom: 14 }}>
          {jogo.odds_mercado.arbitragem?.existe && (
            <div style={{ background: 'rgba(0,230,118,0.12)', border: '1px solid #00e676', borderRadius: 8, padding: '8px 12px', marginBottom: 8, fontSize: 12, fontWeight: 700, color: '#00e676' }}>
              🎯 ARBITRAGEM — lucro garantido de {jogo.odds_mercado.arbitragem.lucroPct}% cobrindo os 3 resultados:{' '}
              {jogo.odds_mercado.arbitragem.pernas.map(p => `${p.resultado} @${p.odd} (${p.casa})`).join(' · ')}
            </div>
          )}
          <div style={{ ...s.probLabel, marginBottom: 8 }}>
            📡 Modelo vs Mercado ({jogo.odds_mercado.bookmaker}) · no-vig com {jogo.odds_mercado.nBooksNoVig ?? '?'} casa(s)
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, marginBottom: 8 }}>
            <GaugeComparativo label="Mandante"  probModelo={jogo.prob_mandante}  probMercado={jogo.odds_mercado.implM} ev={jogo.odds_mercado.evM}  odd={jogo.odds_mercado.mandante} />
            <GaugeComparativo label="Empate"    probModelo={jogo.prob_empate}    probMercado={jogo.odds_mercado.implE} ev={null}                    odd={jogo.odds_mercado.empate} />
            <GaugeComparativo label="Visitante" probModelo={jogo.prob_visitante} probMercado={jogo.odds_mercado.implV} ev={jogo.odds_mercado.evV}  odd={jogo.odds_mercado.visitante} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, marginBottom: 8 }}>
            <GaugeComparativo label="Over 1.5" probModelo={jogo.over15_gols} probMercado={oddParaProb(jogo.odds_mercado.over15)} ev={jogo.odds_mercado.evOver15} odd={jogo.odds_mercado.over15} />
            <GaugeComparativo label="Over 2.5" probModelo={jogo.over25_gols} probMercado={oddParaProb(jogo.odds_mercado.over25)} ev={jogo.odds_mercado.evOver25} odd={jogo.odds_mercado.over25} />
            <GaugeComparativo label="Over 3.5" probModelo={jogo.over35_gols} probMercado={oddParaProb(jogo.odds_mercado.over35)} ev={jogo.odds_mercado.evOver35} odd={jogo.odds_mercado.over35} />
          </div>
          {jogo.odds_mercado.melhorEV && (
            <div style={{ background: 'rgba(0,230,118,0.06)', border: '1px solid rgba(0,230,118,0.25)', borderRadius: 8, padding: '10px 12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                <span style={{ fontSize: 11, color: '#7abf96', fontWeight: 600 }}>💎 Value Bet (edge ≥ {jogo.value_pick?.melhorValue?.edgeMin ?? 5}pp)</span>
                <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 13, fontWeight: 800, color: '#00e676' }}>{jogo.odds_mercado.melhorEV.nome}</span>
                <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 13, fontWeight: 900, color: '#00e676' }}>
                  {jogo.odds_mercado.melhorEV.edge != null ? `edge +${jogo.odds_mercado.melhorEV.edge}pp · ` : ''}
                  EV+{Math.round((jogo.odds_mercado.melhorEV.ev || 0) * 100)}% · @{jogo.odds_mercado.melhorEV.odd}
                </span>
              </div>
              {jogo.value_pick?.edgeMercadoSugerido && (
                <div style={{ fontSize: 11, color: '#8a9bb8' }}>
                  Mercado sugerido ({jogo.mercado_gols_limpo}):{' '}
                  <span style={{
                    color: jogo.value_pick.edgeMercadoSugerido.edge == null ? '#8a9bb8'
                      : jogo.value_pick.edgeMercadoSugerido.temValue ? '#00e676' : '#ffc107',
                    fontWeight: 700,
                  }}>
                    {jogo.value_pick.edgeMercadoSugerido.edge == null
                      ? 'sem odd para comparar'
                      : `edge ${jogo.value_pick.edgeMercadoSugerido.edge >= 0 ? '+' : ''}${jogo.value_pick.edgeMercadoSugerido.edge}pp${jogo.value_pick.edgeMercadoSugerido.temValue ? ' ✓' : ` (abaixo de ${jogo.value_pick.edgeMercadoSugerido.edgeMin ?? 5}pp)`}`}
                  </span>
                </div>
              )}
              {jogo.odds_mercado.melhorEV.stakeKellyPct != null && (
                <BancaKelly pct={jogo.odds_mercado.melhorEV.stakeKellyPct} authToken={authToken} />
              )}
            </div>
          )}
          {!jogo.odds_mercado.melhorEV && jogo.value_pick && (
            <div style={{ background: 'rgba(107,122,153,0.08)', border: '1px solid rgba(107,122,153,0.25)', borderRadius: 8, padding: '10px 12px', fontSize: 12, color: '#8a9bb8' }}>
              ⚖️ {jogo.value_pick.motivo}. Prefira não apostar só pela % do modelo.
            </div>
          )}
        </div>
      )}
      <RankingMercados ranking={jogo.ranking_mercados} />
      <div style={s.probLabel}>📊 Estatísticas de Gols (Últimos 5 Jogos)</div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {[{ label: '🏠', nome: mandante, stats: sM }, { label: '✈️', nome: visitante, stats: sV }].map(({ label, nome, stats }) => (
          <div key={nome} style={{ flex: '1 1 200px' }}>
            <div style={{ fontSize: 10, color: '#4a5a78', fontWeight: 700, marginBottom: 6, fontFamily: "'Barlow Condensed', sans-serif", letterSpacing: 1 }}>
              {label} {nome.substring(0,18).toUpperCase()}
            </div>
            <div style={s.statsRow}>
              <div style={s.statChip}><span style={s.statLabel}>Marc./jogo</span><span style={{ ...s.statVal, color: '#00e676' }}>{stats.mediaGolsMarcados ?? '—'}</span></div>
              <div style={s.statChip}><span style={s.statLabel}>Sof./jogo</span><span style={{ ...s.statVal, color: '#ff6b6b' }}>{stats.mediaGolsSofridos ?? '—'}</span></div>
              <div style={s.statChip}><span style={s.statLabel}>BTTS%</span><span style={s.statVal}>{stats.bttsRate ?? '—'}%</span></div>
            </div>
            <div style={s.statsRow}>
              <div style={s.statChip}><span style={s.statLabel}>OV1.5%</span><span style={{ ...s.statVal, color: '#ffd60a' }}>{stats.over15Rate ?? '—'}%</span></div>
              <div style={s.statChip}><span style={s.statLabel}>OV2.5%</span><span style={{ ...s.statVal, color: '#ffd60a' }}>{stats.over25Rate ?? '—'}%</span></div>
              <div style={s.statChip}><span style={s.statLabel}>Forma</span><span style={{ ...s.statVal, fontSize: 11 }}>{(stats.formaSimbolo ?? []).slice(0,5).join(' ')}</span></div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function TabH2H({ jogo }) {
  const h2h = jogo.h2h
  const { mandante, visitante } = jogo

  // ── Caso novo: resumo agregado sem lista detalhada ──
  if (h2h?.semDados && h2h?.resumoSemGols) {
    const r = h2h.resumoSemGols
    return (
      <div>
        <div style={{ background: 'rgba(160,100,255,0.05)', border: '1px solid rgba(160,100,255,0.2)', borderRadius: 12, padding: '14px 16px', marginBottom: 14 }}>
          <div style={{ ...s.marketHeader, marginBottom: 10 }}>
            <span style={{ ...s.marketLabel, color: '#a064ff' }}>⚔️ Confronto Direto · {r.totalJogos} jogos</span>
            <span style={{ fontSize: 10, color: '#6b7a99', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 20, padding: '2px 8px', fontWeight: 600 }}>
              Resumo (sem placares)
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <div style={{ textAlign: 'center', minWidth: 60 }}>
              <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 28, fontWeight: 900, color: '#00b4d8', lineHeight: 1 }}>{r.vitoriasMandante}</div>
              <div style={{ fontSize: 9, color: '#4a5a78', fontWeight: 700, marginTop: 2 }}>{mandante.split(' ')[0].substring(0,10).toUpperCase()}</div>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', marginBottom: 4 }}>
                <div style={{ width: `${r.probMH2H}%`, background: '#00b4d8' }} />
                <div style={{ width: `${r.probEH2H}%`, background: '#ffd60a' }} />
                <div style={{ width: `${r.probVH2H}%`, background: '#ff6b6b' }} />
              </div>
            </div>
            <div style={{ textAlign: 'center', minWidth: 40 }}>
              <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 28, fontWeight: 900, color: '#ffd60a', lineHeight: 1 }}>{r.empates}</div>
              <div style={{ fontSize: 9, color: '#4a5a78', fontWeight: 700, marginTop: 2 }}>EMP</div>
            </div>
            <div style={{ textAlign: 'center', minWidth: 60 }}>
              <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 28, fontWeight: 900, color: '#ff6b6b', lineHeight: 1 }}>{r.vitoriasVisitante}</div>
              <div style={{ fontSize: 9, color: '#4a5a78', fontWeight: 700, marginTop: 2 }}>{visitante.split(' ')[0].substring(0,10).toUpperCase()}</div>
            </div>
          </div>
          <div style={{ fontSize: 11, color: '#6b7a99', lineHeight: 1.6 }}>
            A fonte de dados não fornece o placar detalhado de cada confronto para essa competição — só o resumo de vitórias/empates. Esse resumo é exibido apenas como referência e não entra no cálculo do mercado de gols.
          </div>
        </div>
      </div>
    )
  }

  // ── Caso original: sem dado nenhum ──
  if (!h2h || h2h.semDados || h2h.totalJogos === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '24px 0' }}>
        <div style={{ fontSize: 32, marginBottom: 10 }}>⚔️</div>
        <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 15, fontWeight: 700, color: '#4a5a78', marginBottom: 6 }}>
          Sem confrontos diretos encontrados
        </div>
      </div>
    )
  }

  // ── Caso original: lista detalhada disponível (football-data.org / api-sports.io) ──
  const corResultado   = r => r === 'M' ? '#00b4d8' : r === 'V' ? '#ff6b6b' : '#ffd60a'
  const labelResultado = r => r === 'M' ? `${mandante.split(' ')[0]} venceu` : r === 'V' ? `${visitante.split(' ')[0]} venceu` : 'Empate'
  const iconeResultado = r => r === 'M' ? '🏠' : r === 'V' ? '✈️' : '🤝'
  return (
    <div>
      <div style={{ background: 'rgba(160,100,255,0.05)', border: '1px solid rgba(160,100,255,0.2)', borderRadius: 12, padding: '14px 16px', marginBottom: 14 }}>
        <div style={{ ...s.marketHeader, marginBottom: 10 }}>
          <span style={{ ...s.marketLabel, color: '#a064ff' }}>⚔️ Confronto Direto · {h2h.totalJogos} jogos</span>
          {jogo.temH2HNoCalculo && (
            <span style={{ fontSize: 10, color: '#00e676', background: 'rgba(0,230,118,0.1)', border: '1px solid rgba(0,230,118,0.3)', borderRadius: 20, padding: '2px 8px', fontWeight: 700 }}>
              ✓ Usado no cálculo
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <div style={{ textAlign: 'center', minWidth: 60 }}>
            <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 28, fontWeight: 900, color: '#00b4d8', lineHeight: 1 }}>{h2h.vitoriasMandante}</div>
            <div style={{ fontSize: 9, color: '#4a5a78', fontWeight: 700, marginTop: 2 }}>{mandante.split(' ')[0].substring(0,10).toUpperCase()}</div>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', marginBottom: 4 }}>
              <div style={{ width: `${h2h.probMH2H}%`, background: '#00b4d8' }} />
              <div style={{ width: `${h2h.probEH2H}%`, background: '#ffd60a' }} />
              <div style={{ width: `${h2h.probVH2H}%`, background: '#ff6b6b' }} />
            </div>
          </div>
          <div style={{ textAlign: 'center', minWidth: 40 }}>
            <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 28, fontWeight: 900, color: '#ffd60a', lineHeight: 1 }}>{h2h.empates}</div>
            <div style={{ fontSize: 9, color: '#4a5a78', fontWeight: 700, marginTop: 2 }}>EMP</div>
          </div>
          <div style={{ textAlign: 'center', minWidth: 60 }}>
            <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 28, fontWeight: 900, color: '#ff6b6b', lineHeight: 1 }}>{h2h.vitoriasVisitante}</div>
            <div style={{ fontSize: 9, color: '#4a5a78', fontWeight: 700, marginTop: 2 }}>{visitante.split(' ')[0].substring(0,10).toUpperCase()}</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={s.statChip}><span style={s.statLabel}>Gols/jogo</span><span style={{ ...s.statVal, color: '#a064ff' }}>{h2h.mediaGolsTotais}</span></div>
          <div style={s.statChip}><span style={s.statLabel}>BTTS H2H</span><span style={{ ...s.statVal, color: h2h.bttsRateH2H >= 60 ? '#00e676' : '#e8eeff' }}>{h2h.bttsRateH2H}%</span></div>
          <div style={s.statChip}><span style={s.statLabel}>Over 1.5</span><span style={{ ...s.statVal, color: h2h.over15RateH2H >= 60 ? '#00e676' : '#e8eeff' }}>{h2h.over15RateH2H}%</span></div>
          <div style={s.statChip}><span style={s.statLabel}>Over 2.5</span><span style={{ ...s.statVal, color: h2h.over25RateH2H >= 60 ? '#00e676' : '#e8eeff' }}>{h2h.over25RateH2H}%</span></div>
        </div>
        {h2h.statsSeries && (
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <div style={s.statChip}><span style={s.statLabel}>Menos 4.5 Cartões</span><span style={s.statVal}>{h2h.statsSeries.menosDe4_5Cartoes}</span></div>
            <div style={s.statChip}><span style={s.statLabel}>Mais 10.5 Escanteios</span><span style={s.statVal}>{h2h.statsSeries.maisDe10_5Escanteios}</span></div>
          </div>
        )}
      </div>
      <div style={s.probLabel}>📅 Histórico dos Confrontos</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {h2h.confrontos.map((c, i) => {
          const cor = corResultado(c.resultado)
          const temStatsJogo = c.cartoesTotal != null || c.escanteiosTotal != null
          return (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 6, background: i === 0 ? 'rgba(160,100,255,0.06)' : 'rgba(255,255,255,0.02)', border: `1px solid ${i === 0 ? 'rgba(160,100,255,0.2)' : 'rgba(255,255,255,0.05)'}`, borderRadius: 10, padding: '10px 12px', position: 'relative', overflow: 'hidden' }}>
              <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: cor, borderRadius: '10px 0 0 10px' }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }} className="fs-h2h-row">
                <div style={{ minWidth: 70 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#e8eeff', fontFamily: "'Barlow Condensed', sans-serif" }}>{c.data}</div>
                  <div style={{ fontSize: 9, color: '#4a5a78', fontWeight: 600, marginTop: 1 }}>{c.competicao.substring(0,14)}</div>
                </div>
                <div style={{ flex: 1, textAlign: 'center' }}>
                  <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 17, fontWeight: 900, color: '#e8eeff', letterSpacing: 2 }}>
                    {c.mandanteNome.split(' ')[0].substring(0,8)} <span style={{ color: cor }}>{c.homeScore}–{c.awayScore}</span> {c.visitanteNome.split(' ')[0].substring(0,8)}
                  </div>
                </div>
                <div style={{ fontSize: 10, fontWeight: 700, color: cor, background: `${cor}15`, border: `1px solid ${cor}40`, borderRadius: 20, padding: '3px 8px', fontFamily: "'Barlow Condensed', sans-serif", whiteSpace: 'nowrap' }}>
                  {iconeResultado(c.resultado)} {labelResultado(c.resultado)}
                </div>
              </div>
              {temStatsJogo && (
                <div style={{ display: 'flex', gap: 6, paddingLeft: 4 }}>
                  {c.cartoesTotal != null && (
                    <span style={{ fontSize: 10, fontWeight: 700, color: '#ffd60a', background: 'rgba(255,214,10,0.1)', border: '1px solid rgba(255,214,10,0.25)', borderRadius: 20, padding: '2px 8px' }}>
                      🟨 {c.cartoesTotal} cartões
                    </span>
                  )}
                  {c.escanteiosTotal != null && (
                    <span style={{ fontSize: 10, fontWeight: 700, color: '#00b4d8', background: 'rgba(0,180,216,0.1)', border: '1px solid rgba(0,180,216,0.25)', borderRadius: 20, padding: '2px 8px' }}>
                      🚩 {c.escanteiosTotal} escanteios
                    </span>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function LinhaOverBar({ label, pct, cor, underPct }) {
  const corBarra = pct >= 60 ? '#00e676' : pct >= 45 ? cor : '#ff6b6b'
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#e8eeff', fontFamily: "'Barlow Condensed', sans-serif" }}>{label}</span>
        <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 16, fontWeight: 900, color: corBarra }}>
          {pct}%{underPct != null && <span style={{ fontSize: 11, fontWeight: 700, color: '#4a5a78', marginLeft: 6 }}>· Under {underPct}%</span>}
        </span>
      </div>
      <div style={{ height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.05)', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: corBarra, borderRadius: 3 }} />
      </div>
    </div>
  )
}

// ✅ NOVO — tabela compacta pra muitas linhas (cartões/escanteios), evita
// lista comprida de barras. Destaca a linha escolhida como "melhor entrada".
function TabelaLinhasCompacta({ linhas, melhorOver, melhorUnder, cor, unidade }) {
  if (!linhas?.length) return null
  const linhasDestaque = new Set([melhorOver?.linha, melhorUnder?.linha].filter(l => l != null))
  const temTravada = linhas.some(l => l.travado)
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4, fontSize: 9, color: '#4a5a78', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, padding: '0 10px 6px' }}>
        <span>Linha</span><span style={{ textAlign: 'center' }}>Over</span><span style={{ textAlign: 'center' }}>Under</span>
      </div>
      {linhas.map(l => {
        const destaque = linhasDestaque.has(l.linha)
        return (
          <div key={l.linha} style={{
            display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4, alignItems: 'center',
            padding: '7px 10px', borderRadius: 7, marginBottom: 3,
            background: destaque ? `${cor}14` : 'rgba(255,255,255,0.03)',
            border: `1px solid ${destaque ? `${cor}50` : 'rgba(255,255,255,0.06)'}`,
          }}>
            <span style={{ fontSize: 12, fontWeight: 800, color: destaque ? cor : '#e8eeff', fontFamily: "'Barlow Condensed', sans-serif" }}>
              {destaque ? '★ ' : ''}{l.linha} {unidade}
            </span>
            <span
              title={l.travado ? `Probabilidade real passa do ${l.travado === 'teto' ? 'teto de 88%' : 'piso de 12%'} do sistema — o valor real é ainda mais ${l.travado === 'teto' ? 'alto' : 'baixo'}` : undefined}
              style={{ textAlign: 'center', fontFamily: "'Barlow', Arial, sans-serif", fontSize: 13, fontWeight: 600, letterSpacing: 0.2, color: l.overPct >= 60 ? '#00e676' : l.overPct >= 45 ? cor : '#ff6b6b' }}
            >
              {l.overPct}%{l.travado === 'teto' ? ' 🔒' : ''}
            </span>
            <span
              title={l.travado === 'piso' ? 'Probabilidade real passa do piso de 12% do sistema — o valor real é ainda mais baixo' : undefined}
              style={{ textAlign: 'center', fontFamily: "'Barlow', Arial, sans-serif", fontSize: 13, fontWeight: 600, letterSpacing: 0.2, color: l.underPct >= 60 ? '#00e676' : l.underPct >= 45 ? cor : '#ff6b6b' }}
            >
              {l.underPct}%{l.travado === 'piso' ? ' 🔒' : ''}
            </span>
          </div>
        )
      })}
      {temTravada && (
        <div style={{ fontSize: 10, color: '#4a5a78', marginTop: 6, padding: '0 10px', lineHeight: 1.4 }}>
          🔒 = a probabilidade real passa do teto de 88% (ou do piso de 12%) que o sistema usa como limite máximo de confiança — por isso várias linhas próximas podem mostrar o mesmo %.
        </div>
      )}
    </div>
  )
}

function MelhorEntradaBox({ over, under, corTitulo, icone, extra }) {
  if (!over && !under) return null
  return (
    <div style={{ background: 'rgba(0,230,118,0.06)', border: '1px solid rgba(0,230,118,0.25)', borderRadius: 12, padding: '12px 16px', marginBottom: 14 }}>
      <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 11, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase', color: '#00e676', marginBottom: 6 }}>
        🎯 Melhor Entrada
      </div>
      <div style={{ fontSize: 13, color: '#e8eeff', lineHeight: 1.8 }}>
        {over && (
          <div>{icone}⬆️ <strong>{over.nome}</strong> — {over.prob}% (confiança {over.confianca})
            {over.melhorEntrada80 && (
              <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 800, color: '#00e676', background: 'rgba(0,230,118,0.12)', border: '1px solid rgba(0,230,118,0.3)', borderRadius: 20, padding: '2px 7px', fontFamily: "'Barlow Condensed', sans-serif" }}>MELHOR ENTRADA</span>
            )}
            {!over.naZonaUtil && !over.melhorEntrada80 && ' ⚠️'}
          </div>
        )}
        {under && (
          <div>{icone}⬇️ <strong>{under.nome}</strong> — {under.prob}% (confiança {under.confianca})
            {under.melhorEntrada80 && (
              <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 800, color: '#00e676', background: 'rgba(0,230,118,0.12)', border: '1px solid rgba(0,230,118,0.3)', borderRadius: 20, padding: '2px 7px', fontFamily: "'Barlow Condensed', sans-serif" }}>MELHOR ENTRADA</span>
            )}
            {!under.naZonaUtil && !under.melhorEntrada80 && ' ⚠️'}
          </div>
        )}
        {extra && (
          <div style={{ marginTop: 6, fontSize: 11, color: '#8a9bb8' }}>{extra}</div>
        )}
      </div>
    </div>
  )
}

function TabCartoes({ jogo }) {
  const temDados = jogo.cartoes_media !== null

  if (!temDados) {
    return (
      <div style={{ textAlign: 'center', padding: '24px 0' }}>
        <div style={{ fontSize: 32, marginBottom: 10 }}>🟨</div>
        <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 15, fontWeight: 700, color: '#4a5a78', marginBottom: 6 }}>
          Dados de cartões indisponíveis
        </div>
        <div style={{ fontSize: 12, color: '#4a5a78' }}>
          API Football não retornou estatísticas para esta partida
        </div>
      </div>
    )
  }

  const cartoesTotal = jogo.cartoes_media
  const cartM = jogo.cartoes_mandante
  const cartV = jogo.cartoes_visitante

  const mercado       = jogo.mercado_cartoes_escanteios
  const cartoesLinhas = mercado?.cartoesLinhas ?? []
  const melhorEntrada = mercado?.melhorEntrada ?? null

  const extraTexto = mercado ? [
    mercado.classicoUsado && 'Clássico/rivalidade considerado no ajuste.',
    mercado.mataMataUsado && 'Jogo eliminatório considerado no ajuste.',
    mercado.equilibrioUsado && 'Equilíbrio de forças entre os times considerado no ajuste.',
  ].filter(Boolean).join(' ') : ''

  return (
    <div>
      <MelhorEntradaBox
        over={melhorEntrada?.cartoesOver}
        under={melhorEntrada?.cartoesUnder}
        icone="🟨"
        extra={extraTexto || null}
      />
      {/* CARTÕES */}
      <div style={{ background: 'rgba(255,214,10,0.06)', border: '1px solid rgba(255,214,10,0.2)', borderRadius: 12, padding: '14px 16px' }}>
        <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 11, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase', color: '#ffd60a', marginBottom: 10 }}>
          🟨 Média de Cartões por Jogo
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: cartoesLinhas.length ? 14 : 0 }}>
          <div style={{ flex: 1, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 8, padding: '10px', textAlign: 'center' }}>
            <div style={{ fontSize: 9, color: '#4a5a78', fontWeight: 700, letterSpacing: 1, marginBottom: 4, fontFamily: "'Barlow Condensed', sans-serif", textTransform: 'uppercase' }}>Total/Jogo</div>
            <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 26, fontWeight: 900, color: '#ffd60a', lineHeight: 1 }}>{cartoesTotal?.toFixed(1) ?? '—'}</div>
          </div>
          <div style={{ flex: 1, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 8, padding: '10px', textAlign: 'center' }}>
            <div style={{ fontSize: 9, color: '#4a5a78', fontWeight: 700, letterSpacing: 1, marginBottom: 4, fontFamily: "'Barlow Condensed', sans-serif", textTransform: 'uppercase' }}>🏠 Mandante</div>
            <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 26, fontWeight: 900, color: '#e8eeff', lineHeight: 1 }}>{cartM?.toFixed(1) ?? '—'}</div>
          </div>
          <div style={{ flex: 1, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 8, padding: '10px', textAlign: 'center' }}>
            <div style={{ fontSize: 9, color: '#4a5a78', fontWeight: 700, letterSpacing: 1, marginBottom: 4, fontFamily: "'Barlow Condensed', sans-serif", textTransform: 'uppercase' }}>✈️ Visitante</div>
            <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 26, fontWeight: 900, color: '#e8eeff', lineHeight: 1 }}>{cartV?.toFixed(1) ?? '—'}</div>
          </div>
        </div>

       {cartoesLinhas.length > 0 && (
          <TabelaLinhasCompacta
            linhas={cartoesLinhas}
            melhorOver={melhorEntrada?.cartoesOver}
            melhorUnder={melhorEntrada?.cartoesUnder}
            cor="#ffd60a"
            unidade="cart."
          />
        )}
        {mercado?.arbitroUsado && mercado?.arbitroNome && (
          <div style={{ fontSize: 10, color: '#4a5a78', marginTop: 4 }}>🧑‍⚖️ Ajustado pelo árbitro: {mercado.arbitroNome}</div>
        )}
      </div>
    </div>
  )
}

function TabEscanteios({ jogo }) {
  const temDados = jogo.escanteios_media !== null

  if (!temDados) {
    return (
      <div style={{ textAlign: 'center', padding: '24px 0' }}>
        <div style={{ fontSize: 32, marginBottom: 10 }}>🚩</div>
        <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 15, fontWeight: 700, color: '#4a5a78', marginBottom: 6 }}>
          Dados de escanteios indisponíveis
        </div>
        <div style={{ fontSize: 12, color: '#4a5a78' }}>
          API Football não retornou estatísticas para esta partida
        </div>
      </div>
    )
  }

  const escanteiosTotal = jogo.escanteios_media
  const escM = jogo.escanteios_mandante
  const escV = jogo.escanteios_visitante

  const mercado          = jogo.mercado_cartoes_escanteios
  const escanteiosLinhas = mercado?.escanteiosLinhas ?? []
  const melhorEntrada    = mercado?.melhorEntrada ?? null

  const extraTexto = mercado?.climaUsado ? '🌦️ Ajustado pelo clima previsto' : ''

  return (
    <div>
      <MelhorEntradaBox
        over={melhorEntrada?.escanteiosOver}
        under={melhorEntrada?.escanteiosUnder}
        icone="🚩"
        extra={extraTexto || null}
      />
      {/* ESCANTEIOS */}
      <div style={{ background: 'rgba(0,180,216,0.06)', border: '1px solid rgba(0,180,216,0.2)', borderRadius: 12, padding: '14px 16px' }}>
        <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 11, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase', color: '#00b4d8', marginBottom: 10 }}>
          🚩 Média de Escanteios por Jogo
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: escanteiosLinhas.length ? 14 : 0 }}>
          <div style={{ flex: 1, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 8, padding: '10px', textAlign: 'center' }}>
            <div style={{ fontSize: 9, color: '#4a5a78', fontWeight: 700, letterSpacing: 1, marginBottom: 4, fontFamily: "'Barlow Condensed', sans-serif", textTransform: 'uppercase' }}>Total/Jogo</div>
            <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 26, fontWeight: 900, color: '#00b4d8', lineHeight: 1 }}>{escanteiosTotal?.toFixed(1) ?? '—'}</div>
          </div>
          <div style={{ flex: 1, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 8, padding: '10px', textAlign: 'center' }}>
            <div style={{ fontSize: 9, color: '#4a5a78', fontWeight: 700, letterSpacing: 1, marginBottom: 4, fontFamily: "'Barlow Condensed', sans-serif", textTransform: 'uppercase' }}>🏠 Mandante</div>
            <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 26, fontWeight: 900, color: '#e8eeff', lineHeight: 1 }}>{escM?.toFixed(1) ?? '—'}</div>
          </div>
          <div style={{ flex: 1, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 8, padding: '10px', textAlign: 'center' }}>
            <div style={{ fontSize: 9, color: '#4a5a78', fontWeight: 700, letterSpacing: 1, marginBottom: 4, fontFamily: "'Barlow Condensed', sans-serif", textTransform: 'uppercase' }}>✈️ Visitante</div>
            <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 26, fontWeight: 900, color: '#e8eeff', lineHeight: 1 }}>{escV?.toFixed(1) ?? '—'}</div>
          </div>
        </div>

        {escanteiosLinhas.length > 0 && (
          <TabelaLinhasCompacta
            linhas={escanteiosLinhas}
            melhorOver={melhorEntrada?.escanteiosOver}
            melhorUnder={melhorEntrada?.escanteiosUnder}
            cor="#00b4d8"
            unidade="esc."
          />
        )}
        {mercado?.climaUsado && (
          <div style={{ fontSize: 10, color: '#4a5a78', marginTop: 4 }}>🌦️ Ajustado pelo clima previsto</div>
        )}
      </div>
    </div>
  )
}



function GameCard({ jogo, authToken, userRole }) {
  const [abaAtiva, setAbaAtiva] = useState('gols')
  const [feedback, setFeedback] = useState('') // mensagem de copiar/salvar
  const confiancaCorRes = confiancaCor(jogo.confianca)

  // ✅ NOVO — candidatos disponíveis pra esse jogo + quais estão marcados
  const candidatosTracker = montarCandidatosTracker(jogo)
  const [selecionados, setSelecionados] = useState({})
  const [ultimoSalvo, setUltimoSalvo] = useState(null)

  const toggleCandidato = (key) => {
    setSelecionados(prev => ({ ...prev, [key]: !prev[key] }))
  }

  const handleCopiar = async () => {
    const ok = await copiarTexto(formatarJogoParaCopia(jogo))
    setFeedback(ok ? '✅ Copiado! Cole no Bloco de Notas (Ctrl+V)' : '❌ Falha ao copiar')
    setTimeout(() => setFeedback(''), 2500)
  }

  const handleSalvarTracker = async () => {
    const escolhidos = candidatosTracker.filter(c => selecionados[c.key])
    try {
      setFeedback('💾 Salvando...')
      const salvos = await salvarEntradasNoTracker(jogo, authToken, escolhidos)
      setUltimoSalvo(salvos)
      const n = salvos?.length ?? 0
      setFeedback(`✅ Salvo no Tracker (${n} mercado${n > 1 ? 's' : ''}) — marque Green/Red depois`)
    } catch (e) {
      setFeedback(`❌ ${e.message}`)
    }
    setTimeout(() => setFeedback(''), 3500)
  }

  const handleCopiarSalvo = async () => {
    if (!ultimoSalvo?.length) return
    const ok = await copiarTexto(formatarEntradasSalvasParaCopia(jogo, ultimoSalvo))
    setFeedback(ok ? '✅ Entrada salva copiada!' : '❌ Falha ao copiar')
    setTimeout(() => setFeedback(''), 2500)
  }
  const score     = jogo.score_composto ?? null
  const scoreCor  = score >= 70 ? '#00e676' : score >= 45 ? '#ffd60a' : '#ff6b6b'
  const scoreLabel = score >= 70 ? 'FORTE' : score >= 45 ? 'MÉDIO' : 'FRACO'
  const topProb   = Math.max(jogo.prob_mandante, jogo.prob_empate, jogo.prob_visitante)
  const temH2H    = jogo.h2h && !jogo.h2h.semDados && jogo.h2h.totalJogos > 0

  const temCartoes    = jogo.cartoes_media !== null
  const temEscanteios = jogo.escanteios_media !== null

  const ABAS = [
    { id: 'gols',       label: '⚽ Gols',       cor: '#ffd60a' },
    { id: 'h2h',        label: temH2H ? `⚔️ H2H·${jogo.h2h.totalJogos}` : '⚔️ H2H', cor: '#a064ff' },
    { id: 'cartoes',    label: '🟨 Cartões',    cor: '#ffd60a' },
    { id: 'escanteios', label: '🚩 Escanteios', cor: '#00b4d8' },
  ]

  return (
    <div style={s.card} className="fs-card">
      <div style={s.cardTop} className="fs-card-top">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={s.competTag}>{jogo.competicao}</span>
          {score !== null && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, background: `${scoreCor}14`, border: `1px solid ${scoreCor}40`, borderRadius: 20, padding: '3px 10px' }}>
              <div style={{ width: 28, height: 28, borderRadius: '50%', background: `conic-gradient(${scoreCor} ${score * 3.6}deg, rgba(255,255,255,0.06) 0deg)`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ width: 20, height: 20, borderRadius: '50%', background: '#0f1724', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 8, fontWeight: 900, color: scoreCor, fontFamily: "'Barlow Condensed', sans-serif" }}>{score}</div>
              </div>
              <span style={{ fontSize: 10, fontWeight: 800, color: scoreCor, fontFamily: "'Barlow Condensed', sans-serif", letterSpacing: 1 }}>{scoreLabel}</span>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ ...s.confiancaBadge, color: confiancaCorRes, background: `${confiancaCorRes}18`, border: `1px solid ${confiancaCorRes}40` }}>
            {jogo.confianca === 'Alta' ? '🔥' : jogo.confianca === 'Média' ? '✅' : '⚠️'} {jogo.confianca}
          </span>
          {jogo.tem_value && jogo.value_pick?.melhorValue && (
            <span style={{
              fontSize: 10, fontWeight: 800, letterSpacing: 0.5,
              color: '#00e676', background: '#00e67618',
              border: '1px solid #00e67650', borderRadius: 6, padding: '3px 8px',
              fontFamily: "'Barlow Condensed', sans-serif",
            }} title={jogo.value_pick.motivo}>
              💎 VALUE +{jogo.value_pick.melhorValue.edge}pp
            </span>
          )}
          {jogo.value_pick && !jogo.tem_value && jogo.odds_mercado && (
            <span style={{
              fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
              color: '#6b7a99', background: '#6b7a9914',
              border: '1px solid #6b7a9940', borderRadius: 6, padding: '3px 8px',
              fontFamily: "'Barlow Condensed', sans-serif",
            }}>
              sem edge suficiente
            </span>
          )}
          <span style={s.horarioTag}>🕐 {jogo.horario}</span>
        </div>
      </div>
      <div style={s.teamsRow}>
        <div style={s.teamName}>{jogo.mandante}</div>
        <div style={s.vsText}>VS</div>
        <div style={{ ...s.teamName, ...s.teamNameRight }}>{jogo.visitante}</div>
      </div>
      <div style={s.probSection}>
        <div style={s.probLabel}>PROBABILIDADES DE RESULTADO</div>
        <div style={s.probRow} className="fs-gauges">
          {[
            { label: 'MANDANTE',  prob: jogo.prob_mandante,  cor: '#00b4d8' },
            { label: 'EMPATE',    prob: jogo.prob_empate,    cor: '#ffd60a' },
            { label: 'VISITANTE', prob: jogo.prob_visitante, cor: '#ff6b6b' },
          ].map(({ label, prob, cor }) => (
            <div key={label} style={{ ...s.probItem, background: prob === topProb ? `${cor}1f` : `${cor}0d`, border: `1px solid ${prob === topProb ? `${cor}59` : `${cor}1a`}`, borderRadius: 10 }}>
              <div style={{ ...s.probPct, color: cor }}>{prob}%</div>
              <div style={{ ...s.probSubLabel, color: cor }}>{label}</div>
            </div>
          ))}
        </div>
        <ProbBar pm={jogo.prob_mandante} pe={jogo.prob_empate} pv={jogo.prob_visitante} />
      </div>
      <div style={s.tabsRow} className="fs-tabs">
        {ABAS.map(aba => {
          const ativa = abaAtiva === aba.id
          return (
            <button key={aba.id} style={{ ...s.tab, background: ativa ? `${aba.cor}20` : 'transparent', color: ativa ? aba.cor : '#4a5a78', border: ativa ? `1px solid ${aba.cor}50` : '1px solid transparent' }} onClick={() => setAbaAtiva(aba.id)}>
              {aba.label}
            </button>
          )
        })}
      </div>
      {abaAtiva === 'gols' && <TabGols jogo={jogo} authToken={authToken} />}
      {abaAtiva === 'h2h'  && <TabH2H  jogo={jogo} />}
      {abaAtiva === 'cartoes' && <TabCartoes jogo={jogo} />}
      {abaAtiva === 'escanteios' && <TabEscanteios jogo={jogo} />}
      <div style={s.divider} />
      <div style={s.analiseBox}>
        <div style={{ fontSize: 10, fontWeight: 700, color: '#00e676', letterSpacing: 1.5, marginBottom: 8, fontFamily: "'Barlow Condensed', sans-serif" }}>
          🤖 ANÁLISE IA
        </div>
        {jogo.analise.split('\n\n').map((bloco, i) => {
          const cores = ['#00b4d8', '#ffd60a', '#a064ff', '#00e676', '#ff6b6b']
          return (
            <p key={i} style={{ margin: i === 0 ? '0 0 10px 0' : '10px 0', lineHeight: 1.75, fontSize: 12, color: '#8a9ab8', borderLeft: `2px solid ${cores[i] ?? '#4a5a78'}`, paddingLeft: 10 }}>
              {bloco}
            </p>
          )
        })}
      </div>

      {/* ── ✅ NOVO — seleção manual de entradas pro tracker ── */}
      {candidatosTracker.length > 0 && (
        <div style={{
          marginTop: 14, background: 'rgba(255,255,255,0.03)',
          border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, padding: '10px 12px',
        }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#4a5a78', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8, fontFamily: "'Barlow Condensed', sans-serif" }}>
            ☑️ Marque a(s) entrada(s) que você realmente fez
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {candidatosTracker.map(c => (
              <label key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#e8eeff', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={!!selecionados[c.key]}
                  onChange={() => toggleCandidato(c.key)}
                  style={{ cursor: 'pointer' }}
                />
                <span style={{ color: '#4a5a78', minWidth: 78 }}>{c.grupo}</span>
                <strong>{c.nome}</strong>
                <span style={{ color: '#8a9bb8' }}>— {c.prob}% (confiança {c.confianca})</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* ── Ações: copiar / salvar no histórico ── */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10, alignItems: 'center' }} className="fs-actions">
        <button
          type="button"
          onClick={handleCopiar}
          style={{
            background: 'rgba(0,180,216,0.12)', border: '1px solid rgba(0,180,216,0.45)',
            borderRadius: 8, padding: '8px 14px', color: '#00b4d8', cursor: 'pointer',
            fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800, fontSize: 13, letterSpacing: 1,
          }}
        >
          📋 COPIAR
        </button>
        <button
          type="button"
          onClick={handleSalvarTracker}
          disabled={!authToken || !candidatosTracker.some(c => selecionados[c.key])}
          title={!authToken ? 'Faça login para salvar' : userRole !== 'admin' ? 'Requer perfil admin para gravar no tracker' : 'Salva no Scout Tracker para marcar Green/Red'}
          style={{
            background: 'rgba(0,230,118,0.12)', border: '1px solid rgba(0,230,118,0.45)',
            borderRadius: 8, padding: '8px 14px', color: '#00e676',
            cursor: (authToken && candidatosTracker.some(c => selecionados[c.key])) ? 'pointer' : 'not-allowed',
            opacity: (authToken && candidatosTracker.some(c => selecionados[c.key])) ? 1 : 0.45,
            fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800, fontSize: 13, letterSpacing: 1,
          }}
        >
          💾 SALVAR NO TRACKER
        </button>
        {ultimoSalvo?.length > 0 && (
          <button
            type="button"
            onClick={handleCopiarSalvo}
            style={{
              background: 'rgba(160,100,255,0.12)', border: '1px solid rgba(160,100,255,0.45)',
              borderRadius: 8, padding: '8px 14px', color: '#a064ff', cursor: 'pointer',
              fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800, fontSize: 13, letterSpacing: 1,
            }}
          >
            📋 Copiar entrada salva
          </button>
        )}
        {feedback && (
          <span style={{ fontSize: 12, color: feedback.startsWith('❌') ? '#ff6b6b' : '#00e676', fontWeight: 600 }}>
            {feedback}
          </span>
        )}
      </div>
    </div>
  )
}

function BasketballCard({ jogo }) {
  const scoreCor = jogo.confianca === 'Alta' ? '#00e676' : jogo.confianca === 'Média' ? '#ffd60a' : '#ff6b6b'
  const sM = jogo.stats_mandante
  const sV = jogo.stats_visitante
  return (
    <div style={{ ...s.card, borderLeft: `3px solid #f97316` }} className="fs-card">
      <div style={s.cardTop} className="fs-card-top">
        <span style={{ ...s.competTag, color: '#f97316', borderColor: 'rgba(249,115,22,0.3)', background: 'rgba(249,115,22,0.1)' }}>
          🏀 {jogo.competicao}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ ...s.confiancaBadge, color: scoreCor, background: `${scoreCor}18`, border: `1px solid ${scoreCor}40` }}>
            {jogo.confianca === 'Alta' ? '🔥' : jogo.confianca === 'Média' ? '✅' : '⚠️'} {jogo.confianca}
          </span>
          <span style={s.horarioTag}>🕐 {jogo.horario}</span>
        </div>
      </div>
      <div style={s.teamsRow}>
        <div style={s.teamName}>{jogo.mandante}</div>
        <div style={s.vsText}>VS</div>
        <div style={{ ...s.teamName, ...s.teamNameRight }}>{jogo.visitante}</div>
      </div>
      <div style={s.probSection}>
        <div style={s.probLabel}>PROBABILIDADE DE RESULTADO</div>
        <div style={s.probRow} className="fs-gauges">
          <div style={{ ...s.probItem, borderRadius: 10, background: jogo.prob_mandante > jogo.prob_visitante ? 'rgba(249,115,22,0.15)' : 'rgba(249,115,22,0.05)', border: `1px solid ${jogo.prob_mandante > jogo.prob_visitante ? 'rgba(249,115,22,0.4)' : 'rgba(249,115,22,0.1)'}` }}>
            <div style={{ ...s.probPct, color: '#f97316' }}>{jogo.prob_mandante}%</div>
            <div style={{ ...s.probSubLabel, color: '#f97316' }}>MANDANTE</div>
          </div>
          <div style={{ ...s.probItem, borderRadius: 10, background: jogo.prob_visitante > jogo.prob_mandante ? 'rgba(249,115,22,0.15)' : 'rgba(249,115,22,0.05)', border: `1px solid ${jogo.prob_visitante > jogo.prob_mandante ? 'rgba(249,115,22,0.4)' : 'rgba(249,115,22,0.1)'}` }}>
            <div style={{ ...s.probPct, color: '#f97316' }}>{jogo.prob_visitante}%</div>
            <div style={{ ...s.probSubLabel, color: '#f97316' }}>VISITANTE</div>
          </div>
        </div>
        <div style={s.barWrap}>
          <div style={{ width: `${jogo.prob_mandante}%`, background: '#f97316' }} />
          <div style={{ width: `${jogo.prob_visitante}%`, background: '#f9731660' }} />
        </div>
      </div>
      <div style={{ ...s.marketBox, background: 'rgba(249,115,22,0.06)', border: '1px solid rgba(249,115,22,0.2)', marginBottom: 14 }}>
        <div style={s.marketHeader}>
          <span style={{ ...s.marketLabel, color: '#f97316' }}>🏀 Totais (Over/Under Pontos)</span>
          <span style={{ ...s.confiancaBadge, color: scoreCor, background: `${scoreCor}18`, border: `1px solid ${scoreCor}40`, fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20 }}>{jogo.confiancaTotais}</span>
        </div>
        <div style={{ ...s.marketValue, color: '#f97316' }}>{jogo.mercadoTotais}</div>
        <div style={{ fontSize: 12, color: '#a06030', marginBottom: 6 }}>
          📊 Total esperado: <strong style={{ color: '#f97316' }}>{jogo.mediaEsperada} pts</strong>
          <span style={{ color: '#6b7a99' }}> · 🏠 {jogo.ptsMandante} pts / ✈️ {jogo.ptsVisitante} pts</span>
        </div>
        <div style={{ fontSize: 11, color: '#a06030' }}>{jogo.descricaoTotais}</div>
      </div>
      {jogo.thresholds && (
        <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            {jogo.thresholds.slice(0, 2).map(t => (
              <React.Fragment key={t.threshold}>
                <div style={s.extraChip}><span style={s.extraLabel}>OVER {t.threshold}</span><span style={s.extraVal}>{t.over}%</span></div>
                <div style={s.extraChip}><span style={s.extraLabel}>UNDER {t.threshold}</span><span style={s.extraVal}>{t.under}%</span></div>
              </React.Fragment>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            {jogo.thresholds.slice(2, 4).map(t => (
              <React.Fragment key={t.threshold}>
                <div style={s.extraChip}><span style={s.extraLabel}>OVER {t.threshold}</span><span style={s.extraVal}>{t.over}%</span></div>
                <div style={s.extraChip}><span style={s.extraLabel}>UNDER {t.threshold}</span><span style={s.extraVal}>{t.under}%</span></div>
              </React.Fragment>
            ))}
          </div>
        </div>
      )}
      <div style={s.probLabel}>📊 Médias dos Últimos Jogos</div>
      <div style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
        {[{ label: '🏠', nome: jogo.mandante, stats: sM }, { label: '✈️', nome: jogo.visitante, stats: sV }].map(({ label, nome, stats }) => (
          <div key={nome} style={{ flex: 1 }}>
            <div style={{ fontSize: 10, color: '#4a5a78', fontWeight: 700, marginBottom: 6, fontFamily: "'Barlow Condensed', sans-serif", letterSpacing: 1 }}>
              {label} {nome.substring(0, 18).toUpperCase()}
            </div>
            <div style={s.statsRow}>
              <div style={s.statChip}><span style={s.statLabel}>Pts Marc.</span><span style={{ ...s.statVal, color: '#f97316' }}>{stats?.mediaPtsMarcados ?? '—'}</span></div>
              <div style={s.statChip}><span style={s.statLabel}>Pts Sof.</span><span style={{ ...s.statVal, color: '#ff6b6b' }}>{stats?.mediaPtsSofridos ?? '—'}</span></div>
              <div style={s.statChip}><span style={s.statLabel}>Forma</span><span style={{ ...s.statVal, fontSize: 11 }}>{(stats?.formaSimbolo ?? []).slice(0,5).join(' ')}</span></div>
            </div>
          </div>
        ))}
      </div>
      <div style={s.divider} />
      <div style={s.analiseBox}>🤖 {jogo.analise}</div>
    </div>
  )
}

function TennisCard({ jogo, authToken, userRole }) {
  const scoreCor = jogo.confianca === 'Alta' ? '#00e676' : jogo.confianca === 'Média' ? '#ffd60a' : '#ff6b6b'
  const corTenis = '#eab308'
  const favoritoMandante = jogo.prob_mandante >= jogo.prob_visitante
  const [feedback, setFeedback] = useState('')

  const handleCopiar = async () => {
    const ok = await copiarTexto(formatarJogoTenisParaCopia(jogo))
    setFeedback(ok ? '✅ Copiado! Cole no Bloco de Notas (Ctrl+V)' : '❌ Falha ao copiar')
    setTimeout(() => setFeedback(''), 2500)
  }

  const handleSalvarTracker = async () => {
    try {
      setFeedback('💾 Salvando...')
      await salvarJogoTenisNoTracker(jogo, authToken)
      setFeedback('✅ Salvo no Tracker — marque Green/Red depois')
    } catch (e) {
      setFeedback(`❌ ${e.message}`)
    }
    setTimeout(() => setFeedback(''), 3500)
  }

  // ✅ NOVO — salva "Sets Diretos" como mercado PRÓPRIO (não mistura com Vitória)
  const handleSalvarSetsDiretos = async () => {
    try {
      setFeedback('💾 Salvando...')
      await salvarSetsDiretosNoTracker(jogo, authToken)
      setFeedback('✅ Sets Diretos salvo no Tracker — marque Green/Red depois')
    } catch (e) {
      setFeedback(`❌ ${e.message}`)
    }
    setTimeout(() => setFeedback(''), 3500)
  }

  // ✅ NOVO — cor/label da recomendação de entrada calculada no backend
  const rec = jogo.recomendacaoEntrada
  const recCor = rec?.tipo === 'evitar' ? '#ff6b6b' : '#00e676'
  const recLabel = rec?.tipo === 'sets_diretos' ? '🎯 Entrada recomendada: SETS DIRETOS'
    : rec?.tipo === 'vitoria' ? '✅ Entrada recomendada: VITÓRIA (ML)'
    : rec?.tipo === 'evitar' ? '⚠️ Confiança baixa — considere não entrar'
    : null

  return (
    <div style={{ ...s.card, borderLeft: `3px solid ${corTenis}` }} className="fs-card">
      <div style={s.cardTop} className="fs-card-top">
        <span style={{ ...s.competTag, color: corTenis, borderColor: 'rgba(234,179,8,0.3)', background: 'rgba(234,179,8,0.1)' }}>
          🎾 {jogo.competicao} · melhor de {jogo.bestOf}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ ...s.confiancaBadge, color: scoreCor, background: `${scoreCor}18`, border: `1px solid ${scoreCor}40` }}>
            {jogo.confianca === 'Alta' ? '🔥' : jogo.confianca === 'Média' ? '✅' : '⚠️'} {jogo.confianca}
          </span>
          <span style={s.horarioTag}>🕐 {jogo.horario}</span>
        </div>
      </div>

      <div style={s.teamsRow}>
        <div style={s.teamName}>{jogo.mandante}</div>
        <div style={s.vsText}>VS</div>
        <div style={{ ...s.teamName, ...s.teamNameRight }}>{jogo.visitante}</div>
      </div>

      <div style={s.probSection}>
        <div style={s.probLabel}>PROBABILIDADE DE VITÓRIA NA PARTIDA</div>
        <div style={s.probRow} className="fs-gauges">
          <div style={{ ...s.probItem, borderRadius: 10, background: favoritoMandante ? 'rgba(234,179,8,0.15)' : 'rgba(234,179,8,0.05)', border: `1px solid ${favoritoMandante ? 'rgba(234,179,8,0.4)' : 'rgba(234,179,8,0.1)'}` }}>
            <div style={{ ...s.probPct, color: corTenis }}>{jogo.prob_mandante}%</div>
            <div style={{ ...s.probSubLabel, color: corTenis }}>MANDANTE</div>
          </div>
          <div style={{ ...s.probItem, borderRadius: 10, background: !favoritoMandante ? 'rgba(234,179,8,0.15)' : 'rgba(234,179,8,0.05)', border: `1px solid ${!favoritoMandante ? 'rgba(234,179,8,0.4)' : 'rgba(234,179,8,0.1)'}` }}>
            <div style={{ ...s.probPct, color: corTenis }}>{jogo.prob_visitante}%</div>
            <div style={{ ...s.probSubLabel, color: corTenis }}>VISITANTE</div>
          </div>
        </div>
        <div style={s.barWrap}>
          <div style={{ width: `${jogo.prob_mandante}%`, background: corTenis }} />
          <div style={{ width: `${jogo.prob_visitante}%`, background: `${corTenis}60` }} />
        </div>
      </div>

      {/* ✅ NOVO — recomendação explícita: evita empurrar sempre "sets diretos" quando
          a prob. real está pulverizada entre 2x0/2x1 (ver recomendacaoEntrada no backend) */}
      {recLabel && (
        <div style={{
          marginBottom: 12, padding: '8px 12px', borderRadius: 8,
          background: `${recCor}15`, border: `1px solid ${recCor}50`,
        }}>
          <div style={{ fontWeight: 800, fontSize: 12.5, color: recCor }}>{recLabel}</div>
          {rec?.motivo && <div style={{ fontSize: 11, color: '#8a97b8', marginTop: 2 }}>{rec.motivo}</div>}
        </div>
      )}

      {/* Mercado de sets diretos — só existe se ainda for matematicamente possível.
          Destaque forte só quando é de fato a entrada recomendada; caso contrário
          fica esmaecido, pra não parecer "a" recomendação por padrão. */}
      {jogo.mercadoStraightSets ? (
        <div style={{
          ...s.marketBox, marginBottom: 14,
          background: rec?.tipo === 'sets_diretos' ? 'rgba(234,179,8,0.06)' : 'rgba(255,255,255,0.02)',
          border: rec?.tipo === 'sets_diretos' ? '1px solid rgba(234,179,8,0.2)' : '1px solid rgba(255,255,255,0.06)',
          opacity: rec?.tipo === 'sets_diretos' ? 1 : 0.65,
        }}>
          <div style={s.marketHeader}>
            <span style={{ ...s.marketLabel, color: corTenis }}>🎯 Vitória em sets diretos ({jogo.mercadoStraightSets.placar})</span>
          </div>
          <div style={{ ...s.marketValue, color: corTenis }}>
            {jogo.mercadoStraightSets.jogador} {jogo.mercadoStraightSets.placar}
          </div>
          <div style={{ fontSize: 12, color: '#a08830' }}>
            📊 Probabilidade do modelo: <strong style={{ color: corTenis }}>{jogo.mercadoStraightSets.prob}%</strong>
          </div>
        </div>
      ) : (
        <div style={{ ...s.marketBox, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', marginBottom: 14, fontSize: 12, color: '#6b7a99' }}>
          🎯 Vitória em sets diretos deixou de ser possível — o jogo já teve set(s) perdido(s) por ambos os lados.
        </div>
      )}

      {/* Placar mais provável (pode ser com perda de set) */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <div style={s.extraChip}>
          <span style={s.extraLabel}>PLACAR MAIS PROVÁVEL</span>
          <span style={s.extraVal}>{jogo.melhorPlacar.jogador} {jogo.melhorPlacar.placar} ({jogo.melhorPlacar.prob}%)</span>
        </div>
        {jogo.totalGamesEstimado && (
          <div style={s.extraChip}>
            <span style={s.extraLabel}>TOTAL DE GAMES (EST.)</span>
            <span style={s.extraVal}>
              ~{jogo.totalGamesEstimado.estimado}
              <span style={{ fontSize: 11, color: '#4a5a78', fontWeight: 600 }}>
                {' '}({jogo.totalGamesEstimado.faixaMin}-{jogo.totalGamesEstimado.faixaMax})
              </span>
            </span>
          </div>
        )}
      </div>
        
        {jogo.totalGamesEstimado && (
  <div style={{ fontSize: 10, color: '#4a5a78', marginTop: -8, marginBottom: 14 }}>
    📐 Baseado em {jogo.totalGamesEstimado.mediaGamesPorSetHistorico} games/set (média histórica) ·
    amostra: {jogo.totalGamesEstimado.amostraSets?.mandante ?? 0} + {jogo.totalGamesEstimado.amostraSets?.visitante ?? 0} sets
  </div>
)}


      <div style={s.probLabel}>📊 Amostra usada no modelo</div>
      <div style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
        {[{ label: '🏠', nome: jogo.mandante, sets: jogo.amostra?.mandante }, { label: '✈️', nome: jogo.visitante, sets: jogo.amostra?.visitante }].map(({ label, nome, sets }) => (
          <div key={nome} style={{ flex: 1 }}>
            <div style={{ fontSize: 10, color: '#4a5a78', fontWeight: 700, marginBottom: 6, fontFamily: "'Barlow Condensed', sans-serif", letterSpacing: 1 }}>
              {label} {nome.substring(0, 18).toUpperCase()}
            </div>
            <div style={s.statsRow}>
              <div style={s.statChip}><span style={s.statLabel}>Sets (8 jogos)</span><span style={{ ...s.statVal, color: corTenis }}>{sets ?? 0}</span></div>
            </div>
          </div>
        ))}
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 10, color: '#4a5a78', fontWeight: 700, marginBottom: 6, fontFamily: "'Barlow Condensed', sans-serif", letterSpacing: 1 }}>🤝 H2H</div>
          <div style={s.statsRow}>
            <div style={s.statChip}><span style={s.statLabel}>Confrontos</span><span style={{ ...s.statVal, fontSize: 11 }}>{jogo.amostra?.h2h ?? 0}</span></div>
          </div>
        </div>
      </div>

      <div style={s.divider} />
      <div style={{ fontSize: 10, color: '#a08830', marginBottom: 8, fontWeight: 700, letterSpacing: 0.5 }}>
        📡 FONTES: {(jogo.fontesUsadas ?? ['Forma recente (sets)']).join(' · ')}
      </div>
      <div style={s.analiseBox}>🤖 {jogo.analise}</div>

      {/* ── Ações: copiar / salvar no histórico (mesmo padrão do futebol) ── */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14, alignItems: 'center' }} className="fs-actions">
        <button
          type="button"
          onClick={handleCopiar}
          style={{
            background: 'rgba(234,179,8,0.12)', border: '1px solid rgba(234,179,8,0.45)',
            borderRadius: 8, padding: '8px 14px', color: corTenis, cursor: 'pointer',
            fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800, fontSize: 13, letterSpacing: 1,
          }}
        >
          📋 COPIAR
        </button>
        <button
          type="button"
          onClick={handleSalvarTracker}
          disabled={!authToken}
          title={!authToken ? 'Faça login para salvar' : userRole !== 'admin' ? 'Requer perfil admin para gravar no tracker' : 'Salva a Vitória (ML) no Scout Tracker para marcar Green/Red'}
          style={{
            background: 'rgba(0,230,118,0.12)', border: '1px solid rgba(0,230,118,0.45)',
            borderRadius: 8, padding: '8px 14px', color: '#00e676',
            cursor: authToken ? 'pointer' : 'not-allowed', opacity: authToken ? 1 : 0.45,
            fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800, fontSize: 13, letterSpacing: 1,
          }}
        >
          💾 SALVAR VITÓRIA
        </button>
        {/* ✅ NOVO — Sets Diretos vira uma entrada própria no Tracker, separada da
            Vitória, pra alimentar a calibração de 'Tênis:Sets Diretos' */}
        <button
          type="button"
          onClick={handleSalvarSetsDiretos}
          disabled={!authToken || !jogo.mercadoStraightSets}
          title={!jogo.mercadoStraightSets ? 'Sets diretos não é mais possível nesse jogo' : !authToken ? 'Faça login para salvar' : 'Salva Sets Diretos no Scout Tracker para marcar Green/Red'}
          style={{
            background: 'rgba(234,179,8,0.12)', border: '1px solid rgba(234,179,8,0.45)',
            borderRadius: 8, padding: '8px 14px', color: corTenis,
            cursor: (authToken && jogo.mercadoStraightSets) ? 'pointer' : 'not-allowed',
            opacity: (authToken && jogo.mercadoStraightSets) ? 1 : 0.45,
            fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800, fontSize: 13, letterSpacing: 1,
          }}
        >
          🎯 SALVAR SETS DIRETOS
        </button>
        {feedback && (
          <span style={{ fontSize: 12, color: feedback.startsWith('❌') ? '#ff6b6b' : '#00e676', fontWeight: 600 }}>
            {feedback}
          </span>
        )}
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════
// App principal
// ════════════════════════════════════════════════════════════
export default function App() {
  const telaInicial = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('tela')
    : null

  const [apiKey,       setApiKey]       = useState('')
  // ✅ NOVO — ?tela=aovivo e ?tela=odds abrem direto as telas novas
  const [modulo,       setModulo]       = useState(
    telaInicial === 'tracker' ? 'tracker'
    : telaInicial === 'aovivo' ? 'aovivo'
    : telaInicial === 'odds'   ? 'odds'
    : 'analise'
  )
  const [esporte,      setEsporte]      = useState(telaInicial === 'basquete' ? 'basquete' : 'futebol')
  const [campeonato,   setCampeonato]   = useState('Copa Libertadores')
  const [ligaBasquete, setLigaBasquete] = useState('132')
  const [torneioTenis,     setTorneioTenis]     = useState('')
  const [torneiosTenis,    setTorneiosTenis]    = useState([])
  const [loadingTorneios,  setLoadingTorneios]  = useState(false)
  const [loadingEtapa, setLoadingEtapa] = useState(null)
  const [erro,         setErro]         = useState('')

  const [jogosEncontrados,  setJogosEncontrados]  = useState(null)
  const [jogosComHistorico, setJogosComHistorico] = useState(null)
  const [resultado,         setResultado]         = useState(null)

  // ── NOVO: lista completa retornada pela Etapa 1 + seleção manual (máx. 3) ──
  const [incluirAmanha,    setIncluirAmanha]    = useState(false)
  const [jogosDisponiveis, setJogosDisponiveis] = useState(null)
  const [selecionados,     setSelecionados]     = useState([])
  const MAX_SELECIONADOS = 3

  // ── Auth ──────────────────────────────────────────────────
  const [authToken, setAuthToken] = useState(localStorage.getItem('scout_token') || null)
const [userRole,  setUserRole]  = useState(localStorage.getItem('scout_role')  || null)
const [username,  setUsername]  = useState(localStorage.getItem('scout_user')  || null)

const handleLogin = (token, role, user) => {
  localStorage.setItem('scout_token', token)
  localStorage.setItem('scout_role',  role)
  localStorage.setItem('scout_user',  user)
  setAuthToken(token)
  setUserRole(role)
  setUsername(user)
}

async function postAutoSaveTracker(payload) {
  try {
    await fetch(`${API_BASE}/api/tracker/auto-save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch (e) { console.warn('[tracker auto-save] falhou:', e.message) }
}

const salvarAnaliseNoTracker = useCallback(async (jogos) => {
  for (const j of jogos) {
    if (!j.id) continue

    // ── Gols ──
    if (j.mercado_gols_limpo) {
      const m = /^(Over|Under)\s+([\d.]+)/i.exec(j.mercado_gols_limpo)
      if (m) {
        const probsGols = {
          over15: j.over15_gols, under15: j.under15_gols,
          over25: j.over25_gols, under25: j.under25_gols,
          over35: j.over35_gols, under35: j.under35_gols,
          btts: j.btts,
        }
        const probModelo = probDoMercado(probsGols, j.mercado_gols_limpo)
        const probabilidade = typeof probModelo === 'number' && probModelo !== 50
          ? probModelo
          : (j.value_pick?.edgeMercadoSugerido?.prob ?? probModelo)

        await postAutoSaveTracker({
          eventoId: j.id,
          mandante: j.mandante, visitante: j.visitante,
          liga: j.competicao,
          mercado: j.mercado_gols_limpo,
          direcao: m[1].toLowerCase(),
          linha: m[2],
          probabilidade,
          // ✅ FIX — prob. do mesmo mercado ANTES da calibração (a calibração lê esta, não a de cima)
          probBruta: j.probs_brutas_gols ? probDoMercado(j.probs_brutas_gols, j.mercado_gols_limpo) : null,
          lambdaEsperado: j.media_gols_esperada,
          confianca: j.confianca_gols,
          dataJogo: j.dataJogo, horario: j.horario,
          clima: j.clima ?? null,
          // ✅ NOVO — Fase 1, item 4: qual versão do motor gerou esta previsão
          motorVersao: j.motor_versao ?? null,
          datasetVersao: j.dataset_versao ?? null,
          fatoresCalibUsados: j.calibracao_fatores ?? j.calibracao?.fatores ?? null, // ✅ NOVO — item 41
          arbitro: j.mercado_cartoes_escanteios?.arbitroNome ?? null, // ✅ FIX — item 7: segmentação por árbitro
        })
      }
    }

        // ✅ NOVO — 1X2 (Vitória Mandante/Visitante) também vai pro tracker, com os
    // sub-modelos Forma/H2H/ELO, pra ser liquidado sozinho e alimentar o stacking.
    const mRes = /^Vitória (Mandante|Visitante)$/.exec(j.mercado_resultado || '')
    if (mRes && j.prob_empate != null) {
      const lado = mRes[1] === 'Mandante' ? 'mandante' : 'visitante'
      await postAutoSaveTracker({
        eventoId: j.id,
        mandante: j.mandante, visitante: j.visitante,
        liga: j.competicao,
        mercado: j.mercado_resultado,
        direcao: lado,
        linha: null,
        probabilidade: lado === 'mandante' ? j.prob_mandante : j.prob_visitante,
        confianca: j.confianca,
        dataJogo: j.dataJogo, horario: j.horario,
        odd: j.odds_mercado?.[lado] ?? null,
        clima: j.clima ?? null,
        motorVersao: j.motor_versao ?? null,
        datasetVersao: j.dataset_versao ?? null,
        subModelos: j.resultado_subModelos?.[lado] ?? null,
        // ✅ NOVO — item 34: as 3 juntas, pra RPS (o resultado real vem do
        // placarFinal quando o jogo terminar, não precisa mandar aqui)
        probMandante: j.prob_mandante, probEmpate: j.prob_empate, probVisitante: j.prob_visitante,
      })
    }


    // ✅ NOVO — Cartões e Escanteios entram no auto-save do mesmo jeito, pra
    // ganharem eventoId + origem 'auto' e serem liquidados sozinhos pelo
    // resolvedor (resolverMercadoLinha, no server).
    const meCE = j.mercado_cartoes_escanteios?.melhorEntrada
    const escolherMelhor = (over, under) => {
      if (!over && !under) return null
      if (!under) return over
      if (!over) return under
      if (over.naZonaUtil && !under.naZonaUtil) return over
      if (under.naZonaUtil && !over.naZonaUtil) return under
      return over.prob >= under.prob ? over : under
    }
    const melhorCartoes    = escolherMelhor(meCE?.cartoesOver,    meCE?.cartoesUnder)
    const melhorEscanteios = escolherMelhor(meCE?.escanteiosOver, meCE?.escanteiosUnder)

    if (melhorCartoes) {
      await postAutoSaveTracker({
        eventoId: j.id,
        mandante: j.mandante, visitante: j.visitante,
        liga: j.competicao,
        mercado: melhorCartoes.nome,
        direcao: melhorCartoes.direcao,
        linha: melhorCartoes.linha,
        probabilidade: melhorCartoes.prob,
        probBruta: melhorCartoes.probBruta ?? null,   // ✅ FIX
        confianca: melhorCartoes.confianca,
        dataJogo: j.dataJogo, horario: j.horario,
        clima: j.clima ?? null,
        // ✅ NOVO — Fase 1, item 4: qual versão do motor gerou esta previsão
        motorVersao: j.motor_versao ?? null,
        datasetVersao: j.dataset_versao ?? null,
      })
    }
    if (melhorEscanteios) {
      await postAutoSaveTracker({
        eventoId: j.id,
        mandante: j.mandante, visitante: j.visitante,
        liga: j.competicao,
        mercado: melhorEscanteios.nome,
        direcao: melhorEscanteios.direcao,
        linha: melhorEscanteios.linha,
        probabilidade: melhorEscanteios.prob,
        probBruta: melhorEscanteios.probBruta ?? null,   // ✅ FIX
        confianca: melhorEscanteios.confianca,
        dataJogo: j.dataJogo, horario: j.horario,
        clima: j.clima ?? null,
        // ✅ NOVO — Fase 1, item 4: qual versão do motor gerou esta previsão
        motorVersao: j.motor_versao ?? null,
        datasetVersao: j.dataset_versao ?? null,
      })
    }
  }
}, [])

const handleLogout = () => {
  fetch(`${API_BASE}/api/logout`, {
    method: 'POST',
    headers: { 'x-auth-token': authToken }
  }).catch(() => {})
  localStorage.removeItem('scout_token')
  localStorage.removeItem('scout_role')
  localStorage.removeItem('scout_user')
  setAuthToken(null)
  setUserRole(null)
  setUsername(null)
}

  const etapaAtual = resultado ? 3 : jogosComHistorico ? 2 : jogosEncontrados ? 1 : 0

  const reset = () => {
    setJogosDisponiveis(null)
    setSelecionados([])
    setJogosEncontrados(null)
    setJogosComHistorico(null)
    setResultado(null)
    setErro('')
    setLoadingEtapa(null)
  }

  // ── Busca torneios ativos de tênis (dinâmico) quando o usuário entra na aba ──
  useEffect(() => {
    if (esporte !== 'tenis') return
    let cancelado = false
    setLoadingTorneios(true)
    ts_buscarTorneiosAtivos(incluirAmanha)
      .then(lista => {
        if (cancelado) return
        setTorneiosTenis(lista)
        // mantém a escolha só se ela ainda existir na lista nova (ex.: ao ligar/desligar "amanhã")
        if (lista.length > 0) setTorneioTenis(prev => (prev && lista.some(t => String(t.id) === String(prev))) ? prev : String(lista[0].id))
      })
      .catch(e => { if (!cancelado) setErro(`❌ Erro ao buscar torneios de tênis: ${e.message}`) })
      .finally(() => { if (!cancelado) setLoadingTorneios(false) })
    return () => { cancelado = true }
  }, [esporte, incluirAmanha])

  const handleEtapa1 = useCallback(async () => {
  setErro(''); setLoadingEtapa(1)
  try {
    let lista
    if (esporte === 'tenis') {
      lista = await ts_buscarJogosTorneio(torneioTenis, incluirAmanha)
    } else if (esporte === 'basquete') {
      lista = await bs_etapa1_buscarJogos(ligaBasquete, incluirAmanha)
    } else if (campeonato === 'Copa Sul-Americana') {
      lista = await csa_etapa1_buscarJogos(incluirAmanha)      // ← SEM apiKey
      } else if (campeonato === 'Campeonato Brasileiro Serie B') {
     lista = await sb_etapa1_buscarJogos(incluirAmanha)
    } else if (campeonato === 'UEFA Europa League') {
      lista = await el_etapa1_buscarJogos(incluirAmanha)       // ← SEM football-data.org (plano free não cobre)
    } else if (campeonato === 'UEFA Nations League') {
      lista = await nl_etapa1_buscarJogos(incluirAmanha)       // ← FlashLive (football-data free não cobre Nations League)
    } else if (campeonato === 'Amistosos Internacionais') {
      lista = await am_etapa1_buscarJogos(incluirAmanha)       // ← FlashLive
    } else {
      lista = await etapa1_buscarJogos(apiKey.trim(), campeonato, incluirAmanha)
    }

    if (esporte === 'basquete') {
      // Basquete mantém o fluxo automático de sempre (sem seleção manual)
      setJogosDisponiveis(null)
      setJogosEncontrados(lista)
    } else {
      // ✅ Futebol: mostra TODOS os jogos encontrados e deixa o usuário
      // escolher manualmente até 3 para analisar (etapas 2 e 3).
      setJogosDisponiveis(lista)
      setJogosEncontrados(null)
      setSelecionados(lista.length === 1 ? [0] : [])
    }
    } catch (e) { setErro(`❌ Erro na Etapa 1: ${e.message}`) }
    finally { setLoadingEtapa(null) }
      }, [apiKey, campeonato, esporte, ligaBasquete, incluirAmanha, torneioTenis])

  // ── Alterna a seleção de um jogo (respeitando o limite de 3) ──
  const toggleSelecionado = idx => {
    setSelecionados(prev => {
      if (prev.includes(idx)) return prev.filter(i => i !== idx)
      if (prev.length >= MAX_SELECIONADOS) return prev
      return [...prev, idx]
    })
  }

  // ── Confirma a seleção e libera a Etapa 2 ──
  const confirmarSelecao = () => {
    if (!jogosDisponiveis || selecionados.length === 0) return
    const escolhidos = selecionados
      .slice(0, MAX_SELECIONADOS)
      .map(i => jogosDisponiveis[i])
      .filter(Boolean)
    setJogosEncontrados(escolhidos)
  }

  const handleEtapa2 = useCallback(async () => {
  setErro(''); setLoadingEtapa(2)
  try {
    let data
    if (esporte === 'tenis') {
      data = await ts_buscarHistoricos(jogosEncontrados)
    } else if (esporte === 'basquete') {
      data = await bs_etapa2_buscarHistoricos(jogosEncontrados)
    } else if (campeonato === 'Copa Sul-Americana') {
      data = await csa_etapa2_buscarHistoricos(jogosEncontrados) // ← SEM apiKey
      } else if (campeonato === 'Campeonato Brasileiro Serie B') {
      data = await sb_etapa2_buscarHistoricos(jogosEncontrados)
    } else if (campeonato === 'UEFA Europa League') {
      data = await el_etapa2_buscarHistoricos(jogosEncontrados)
    } else if (campeonato === 'UEFA Nations League') {
      data = await nl_etapa2_buscarHistoricos(jogosEncontrados)
    } else if (campeonato === 'Amistosos Internacionais') {
      data = await am_etapa2_buscarHistoricos(jogosEncontrados)
    } else {
      data = await etapa2_buscarHistoricos(apiKey.trim(), jogosEncontrados)
    }
    setJogosComHistorico(data)
  } catch (e) { setErro(`❌ Erro na Etapa 2: ${e.message}`) }
  finally { setLoadingEtapa(null) }
}, [apiKey, campeonato, jogosEncontrados, esporte])

const handleEtapa3 = useCallback(async () => {
  setErro(''); setLoadingEtapa(3)
  try {
    let data
    if (esporte === 'tenis') {
      data = await ts_calcularProbabilidades(jogosComHistorico)
            data = await calibrarJogosTenis(data) // ✅ NOVO — aplica calibração do Tracker (tênis)
    } else if (esporte === 'basquete') {
      data = await bs_etapa3_calcularProbabilidades(apiKey.trim(), jogosComHistorico)
    } else if (campeonato === 'Copa Sul-Americana') {
      data = await csa_etapa3_calcularProbabilidades(jogosComHistorico) // ← SEM apiKey
      } else if (campeonato === 'Campeonato Brasileiro Serie B') {
      data = await sb_etapa3_calcularProbabilidades(jogosComHistorico)
    } else if (campeonato === 'UEFA Europa League') {
      data = await el_etapa3_calcularProbabilidades(jogosComHistorico)
    } else if (campeonato === 'UEFA Nations League') {
      data = await nl_etapa3_calcularProbabilidades(jogosComHistorico)
    } else if (campeonato === 'Amistosos Internacionais') {
      data = await am_etapa3_calcularProbabilidades(jogosComHistorico)
    } else {
      data = await etapa3_calcularProbabilidades(apiKey.trim(), jogosComHistorico)
    }
    setResultado(data)
    if (esporte === 'futebol') {
      salvarAnaliseNoTracker(data?.jogos ?? [])
    }
    // ao terminar a Etapa 3, envia os jogos + múltipla sugerida pro Telegram (futebol, tênis e basquete)
    const jogosTg = data?.jogos ?? []
    const textoTelegram =
      esporte === 'futebol'  ? montarMensagemTelegram(jogosTg)
      : esporte === 'tenis'    ? montarMensagemTelegramTenis(jogosTg)
      : esporte === 'basquete' ? montarMensagemTelegramBasquete(jogosTg)
      : ''
    if (textoTelegram) {
      enviarParaTelegram(textoTelegram).then(r => {
        if (!r.ok) console.warn('[Telegram] falha ao enviar:', r.erro)
      })
    }
  } catch (e) { setErro(`❌ Erro na Etapa 3: ${e.message}`) }
  finally { setLoadingEtapa(null) }
}, [apiKey, campeonato, jogosComHistorico, esporte, salvarAnaliseNoTracker])

  const handlers = [handleEtapa1, handleEtapa2, handleEtapa3]

  // ── Roteamento de módulos ─────────────────────────────────
  // ── Roteamento de módulos ─────────────────────────────────
// Bloqueia acesso ao site — exige login




// Bloqueia site — exige login
if (!authToken) {
  return <LoginSite onLogin={handleLogin} />
}

// ✅ Barra de navegação inferior (aparece só no celular)
const bottomNav = (
  <BottomNav
    modulo={modulo}
    onNavegar={setModulo}
    userRole={userRole}
    username={username}
    onLogout={handleLogout}
  />
)

if (modulo === 'tracker') {
  return (
    <>
      <ScoutTracker
        token={authToken}
        userRole={userRole}
        onVoltar={() => setModulo('analise')}
      />
      {bottomNav}
    </>
  )
}

// ✅ NOVO — Tela "Jogos ao Vivo"
if (modulo === 'aovivo') {
  return <><JogosAoVivo onVoltar={() => setModulo('analise')} />{bottomNav}</>
}

// ✅ NOVO — Tela "Odds"
// Passa os jogos já analisados (Etapa 3) pra tela conseguir calcular o EV
// comparando a probabilidade do modelo com a odd real do mercado.
if (modulo === 'odds') {
  return (
    <>
      <PainelOdds
        onVoltar={() => setModulo('analise')}
        jogosAnalisados={resultado?.jogos ?? []}
      />
      {bottomNav}
    </>
  )
}
  // ── Tela principal de análise ─────────────────────────────
  return (
    <div style={s.wrap}>
      <header style={s.header} className="fs-header">
        <div style={s.logoWrap}>
          <div style={s.logo}>FOOTBALL<span style={s.logoAccent}>SCOUT</span><span style={{ color: '#4a5a78', fontWeight: 400 }}> IA</span></div>
          <span style={s.liveBadge}>LIVE</span>
        </div>

        {/* ── Botões de navegação no header ── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }} className="fs-nav">
          {/* ✅ NOVO — Jogos ao Vivo */}
          <Tooltip texto="Placar e estatísticas em tempo real dos jogos em andamento agora">
            <button
              onClick={() => setModulo('aovivo')}
              style={{
                background: 'rgba(255,59,59,0.1)',
                border: '1px solid rgba(255,59,59,0.3)',
                borderRadius: 8, padding: '6px 14px',
                color: '#ff3b3b', fontSize: 12, fontWeight: 700,
                cursor: 'pointer', fontFamily: "'Barlow Condensed', sans-serif", letterSpacing: 1,
              }}>
              🔴 Ao Vivo
            </button>
          </Tooltip>

          {/* ✅ NOVO — Odds */}
          <Tooltip texto="Odds 1X2 e Over/Under dos próximos jogos, com probabilidade implícita e margem da casa">
            <button
              onClick={() => setModulo('odds')}
              style={{
                background: 'rgba(255,214,10,0.1)',
                border: '1px solid rgba(255,214,10,0.3)',
                borderRadius: 8, padding: '6px 14px',
                color: '#ffd60a', fontSize: 12, fontWeight: 700,
                cursor: 'pointer', fontFamily: "'Barlow Condensed', sans-serif", letterSpacing: 1,
              }}>
              💰 Odds
            </button>
          </Tooltip>

          {/* Tracker */}
          <Tooltip texto="Abre o histórico de apostas salvas: marque Green/Red e veja o % de acerto do sistema">
            <button
              onClick={() => setModulo('tracker')}
              style={{
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(0,230,118,0.3)',
                borderRadius: 8, padding: '6px 14px',
                color: '#00e676', fontSize: 12, fontWeight: 700,
                cursor: 'pointer', fontFamily: "'Barlow Condensed', sans-serif", letterSpacing: 1,
              }}>
              📊 Tracker
            </button>
          </Tooltip>

          {/* Admin (só para admins) */}
          {userRole === 'admin' && (
          <button
            onClick={() => window.location.href = '/admin'}
            style={{
              background: 'rgba(160,100,255,0.1)',
              border: '1px solid rgba(160,100,255,0.3)',
              borderRadius: 8, padding: '6px 14px',
              color: '#a064ff', fontSize: 12, fontWeight: 700,
              cursor: 'pointer', fontFamily: "'Barlow Condensed', sans-serif", letterSpacing: 1,
            }}>
            ⚙️ Admin
          </button>
        )}

          {/* Login / Logout */}
          {authToken ? (
            <button
              onClick={handleLogout}
              style={{
                background: 'transparent',
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 8, padding: '6px 12px',
                color: '#6b7a99', fontSize: 11, fontWeight: 700,
                cursor: 'pointer', fontFamily: "'Barlow Condensed', sans-serif", letterSpacing: 1,
              }}>
              Sair ({username})
            </button>
          ) : (
            <button
              onClick={() => setModulo('login')}
              style={{
                background: 'transparent',
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 8, padding: '6px 12px',
                color: '#6b7a99', fontSize: 11, fontWeight: 700,
                cursor: 'pointer', fontFamily: "'Barlow Condensed', sans-serif", letterSpacing: 1,
              }}>
              🔑 Login
            </button>
          )}

          <div style={s.dateChip}>{getTodayStr()}</div>
        </div>
      </header>

      <main style={s.main} className="fs-main">
        <div style={s.configBox}>
          <div style={s.sectionLabel}>🔑 Groq API Key</div>
          <div style={s.apiRow}>
            <input style={s.apiInput} type="password" placeholder="gsk_xxxxxxxxxxxxxxxxxxxxxxxxxxxx" value={apiKey} onChange={e => setApiKey(e.target.value)} />
            <div style={{ width: 10, height: 10, borderRadius: '50%', flexShrink: 0, background: apiKey.length > 10 ? '#00e676' : '#4a5a78', boxShadow: apiKey.length > 10 ? '0 0 8px #00e676' : 'none', transition: 'all 0.3s' }} />
          </div>
          <p style={s.apiHelp}>Obtenha em <a href="https://console.groq.com" target="_blank" rel="noreferrer" style={s.apiLink}>console.groq.com</a> → API Keys</p>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          {[{ id: 'futebol', label: '⚽ Futebol', cor: '#00e676' }, { id: 'basquete', label: '🏀 Basquete', cor: '#f97316' }, { id: 'tenis', label: '🎾 Tênis', cor: '#eab308' }].map(esp => (
            <button key={esp.id}
              style={{ flex: 1, borderRadius: 10, padding: '12px', fontFamily: "'Barlow Condensed', sans-serif", fontSize: 15, fontWeight: 800, letterSpacing: 1.5, cursor: 'pointer', transition: 'all 0.2s', background: esporte === esp.id ? `${esp.cor}20` : 'rgba(255,255,255,0.03)', color: esporte === esp.id ? esp.cor : '#4a5a78', border: `1px solid ${esporte === esp.id ? `${esp.cor}50` : 'rgba(255,255,255,0.07)'}` }}
              onClick={() => { setEsporte(esp.id); reset() }}>
              {esp.label}
            </button>
          ))}
        </div>

        <div style={s.filtersRow}>
          <div style={s.filterCard}>
            <label style={s.filterLabel}>{esporte === 'basquete' ? '🏀' : esporte === 'tenis' ? '🎾' : '⚽'} Competição</label>
            {esporte === 'futebol' ? (
              <select style={s.select} value={campeonato} onChange={e => { setCampeonato(e.target.value); reset() }}>
                {LIGAS.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
              </select>
            ) : esporte === 'tenis' ? (
              <select style={s.select} value={torneioTenis} onChange={e => { setTorneioTenis(e.target.value); reset() }} disabled={loadingTorneios}>
                {loadingTorneios && <option>Carregando torneios ativos...</option>}
                {!loadingTorneios && torneiosTenis.length === 0 && <option>Nenhum torneio ATP/WTA ativo agora</option>}
                {torneiosTenis.map(t => (
                  <option key={t.id} value={t.id}>{t.rotulo}</option>
                ))}
              </select>
            ) : (
              <select style={s.select} value={ligaBasquete} onChange={e => { setLigaBasquete(e.target.value); reset() }}>
                {LIGAS_BASQUETE.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
              </select>
            )}
            {(esporte === 'futebol' || esporte === 'tenis' || esporte === 'basquete') && (
              <label style={s.amanhaRow} onClick={() => { setIncluirAmanha(v => !v); reset() }}>
                <input type="checkbox" checked={incluirAmanha} onChange={() => {}} style={{ width: 16, height: 16, accentColor: '#00e676', cursor: 'pointer' }} />
                <span style={s.amanhaLabel}>📅 Buscar também os jogos de amanhã</span>
              </label>
            )}
          </div>
        </div>

        {/* ✅ Fix: a caixa era fixa e sempre descrevia o modelo de futebol (Poisson/gols),
            mesmo nas abas de tênis e basquete — texto agora varia por esporte. */}
        <div style={s.infoBox}>
          {esporte === 'tenis' ? (
            <>🎾 Análise focada em <strong>vitória na partida e sets diretos</strong>: taxa de sets (Bradley-Terry) + H2H
              + ranking oficial ATP/WTA + aproveitamento por superfície, com shrinkage bayesiano.
              O modelo usa os últimos 8 jogos por jogador + H2H direto.</>
          ) : esporte === 'basquete' ? (
            <>🏀 Análise focada em <strong>pontuação e handicap</strong> com base no histórico recente de cada equipe.</>
          ) : (
            <>⚽ Análise focada em <strong>mercados de gols</strong>: Poisson + H2H integrado no cálculo do λ + shrinkage bayesiano.
              O modelo usa os últimos 5 jogos por time + até 5 confrontos diretos para calcular o λ final.</>
          )}
        </div>

        <div style={s.stepsWrap}>
          {STEP_LABELS.map((step, i) => {
            const etapaNum      = i + 1
            const color         = STEP_COLORS[i]
            const isAtiva       = etapaAtual === i
            const isConcluida   = etapaAtual > i
            const isLoadingEsta = loadingEtapa === etapaNum
            const isDisabled    = !isAtiva || loadingEtapa !== null

            const summaries = [
              jogosEncontrados  ? `✅ ${jogosEncontrados.length} jogo(s) selecionado(s) para análise` : null,
              jogosComHistorico ? `✅ Histórico coletado para ${jogosComHistorico.length} jogo(s)` : null,
              resultado         ? `✅ Probabilidades calculadas para ${resultado.total} jogo(s)` : null,
            ]
            const bgNum = color === '#00e676' ? '0,230,118' : color === '#ffd60a' ? '255,214,10' : '0,180,216'

            return (
              <div key={i}>
                {i > 0 && <div style={s.connector} />}
                <div style={s.stepRow}>
                  <div style={{ ...s.stepNum, background: isConcluida ? `rgba(${bgNum},0.15)` : 'rgba(255,255,255,0.04)', color: isConcluida ? color : isAtiva ? color : '#4a5a78', border: `1.5px solid ${isAtiva || isConcluida ? color : 'rgba(255,255,255,0.08)'}` }}>
                    {isConcluida ? '✓' : etapaNum}
                  </div>
                  <button
                    style={{ ...s.stepBtn, background: isConcluida ? 'rgba(255,255,255,0.03)' : isAtiva ? `linear-gradient(135deg, ${color} 0%, ${color}bb 100%)` : 'rgba(255,255,255,0.03)', color: isConcluida ? '#4a5a78' : isAtiva ? '#080d18' : '#4a5a78', border: isConcluida ? '1px solid rgba(255,255,255,0.06)' : isAtiva ? 'none' : '1px solid rgba(255,255,255,0.06)', cursor: isDisabled ? 'not-allowed' : 'pointer', opacity: isDisabled && !isLoadingEsta ? 0.45 : 1 }}
                    onClick={isDisabled ? undefined : handlers[i]}
                    disabled={isDisabled}
                  >
                    {isLoadingEsta ? '⏳ Aguarde...' : `${step.icon} ${step.text}`}
                  </button>
                </div>
                {summaries[i] && <div style={s.stepDone}>{summaries[i]}</div>}
              </div>
            )
          })}
          {etapaAtual === 3 && <button style={s.resetBtn} onClick={reset}>🔄 Nova Busca</button>}
        </div>

        {/* ── Seleção manual dos jogos (máx. 3) — aparece após a Etapa 1 ── */}
        {(esporte === 'futebol' || esporte === 'tenis') && jogosDisponiveis && !jogosEncontrados && !loadingEtapa && (
          <div style={s.selecaoBox}>
            <div style={s.selecaoTitulo}>
              {esporte === 'tenis' ? '🎾' : '⚽'} {jogosDisponiveis.length} jogo{jogosDisponiveis.length !== 1 ? 's' : ''} do {esporte === 'tenis' ? 'torneio' : 'campeonato'} encontrado{jogosDisponiveis.length !== 1 ? 's' : ''}
            </div>
            <div style={s.selecaoSub}>
              Selecione até <strong style={{ color: '#00e676' }}>{MAX_SELECIONADOS} jogos</strong> para
              analisar ({selecionados.length}/{MAX_SELECIONADOS} selecionado{selecionados.length !== 1 ? 's' : ''}).
            </div>
            {jogosDisponiveis.map((jogo, idx) => {
              const ativo       = selecionados.includes(idx)
              const desabilitado = !ativo && selecionados.length >= MAX_SELECIONADOS
              return (
                <div
                  key={idx}
                  style={{
                    ...s.selecaoItem,
                    ...(ativo ? s.selecaoItemAtiva : {}),
                    ...(desabilitado ? s.selecaoItemDesabilitada : {}),
                  }}
                  onClick={() => !desabilitado && toggleSelecionado(idx)}
                >
                  <div style={{ ...s.selecaoCheck, background: ativo ? '#00e676' : 'transparent', borderColor: ativo ? '#00e676' : 'rgba(255,255,255,0.2)', color: '#080d18' }}>
                    {ativo ? '✓' : ''}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 14, fontWeight: 700, color: '#e8eeff' }}>
                      {jogo.mandante} <span style={{ color: '#4a5a78' }}>x</span> {jogo.visitante}
                    </div>
                    <div style={{ fontSize: 11, color: '#6b7a99', marginTop: 2 }}>
                      🕐 {jogo.horario} · {jogo.dataJogo}
                      {jogo.usandoAmanha && <span style={{ color: '#ffd60a', marginLeft: 6 }}>· amanhã</span>}
                    </div>
                  </div>
                </div>
              )
            })}
            <button
              style={{
                ...s.confirmarBtn,
                background: selecionados.length === 0 ? 'rgba(255,255,255,0.05)' : 'linear-gradient(135deg, #00e676 0%, #00b85e 100%)',
                color: selecionados.length === 0 ? '#4a5a78' : '#080d18',
                cursor: selecionados.length === 0 ? 'not-allowed' : 'pointer',
              }}
              disabled={selecionados.length === 0}
              onClick={confirmarSelecao}
            >
              ✅ Confirmar seleção ({selecionados.length}/{MAX_SELECIONADOS}) e ir para Etapa 2
            </button>
          </div>
        )}

        {erro && <div style={s.errorBox}>{erro}</div>}
        {loadingEtapa && <LoadingScreen />}

        {!loadingEtapa && resultado?.jogos?.length > 0 && (
          <div>
            <div style={{ ...s.resultsHeader, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
              <div style={s.resultsTitle}>📋 {resultado.total} jogo{resultado.total !== 1 ? 's' : ''} analisado{resultado.total !== 1 ? 's' : ''}</div>
              <Tooltip texto="Copia a análise completa de todos os jogos listados, pra colar no bloco de notas">
                <button
                  type="button"
                  onClick={async () => {
                    const ok = await copiarTexto(formatarListaParaCopia(resultado.jogos))
                    setErro(ok ? '' : '❌ Não foi possível copiar')
                    if (ok) {
                      // feedback temporário via alert leve
                      const prev = document.title
                      document.title = '✅ Copiado!'
                      setTimeout(() => { document.title = prev }, 1500)
                    }
                  }}
                  style={{
                    background: 'rgba(0,180,216,0.12)', border: '1px solid rgba(0,180,216,0.4)',
                    borderRadius: 8, padding: '7px 14px', color: '#00b4d8', cursor: 'pointer',
                    fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800, fontSize: 13, letterSpacing: 1,
                  }}
                >
                  📋 COPIAR TODOS
                </button>
              </Tooltip>
            </div>
            {resultado.resumo && <div style={s.resumeBox}>🤖 {resultado.resumo}</div>}
            {esporte === 'futebol' && resultado.jogos.length > 1 && (
              <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
                {resultado.jogos.map((j, i) => {
                  const sc  = j.score_composto ?? 0
                  const cor = sc >= 70 ? '#00e676' : sc >= 45 ? '#ffd60a' : '#ff6b6b'
                  const rel = j.relevancia ?? 50
                  const relCor = rel >= 90 ? '#a064ff' : rel >= 75 ? '#00b4d8' : '#4a5a78'
                  return (
                    <div key={i} style={{ background: `${cor}10`, border: `1px solid ${cor}35`, borderRadius: 10, padding: '6px 12px', fontSize: 11, fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700 }}>
                      <span style={{ color: relCor, marginRight: 4 }}>{rel >= 90 ? '⭐' : rel >= 75 ? '🔵' : '⚪'}</span>
                      <span style={{ color: cor }}>#{i + 1} · {sc}pts</span>
                      <span style={{ color: '#6b7a99', marginLeft: 6 }}>{j.mandante.split(' ')[0]} x {j.visitante.split(' ')[0]}</span>
                    </div>
                  )
                })}
              </div>
            )}
            {resultado.jogos.map((jogo, i) => (
              esporte === 'basquete' ? <BasketballCard key={i} jogo={jogo} />
              : esporte === 'tenis'  ? <TennisCard key={i} jogo={jogo} authToken={authToken} userRole={userRole} />
              : <GameCard key={i} jogo={jogo} authToken={authToken} userRole={userRole} />
            ))}
            {esporte === 'futebol' && <MultiplaFlutuante jogos={resultado.jogos} />}
            {(esporte === 'tenis' || esporte === 'basquete') && (
            <MultiplaFlutuanteSimples
              key={esporte + '|' + resultado.jogos.map(j => j.mandante + j.visitante).join('|')}
              jogos={resultado.jogos}
              esporte={esporte}
            />
          )}
          </div>
        )}

        {!loadingEtapa && !resultado && !erro && !jogosEncontrados && (
          <div style={s.emptyState}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>{esporte === 'basquete' ? '🏀' : '⚽'}</div>
            <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 22, fontWeight: 700, color: '#4a5a78', marginBottom: 8 }}>
              ANÁLISE DE GOLS EM 3 ETAPAS
            </div>
            <p style={{ fontSize: 13, maxWidth: 420, margin: '0 auto', lineHeight: 1.6 }}>
              Selecione a competição, insira sua chave Groq e execute as etapas.
              O modelo combina <strong style={{ color: '#ffd60a' }}>Poisson</strong>,{' '}
              <strong style={{ color: '#00e676' }}>shrinkage bayesiano</strong> e{' '}
              <strong style={{ color: '#a064ff' }}>H2H integrado</strong> para calcular o λ final.
            </p>
          </div>
        )}
      </main>

      <footer style={{ textAlign: 'center', padding: '14px 20px', borderTop: '1px solid rgba(255,255,255,0.05)', fontSize: 11, color: '#4a5a78', letterSpacing: 0.5, fontWeight: 600 }}>
        FOOTBALL SCOUT IA · POISSON + H2H BLEND · ANÁLISE DE GOLS
      </footer>
      {bottomNav}
    </div>
  )
}