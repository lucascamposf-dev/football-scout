// src/components/PainelOdds.jsx
// ✅ NOVO — Tela "Odds"
// Mostra as odds (FlashLive) dos próximos jogos de uma liga: 1X2,
// Over/Under 2.5, probabilidade implícita, margem da casa e — quando
// o jogo já tem probabilidade calculada pela análise — o EV da entrada.
// ─────────────────────────────────────────────────────────────

import React, { useState, useEffect, useCallback } from 'react'
import {
  buscarOddsLiga, buscarOddsPartida, LIGAS_COBERTURA,
  probabilidadesJustas, calcularEV, formatarDataJogo,
} from '../services/liveOddsService'

const st = {
  wrap: { minHeight: '100vh', background: '#070b14', color: '#e8eef7', fontFamily: "'Barlow Condensed', sans-serif" },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '12px clamp(12px, 4vw, 20px)', flexWrap: 'wrap', gap: 8, borderBottom: '1px solid rgba(255,255,255,0.07)',
    background: 'rgba(255,255,255,0.02)', position: 'sticky', top: 0, zIndex: 10,
  },
  titulo: { fontSize: 'clamp(18px, 5.5vw, 22px)', fontWeight: 900, letterSpacing: 1.5 },
  btnVoltar: {
    background: 'transparent', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8,
    padding: '6px 14px', minHeight: 44, display: 'inline-flex', alignItems: 'center',
    color: '#6b7a99', fontSize: 12, fontWeight: 700, cursor: 'pointer',
    fontFamily: "'Barlow Condensed', sans-serif", letterSpacing: 1,
  },
  main: { maxWidth: 900, margin: '0 auto', padding: '18px 16px 60px' },
  controles: { display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 },
  campo: { display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 200 },
  label: { fontSize: 11, fontWeight: 800, letterSpacing: 1.5, color: '#4a5a78', textTransform: 'uppercase' },
  select: {
    background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 8, padding: '10px 12px', color: '#e8eef7', fontSize: 14,
    fontFamily: "'Barlow Condensed', sans-serif", cursor: 'pointer', outline: 'none',
  },
  btnBuscar: {
    background: 'rgba(255,214,10,0.12)', border: '1px solid rgba(255,214,10,0.35)',
    borderRadius: 8, padding: '10px 20px', minHeight: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    color: '#ffd60a', fontSize: 14, fontWeight: 800,
    letterSpacing: 1, cursor: 'pointer', fontFamily: "'Barlow Condensed', sans-serif",
  },
  infoBox: {
    background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)',
    borderRadius: 10, padding: '10px 14px', fontSize: 12.5, color: '#8fa3c4',
    marginBottom: 16, lineHeight: 1.5,
  },
  card: {
    background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)',
    borderRadius: 12, padding: '14px', marginBottom: 10,
  },
  cardTopo: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12, gap: 10 },
  confronto: { fontSize: 16, fontWeight: 800 },
  dataJogo: { fontSize: 11.5, color: '#4a5a78', fontWeight: 600, whiteSpace: 'nowrap' },
  gradeOdds: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(84px, 1fr))', gap: 8 },
  oddBox: {
    background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 8, padding: '8px 6px', textAlign: 'center',
  },
  oddLabel: { fontSize: 10.5, fontWeight: 800, letterSpacing: 1, color: '#4a5a78', textTransform: 'uppercase', marginBottom: 4 },
  oddValor: { fontSize: 18, fontWeight: 900, color: '#ffd60a' },
  oddProb: { fontSize: 10.5, color: '#6b7a99', marginTop: 2, fontWeight: 600 },
  rodape: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    marginTop: 10, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,0.06)',
    fontSize: 11.5, color: '#4a5a78', fontWeight: 600, gap: 10, flexWrap: 'wrap',
  },
  btnMercados: {
    background: 'transparent', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6,
    padding: '4px 10px', color: '#8fa3c4', fontSize: 11, fontWeight: 700, cursor: 'pointer',
    fontFamily: "'Barlow Condensed', sans-serif", letterSpacing: 0.5,
  },
  mercado: { marginTop: 12, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,0.06)' },
  mercadoNome: { fontSize: 12, fontWeight: 800, color: '#8fa3c4', letterSpacing: 0.8, marginBottom: 2 },
  mercadoExplicacao: { fontSize: 11, color: '#4a5a78', marginBottom: 6, lineHeight: 1.4 },
  semOdds: { fontSize: 12.5, color: '#6b7a99', fontStyle: 'italic' },
  erro: {
    background: 'rgba(255,59,59,0.08)', border: '1px solid rgba(255,59,59,0.25)',
    borderRadius: 10, padding: '12px 14px', color: '#ff6b6b', fontSize: 13, marginBottom: 14,
  },
  vazio: { textAlign: 'center', padding: '60px 20px', color: '#4a5a78' },
  vazioIcone: { fontSize: 44, marginBottom: 12, opacity: 0.5 },
}

/** Caixinha de uma odd com a probabilidade implícita embaixo.
 *  `titulo`, quando passado, vira uma dica (tooltip nativa) ao passar
 *  o mouse — usada pra explicar o que aquela odd significa. */
function OddBox({ label, odd, prob, destaque, titulo }) {
  return (
    <div
      style={{ ...st.oddBox, ...(destaque ? { borderColor: 'rgba(0,230,118,0.4)', background: 'rgba(0,230,118,0.06)' } : {}) }}
      title={titulo}
    >
      <div style={st.oddLabel}>{label}</div>
      <div style={{ ...st.oddValor, ...(destaque ? { color: '#00e676' } : {}) }}>{odd ?? '—'}</div>
      {prob != null && <div style={st.oddProb}>{prob}%</div>}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// ✅ Glossário: explica em 1 linha o que cada mercado de odds
// significa, pra quem não é acostumado com termos de apostas.
// Primeiro tenta achar o nome exato; se não achar, procura por
// palavras-chave dentro do nome (cobre mercados compostos, tipo
// "1º Tempo" combinado com outro mercado).
// ─────────────────────────────────────────────────────────────
const EXPLICACAO_EXATA = {
  'resultado final':               'Quem vence a partida no tempo normal: mandante, empate ou visitante.',
  'resultado final (1x2)':         'Quem vence a partida no tempo normal: mandante (1), empate (X) ou visitante (2).',
  'vencedor da partida':           'Quem vence a partida, incluindo prorrogação/pênaltis quando aplicável.',
  'dupla chance':                  'Aposta em duas das três hipóteses ao mesmo tempo (ex.: mandante OU empate), reduzindo o risco.',
  'empate anula a aposta':         'Se o jogo terminar empatado, o valor apostado é devolvido — o empate "não conta".',
  'ambas as equipes marcam':       'Aposta se os dois times balançam a rede na partida, não importa o placar final.',
  'total de gols da partida':      'Quantos gols saem no total (mandante + visitante), acima ou abaixo de uma linha (ex.: 2.5).',
  'total de gols':                 'Quantos gols saem no total (mandante + visitante), acima ou abaixo de uma linha.',
  'mais/menos de gols':            'Aposta se o total de gols fica acima ("Mais de") ou abaixo ("Menos de") de uma linha.',
  '1º tempo':                      'Mercado calculado só com o que acontece até o intervalo (primeiros 45min + acréscimos).',
  '2º tempo':                      'Mercado calculado só com o que acontece na etapa final da partida.',
  'resultado do 1º tempo':         'Quem está na frente (ou empate) só olhando o placar do intervalo.',
  '1º tempo / resultado final':    'Combina quem está na frente no intervalo com quem vence no final (ex.: empate no 1º/vitória no 2º).',
  'placar exato':                  'Aposta no placar exato da partida (ex.: 2 a 1). Paga mais porque é mais difícil de acertar.',
  'handicap asiático':             'Dá uma "vantagem" ou "desvantagem" de gols pra um dos times antes da partida começar, equilibrando o confronto.',
  'handicap europeu':              'Mesma ideia do handicap asiático, mas sem opção de "devolução" — sempre há vencedor na aposta.',
  'time que marca primeiro':       'Aposta em qual dos dois times vai balançar a rede primeiro.',
  'não sofre gol (clean sheet)':   'Aposta se um time específico termina o jogo sem sofrer nenhum gol.',
  'vence sem sofrer gol':          'O time precisa vencer a partida E não sofrer nenhum gol.',
  'tempo com mais gols':           'Aposta em qual dos dois tempos (1º ou 2º) vai ter mais gols marcados.',
  'ímpar/par (total de gols)':     'Aposta se o número total de gols da partida vai ser ímpar ou par.',
  'total de gols do mandante':     'Quantos gols só o time da casa marca na partida, acima/abaixo de uma linha.',
  'total de gols do visitante':    'Quantos gols só o time visitante marca na partida, acima/abaixo de uma linha.',
  'escanteios':                    'Mercados relacionados ao número de escanteios cobrados na partida.',
  'total de escanteios':           'Quantos escanteios saem no total da partida, acima/abaixo de uma linha.',
  'cartões':                       'Mercados relacionados ao número de cartões (amarelos/vermelhos) na partida.',
  'total de cartões':              'Quantos cartões saem no total da partida, acima/abaixo de uma linha.',
}

const EXPLICACAO_PALAVRA_CHAVE = [
  [/ambas as equipes marcam/i, 'Aposta se os dois times marcam gol na partida.'],
  [/empate anula/i,            'Se empatar, o valor apostado volta pra você.'],
  [/handicap/i,                'Dá uma vantagem/desvantagem de gols pra equilibrar o confronto antes de calcular o resultado.'],
  [/total de gols|gols/i,      'Mercado ligado à quantidade de gols marcados, acima ou abaixo de uma linha.'],
  [/escanteio/i,                'Mercado ligado ao número de escanteios da partida.'],
  [/cart(ã|a)o/i,               'Mercado ligado ao número de cartões da partida.'],
  [/1º tempo/i,                 'Considera só o que acontece até o intervalo da partida.'],
  [/2º tempo/i,                 'Considera só a etapa final da partida.'],
  [/dupla chance/i,             'Cobre duas das três hipóteses de resultado ao mesmo tempo, com odd menor.'],
  [/placar exato/i,             'Aposta no placar exato final da partida.'],
]

/** Devolve uma frase curta explicando o que o mercado significa.
 *  Sempre retorna algo (fallback genérico), pra nunca deixar o
 *  usuário sem contexto sobre o que está vendo. */
function explicarMercado(nomeMercado = '') {
  const chave = nomeMercado.trim().toLowerCase()
  if (EXPLICACAO_EXATA[chave]) return EXPLICACAO_EXATA[chave]
  const achada = EXPLICACAO_PALAVRA_CHAVE.find(([regex]) => regex.test(nomeMercado))
  return achada ? achada[1] : 'Mercado de apostas desse jogo — passe o mouse sobre cada odd pra ver a probabilidade implícita.'
}

export default function PainelOdds({ onVoltar, jogosAnalisados = [] }) {
  const [liga, setLiga]           = useState('brasileirao')
  const [dados, setDados]         = useState(null)
  const [carregando, setCarregando] = useState(false)
  const [erro, setErro]           = useState('')
  const [expandido, setExpandido] = useState(null)
  const [detalhes, setDetalhes]   = useState({})

  const carregar = useCallback(async () => {
    setCarregando(true)
    setErro('')
    setExpandido(null)
    try {
      const res = await buscarOddsLiga(liga, 12)
      setDados(res)
    } catch (e) {
      setErro(e.message)
      setDados(null)
    } finally {
      setCarregando(false)
    }
  }, [liga])

  useEffect(() => { carregar() }, [carregar])

  const abrirMercados = async (jogo) => {
    if (expandido === jogo.id) { setExpandido(null); return }
    setExpandido(jogo.id)
    if (detalhes[jogo.id]) return
    try {
      const d = await buscarOddsPartida(jogo.id)
      setDetalhes(prev => ({ ...prev, [jogo.id]: d }))
    } catch (e) {
      setDetalhes(prev => ({ ...prev, [jogo.id]: { erro: e.message } }))
    }
  }

  /** Procura a probabilidade que a análise (Etapa 3) calculou para esse jogo,
   *  casando pelo id da FlashLive. Se achar, dá pra mostrar o EV real. */
  const acharAnalise = (jogo) =>
    jogosAnalisados.find(j => j.id === jogo.id) ?? null

  return (
    <div style={st.wrap}>
      <header style={st.header}>
        <div style={st.titulo}>💰 ODDS</div>
        <button className="fs-hide-m" style={st.btnVoltar} onClick={onVoltar}>← Voltar</button>
      </header>

      <main style={st.main}>
        <div style={st.controles}>
          <div style={st.campo}>
            <label style={st.label}>Competição</label>
            <select style={st.select} value={liga} onChange={e => setLiga(e.target.value)}>
              {LIGAS_COBERTURA.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
            </select>
          </div>
          <button style={st.btnBuscar} onClick={carregar} disabled={carregando}>
            {carregando ? '⏳ BUSCANDO...' : '🔄 ATUALIZAR'}
          </button>
        </div>

        <div style={st.infoBox}>
          💡 Odds em formato <strong>decimal</strong>, vindas da FlashLive (ex.: odd 2.00 significa que, se você
          acertar, recebe 2x o valor apostado de volta). O percentual embaixo de cada odd é a{' '}
          <strong>probabilidade implícita</strong> — a chance de acerto que a própria odd embute (1 ÷ odd) —,
          que já inclui a margem da casa. A <strong>margem da casa</strong> aparece no rodapé de cada jogo: quanto
          menor, mais justo é o preço cobrado pela casa de apostas. Clique em <strong>"Todos os mercados"</strong>
          {' '}dentro de um jogo pra ver outras apostas além de 1X2 e Mais/Menos de gols, cada uma com uma explicação
          rápida do que ela significa.
          {jogosAnalisados.length > 0 && ' Jogos que você já analisou na aba de Análise mostram também o EV (valor esperado) da entrada: se ele for positivo, a odd está paga acima da sua probabilidade estimada — ou seja, é uma aposta com vantagem matemática pra você a longo prazo.'}
        </div>

        {erro && <div style={st.erro}>❌ {erro}</div>}

        {carregando && !dados && (
          <div style={st.vazio}>
            <div style={st.vazioIcone}>⏳</div>
            <div>Buscando odds da liga... (pode levar alguns segundos)</div>
          </div>
        )}

        {dados && dados.jogos.length === 0 && !carregando && (
          <div style={st.vazio}>
            <div style={st.vazioIcone}>📭</div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>Nenhum jogo futuro encontrado nessa liga</div>
          </div>
        )}

        {dados && dados.jogos.map(jogo => {
          const o = jogo.odds ?? {}
          const justas = probabilidadesJustas([o.mandante, o.empate, o.visitante])
          const analise = acharAnalise(jogo)
          const aberto = expandido === jogo.id
          const det = detalhes[jogo.id]

          // EV do Over 2.5 quando a análise já calculou essa probabilidade
          const evOver = analise?.over25_gols != null && o.over25
            ? calcularEV(analise.over25_gols, o.over25)
            : null

          return (
            <div key={jogo.id} style={st.card}>
              <div style={st.cardTopo}>
                <div style={st.confronto}>{jogo.mandante} × {jogo.visitante}</div>
                <div style={st.dataJogo}>{formatarDataJogo(jogo.startTimestamp)}</div>
              </div>

              {jogo.semOdds ? (
                <div style={st.semOdds}>Sem odds publicadas para este jogo ainda.</div>
              ) : (
                <>
                  <div style={st.gradeOdds}>
                    <OddBox label="Casa"     odd={o.mandante}  prob={justas?.[0]} titulo="Odd para o time mandante vencer no tempo normal." />
                    <OddBox label="Empate"   odd={o.empate}    prob={justas?.[1]} titulo="Odd para a partida terminar empatada." />
                    <OddBox label="Fora"     odd={o.visitante} prob={justas?.[2]} titulo="Odd para o time visitante vencer no tempo normal." />
                    <OddBox label="Mais de 2.5"  odd={o.over25}  destaque={evOver != null && evOver > 0} titulo="Odd para a partida ter 3 gols ou mais no total (mandante + visitante)." />
                    <OddBox label="Menos de 2.5" odd={o.under25} titulo="Odd para a partida ter 2 gols ou menos no total (mandante + visitante)." />
                  </div>

                  <div style={st.rodape}>
                    <span>
                      Margem da casa (1X2): {o.margemCasa1x2 != null ? `${o.margemCasa1x2}%` : '—'}
                    </span>

                    {evOver != null && (
                      <span style={{ color: evOver > 0 ? '#00e676' : '#ff6b6b', fontWeight: 800 }}>
                        {evOver > 0 ? '🎯' : '⚠️'} EV Over 2.5: {evOver > 0 ? '+' : ''}{evOver}%
                        {analise?.over25_gols != null && ` (sua estimativa: ${analise.over25_gols}%)`}
                      </span>
                    )}

                    <button style={st.btnMercados} onClick={() => abrirMercados(jogo)}>
                      {aberto ? '▲ Menos mercados' : '▼ Todos os mercados'}
                    </button>
                  </div>

                  {aberto && (
                    <div>
                      {!det && <div style={{ ...st.semOdds, marginTop: 10 }}>⏳ Carregando mercados...</div>}
                      {det?.erro && <div style={{ ...st.semOdds, marginTop: 10 }}>{det.erro}</div>}
                      {det?.mercados?.map((m, i) => (
                        <div key={i} style={st.mercado}>
                          <div style={st.mercadoNome}>
                            {m.nome}{m.linha ? ` · Linha ${m.linha}` : ''}
                            {m.suspenso && <span style={{ color: '#ff6b6b' }}> · suspenso</span>}
                          </div>
                          <div style={st.mercadoExplicacao}>{explicarMercado(m.nome)}</div>
                          <div style={st.gradeOdds}>
                            {m.opcoes.map((op, k) => (
                              <OddBox key={k} label={op.nome} odd={op.odd} prob={op.probImplicita} />
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )
        })}

        {dados && (
          <div style={{ textAlign: 'center', fontSize: 11.5, color: '#4a5a78', marginTop: 16 }}>
            {dados.comOdds} de {dados.total} jogos com odds disponíveis
          </div>
        )}
      </main>
    </div>
  )
}