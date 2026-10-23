// src/components/JogosAoVivo.jsx
// ✅ NOVO — Tela "Jogos ao Vivo"
// Lista os jogos em andamento agora (FlashLive) com placar e minuto,
// auto-refresh a cada 30s, e abre estatísticas ao vivo ao clicar no jogo.
// ✅ abas Futebol / Tênis / Basquete (as três com rota de ao vivo via FlashLive).
// ─────────────────────────────────────────────────────────────

import React, { useState, useEffect, useCallback, useRef } from 'react'
import {
  buscarJogosAoVivo, buscarEstatisticasAoVivo, analisarMelhorEntradaAoVivo, LIGAS_COBERTURA,
  buscarJogosTenisAoVivo, buscarEstatisticasTenisAoVivo, analisarMelhorEntradaTenisAoVivo,
} from '../services/liveOddsService'
import { buscarJogosBasqueteAoVivo } from '../services/basketballService'

const REFRESH_MS = 30_000

const IS_PROD  = typeof window !== 'undefined' && window.location.hostname !== 'localhost'
const API_BASE = IS_PROD ? '' : 'http://localhost:3001'

const st = {
  wrap: { minHeight: '100vh', background: '#070b14', color: '#e8eef7', fontFamily: "'Barlow Condensed', sans-serif" },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '14px 20px', borderBottom: '1px solid rgba(255,255,255,0.07)',
    background: 'rgba(255,255,255,0.02)', position: 'sticky', top: 0, zIndex: 10,
  },
  titulo: { fontSize: 'clamp(18px, 5.5vw, 22px)', fontWeight: 700, letterSpacing: 1.5, display: 'flex', alignItems: 'center', gap: 10 },
  pulso: {
    width: 10, height: 10, borderRadius: '50%', background: '#ff3b3b',
    boxShadow: '0 0 10px #ff3b3b', animation: 'scoutPulse 1.4s ease-in-out infinite',
  },
  btnVoltar: {
    background: 'transparent', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8,
    padding: '6px 14px', minHeight: 44, display: 'inline-flex', alignItems: 'center',
    color: '#6b7a99', fontSize: 12, fontWeight: 700, cursor: 'pointer',
    fontFamily: "'Barlow Condensed', sans-serif", letterSpacing: 1,
  },
  main: { maxWidth: 900, margin: '0 auto', padding: '18px 16px 60px' },
  barraTopo: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 16 },
  toggle: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' },
  toggleLabel: { fontSize: 13, color: '#8fa3c4', fontWeight: 600, letterSpacing: 0.5 },
    select: {
    background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 8, padding: '8px 12px', color: '#e8eef7', fontSize: 13,
    fontFamily: "'Barlow Condensed', sans-serif", cursor: 'pointer', outline: 'none',
  },
  contador: { marginLeft: 'auto', fontSize: 12, color: '#4a5a78', fontWeight: 600 },
  btnAtualizar: {
    background: 'rgba(0,230,118,0.1)', border: '1px solid rgba(0,230,118,0.3)', borderRadius: 8,
    padding: '6px 14px', minHeight: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    color: '#00e676', fontSize: 12, fontWeight: 700, cursor: 'pointer',
    fontFamily: "'Barlow Condensed', sans-serif", letterSpacing: 1,
  },
  grupoLiga: { marginBottom: 20 },
  grupoTitulo: {
    fontSize: 13, fontWeight: 700, letterSpacing: 1.5, color: '#4a5a78',
    textTransform: 'uppercase', marginBottom: 8, paddingLeft: 2,
  },
  card: {
    background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)',
    borderRadius: 12, padding: '12px 14px', marginBottom: 8, cursor: 'pointer',
    transition: 'all 0.15s',
  },
  cardAberto: { borderColor: 'rgba(255,59,59,0.35)', background: 'rgba(255,59,59,0.04)' },
  linhaJogo: { display: 'flex', alignItems: 'center', gap: 12 },
  minuto: {
    minWidth: 46, textAlign: 'center', fontSize: 13, fontWeight: 600, color: '#ff3b3b',
    letterSpacing: 0.5,
  },
  times: { flex: 1, display: 'flex', flexDirection: 'column', gap: 3 },
  time: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 15, fontWeight: 600 },
  timeVencendo: { color: '#fff', fontWeight: 600 },
  timePerdendo: { color: '#6b7a99' },
  gol: { fontSize: 17, fontWeight: 700, minWidth: 22, textAlign: 'right' },
  seta: { color: '#4a5a78', fontSize: 14 },
  stats: { marginTop: 12, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.07)' },
  statLinha: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 7, fontSize: 13 },
  statNome: { flex: 1, textAlign: 'center', color: '#6b7a99', fontWeight: 600, fontSize: 11, letterSpacing: 1, textTransform: 'uppercase' },
  statVal: { minWidth: 34, textAlign: 'center', fontWeight: 600, fontSize: 14 },
  barra: { flex: 2, height: 5, borderRadius: 3, background: 'rgba(255,255,255,0.07)', overflow: 'hidden', display: 'flex' },
  vazio: { textAlign: 'center', padding: '60px 20px', color: '#4a5a78' },
  vazioIcone: { fontSize: 44, marginBottom: 12, opacity: 0.5 },
  erro: {
    background: 'rgba(255,59,59,0.08)', border: '1px solid rgba(255,59,59,0.25)',
    borderRadius: 10, padding: '12px 14px', color: '#ff6b6b', fontSize: 13, marginBottom: 14,
  },
  abas: { display: 'flex', gap: 8, marginBottom: 14 },
  aba: {
    background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 8, padding: '8px 16px', minHeight: 40, color: '#8fa3c4', fontSize: 13,
    fontWeight: 700, letterSpacing: 0.5, cursor: 'pointer', fontFamily: "'Barlow Condensed', sans-serif",
  },
  abaAtiva: { background: 'rgba(0,230,118,0.12)', border: '1px solid rgba(0,230,118,0.4)', color: '#00e676' },
}

/** Barra comparativa mandante × visitante de uma estatística. */
function BarraStat({ nome, casa, fora }) {
  const c = Number(casa) || 0
  const f = Number(fora) || 0
  const total = c + f
  const pctC = total > 0 ? (c / total) * 100 : 50

  return (
    <div style={st.statLinha}>
      <div style={{ ...st.statVal, color: c >= f ? '#00e676' : '#6b7a99' }}>{casa ?? '—'}</div>
      <div style={{ flex: 3 }}>
        <div style={st.statNome}>{nome}</div>
        <div style={st.barra}>
          <div style={{ width: `${pctC}%`, background: '#00e676' }} />
          <div style={{ width: `${100 - pctC}%`, background: '#00b4d8' }} />
        </div>
      </div>
      <div style={{ ...st.statVal, color: f > c ? '#00b4d8' : '#6b7a99' }}>{fora ?? '—'}</div>
    </div>
  )
}

/** Salva uma entrada (já calculada) no tracker via auto-save — usado tanto
 *  pelo bloco de futebol quanto pelo de tênis. */
async function salvarEntradaNoTracker(payload) {
  try {
    await fetch(`${API_BASE}/api/tracker/auto-save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return true
  } catch (e) {
    console.warn('[tracker auto-save] falhou:', e.message)
    return false
  }
}

// ═══════════════════════════════════════════════════════════════
// FUTEBOL AO VIVO (inalterado — só passou a viver dentro de uma aba)
// ═══════════════════════════════════════════════════════════════
function FutebolAoVivo() {
  const [jogos, setJogos]         = useState([])
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro]           = useState('')
  const [ligaSelecionada, setLigaSelecionada] = useState('')
  const [expandido, setExpandido] = useState(null)
  const [stats, setStats]         = useState({})
  const [carregandoStats, setCarregandoStats] = useState(null)
  const [ultimaAtualizacao, setUltimaAtualizacao] = useState(null)
  const [entradas, setEntradas] = useState({})
  const [carregandoEntrada, setCarregandoEntrada] = useState(null)

  const calcularEntrada = async (jogo) => {
    setCarregandoEntrada(jogo.id)
    try {
      const resultado = await analisarMelhorEntradaAoVivo(jogo.id, { mandante: jogo.mandante, visitante: jogo.visitante })
      if (montado.current) setEntradas(prev => ({ ...prev, [jogo.id]: resultado }))
    } catch (e) {
      if (montado.current) setEntradas(prev => ({ ...prev, [jogo.id]: { erro: e.message } }))
    } finally {
      if (montado.current) setCarregandoEntrada(null)
    }
  }

  // evita setState depois de desmontar (auto-refresh roda em background)
  const montado = useRef(true)
  useEffect(() => () => { montado.current = false }, [])

  const carregar = useCallback(async (silencioso = false) => {
    if (!silencioso) setCarregando(true)
    try {
      const { jogos: lista } = await buscarJogosAoVivo(ligaSelecionada === 'mundo')
      if (!montado.current) return
      setJogos(lista)
      setErro('')
      setUltimaAtualizacao(new Date())
    } catch (e) {
      if (montado.current) setErro(e.message)
    } finally {
      if (montado.current) setCarregando(false)
    }
  }, [ligaSelecionada])

  useEffect(() => { carregar() }, [carregar])

  // auto-refresh
  useEffect(() => {
    const id = setInterval(() => carregar(true), REFRESH_MS)
    return () => clearInterval(id)
  }, [carregar])

  const abrirJogo = async (jogo) => {
    if (expandido === jogo.id) { setExpandido(null); return }
    setExpandido(jogo.id)

    if (stats[jogo.id]) return
    setCarregandoStats(jogo.id)
    try {
      const s = await buscarEstatisticasAoVivo(jogo.id)
      if (montado.current) setStats(prev => ({ ...prev, [jogo.id]: s }))
    } catch (e) {
      if (montado.current) setStats(prev => ({ ...prev, [jogo.id]: { erro: e.message } }))
    } finally {
      if (montado.current) setCarregandoStats(null)
    }
  }

  // filtra pela liga escolhida no seletor (quando não é "minhas ligas" nem "mundo todo")
  const jogosFiltrados = (ligaSelecionada && ligaSelecionada !== 'mundo')
    ? jogos.filter(j => j.liga === ligaSelecionada)
    : jogos

  // agrupa por competição
  const grupos = jogosFiltrados.reduce((acc, j) => {
    const k = j.competicao || 'Outros'
    ;(acc[k] = acc[k] || []).push(j)
    return acc
  }, {})

  return (
    <>
      <div style={st.barraTopo}>
        <select
          style={st.select}
          value={ligaSelecionada}
          onChange={e => setLigaSelecionada(e.target.value)}
        >
          <option value="">🏆 Minhas ligas (todas)</option>
          {LIGAS_COBERTURA.map(l => (
            <option key={l.value} value={l.value}>{l.label}</option>
          ))}
          <option value="mundo">🌍 Mundo todo</option>
        </select>

        <button style={st.btnAtualizar} onClick={() => carregar()} disabled={carregando}>
          {carregando ? '⏳ Carregando...' : '🔄 Atualizar'}
        </button>

        <span style={st.contador}>
          {jogosFiltrados.length} jogo{jogosFiltrados.length === 1 ? '' : 's'} ao vivo
          {ultimaAtualizacao && ` · ${ultimaAtualizacao.toLocaleTimeString('pt-BR')}`}
        </span>
      </div>

      {erro && <div style={st.erro}>❌ {erro}</div>}

      {carregando && jogos.length === 0 && (
        <div style={st.vazio}>
          <div style={st.vazioIcone}>⏳</div>
          <div>Buscando jogos em andamento...</div>
        </div>
      )}

      {!carregando && jogosFiltrados.length === 0 && !erro && (
        <div style={st.vazio}>
          <div style={st.vazioIcone}>😴</div>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>Nenhum jogo ao vivo agora</div>
          <div style={{ fontSize: 13 }}>
            {ligaSelecionada === 'mundo'
              ? 'Não há partidas de futebol em andamento neste momento.'
              : 'Escolha "🌍 Mundo todo" no seletor para ver jogos de outras competições.'}
          </div>
        </div>
      )}

      {Object.entries(grupos).map(([liga, lista]) => (
        <div key={liga} style={st.grupoLiga}>
          <div style={st.grupoTitulo}>{liga} · {lista.length}</div>

          {lista.map(j => {
            const aberto = expandido === j.id
            const s = stats[j.id]
            return (
              <div
                key={j.id}
                style={{ ...st.card, ...(aberto ? st.cardAberto : {}) }}
                onClick={() => abrirJogo(j)}
              >
                <div style={st.linhaJogo}>
                  <div style={st.minuto}>
                    {j.minuto === 'INT' ? 'INT' : j.minuto === 'FIM' ? 'FIM' : `${j.minuto ?? '·'}'`}
                  </div>

                  <div style={st.times}>
                    <div style={{ ...st.time, ...(j.vencendo === 'mandante' ? st.timeVencendo : j.vencendo === 'visitante' ? st.timePerdendo : {}) }}>
                      <span>{j.mandante}</span>
                      <span style={{ ...st.gol, color: j.vencendo === 'mandante' ? '#00e676' : '#e8eef7' }}>
                        {j.placarMandante}
                      </span>
                    </div>
                    <div style={{ ...st.time, ...(j.vencendo === 'visitante' ? st.timeVencendo : j.vencendo === 'mandante' ? st.timePerdendo : {}) }}>
                      <span>{j.visitante}</span>
                      <span style={{ ...st.gol, color: j.vencendo === 'visitante' ? '#00e676' : '#e8eef7' }}>
                        {j.placarVisitante}
                      </span>
                    </div>
                  </div>

                  <div style={st.seta}>{aberto ? '▲' : '▼'}</div>
                </div>

                {aberto && (
                  <div style={st.stats} onClick={e => e.stopPropagation()}>
                    {carregandoStats === j.id && (
                      <div style={{ color: '#4a5a78', fontSize: 13, textAlign: 'center' }}>
                        ⏳ Carregando estatísticas...
                      </div>
                    )}

                    {s?.erro && (
                      <div style={{ color: '#ff6b6b', fontSize: 13, textAlign: 'center' }}>
                        Estatísticas ainda não disponíveis para esta partida.
                      </div>
                    )}

                    {s && !s.erro && (
                      <>
                        <BarraStat nome="Escanteios"  casa={s.escanteios_casa}        fora={s.escanteios_fora} />
                        <BarraStat nome="Amarelos"    casa={s.cartoes_amarelos_casa}  fora={s.cartoes_amarelos_fora} />
                        <BarraStat nome="Vermelhos"   casa={s.cartoes_vermelhos_casa} fora={s.cartoes_vermelhos_fora} />
                        <BarraStat nome="xG"          casa={s.xg_casa}                fora={s.xg_fora} />
                        <div style={{ fontSize: 11, color: '#4a5a78', textAlign: 'center', marginTop: 8 }}>
                          {s.status} · atualiza sozinho a cada 30s
                        </div>

                        <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.07)', textAlign: 'center' }}>
                          <button
                            style={st.btnAtualizar}
                            onClick={() => calcularEntrada(j)}
                            disabled={carregandoEntrada === j.id}
                          >
                            {carregandoEntrada === j.id ? '⏳ Calculando...' : '🎯 Calcular Melhor Entrada'}
                          </button>

                          {entradas[j.id]?.erro && (
                            <div style={{ color: '#ff6b6b', fontSize: 13, marginTop: 10 }}>{entradas[j.id].erro}</div>
                          )}

                          {entradas[j.id] && !entradas[j.id].erro && (
                            <div style={{ marginTop: 10, fontSize: 13, textAlign: 'left' }}>
                              {[
                                { chave: 'gols',       rotulo: '⚽ Gols' },
                                { chave: 'escanteios', rotulo: '🚩 Escanteios' },
                                { chave: 'cartoes',    rotulo: '🟨 Cartões' },
                              ].map(({ chave, rotulo }) => {
                                const e = entradas[j.id].entradas?.[chave]
                                return (
                                  <div key={chave} style={{
                                    padding: '9px 10px', marginBottom: 8, borderRadius: 8,
                                    background: e ? 'rgba(0,230,118,0.06)' : 'rgba(255,255,255,0.02)',
                                    border: `1px solid ${e ? 'rgba(0,230,118,0.2)' : 'rgba(255,255,255,0.06)'}`,
                                  }}>
                                    <div style={{ fontSize: 10, color: '#6b7a99', fontWeight: 700, letterSpacing: 1, marginBottom: 4 }}>{rotulo}</div>
                                    {e ? (
                                      <>
                                        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
                                          <span style={{ fontSize: 15, fontWeight: 700, color: '#00e676' }}>
                                            {e.mercado} — {e.prob}%
                                          </span>
                                          {e.odd != null ? (
                                            <span style={{
                                              fontSize: 12, fontWeight: 700,
                                              color: e.valueBet ? '#00e676' : '#ffb700',
                                            }}>
                                              Odd {e.odd} {e.valueBet ? `🔥 vale a pena (EV +${e.ev}%)` : `(justa seria ${e.oddJusta})`}
                                            </span>
                                          ) : (
                                            <span style={{ fontSize: 11, color: '#4a5a78' }}>sem odd disponível agora</span>
                                          )}
                                        </div>
                                      </>
                                    ) : (
                                      <div style={{ color: '#4a5a78', fontSize: 12 }}>Nenhuma linha acima de 80% agora.</div>
                                    )}
                                  </div>
                                )
                              })}

                              {entradas[j.id].comentario && (
                                <div style={{ color: '#8fa3c4', marginTop: 4 }}>{entradas[j.id].comentario}</div>
                              )}
                              {entradas[j.id].alertas.length > 0 && (
                                <div style={{ color: '#ffb700', marginTop: 6 }}>
                                  ⚠️ {entradas[j.id].alertas.join(' · ')}
                                </div>
                              )}
                              <div style={{ fontSize: 11, color: '#4a5a78', marginTop: 8, textAlign: 'center' }}>
                                Análise às {entradas[j.id].atualizadoEm.toLocaleTimeString('pt-BR')} · minuto {entradas[j.id].minutoAtual}'
                              </div>
                            </div>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ))}
    </>
  )
}

// ═══════════════════════════════════════════════════════════════
// ✅ NOVO — TÊNIS AO VIVO
// ═══════════════════════════════════════════════════════════════
function TenisAoVivo() {
  const [jogos, setJogos]         = useState([])
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro]           = useState('')
  const [expandido, setExpandido] = useState(null)
  const [ultimaAtualizacao, setUltimaAtualizacao] = useState(null)
  const [entradas, setEntradas] = useState({})
  const [carregandoEntrada, setCarregandoEntrada] = useState(null)
  const [salvos, setSalvos] = useState({})

  const montado = useRef(true)
  useEffect(() => () => { montado.current = false }, [])

  const carregar = useCallback(async (silencioso = false) => {
    if (!silencioso) setCarregando(true)
    try {
      const { jogos: lista } = await buscarJogosTenisAoVivo()
      if (!montado.current) return
      setJogos(lista)
      setErro('')
      setUltimaAtualizacao(new Date())
    } catch (e) {
      if (montado.current) setErro(e.message)
    } finally {
      if (montado.current) setCarregando(false)
    }
  }, [])

  useEffect(() => { carregar() }, [carregar])
  useEffect(() => {
    const id = setInterval(() => carregar(true), REFRESH_MS)
    return () => clearInterval(id)
  }, [carregar])

  const abrirJogo = (jogo) => {
    setExpandido(expandido === jogo.id ? null : jogo.id)
  }

  const calcularEntrada = async (jogo) => {
    setCarregandoEntrada(jogo.id)
    try {
      const resultado = await analisarMelhorEntradaTenisAoVivo(jogo.id, { mandante: jogo.mandante, visitante: jogo.visitante, bestOf: jogo.bestOf })
      if (montado.current) setEntradas(prev => ({ ...prev, [jogo.id]: resultado }))
    } catch (e) {
      if (montado.current) setEntradas(prev => ({ ...prev, [jogo.id]: { erro: e.message } }))
    } finally {
      if (montado.current) setCarregandoEntrada(null)
    }
  }

  const salvarNoTracker = async (jogo, entrada, chave, motorVersao = null) => {
    const ok = await salvarEntradaNoTracker({
      eventoId: jogo.id,
      mandante: jogo.mandante, visitante: jogo.visitante,
      liga: jogo.competicao,
      esporte: 'tenis',
      mercado: entrada.mercado,
      direcao: entrada.direcao,
      linha: entrada.linha,
      probabilidade: entrada.prob,
      confianca: entrada.prob >= 85 ? 'Alta' : entrada.prob >= 75 ? 'Média' : 'Baixa',
      // ✅ NOVO — Fase 1, item 4: qual versão do motor gerou esta previsão
      motorVersao,
    })
    if (montado.current) setSalvos(prev => ({ ...prev, [`${jogo.id}_${chave}`]: ok }))
  }

  const grupos = jogos.reduce((acc, j) => {
    const k = j.competicao || 'Outros'
    ;(acc[k] = acc[k] || []).push(j)
    return acc
  }, {})

  return (
    <>
      <div style={st.barraTopo}>
        <button style={st.btnAtualizar} onClick={() => carregar()} disabled={carregando}>
          {carregando ? '⏳ Carregando...' : '🔄 Atualizar'}
        </button>
        <span style={st.contador}>
          {jogos.length} jogo{jogos.length === 1 ? '' : 's'} de tênis ao vivo
          {ultimaAtualizacao && ` · ${ultimaAtualizacao.toLocaleTimeString('pt-BR')}`}
        </span>
      </div>

      <div style={{ ...st.erro, background: 'rgba(0,180,216,0.08)', border: '1px solid rgba(0,180,216,0.25)', color: '#8fd6ef' }}>
        ℹ️ Modelo de tênis ao vivo é novo — a % é uma aproximação (não existe fórmula exata igual à de gols).
        A calibração do Tracker corrige o viés dela com o tempo. Acompanhe antes de confiar de olhos fechados.
      </div>

      {erro && <div style={st.erro}>❌ {erro}</div>}

      {carregando && jogos.length === 0 && (
        <div style={st.vazio}>
          <div style={st.vazioIcone}>⏳</div>
          <div>Buscando jogos de tênis em andamento...</div>
        </div>
      )}

      {!carregando && jogos.length === 0 && !erro && (
        <div style={st.vazio}>
          <div style={st.vazioIcone}>🎾</div>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>Nenhum jogo de tênis ao vivo agora</div>
          <div style={{ fontSize: 13 }}>Só ATP/WTA principal (sem Challenger/ITF/exibição).</div>
        </div>
      )}

      {Object.entries(grupos).map(([liga, lista]) => (
        <div key={liga} style={st.grupoLiga}>
          <div style={st.grupoTitulo}>{liga} · {lista.length}</div>

          {lista.map(j => {
            const aberto = expandido === j.id
            const e = entradas[j.id]
            return (
              <div key={j.id} style={{ ...st.card, ...(aberto ? st.cardAberto : {}) }} onClick={() => abrirJogo(j)}>
                <div style={st.linhaJogo}>
                  <div style={{ ...st.minuto, color: '#00b4d8' }}>bo{j.bestOf}</div>
                  <div style={st.times}>
                    <div style={{ ...st.time, ...(j.setsMandante > j.setsVisitante ? st.timeVencendo : st.timePerdendo) }}>
                      <span>{j.mandante}</span>
                      <span style={st.gol}>{j.setsMandante}</span>
                    </div>
                    <div style={{ ...st.time, ...(j.setsVisitante > j.setsMandante ? st.timeVencendo : st.timePerdendo) }}>
                      <span>{j.visitante}</span>
                      <span style={st.gol}>{j.setsVisitante}</span>
                    </div>
                  </div>
                  <div style={st.seta}>{aberto ? '▲' : '▼'}</div>
                </div>

                {aberto && (
                  <div style={st.stats} onClick={ev => ev.stopPropagation()}>
                    {(j.placarSets?.sets ?? []).length > 0 && (
                      <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginBottom: 12, fontSize: 13 }}>
                        {j.placarSets.sets.map((s, i) => (
                          <div key={i} style={{ textAlign: 'center', color: '#8fa3c4' }}>
                            <div style={{ fontSize: 10, letterSpacing: 1 }}>SET {i + 1}</div>
                            <div style={{ fontWeight: 700, color: '#e8eef7' }}>{s.casa ?? '-'}-{s.fora ?? '-'}</div>
                          </div>
                        ))}
                      </div>
                    )}

                    <div style={{ textAlign: 'center' }}>
                      <button style={st.btnAtualizar} onClick={() => calcularEntrada(j)} disabled={carregandoEntrada === j.id}>
                        {carregandoEntrada === j.id ? '⏳ Calculando...' : '🎯 Calcular Melhor Entrada'}
                      </button>
                    </div>

                    {e?.erro && <div style={{ color: '#ff6b6b', fontSize: 13, marginTop: 10, textAlign: 'center' }}>{e.erro}</div>}

                    {e && !e.erro && (
                      <div style={{ marginTop: 10, fontSize: 13 }}>
                        {[
                          { chave: 'vencedor', rotulo: '🏆 Vencedor da Partida' },
                          { chave: 'games',    rotulo: '🎾 Total de Games' },
                        ].map(({ chave, rotulo }) => {
                          const entrada = e.entradas?.[chave]
                          const chaveSalvo = `${j.id}_${chave}`
                          return (
                            <div key={chave} style={{
                              padding: '9px 10px', marginBottom: 8, borderRadius: 8,
                              background: entrada ? 'rgba(0,230,118,0.06)' : 'rgba(255,255,255,0.02)',
                              border: `1px solid ${entrada ? 'rgba(0,230,118,0.2)' : 'rgba(255,255,255,0.06)'}`,
                            }}>
                              <div style={{ fontSize: 10, color: '#6b7a99', fontWeight: 700, letterSpacing: 1, marginBottom: 4 }}>{rotulo}</div>
                              {entrada ? (
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                                  <span style={{ fontSize: 15, fontWeight: 700, color: '#00e676' }}>
                                    {entrada.mercado} — {entrada.prob}%
                                  </span>
                                  <button
                                    style={{ ...st.btnAtualizar, padding: '4px 10px', fontSize: 11, minHeight: 32 }}
                                    onClick={() => salvarNoTracker(j, entrada, chave, e.motorVersao)}
                                  >
                                    {salvos[chaveSalvo] === true ? '✅ salvo' : salvos[chaveSalvo] === false ? '❌ falhou' : '💾 salvar no tracker'}
                                  </button>
                                </div>
                              ) : (
                                <div style={{ color: '#4a5a78', fontSize: 12 }}>Nenhuma linha acima de 80% agora.</div>
                              )}
                            </div>
                          )
                        })}
                        <div style={{ fontSize: 11, color: '#4a5a78', marginTop: 8, textAlign: 'center' }}>
                          Análise às {e.atualizadoEm.toLocaleTimeString('pt-BR')} · calibração {e.calibracaoAtiva ? 'ativa' : 'indisponível'}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ))}
    </>
  )
}

// ═══════════════════════════════════════════════════════════════
// BASQUETE AO VIVO — placar via FlashLive (/api/sportsdata/flashlive/basquete/ao-vivo)
// ═══════════════════════════════════════════════════════════════
function BasqueteAoVivo() {
  const [jogos, setJogos]         = useState([])
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro]           = useState('')
  const [ultimaAtualizacao, setUltimaAtualizacao] = useState(null)

  const montado = useRef(true)
  useEffect(() => () => { montado.current = false }, [])

  const carregar = useCallback(async (silencioso = false) => {
    if (!silencioso) setCarregando(true)
    try {
      const { jogos: lista } = await buscarJogosBasqueteAoVivo()
      if (!montado.current) return
      setJogos(lista)
      setErro('')
      setUltimaAtualizacao(new Date())
    } catch (e) {
      if (montado.current) setErro(e.message)
    } finally {
      if (montado.current) setCarregando(false)
    }
  }, [])

  useEffect(() => { carregar() }, [carregar])
  useEffect(() => {
    const id = setInterval(() => carregar(true), REFRESH_MS)
    return () => clearInterval(id)
  }, [carregar])

  const grupos = jogos.reduce((acc, j) => {
    const k = j.competicao || 'Outros'
    ;(acc[k] = acc[k] || []).push(j)
    return acc
  }, {})

  return (
    <>
      <div style={st.barraTopo}>
        <button style={st.btnAtualizar} onClick={() => carregar()} disabled={carregando}>
          {carregando ? '⏳ Carregando...' : '🔄 Atualizar'}
        </button>
        <span style={st.contador}>
          {jogos.length} jogo{jogos.length === 1 ? '' : 's'} de basquete ao vivo
          {ultimaAtualizacao && ` · ${ultimaAtualizacao.toLocaleTimeString('pt-BR')}`}
        </span>
      </div>

      {erro && <div style={st.erro}>❌ {erro}</div>}

      {carregando && jogos.length === 0 && (
        <div style={st.vazio}>
          <div style={st.vazioIcone}>⏳</div>
          <div>Buscando jogos de basquete em andamento...</div>
        </div>
      )}

      {!carregando && jogos.length === 0 && !erro && (
        <div style={st.vazio}>
          <div style={st.vazioIcone}>🏀</div>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>Nenhum jogo de basquete ao vivo agora</div>
        </div>
      )}

      {Object.entries(grupos).map(([liga, lista]) => (
        <div key={liga} style={st.grupoLiga}>
          <div style={st.grupoTitulo}>{liga} · {lista.length}</div>
          {lista.map(j => (
            <div key={j.id} style={st.card}>
              <div style={st.linhaJogo}>
                <div style={{ ...st.minuto, color: '#f97316' }}>{j.statusDescricao || 'AO VIVO'}</div>
                <div style={st.times}>
                  <div style={{ ...st.time, ...(j.pontosMandante > j.pontosVisitante ? st.timeVencendo : st.timePerdendo) }}>
                    <span>{j.mandante}</span>
                    <span style={st.gol}>{j.pontosMandante}</span>
                  </div>
                  <div style={{ ...st.time, ...(j.pontosVisitante > j.pontosMandante ? st.timeVencendo : st.timePerdendo) }}>
                    <span>{j.visitante}</span>
                    <span style={st.gol}>{j.pontosVisitante}</span>
                  </div>
                </div>
              </div>
              {j.periodos?.length > 0 && (
                <div style={{ display: 'flex', gap: 10, justifyContent: 'center', padding: '4px 0 10px', fontSize: 12, color: '#8fa3c4' }}>
                  {j.periodos.map((p, i) => (
                    <div key={i} style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: 9, letterSpacing: 1 }}>{i < 4 ? `Q${i + 1}` : `OT${i - 3}`}</div>
                      <div style={{ fontWeight: 700, color: '#e8eef7' }}>{p.casa ?? '-'}-{p.fora ?? '-'}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
    </>
  )
}

export default function JogosAoVivo({ onVoltar }) {
  const [esporteAoVivo, setEsporteAoVivo] = useState('futebol') // 'futebol' | 'tenis' | 'basquete'

  return (
    <div style={st.wrap}>
      <style>{`@keyframes scoutPulse { 0%,100% { opacity:1 } 50% { opacity:0.25 } }`}</style>

      <header style={st.header}>
        <div style={st.titulo}>
          <span style={st.pulso} />
          JOGOS AO VIVO
        </div>
        <button className="fs-hide-m" style={st.btnVoltar} onClick={onVoltar}>← Voltar</button>
      </header>

      <main style={st.main}>
        <div style={st.abas}>
          {[
            { chave: 'futebol',  label: '⚽ Futebol' },
            { chave: 'tenis',    label: '🎾 Tênis' },
            { chave: 'basquete', label: '🏀 Basquete' },
          ].map(op => (
            <button
              key={op.chave}
              style={{ ...st.aba, ...(esporteAoVivo === op.chave ? st.abaAtiva : {}) }}
              onClick={() => setEsporteAoVivo(op.chave)}
            >
              {op.label}
            </button>
          ))}
        </div>

        {esporteAoVivo === 'futebol'  && <FutebolAoVivo />}
        {esporteAoVivo === 'tenis'    && <TenisAoVivo />}
        {esporteAoVivo === 'basquete' && <BasqueteAoVivo />}
      </main>
    </div>
  )
}