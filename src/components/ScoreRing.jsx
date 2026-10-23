// ScoreRing.jsx — Anel circular do Score de Assertividade
import React from 'react'

export default function ScoreRing({ score }) {
  const r = 28
  const circ = 2 * Math.PI * r
  const fill = (score / 100) * circ

  const color =
    score >= 75 ? '#00e676' :
    score >= 60 ? '#ffd60a' :
    '#ff5252'

  return (
    <div style={{ position: 'relative', width: 72, height: 72, flexShrink: 0 }}>
      <svg width="72" height="72" style={{ transform: 'rotate(-90deg)' }}>
        <circle cx="36" cy="36" r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="5" />
        <circle
          cx="36" cy="36" r={r}
          fill="none"
          stroke={color}
          strokeWidth="5"
          strokeDasharray={`${fill} ${circ}`}
          strokeLinecap="round"
          style={{ transition: 'stroke-dasharray 0.8s ease' }}
        />
      </svg>
      <div style={{
        position: 'absolute', inset: 0,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center'
      }}>
        <span style={{ fontFamily: "'Barlow Condensed'", fontWeight: 900, fontSize: 18, color, lineHeight: 1 }}>
          {score}
        </span>
        <span style={{ fontSize: 9, color: '#4a5a78', fontWeight: 600, letterSpacing: 1 }}>SCORE</span>
      </div>
    </div>
  )
}
