// GameCard.jsx — Card de cada jogo analisado
import React, { useState } from 'react'
import ScoreRing from './ScoreRing'
import { PieChart, BarChart } from './MiniCharts'

const styles = {
  card: {
    background: '#0f1724',
    border: '1px solid rgba(255,255,255,0.07)',
    borderRadius: 14,
    padding: '18px 20px',
    marginBottom: 12,
    transition: 'border-color 0.2s, transform 0.15s',
    cursor: 'default',
    position: 'relative',
    overflow: 'hidden',
  },
  cardHover: {
    borderColor: 'rgba(255,255,255,0.18)',
    transform: 'translateY(-1px)',
  },
  accentLine: {
    position: 'absolute',
    left: 0, top: 0, bottom: 0,
    width: 3,
    borderRadius: '14px 0 0 14px',
  },
  topRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 14,
  },
  matchInfo: {
    flex: 1,
    minWidth: 0,
  },
  teams: {
    fontFamily: "'Barlow Condensed'",
    fontSize: 17,
    fontWeight: 700,
    color: '#e8eeff',
    letterSpacing: 0.5,
    lineHeight: 1.3,
    whiteSpace: 'normal',
    wordBreak: 'break-word',
  },
  metaRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
    flexWrap: 'wrap',
  },
  badge: {
    fontSize: 11,
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: 6,
    letterSpacing: 0.5,
  },
  rightCol: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: 6,
    flexShrink: 0,
  },
  mercadoTag: {
    background: 'rgba(0,180,216,0.12)',
    color: '#00b4d8',
    border: '1px solid rgba(0,180,216,0.25)',
    fontFamily: "'Barlow Condensed'",
    fontSize: 13,
    fontWeight: 700,
    padding: '4px 12px',
    borderRadius: 20,
    letterSpacing: 0.5,
    whiteSpace: 'nowrap',
  },
  oddsTag: {
    fontSize: 11,
    color: '#4a5a78',
    fontWeight: 600,
  },
  expandBtn: {
    background: 'none',
    border: 'none',
    color: '#4a5a78',
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: 1,
    padding: '6px 0 0',
    cursor: 'pointer',
    textTransform: 'uppercase',
    fontFamily: "'Barlow Condensed'",
    transition: 'color 0.15s',
  },
  detail: {
    marginTop: 14,
    paddingTop: 14,
    borderTop: '1px solid rgba(255,255,255,0.06)',
  },
  formsRow: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 12,
    marginBottom: 12,
  },
  formBox: {
    background: '#080d18',
    borderRadius: 8,
    padding: '10px 12px',
  },
  formTitle: {
    fontSize: 11,
    fontWeight: 600,
    color: '#4a5a78',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  formBadges: {
    display: 'flex',
    gap: 4,
    flexWrap: 'wrap',
  },
  resultBadge: {
    fontSize: 11,
    fontWeight: 700,
    padding: '2px 7px',
    borderRadius: 5,
    letterSpacing: 0.3,
    fontFamily: "'Barlow Condensed'",
  },
  justBox: {
    background: 'rgba(0,230,118,0.05)',
    border: '1px solid rgba(0,230,118,0.12)',
    borderRadius: 8,
    padding: '10px 12px',
    fontSize: 13,
    color: '#9aaac4',
    lineHeight: 1.5,
  },
  statsRow: {
    display: 'flex',
    gap: 10,
    marginBottom: 12,
  },
  statChip: {
    background: '#18243a',
    borderRadius: 6,
    padding: '6px 10px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 2,
    flex: 1,
  },
  statVal: {
    fontFamily: "'Barlow Condensed'",
    fontSize: 16,
    fontWeight: 700,
    color: '#e8eeff',
  },
  statLbl: {
    fontSize: 10,
    color: '#4a5a78',
    fontWeight: 600,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
}

function getResultColor(res) {
  const r = res?.toUpperCase()
  if (r?.startsWith('V')) return { bg: 'rgba(0,230,118,0.15)', color: '#00e676' }
  if (r?.startsWith('E')) return { bg: 'rgba(255,214,10,0.15)', color: '#ffd60a' }
  return { bg: 'rgba(255,82,82,0.15)', color: '#ff5252' }
}

function getScoreColor(score) {
  if (score >= 75) return '#00e676'
  if (score >= 60) return '#ffd60a'
  return '#ff5252'
}

export default function GameCard({ jogo, index }) {
  const [expanded, setExpanded] = useState(false)
  const [hovered, setHovered] = useState(false)
  const color = getScoreColor(jogo.score)

  return (
    <div
      style={{ ...styles.card, ...(hovered ? styles.cardHover : {}) }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Linha colorida lateral */}
      <div style={{ ...styles.accentLine, background: color }} />

      {/* Ranking number */}
      <div style={{
        position: 'absolute', top: 14, right: 14,
        fontFamily: "'Barlow Condensed'", fontSize: 11, fontWeight: 700,
        color: '#4a5a78', letterSpacing: 1
      }}>
        #{index + 1}
      </div>

      <div style={styles.topRow}>
        <ScoreRing score={jogo.score} />

        <div style={styles.matchInfo}>
          <div style={styles.teams}>
            {jogo.mandante} <span style={{ color: '#4a5a78' }}>✕</span> {jogo.visitante}
          </div>
          <div style={styles.metaRow}>
            {jogo.horario && (
              <span style={{
                ...styles.badge,
                background: 'rgba(255,255,255,0.06)',
                color: '#9aaac4',
              }}>
                🕐 {jogo.horario}
              </span>
            )}
            <span style={{
              ...styles.badge,
              background: 'rgba(255,255,255,0.04)',
              color: '#6b7a99',
            }}>
              {jogo.competicao}
            </span>
            {jogo.pais && (
              <span style={{
                ...styles.badge,
                background: 'rgba(255,255,255,0.04)',
                color: '#4a5a78',
              }}>
                {jogo.pais}
              </span>
            )}
            {jogo.odds_mercado?.melhorEV && (
              <span style={{
                ...styles.badge,
                background: 'rgba(0,230,118,0.15)',
                color: '#00e676',
                border: '1px solid rgba(0,230,118,0.3)',
              }}>
                🎯 EV+{Math.round(jogo.odds_mercado.melhorEV.ev * 100)}% · {jogo.odds_mercado.melhorEV.nome} @ {jogo.odds_mercado.melhorEV.odd}
              </span>
            )}
            
          </div>
        </div>

        <div style={styles.rightCol}>
          <div style={styles.mercadoTag}>{jogo.mercado}</div>
          {jogo.odds_sugerida && (
            <div style={styles.oddsTag}>Odds: {jogo.odds_sugerida}</div>
          )}
        </div>
      </div>

      {/* Expand toggle */}
      <button
        style={styles.expandBtn}
        onClick={() => setExpanded(e => !e)}
      >
        {expanded ? '▲ Ocultar detalhes' : '▼ Ver análise completa'}
      </button>

      {/* Detalhes expandidos */}
      {expanded && (
        <div style={styles.detail}>
          {/* Stats rápidas */}
          <div style={styles.statsRow}>
            <div style={styles.statChip}>
              <span style={styles.statVal}>{jogo.media_gols_mandante?.toFixed(1) ?? '—'}</span>
              <span style={styles.statLbl}>Gols/jogo {jogo.mandante?.split(' ')[0]}</span>
            </div>
            <div style={styles.statChip}>
              <span style={styles.statVal}>{jogo.media_gols_visitante?.toFixed(1) ?? '—'}</span>
              <span style={styles.statLbl}>Gols/jogo {jogo.visitante?.split(' ')[0]}</span>
            </div>
            <div style={styles.statChip}>
              <span style={{ ...styles.statVal, color }}>
                {jogo.score}%
              </span>
              <span style={styles.statLbl}>Assertividade</span>
            </div>
          </div>

          {/* Formas recentes */}
          <div style={styles.formsRow}>
            <div style={styles.formBox}>
              <div style={styles.formTitle}>{jogo.mandante} — últimos 5</div>
              <div style={styles.formBadges}>
                {(jogo.ultimos5_mandante || []).map((r, i) => {
                  const { bg, color } = getResultColor(r)
                  return (
                    <span key={i} style={{ ...styles.resultBadge, background: bg, color }}>
                      {r}
                    </span>
                  )
                })}
              </div>
            </div>
            <div style={styles.formBox}>
              <div style={styles.formTitle}>{jogo.visitante} — últimos 5</div>
              <div style={styles.formBadges}>
                {(jogo.ultimos5_visitante || []).map((r, i) => {
                  const { bg, color } = getResultColor(r)
                  return (
                    <span key={i} style={{ ...styles.resultBadge, background: bg, color }}>
                      {r}
                    </span>
                  )
                })}
              </div>
            </div>
          </div>

          {/* Odds de mercado + EV */}
          {jogo.odds_mercado && (
            <div style={{
              background: '#080d18',
              borderRadius: 8,
              padding: '10px 12px',
              marginBottom: 10,
            }}>
              <div style={styles.formTitle}>Odds · {jogo.odds_mercado.bookmaker}</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {[
                  { label: '1', odd: jogo.odds_mercado.mandante, impl: jogo.odds_mercado.implM },
                  { label: 'X', odd: jogo.odds_mercado.empate,   impl: jogo.odds_mercado.implE },
                  { label: '2', odd: jogo.odds_mercado.visitante, impl: jogo.odds_mercado.implV },
                  { label: 'O2.5', odd: jogo.odds_mercado.over25, impl: null },
                  { label: 'U2.5', odd: jogo.odds_mercado.under25, impl: null },
                ].filter(o => o.odd).map((o, i) => (
                  <div key={i} style={{
                    background: '#18243a', borderRadius: 6,
                    padding: '6px 10px', textAlign: 'center', minWidth: 52,
                  }}>
                    <div style={{ fontSize: 10, color: '#4a5a78', fontWeight: 600, marginBottom: 2 }}>{o.label}</div>
                    <div style={{ fontFamily: "'Barlow Condensed'", fontSize: 16, fontWeight: 700, color: '#e8eeff' }}>{o.odd}</div>
                    {o.impl && <div style={{ fontSize: 10, color: '#4a5a78' }}>{o.impl}%</div>}
                  </div>
                ))}
              </div>
              {jogo.odds_mercado.melhorEV && (
                <div style={{
                  marginTop: 8, padding: '6px 10px',
                  background: 'rgba(0,230,118,0.08)',
                  border: '1px solid rgba(0,230,118,0.2)',
                  borderRadius: 6, fontSize: 12, color: '#00e676',
                }}>
                  🎯 Value bet detectado: <strong>{jogo.odds_mercado.melhorEV.nome}</strong> @ {jogo.odds_mercado.melhorEV.odd} · EV +{Math.round(jogo.odds_mercado.melhorEV.ev * 100)}%
                </div>
              )}
            </div>
          )}

          {/* ✅ NOVO — Cartões/Escanteios (histórico real) + árbitro + clima */}
          {(jogo.mercado_cartoes_escanteios || jogo.arbitro || jogo.clima) && (
            <div style={{
              background: '#080d18',
              borderRadius: 8,
              padding: '10px 12px',
              marginBottom: 10,
            }}>
              <div style={styles.formTitle}>Contexto</div>

              {jogo.mercado_cartoes_escanteios?.cartoesLinhas?.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 10, color: '#ffd60a', fontWeight: 700, letterSpacing: 0.5, marginBottom: 4 }}>🟨 Cartões</div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {jogo.mercado_cartoes_escanteios.cartoesLinhas.map((l, i) => (
                      <div key={`c${i}`} style={{ background: '#18243a', borderRadius: 6, padding: '6px 10px', textAlign: 'center', minWidth: 64 }}>
                        <div style={{ fontSize: 10, color: '#4a5a78', fontWeight: 600 }}>{l.linha}</div>
                        <div style={{ fontFamily: "'Barlow Condensed'", fontSize: 15, fontWeight: 700, color: '#e8eeff' }}>O {l.overPct}%</div>
                        <div style={{ fontFamily: "'Barlow Condensed'", fontSize: 11, fontWeight: 600, color: '#6b7a99' }}>U {l.underPct}%</div>
                      </div>
                    ))}
                  </div>
                  {jogo.arbitro?.nome && (
                    <div style={{ fontSize: 11, color: '#8a9bb8', marginTop: 4 }}>🧑‍⚖️ Árbitro: {jogo.arbitro.nome}{jogo.arbitro.mediaCartoesPorJogo != null ? ` · média ${jogo.arbitro.mediaCartoesPorJogo} cartões/jogo` : ''}{jogo.arbitro.sazonal?.mediaPenaltisPorJogo != null ? ` · ${jogo.arbitro.sazonal.mediaPenaltisPorJogo} pênaltis/jogo nesta liga` : ''}{jogo.arbitro.sazonal?.pctVitoriaMandante != null ? ` · mandante vence ${jogo.arbitro.sazonal.pctVitoriaMandante}% sob ele` : ''}</div>
                  )}
                </div>
              )}

              {jogo.mercado_cartoes_escanteios?.escanteiosLinhas?.length > 0 && (
                <div style={{ marginBottom: 6 }}>
                  <div style={{ fontSize: 10, color: '#00b4d8', fontWeight: 700, letterSpacing: 0.5, marginBottom: 4 }}>🚩 Escanteios</div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {jogo.mercado_cartoes_escanteios.escanteiosLinhas.map((l, i) => (
                      <div key={`e${i}`} style={{ background: '#18243a', borderRadius: 6, padding: '6px 10px', textAlign: 'center', minWidth: 64 }}>
                        <div style={{ fontSize: 10, color: '#4a5a78', fontWeight: 600 }}>{l.linha}</div>
                        <div style={{ fontFamily: "'Barlow Condensed'", fontSize: 15, fontWeight: 700, color: '#e8eeff' }}>O {l.overPct}%</div>
                        <div style={{ fontFamily: "'Barlow Condensed'", fontSize: 11, fontWeight: 600, color: '#6b7a99' }}>U {l.underPct}%</div>
                      </div>
                    ))}
                  </div>
                  {jogo.clima && (
                    <div style={{ fontSize: 11, color: '#8a9bb8', marginTop: 4 }}>🌦️ {jogo.clima.estadio}: {jogo.clima.temperaturaC ?? '—'}°C · {jogo.clima.probabilidadeChuva ?? '—'}% chuva · vento {jogo.clima.ventoKmh ?? '—'}km/h{jogo.clima.altitudeM != null ? ` · altitude ${jogo.clima.altitudeM}m (${jogo.clima.altitudeClasse})` : ''}</div>
                  )}
                </div>
              )}

              {jogo.mercado_cartoes_escanteios && !jogo.mercado_cartoes_escanteios.amostraSuficiente && (
                <div style={{ fontSize: 10, color: '#f5a623' }}>⚠️ amostra pequena</div>
              )}

              {!jogo.mercado_cartoes_escanteios && (jogo.arbitro || jogo.clima) && (
                <div style={{ fontSize: 11, color: '#8a9bb8', lineHeight: 1.5 }}>
                  {jogo.arbitro?.nome && (
                    <div>🧑‍⚖️ Árbitro: {jogo.arbitro.nome}{jogo.arbitro.mediaCartoesPorJogo != null ? ` · média ${jogo.arbitro.mediaCartoesPorJogo} cartões/jogo` : ''}{jogo.arbitro.sazonal?.mediaPenaltisPorJogo != null ? ` · ${jogo.arbitro.sazonal.mediaPenaltisPorJogo} pênaltis/jogo nesta liga` : ''}{jogo.arbitro.sazonal?.pctVitoriaMandante != null ? ` · mandante vence ${jogo.arbitro.sazonal.pctVitoriaMandante}% sob ele` : ''}</div>
                  )}
                  {jogo.clima && (
                    <div>🌦️ {jogo.clima.estadio}: {jogo.clima.temperaturaC ?? '—'}°C · {jogo.clima.probabilidadeChuva ?? '—'}% chuva · vento {jogo.clima.ventoKmh ?? '—'}km/h{jogo.clima.altitudeM != null ? ` · altitude ${jogo.clima.altitudeM}m (${jogo.clima.altitudeClasse})` : ''}</div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ✅ NOVO — Confronto direto (H2H) completo: mando, sequência, tendência */}
          {jogo.h2h && !jogo.h2h.semDados && jogo.h2h.totalJogos > 0 && (
            <div style={{
              background: '#080d18',
              borderRadius: 8,
              padding: '10px 12px',
              marginBottom: 10,
            }}>
              <div style={styles.formTitle}>
                Confronto Direto (H2H) · últimos {jogo.h2h.totalJogos}
              </div>

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                <div style={{ background: '#18243a', borderRadius: 6, padding: '6px 10px', textAlign: 'center', minWidth: 56 }}>
                  <div style={{ fontSize: 10, color: '#4a5a78', fontWeight: 600 }}>Vitórias {jogo.mandante?.split(' ')[0]}</div>
                  <div style={{ fontFamily: "'Barlow Condensed'", fontSize: 16, fontWeight: 700, color: '#00e676' }}>{jogo.h2h.probMH2H}%</div>
                </div>
                <div style={{ background: '#18243a', borderRadius: 6, padding: '6px 10px', textAlign: 'center', minWidth: 56 }}>
                  <div style={{ fontSize: 10, color: '#4a5a78', fontWeight: 600 }}>Empates</div>
                  <div style={{ fontFamily: "'Barlow Condensed'", fontSize: 16, fontWeight: 700, color: '#ffd60a' }}>{jogo.h2h.probEH2H}%</div>
                </div>
                <div style={{ background: '#18243a', borderRadius: 6, padding: '6px 10px', textAlign: 'center', minWidth: 56 }}>
                  <div style={{ fontSize: 10, color: '#4a5a78', fontWeight: 600 }}>Vitórias {jogo.visitante?.split(' ')[0]}</div>
                  <div style={{ fontFamily: "'Barlow Condensed'", fontSize: 16, fontWeight: 700, color: '#ff5252' }}>{jogo.h2h.probVH2H}%</div>
                </div>
                <div style={{ background: '#18243a', borderRadius: 6, padding: '6px 10px', textAlign: 'center', minWidth: 56 }}>
                  <div style={{ fontSize: 10, color: '#4a5a78', fontWeight: 600 }}>Média gols</div>
                  <div style={{ fontFamily: "'Barlow Condensed'", fontSize: 16, fontWeight: 700, color: '#e8eeff' }}>{jogo.h2h.mediaGolsTotais}</div>
                </div>
              </div>

              {/* ✅ NOVO — pizza do retrospecto V/E/D */}
              <div style={{ marginBottom: 10 }}>
                <PieChart size={90} thickness={14} data={[
                  { label: `Vitória ${jogo.mandante?.split(' ')[0]}`, value: jogo.h2h.vitoriasMandante,  color: '#00e676' },
                  { label: 'Empate',                                   value: jogo.h2h.empates,           color: '#ffd60a' },
                  { label: `Vitória ${jogo.visitante?.split(' ')[0]}`, value: jogo.h2h.vitoriasVisitante, color: '#ff5252' },
                ]} />
              </div>

              {/* ✅ NOVO — barra de gols marcados: quando jogou em casa vs quando jogou fora */}
              {(jogo.h2h.quandoMandanteJogaEmCasa || jogo.h2h.quandoMandanteJogaFora) && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 10, color: '#4a5a78', fontWeight: 600, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                    Gols marcados por {jogo.mandante?.split(' ')[0]} neste confronto — em casa vs fora
                  </div>
                  <BarChart height={100} data={[
                    { label: 'Em casa', value: jogo.h2h.quandoMandanteJogaEmCasa?.mediaGolsMarcados ?? 0, color: '#00b4d8' },
                    { label: 'Fora',    value: jogo.h2h.quandoMandanteJogaFora?.mediaGolsMarcados    ?? 0, color: '#a064ff' },
                  ]} />
                </div>
              )}

              {(jogo.h2h.quandoMandanteJogaEmCasa || jogo.h2h.quandoMandanteJogaFora) && (
                <div style={styles.formsRow}>
                  {jogo.h2h.quandoMandanteJogaEmCasa && (
                    <div style={styles.formBox}>
                      <div style={styles.formTitle}>Quando {jogo.mandante} jogou EM CASA vs {jogo.visitante}</div>
                      <div style={{ fontSize: 12, color: '#9aaac4' }}>
                        {jogo.h2h.quandoMandanteJogaEmCasa.vitorias}V {jogo.h2h.quandoMandanteJogaEmCasa.empates}E {jogo.h2h.quandoMandanteJogaEmCasa.derrotas}D
                        {' '}em {jogo.h2h.quandoMandanteJogaEmCasa.jogos} jogo{jogo.h2h.quandoMandanteJogaEmCasa.jogos === 1 ? '' : 's'}
                        {' '}· {jogo.h2h.quandoMandanteJogaEmCasa.mediaGolsMarcados} gols marcados / {jogo.h2h.quandoMandanteJogaEmCasa.mediaGolsSofridos} sofridos
                      </div>
                    </div>
                  )}
                  {jogo.h2h.quandoMandanteJogaFora && (
                    <div style={styles.formBox}>
                      <div style={styles.formTitle}>Quando {jogo.mandante} jogou FORA vs {jogo.visitante}</div>
                      <div style={{ fontSize: 12, color: '#9aaac4' }}>
                        {jogo.h2h.quandoMandanteJogaFora.vitorias}V {jogo.h2h.quandoMandanteJogaFora.empates}E {jogo.h2h.quandoMandanteJogaFora.derrotas}D
                        {' '}em {jogo.h2h.quandoMandanteJogaFora.jogos} jogo{jogo.h2h.quandoMandanteJogaFora.jogos === 1 ? '' : 's'}
                        {' '}· {jogo.h2h.quandoMandanteJogaFora.mediaGolsMarcados} gols marcados / {jogo.h2h.quandoMandanteJogaFora.mediaGolsSofridos} sofridos
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div style={{ fontSize: 11, color: '#8a9bb8', lineHeight: 1.6 }}>
                {jogo.h2h.sequenciaAtual && (
                  <div>
                    🔁 Sequência atual: {jogo.h2h.sequenciaAtual.tamanho}x seguido(s) {
                      jogo.h2h.sequenciaAtual.resultado === 'M' ? `vitória de ${jogo.mandante}`
                        : jogo.h2h.sequenciaAtual.resultado === 'V' ? `vitória de ${jogo.visitante}`
                        : 'empate'
                    }
                  </div>
                )}
                {jogo.h2h.tendenciaGols && (
                  <div>
                    📈 Tendência de gols no confronto: {
                      jogo.h2h.tendenciaGols === 'subindo' ? 'subindo (jogos recentes mais movimentados)'
                        : jogo.h2h.tendenciaGols === 'caindo' ? 'caindo (jogos recentes mais fechados)'
                        : 'estável'
                    }
                  </div>
                )}
                {jogo.h2h.pctDecididoPorUmGol != null && (
                  <div>⚖️ {jogo.h2h.pctDecididoPorUmGol}% dos confrontos foram decididos por apenas 1 gol de diferença</div>
                )}
                <div>
                  ⚽ BTTS {jogo.h2h.bttsRateH2H ?? '—'}% · Over 1.5 {jogo.h2h.over15RateH2H ?? '—'}% · Over 2.5 {jogo.h2h.over25RateH2H ?? '—'}%
                  {jogo.h2h.over35RateH2H != null ? ` · Over 3.5 ${jogo.h2h.over35RateH2H}%` : ''}
                </div>
              </div>
            </div>
          )}

          {/* ✅ NOVO — Alertas da camada de IA (validação qualitativa) */}
          {jogo.analise_ia?.alertas?.length > 0 && (
            <div style={{
              marginBottom: 10, padding: '6px 10px',
              background: jogo.analise_ia.nivel_risco === 'alto' ? 'rgba(255,82,82,0.08)' : 'rgba(245,166,35,0.08)',
              border: `1px solid ${jogo.analise_ia.nivel_risco === 'alto' ? 'rgba(255,82,82,0.25)' : 'rgba(245,166,35,0.25)'}`,
              borderRadius: 6, fontSize: 12, color: jogo.analise_ia.nivel_risco === 'alto' ? '#ff5252' : '#f5a623',
            }}>
              ⚠️ IA — risco {jogo.analise_ia.nivel_risco}: {jogo.analise_ia.alertas.join(' · ')}
            </div>
          )}

          {/* Justificativa */}
          <div style={styles.justBox}>
            <span style={{ fontWeight: 600, color: '#00e676', marginRight: 6 }}>📊</span>
            {jogo.justificativa}
          </div>
        </div>
      )}
    </div>
  )
}
