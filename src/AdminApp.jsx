import { useState, useEffect } from 'react'
import AdminPanel  from './admin/AdminPanel'
import LoginScreen from './admin/LoginScreen'

const IS_PROD  = typeof window !== 'undefined' && window.location.hostname !== 'localhost'
const API_BASE = IS_PROD ? '' : 'http://localhost:3001'

export default function AdminApp() {
  const [token,    setToken]    = useState(localStorage.getItem('admin_token') || null)
  const [username, setUsername] = useState(localStorage.getItem('admin_user')  || null)
  const [checking, setChecking] = useState(true)

  // Valida o token salvo ao carregar
  useEffect(() => {
    if (!token) { setChecking(false); return }
    fetch(`${API_BASE}/api/me`, { headers: { 'x-auth-token': token } })
      .then(r => r.json())
      .then(data => {
        if (!data.role || data.role !== 'admin') logout()
        else setChecking(false)
      })
      .catch(() => { logout(); })
  }, [])

  const login = (tok, role, user) => {
    if (role !== 'admin') {
      alert('Acesso negado. Apenas administradores podem acessar este painel.')
      return
    }
    localStorage.setItem('admin_token', tok)
    localStorage.setItem('admin_user',  user)
    setToken(tok)
    setUsername(user)
  }

  const logout = () => {
    localStorage.removeItem('admin_token')
    localStorage.removeItem('admin_user')
    setToken(null)
    setUsername(null)
    setChecking(false)
  }

  if (checking) return (
    <div style={{ minHeight: '100vh', background: '#080d18', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#4a5a78', fontFamily: "'Barlow', sans-serif", fontSize: 14 }}>
      ⏳ Verificando sessão...
    </div>
  )

  if (!token) return (
    <LoginScreen
      onLogin={login}
      onBack={null}   // sem botão "voltar" no painel admin
      adminOnly       // passa prop para esconder o aviso de "visitantes podem ver"
    />
  )

  return (
    <AdminPanel
      token={token}
      username={username}
      onLogout={logout}
      onNavegar={(tela) => window.open(`/?tela=${tela}`, '_blank')}
    />
  )
}