// LoadingScreen.jsx — Tela de carregamento animada
import React, { useEffect, useState } from 'react'

const steps = [
  { icon: '🔍', text: 'Conectando à Groq com Web Search...' },
  { icon: '🌐', text: 'Varrendo a internet pelos jogos de hoje...' },
  { icon: '📊', text: 'Buscando histórico dos últimos 5 jogos...' },
  { icon: '🧮', text: 'Calculando Score de Assertividade...' },
  { icon: '🎯', text: 'Filtrando as melhores oportunidades...' },
]

export default function LoadingScreen() {
  const [step, setStep] = useState(0)
  const [dots, setDots] = useState('')

  useEffect(() => {
    const t1 = setInterval(() => {
      setStep(s => (s + 1) % steps.length)
    }, 2200)
    const t2 = setInterval(() => {
      setDots(d => d.length >= 3 ? '' : d + '.')
    }, 400)
    return () => { clearInterval(t1); clearInterval(t2) }
  }, [])

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '60px 20px',
      gap: 32,
    }}>
      {/* Campo animado */}
      <div style={{ position: 'relative', width: 80, height: 80 }}>
        <div style={{
          width: 80, height: 80,
          borderRadius: '50%',
          border: '3px solid rgba(0,230,118,0.15)',
          borderTopColor: '#00e676',
          animation: 'spin 1s linear infinite',
        }} />
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 28,
        }}>
          ⚽
        </div>
      </div>

      {/* Steps */}
      <div style={{
        background: '#0f1724',
        border: '1px solid rgba(255,255,255,0.07)',
        borderRadius: 12,
        padding: '16px 24px',
        minWidth: 300,
        textAlign: 'center',
      }}>
        <div style={{ fontSize: 22, marginBottom: 8 }}>{steps[step].icon}</div>
        <div style={{
          fontFamily: "'Barlow Condensed'",
          fontSize: 16,
          fontWeight: 600,
          color: '#9aaac4',
          letterSpacing: 0.3,
        }}>
          {steps[step].text}{dots}
        </div>
      </div>

      {/* Progress dots */}
      <div style={{ display: 'flex', gap: 6 }}>
        {steps.map((_, i) => (
          <div key={i} style={{
            width: i === step ? 24 : 6,
            height: 6,
            borderRadius: 3,
            background: i === step ? '#00e676' : 'rgba(255,255,255,0.1)',
            transition: 'all 0.3s ease',
          }} />
        ))}
      </div>

      <p style={{ color: '#4a5a78', fontSize: 12, fontWeight: 600, letterSpacing: 1 }}>
        GROQ LPU — ANÁLISE EM TEMPO REAL
      </p>

      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  )
}
