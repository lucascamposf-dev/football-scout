// MiniCharts.jsx — gráficos leves em SVG puro (sem dependências externas,
// então não precisa rodar `npm install` de nada novo pra usar isso).
import React from 'react'

// ─── Gráfico de pizza/rosca ──────────────────────────────────
// data: [{ label, value, color }]
export function PieChart({ data, size = 120, thickness = 18, showLegend = true }) {
  const total = data.reduce((s, d) => s + (d.value || 0), 0)
  if (!total) {
    return <div style={{ fontSize: 12, color: '#4a5a78', textAlign: 'center', padding: 16 }}>Sem dados ainda</div>
  }

  const radius = size / 2
  const innerRadius = radius - thickness
  const cx = radius, cy = radius

  let acumulado = 0
  const fatias = data.filter(d => d.value > 0).map((d, i) => {
    const fracao = d.value / total
    const inicio = acumulado
    acumulado += fracao
    const fim = acumulado

    const angInicio = inicio * 2 * Math.PI - Math.PI / 2
    const angFim    = fim    * 2 * Math.PI - Math.PI / 2

    const x1  = cx + radius * Math.cos(angInicio)
    const y1  = cy + radius * Math.sin(angInicio)
    const x2  = cx + radius * Math.cos(angFim)
    const y2  = cy + radius * Math.sin(angFim)
    const x1i = cx + innerRadius * Math.cos(angInicio)
    const y1i = cy + innerRadius * Math.sin(angInicio)
    const x2i = cx + innerRadius * Math.cos(angFim)
    const y2i = cy + innerRadius * Math.sin(angFim)

    const largeArc = fracao > 0.5 ? 1 : 0

    const path = [
      `M ${x1} ${y1}`,
      `A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2}`,
      `L ${x2i} ${y2i}`,
      `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${x1i} ${y1i}`,
      'Z',
    ].join(' ')

    return <path key={i} d={path} fill={d.color} stroke="#0f1724" strokeWidth={1} />
  })

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {fatias}
      </svg>
      {showLegend && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {data.filter(d => d.value > 0).map((d, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#9aaac4' }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: d.color, display: 'inline-block' }} />
              {d.label}: <strong style={{ color: '#e8eeff' }}>{d.value}</strong>
              {' '}({Math.round((d.value / total) * 100)}%)
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Gráfico de barras verticais ─────────────────────────────
// data: [{ label, value, color }]
export function BarChart({ data, height = 130, maxValue = null }) {
  if (!data?.length) return null
  const max = maxValue ?? Math.max(1, ...data.map(d => d.value || 0))

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, height, padding: '4px 2px' }}>
      {data.map((d, i) => {
        const h = Math.max(2, (d.value / max) * (height - 28))
        return (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1, minWidth: 30 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: d.color, marginBottom: 3 }}>{d.value}</div>
            <div style={{
              width: '100%', maxWidth: 34, height: h,
              background: d.color, borderRadius: '4px 4px 0 0',
              transition: 'height 0.3s ease',
            }} />
            <div style={{
              fontSize: 10, color: '#6b7a99', marginTop: 6, textAlign: 'center',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 60,
            }}>{d.label}</div>
          </div>
        )
      })}
    </div>
  )
}

// ─── Barra horizontal (melhor pra rótulos longos ou % de 0-100) ─────
// data: [{ label, value, color }]
export function HBarChart({ data, maxValue = null }) {
  if (!data?.length) return null
  const max = maxValue ?? Math.max(1, ...data.map(d => d.value || 0))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {data.map((d, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 100, fontSize: 11, color: '#9aaac4', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 0 }}>{d.label}</div>
          <div style={{ flex: 1, height: 10, background: 'rgba(255,255,255,0.05)', borderRadius: 5, overflow: 'hidden' }}>
            <div style={{ width: `${Math.max(2, (d.value / max) * 100)}%`, height: '100%', background: d.color, borderRadius: 5, transition: 'width 0.3s ease' }} />
          </div>
          <div style={{ width: 36, fontSize: 11, fontWeight: 700, color: d.color, textAlign: 'right', flexShrink: 0 }}>{d.value}</div>
        </div>
      ))}
    </div>
  )
}