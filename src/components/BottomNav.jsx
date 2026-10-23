// src/components/BottomNav.jsx
// Barra de navegação fixa na parte de baixo — só aparece no celular (≤640px).
// No desktop ela fica escondida pelo CSS (global.css) e nada muda.
// ─────────────────────────────────────────────────────────────

import React, { useEffect, useState } from 'react'

const ITENS = [
  { id: 'analise', icon: '⚽', label: 'Análise', cor: '#00e676' },
  { id: 'aovivo',  icon: '🔴', label: 'Ao Vivo', cor: '#ff3b3b' },
  { id: 'odds',    icon: '💰', label: 'Odds',    cor: '#ffd60a' },
  { id: 'tracker', icon: '📊', label: 'Tracker', cor: '#00b4d8' },
]

export default function BottomNav({ modulo, onNavegar, userRole, username, onLogout }) {
  const [menuAberto, setMenuAberto] = useState(false)

  // marca o <body> pra reservar espaço embaixo (evita a barra cobrir o conteúdo)
  useEffect(() => {
    document.body.classList.add('has-bnav')
    return () => document.body.classList.remove('has-bnav')
  }, [])

  const irPara = (id) => {
    setMenuAberto(false)
    if (id !== modulo) onNavegar(id)
    window.scrollTo({ top: 0, behavior: id === modulo ? 'smooth' : 'auto' })
  }

  return (
    <>
      <nav className="bnav" aria-label="Navegação principal">
        {ITENS.map(it => (
          <button
            key={it.id}
            type="button"
            className={modulo === it.id && !menuAberto ? 'ativo' : ''}
            style={{ '--c': it.cor }}
            aria-current={modulo === it.id ? 'page' : undefined}
            onClick={() => irPara(it.id)}
          >
            <span className="bnav-ico">{it.icon}</span>
            <span>{it.label}</span>
          </button>
        ))}
        <button
          type="button"
          className={menuAberto ? 'ativo' : ''}
          style={{ '--c': '#a064ff' }}
          aria-expanded={menuAberto}
          onClick={() => setMenuAberto(v => !v)}
        >
          <span className="bnav-ico">☰</span>
          <span>Menu</span>
        </button>
      </nav>

      {menuAberto && (
        <div className="bnav-overlay" onClick={() => setMenuAberto(false)}>
          <div className="bnav-sheet" onClick={e => e.stopPropagation()}>
            <div className="bnav-grip" />
            {username && <div className="bnav-user">👤 {username}</div>}

            {userRole === 'admin' && (
              <button
                type="button"
                className="bnav-item"
                onClick={() => { window.location.href = '/admin' }}
              >
                ⚙️ Painel Admin
              </button>
            )}

            <button
              type="button"
              className="bnav-item bnav-sair"
              onClick={() => { setMenuAberto(false); onLogout() }}
            >
              🚪 Sair
            </button>
          </div>
        </div>
      )}
    </>
  )
}