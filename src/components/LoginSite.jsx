import { useState } from "react"

const IS_PROD  = typeof window !== 'undefined' && window.location.hostname !== 'localhost'
const API_BASE = IS_PROD ? '' : 'http://localhost:3001'

export default function LoginSite({ onLogin }) {
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [erro,     setErro]     = useState("")
  const [loading,  setLoading]  = useState(false)
  const [showPass, setShowPass] = useState(false)

  const handleLogin = async () => {
    if (!username.trim() || !password.trim()) {
      setErro("Preencha usuário e senha.")
      return
    }
    setLoading(true)
    setErro("")
    try {
      const res  = await fetch(`${API_BASE}/api/login`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ username: username.trim(), password }),
      })
      const data = await res.json()
      if (!res.ok) { setErro(data.error || "Credenciais inválidas."); return }
      onLogin(data.token, data.role, data.username)
    } catch {
      setErro("Erro ao conectar com o servidor.")
    } finally {
      setLoading(false)
    }
  }

  const handleKey = e => { if (e.key === "Enter") handleLogin() }

  return (
    <div style={{
      minHeight: "100vh",
      background: "#080d18",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: "'Barlow', sans-serif",
      padding: 20,
    }}>
      {/* Glow de fundo */}
      <div style={{
        position: "fixed", top: "30%", left: "50%",
        transform: "translate(-50%,-50%)",
        width: 600, height: 600, borderRadius: "50%",
        background: "radial-gradient(circle, rgba(0,180,216,0.05) 0%, transparent 70%)",
        pointerEvents: "none",
      }} />

      <div style={{
        width: "100%", maxWidth: 420,
        background: "#0c1422",
        border: "1px solid rgba(255,255,255,0.07)",
        borderRadius: 24, padding: "clamp(28px, 8vw, 48px) clamp(20px, 6vw, 40px)",
        boxShadow: "0 32px 80px rgba(0,0,0,0.6)",
        position: "relative",
      }}>

        {/* Logo */}
        <div style={{ textAlign: "center", marginBottom: 40 }}>
          <div style={{
            fontFamily: "'Barlow Condensed', sans-serif",
            fontSize: 'clamp(24px, 8vw, 32px)', fontWeight: 900, letterSpacing: 2, marginBottom: 10,
          }}>
            FOOTBALL<span style={{ color: "#00e676" }}>SCOUT</span>
            <span style={{ color: "#4a5a78", fontWeight: 400 }}> IA</span>
          </div>
          <div style={{
            fontSize: 12, color: "#4a5a78", letterSpacing: 1,
            fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 600,
          }}>
            ANÁLISE INTELIGENTE DE JOGOS
          </div>
        </div>

        {/* Usuário */}
        <div style={{ marginBottom: 16 }}>
          <label style={{
            fontSize: 10, fontWeight: 700, letterSpacing: 2,
            color: "#4a5a78", textTransform: "uppercase",
            display: "block", marginBottom: 8,
            fontFamily: "'Barlow Condensed', sans-serif",
          }}>Usuário</label>
          <input
            value={username}
            onChange={e => setUsername(e.target.value)}
            onKeyDown={handleKey}
            placeholder="seu_usuario"
            autoFocus
            style={{
              width: "100%", boxSizing: "border-box",
              background: "#080d18",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 12, padding: "14px 16px",
              color: "#e8eeff", fontSize: 14, outline: "none",
              fontFamily: "'Barlow', sans-serif",
              transition: "border-color 0.2s",
            }}
            onFocus={e => e.target.style.borderColor = "rgba(0,180,216,0.5)"}
            onBlur={e  => e.target.style.borderColor = "rgba(255,255,255,0.08)"}
          />
        </div>

        {/* Senha */}
        <div style={{ marginBottom: 28 }}>
          <label style={{
            fontSize: 10, fontWeight: 700, letterSpacing: 2,
            color: "#4a5a78", textTransform: "uppercase",
            display: "block", marginBottom: 8,
            fontFamily: "'Barlow Condensed', sans-serif",
          }}>Senha</label>
          <div style={{ position: "relative" }}>
            <input
              type={showPass ? "text" : "password"}
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={handleKey}
              placeholder="••••••••"
              style={{
                width: "100%", boxSizing: "border-box",
                background: "#080d18",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 12, padding: "14px 44px 14px 16px",
                color: "#e8eeff", fontSize: 14, outline: "none",
                fontFamily: "'Barlow', sans-serif",
                transition: "border-color 0.2s",
              }}
              onFocus={e => e.target.style.borderColor = "rgba(0,180,216,0.5)"}
              onBlur={e  => e.target.style.borderColor = "rgba(255,255,255,0.08)"}
            />
            <button onClick={() => setShowPass(v => !v)} style={{
              position: "absolute", right: 14, top: "50%",
              transform: "translateY(-50%)",
              background: "none", border: "none",
              cursor: "pointer", color: "#4a5a78", fontSize: 16, padding: 4,
            }}>{showPass ? "🙈" : "👁️"}</button>
          </div>
        </div>

        {/* Erro */}
        {erro && (
          <div style={{
            background: "rgba(255,71,87,0.08)",
            border: "1px solid rgba(255,71,87,0.25)",
            borderRadius: 10, padding: "10px 14px",
            fontSize: 12, color: "#ff4757",
            marginBottom: 20, textAlign: "center",
          }}>
            ❌ {erro}
          </div>
        )}

        {/* Botão */}
        <button
          onClick={handleLogin}
          disabled={loading}
          style={{
            width: "100%", border: "none", borderRadius: 12,
            padding: "15px",
            cursor: loading ? "not-allowed" : "pointer",
            background: loading
              ? "rgba(0,180,216,0.3)"
              : "linear-gradient(135deg, #00b4d8, #0077a8)",
            color: "#fff",
            fontFamily: "'Barlow Condensed', sans-serif",
            fontSize: 17, fontWeight: 900,
            letterSpacing: 2, textTransform: "uppercase",
            transition: "all 0.2s",
            opacity: loading ? 0.7 : 1,
          }}
          onMouseEnter={e => { if (!loading) e.target.style.transform = "translateY(-1px)" }}
          onMouseLeave={e => { e.target.style.transform = "none" }}
        >
          {loading ? "⏳ Entrando..." : "🔑 Entrar"}
        </button>

        {/* Rodapé */}
        <div style={{
          marginTop: 28, textAlign: "center",
          fontSize: 11, color: "#2a3a52", lineHeight: 1.6,
        }}>
          Acesso exclusivo · Entre em contato para obter seu login
        </div>
      </div>
    </div>
  )
}