import { useState } from "react"

const IS_PROD  = typeof window !== 'undefined' && window.location.hostname !== 'localhost'
const API_BASE = IS_PROD ? '' : 'http://localhost:3001'

export default function LoginScreen({ onLogin, onBack, adminOnly = false }) {
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
      minHeight: "100vh", background: "#080d18",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: "'Barlow', sans-serif", padding: 20,
    }}>
      {/* Background glow */}
      <div style={{
        position: "fixed", top: "30%", left: "50%", transform: "translate(-50%,-50%)",
        width: 500, height: 500, borderRadius: "50%",
        background: "radial-gradient(circle, rgba(0,230,118,0.04) 0%, transparent 70%)",
        pointerEvents: "none",
      }} />

      <div style={{
        width: "100%", maxWidth: 400,
        background: "#0c1422", border: "1px solid rgba(255,255,255,0.07)",
        borderRadius: 20, padding: "clamp(28px, 8vw, 40px) clamp(20px, 6vw, 36px)",
        boxShadow: "0 24px 80px rgba(0,0,0,0.5), 0 0 0 1px rgba(0,230,118,0.05)",
        position: "relative",
      }}>
        {/* Logo */}
        <div style={{ textAlign: "center", marginBottom: 36 }}>
          <div style={{
            fontFamily: "'Barlow Condensed', sans-serif",
            fontSize: 'clamp(22px, 7vw, 28px)', fontWeight: 900, letterSpacing: 2, marginBottom: 8,
          }}>
            FOOTBALL<span style={{ color: "#00e676" }}>SCOUT</span>
            <span style={{ color: "#4a5a78", fontWeight: 400 }}> IA</span>
          </div>
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            background: "rgba(0,230,118,0.08)", border: "1px solid rgba(0,230,118,0.2)",
            borderRadius: 20, padding: "4px 14px",
            fontSize: 11, fontWeight: 700, color: "#00e676",
            letterSpacing: 2, fontFamily: "'Barlow Condensed', sans-serif",
          }}>
            🔐 ACESSO RESTRITO
          </div>
        </div>

        {/* Campos */}
        <div style={{ marginBottom: 14 }}>
          <label style={{
            fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: "#4a5a78",
            textTransform: "uppercase", display: "block", marginBottom: 6,
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
              background: "#080d18", border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 10, padding: "12px 14px",
              color: "#e8eeff", fontSize: 14, outline: "none",
              fontFamily: "'Barlow', sans-serif",
              transition: "border-color 0.2s",
            }}
            onFocus={e => e.target.style.borderColor = "rgba(0,230,118,0.4)"}
            onBlur={e  => e.target.style.borderColor = "rgba(255,255,255,0.08)"}
          />
        </div>

        <div style={{ marginBottom: 24 }}>
          <label style={{
            fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: "#4a5a78",
            textTransform: "uppercase", display: "block", marginBottom: 6,
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
                background: "#080d18", border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 10, padding: "12px 42px 12px 14px",
                color: "#e8eeff", fontSize: 14, outline: "none",
                fontFamily: "'Barlow', sans-serif",
                transition: "border-color 0.2s",
              }}
              onFocus={e => e.target.style.borderColor = "rgba(0,230,118,0.4)"}
              onBlur={e  => e.target.style.borderColor = "rgba(255,255,255,0.08)"}
            />
            <button
              onClick={() => setShowPass(v => !v)}
              style={{
                position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)",
                background: "none", border: "none", cursor: "pointer",
                color: "#4a5a78", fontSize: 16, padding: 4,
              }}
            >{showPass ? "🙈" : "👁️"}</button>
          </div>
        </div>

        {/* Erro */}
        {erro && (
          <div style={{
            background: "rgba(255,71,87,0.08)", border: "1px solid rgba(255,71,87,0.25)",
            borderRadius: 8, padding: "10px 14px", fontSize: 12, color: "#ff4757",
            marginBottom: 16, textAlign: "center",
          }}>
            ❌ {erro}
          </div>
        )}

        {/* Botão entrar */}
        <button
          onClick={handleLogin}
          disabled={loading}
          style={{
            width: "100%", border: "none", borderRadius: 10,
            padding: "14px", cursor: loading ? "not-allowed" : "pointer",
            background: loading ? "rgba(0,230,118,0.3)" : "linear-gradient(135deg, #00e676, #00c853)",
            color: "#080d18", fontFamily: "'Barlow Condensed', sans-serif",
            fontSize: 16, fontWeight: 900, letterSpacing: 2, textTransform: "uppercase",
            transition: "opacity 0.2s, transform 0.15s",
            transform: loading ? "none" : undefined,
            opacity: loading ? 0.7 : 1,
          }}
          onMouseEnter={e => { if (!loading) e.target.style.transform = "translateY(-1px)" }}
          onMouseLeave={e => { e.target.style.transform = "none" }}
        >
          {loading ? "⏳ Entrando..." : "🔑 Entrar"}
        </button>

        {onBack && (
            <button
              onClick={onBack}
              style={{
                width: "100%", marginTop: 12, background: "none",
                border: "1px solid rgba(255,255,255,0.07)", borderRadius: 10,
                padding: "11px", cursor: "pointer", color: "#4a5a78",
                fontFamily: "'Barlow Condensed', sans-serif",
                fontSize: 14, fontWeight: 700, letterSpacing: 1,
                transition: "all 0.2s",
              }}
              onMouseEnter={e => { e.target.style.borderColor = "rgba(255,255,255,0.15)"; e.target.style.color = "#6b7a99" }}
              onMouseLeave={e => { e.target.style.borderColor = "rgba(255,255,255,0.07)"; e.target.style.color = "#4a5a78" }}
            >
              ← Voltar sem login
            </button>
          )}

        {/* Info */}
        {!adminOnly && (
          <div style={{
            marginTop: 24, padding: "12px 14px",
            background: "rgba(0,180,216,0.05)", border: "1px solid rgba(0,180,216,0.12)",
            borderRadius: 8, fontSize: 11, color: "#4a6a7a", lineHeight: 1.6,
            textAlign: "center",
          }}>
            Apenas administradores podem marcar greens/reds e gerenciar acessos.
            Visitantes podem visualizar os jogos normalmente.
          </div>
        )}

        {/* Botão voltar — só aparece se onBack foi passado */}
      </div>
    </div>
  )
}