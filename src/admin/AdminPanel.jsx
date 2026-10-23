import { useState, useEffect, useCallback } from "react"
import { checklistPreDeploy, validacaoOutOfSample, validacaoStackingGols, validacaoStacking1x2 } from '../services/calibrationService.js'

const IS_PROD  = typeof window !== 'undefined' && window.location.hostname !== 'localhost'
const API_BASE = IS_PROD ? '' : 'http://localhost:3001'

// ─── Paleta ────────────────────────────────────────────────
const C = {
  bg:      "#080d18",
  surface: "#0c1422",
  card:    "#0f1a2e",
  border:  "rgba(255,255,255,0.07)",
  green:   "#00e676",
  red:     "#ff4757",
  yellow:  "#ffd60a",
  blue:    "#00b4d8",
  purple:  "#a064ff",
  orange:  "#ff9f43",
  muted:   "#3a4a62",
  text:    "#e8eeff",
  sub:     "#6b7a99",
}

// ─── Componentes base ──────────────────────────────────────
function Badge({ children, color = C.blue }) {
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20,
      color, background: color + "1a", border: `1px solid ${color}40`,
      fontFamily: "'Barlow Condensed', sans-serif", letterSpacing: 1,
      whiteSpace: "nowrap",
    }}>{children}</span>
  )
}

function Btn({ children, onClick, color = C.blue, outline = false, small = false, disabled = false }) {
  const [hov, setHov] = useState(false)
  return (
    <button onClick={onClick} disabled={disabled}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        border: `1px solid ${color}80`, borderRadius: 8,
        padding: small ? "5px 12px" : "9px 18px",
        fontFamily: "'Barlow Condensed', sans-serif",
        fontSize: small ? 12 : 14, fontWeight: 800, letterSpacing: 1.5,
        textTransform: "uppercase", cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.4 : 1, transition: "all 0.15s",
        background: outline ? (hov ? color + "20" : "transparent") : (hov ? color + "dd" : color),
        color: outline ? color : "#080d18",
        transform: hov && !disabled ? "translateY(-1px)" : "none",
      }}>{children}</button>
  )
}

function Input({ value, onChange, placeholder, type = "text" }) {
  return (
    <input type={type} value={value} onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        background: "#080d18", border: `1px solid ${C.border}`,
        borderRadius: 8, padding: "9px 13px", color: C.text,
        fontSize: 13, outline: "none", width: "100%", boxSizing: "border-box",
        fontFamily: "inherit",
      }} />
  )
}

function Select({ value, onChange, options }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      style={{
        background: "#080d18", border: `1px solid ${C.border}`,
        borderRadius: 8, padding: "9px 10px", color: C.text,
        fontSize: 13, outline: "none", width: "100%", fontFamily: "inherit",
      }}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

const labelStyle = {
  fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: C.muted,
  textTransform: "uppercase", display: "block", marginBottom: 5,
  fontFamily: "'Barlow Condensed', sans-serif",
}

// ─── Seção: Status do Sistema ──────────────────────────────
function SecaoStatus({ token }) {
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)

  const carregar = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`${API_BASE}/api/health`)
      setStatus(await res.json())
    } catch { setStatus(null) }
    setLoading(false)
  }, [])

  useEffect(() => { carregar() }, [carregar])

  if (loading) return <div className="ad-header" style={{ textAlign: "center", padding: 48, color: C.muted }}>⏳ Verificando...</div>

  const Item = ({ label, value, ok }) => (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "center",
      padding: "12px 16px", background: C.card, borderRadius: 10,
      border: `1px solid ${C.border}`, marginBottom: 8,
    }}>
      <span style={{ fontSize: 13, color: C.sub, fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, letterSpacing: 1 }}>{label}</span>
      <span style={{
        fontFamily: "'Barlow Condensed', sans-serif", fontSize: 13, fontWeight: 800,
        color: ok === true ? C.green : ok === false ? C.red : C.yellow,
      }}>{value}</span>
    </div>
  )

  if (!status) return (
    <div style={{ textAlign: "center", padding: 48, color: C.red }}>
      ❌ Servidor não responde
    </div>
  )

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <Item label="Servidor" value="✅ Online" ok={true} />
        <Item
          label="Persistência (PostgreSQL)"
          value={status.ok ? "✅ Conectado" : "❌ Falha na conexão"}
          ok={status.ok}
        />
        <Item label="Arquivo tracker" value={status.trackerExists ? "✅ Existe" : "📭 Vazio (sem jogos)"} ok={status.trackerExists} />
        <Item label="Arquivo usuários" value={status.usersExists ? "✅ Existe" : "❌ Não encontrado"} ok={status.usersExists} />
        <Item label="Sessões ativas" value={`${status.activeSessions} sessão(ões)`} ok={null} />
      </div>

      {!status.ok && (
        <div style={{
          background: C.red + "15", border: `1px solid ${C.red}40`,
          borderRadius: 12, padding: 16, marginTop: 12,
        }}>
          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 14, fontWeight: 800, color: C.red, marginBottom: 8 }}>
            ⚠️ POSTGRES NÃO CONECTOU
          </div>
          <div style={{ fontSize: 12, color: C.red + "cc", lineHeight: 1.7 }}>
            Verifique no Railway → Variables se <code style={{ background: "rgba(255,71,87,0.2)", padding: "1px 6px", borderRadius: 4 }}>DATABASE_URL</code> está definida.
          </div>
        </div>
      )}

      <div style={{ marginTop: 16, textAlign: "right" }}>
        <Btn onClick={carregar} color={C.blue} small outline>↻ Atualizar status</Btn>
      </div>
    </div>
  )
}

// ─── Seção: Gerenciar Usuários ─────────────────────────────
function SecaoUsuarios({ token }) {
  const [usuarios, setUsuarios] = useState([])
  const [loading, setLoading]   = useState(true)
  const [erro, setErro]         = useState("")
  const [novoUser, setNovoUser] = useState("")
  const [novaPass, setNovaPass] = useState("")
  const [novoRole, setNovoRole] = useState("user")
  const [criando, setCriando]   = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [editandoSenha, setEditandoSenha] = useState(null)
  const [novaSenhaEdit, setNovaSenhaEdit] = useState("")
  const [usuarioCriado, setUsuarioCriado] = useState(null)
  const [copiado,       setCopiado]       = useState(false)

  const carregar = useCallback(async () => {
    setLoading(true)
    try {
      const res  = await fetch(`${API_BASE}/api/users`, { headers: { "x-auth-token": token } })
      const data = await res.json()
      setUsuarios(Array.isArray(data) ? data : [])
    } catch { setErro("Erro ao carregar usuários.") }
    finally { setLoading(false) }
  }, [token])

  useEffect(() => { carregar() }, [carregar])

  const criarUsuario = async () => {
    if (!novoUser.trim() || !novaPass.trim()) { setErro("Preencha usuário e senha"); return }
    setCriando(true); setErro("")
    try {
      const res  = await fetch(`${API_BASE}/api/users`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-auth-token": token },
        body: JSON.stringify({ username: novoUser.trim(), password: novaPass.trim(), role: novoRole }),
      })
      const data = await res.json()
      if (!res.ok) { setErro(data.error || "Erro ao criar usuário."); return }
      const siteUrl = window.location.origin
      setUsuarioCriado({ username: novoUser.trim(), password: novaPass.trim(), url: siteUrl })
      setNovoUser(""); setNovaPass(""); setNovoRole("user"); setShowForm(false)
      await carregar()
    } catch { setErro("Erro de conexão.") }
    finally { setCriando(false) }
  }

  const removerUsuario = async (username) => {
    if (!confirm(`Remover "${username}"?`)) return
    try {
      const res = await fetch(`${API_BASE}/api/users/${username}`, {
        method: "DELETE", headers: { "x-auth-token": token },
      })
      if (!res.ok) { const d = await res.json(); setErro(d.error); return }
      await carregar()
    } catch { setErro("Erro ao remover.") }
  }

  const alterarSenha = async (username) => {
    if (!novaSenhaEdit.trim()) { setErro("Nova senha obrigatória"); return }
    try {
      const res = await fetch(`${API_BASE}/api/users/${username}/password`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-auth-token": token },
        body: JSON.stringify({ password: novaSenhaEdit.trim() }),
      })
      if (!res.ok) { const d = await res.json(); setErro(d.error); return }
      setEditandoSenha(null); setNovaSenhaEdit(""); setErro("")
      alert(`Senha de "${username}" alterada com sucesso!`)
    } catch { setErro("Erro ao alterar senha.") }
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
        <div style={{ fontSize: 13, color: C.sub }}>{usuarios.length} usuário(s) cadastrado(s)</div>
        <Btn onClick={() => { setShowForm(v => !v); setErro("") }} color={C.green} small>
          {showForm ? "✕ Cancelar" : "+ Novo usuário"}
        </Btn>
      </div>

      {showForm && (
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 18, marginBottom: 18 }}>
          <div style={{ display: "flex", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 140 }}>
              <label style={labelStyle}>Usuário</label>
              <Input value={novoUser} onChange={setNovoUser} placeholder="nome_usuario" />
            </div>
            <div style={{ flex: 1, minWidth: 140 }}>
              <label style={labelStyle}>Senha</label>
              <Input value={novaPass} onChange={setNovaPass} placeholder="senha123" type="password" />
            </div>
            <div style={{ flex: "0 0 130px" }}>
              <label style={labelStyle}>Perfil</label>
              <Select value={novoRole} onChange={setNovoRole} options={[
                { value: "user", label: "👤 Usuário" },
                { value: "admin", label: "⚙️ Admin" },
              ]} />
            </div>
          </div>
          {erro && <div style={{ fontSize: 12, color: C.red, marginBottom: 10 }}>❌ {erro}</div>}
          <Btn onClick={criarUsuario} color={C.green} disabled={criando}>
            {criando ? "⏳ Criando..." : "💾 Criar usuário"}
          </Btn>
        </div>
      )}

      {usuarioCriado && (
  <div style={{
    background: "rgba(0,230,118,0.08)",
    border: "1px solid rgba(0,230,118,0.3)",
    borderRadius: 12, padding: 18, marginBottom: 18,
  }}>
    <div style={{
      fontFamily: "'Barlow Condensed', sans-serif",
      fontSize: 14, fontWeight: 800, color: "#00e676", marginBottom: 12,
    }}>
      ✅ Usuário criado! Dados de acesso:
    </div>

    {/* Caixa com os dados */}
    <div style={{
      background: "#080d18", border: "1px solid rgba(255,255,255,0.1)",
      borderRadius: 8, padding: "12px 14px", marginBottom: 12,
      fontFamily: "monospace", fontSize: 13, lineHeight: 2,
    }}>
      <div>🌐 <span style={{ color: "#4a5a78" }}>Site:</span>{" "}
        <span style={{ color: "#00b4d8" }}>{usuarioCriado.url}</span>
      </div>
      <div>👤 <span style={{ color: "#4a5a78" }}>Usuário:</span>{" "}
        <span style={{ color: "#e8eeff" }}>{usuarioCriado.username}</span>
      </div>
      <div>🔑 <span style={{ color: "#4a5a78" }}>Senha:</span>{" "}
        <span style={{ color: "#e8eeff" }}>{usuarioCriado.password}</span>
      </div>
    </div>

    {/* Botões */}
    <div style={{ display: "flex", gap: 8 }}>
      <button
        onClick={() => {
          const texto = `🌐 Site: ${usuarioCriado.url}\n👤 Usuário: ${usuarioCriado.username}\n🔑 Senha: ${usuarioCriado.password}`
          navigator.clipboard.writeText(texto)
          setCopiado(true)
          setTimeout(() => setCopiado(false), 2500)
        }}
        style={{
          flex: 1, borderRadius: 8, padding: "10px",
          background: copiado ? "rgba(0,230,118,0.2)" : "rgba(0,230,118,0.12)",
          border: `1px solid ${copiado ? "rgba(0,230,118,0.6)" : "rgba(0,230,118,0.3)"}`,
          color: "#00e676", fontFamily: "'Barlow Condensed', sans-serif",
          fontSize: 14, fontWeight: 800, cursor: "pointer", letterSpacing: 1,
          transition: "all 0.2s",
        }}
      >
        {copiado ? "✅ COPIADO!" : "📋 COPIAR DADOS DE ACESSO"}
      </button>

      <button
        onClick={() => { setUsuarioCriado(null); setCopiado(false) }}
        style={{
          border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8,
          padding: "10px 16px", background: "transparent",
          color: "#4a5a78", fontFamily: "'Barlow Condensed', sans-serif",
          fontSize: 13, fontWeight: 700, cursor: "pointer",
        }}
      >
        ✕ Fechar
      </button>
    </div>
  </div>
)}

      {loading ? (
        <div style={{ textAlign: "center", padding: 32, color: C.muted }}>⏳ Carregando...</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {usuarios.map(u => (
            <div key={u.username} style={{
              background: C.card, border: `1px solid ${C.border}`,
              borderLeft: `3px solid ${u.role === "admin" ? C.purple : C.blue}`,
              borderRadius: 10, padding: "12px 16px",
            }}>
              <div className="ad-user-row" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ fontSize: 22 }}>{u.role === "admin" ? "⚙️" : "👤"}</div>
                  <div>
                    <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 16, fontWeight: 800, color: C.text }}>
                      {u.username}
                    </div>
                    <Badge color={u.role === "admin" ? C.purple : C.blue}>
                      {u.role === "admin" ? "ADMIN" : "USUÁRIO"}
                    </Badge>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => { setEditandoSenha(editandoSenha === u.username ? null : u.username); setNovaSenhaEdit(""); setErro("") }}
                    style={{ background: "none", border: `1px solid ${C.blue}40`, borderRadius: 6, padding: "4px 10px", color: C.blue, fontSize: 11, cursor: "pointer", fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700 }}>
                    🔑 SENHA
                  </button>
                  {u.username !== "admin" && (
                    <button onClick={() => removerUsuario(u.username)}
                      style={{ background: "none", border: `1px solid ${C.red}40`, borderRadius: 6, padding: "4px 10px", color: C.red, fontSize: 11, cursor: "pointer", fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700 }}>
                      ✕ REMOVER
                    </button>
                  )}
                </div>
              </div>

              {editandoSenha === u.username && (
                <div className="ad-pass-row" style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.border}`, display: "flex", gap: 8, alignItems: "flex-end" }}>
                  <div style={{ flex: 1 }}>
                    <label style={labelStyle}>Nova senha para {u.username}</label>
                    <Input value={novaSenhaEdit} onChange={setNovaSenhaEdit} placeholder="nova_senha" type="password" />
                  </div>
                  <Btn onClick={() => alterarSenha(u.username)} color={C.blue} small>Salvar</Btn>
                  <Btn onClick={() => { setEditandoSenha(null); setErro("") }} color={C.muted} small outline>Cancelar</Btn>
                </div>
              )}
            </div>
          ))}
          {!showForm && erro && <div style={{ fontSize: 12, color: C.red, marginTop: 8 }}>❌ {erro}</div>}
        </div>
      )}
    </div>
  )
}

// ─── Seção: Gerenciar Jogos ────────────────────────────────
function SecaoJogos({ token }) {
  const [jogos, setJogos]       = useState([])
  const [loading, setLoading]   = useState(true)
  const [salvando, setSalvando] = useState(false)
  const [filtro, setFiltro]     = useState("todos")

  const carregar = useCallback(async () => {
    setLoading(true)
    try {
      const res  = await fetch(`${API_BASE}/api/tracker`)
      const data = await res.json()
      setJogos(Array.isArray(data) ? data : [])
    } catch { } finally { setLoading(false) }
  }, [])

  useEffect(() => { carregar() }, [carregar])

  const salvar = useCallback(async (novos) => {
    setSalvando(true)
    try {
      const res = await fetch(`${API_BASE}/api/tracker`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-auth-token": token },
        body: JSON.stringify(novos),
      })
      if (!res.ok) {
        const err = await res.json()
        alert("Erro ao salvar: " + (err.error || res.status))
        return
      }
      setJogos(novos)
    } catch (e) { alert("Erro de conexão: " + e.message) }
    finally { setSalvando(false) }
  }, [token])

  const marcar = async (id, resultado) => {
    const novos = jogos.map(j => j.id === id
      ? { ...j, resultado, marcadoEm: resultado ? new Date().toISOString() : null }
      : j
    )
    await salvar(novos)
  }

  const remover = async (id) => {
    if (!confirm("Remover este jogo permanentemente?")) return
    await salvar(jogos.filter(j => j.id !== id))
  }

  const jogosFiltrados =
    filtro === "pendentes" ? jogos.filter(j => j.resultado === null) :
    filtro === "green"     ? jogos.filter(j => j.resultado === "green") :
    filtro === "red"       ? jogos.filter(j => j.resultado === "red") :
    jogos

  const confCor = c => c === "Alta" ? C.green : c === "Média" ? C.yellow : C.red

  if (loading) return <div style={{ textAlign: "center", padding: 48, color: C.muted }}>⏳ Carregando jogos...</div>

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: C.sub }}>{jogos.length} jogo(s) no tracker</div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {salvando && <span style={{ fontSize: 11, color: C.yellow }}>💾 Salvando...</span>}
          <button onClick={carregar} style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 6, padding: "4px 10px", color: C.sub, fontSize: 11, cursor: "pointer" }}>↻ Recarregar</button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
        {[
          { id: "todos",     label: `Todos (${jogos.length})` },
          { id: "pendentes", label: `⏳ Pendentes (${jogos.filter(j => !j.resultado).length})` },
          { id: "green",     label: `🟢 Green (${jogos.filter(j => j.resultado === "green").length})` },
          { id: "red",       label: `🔴 Red (${jogos.filter(j => j.resultado === "red").length})` },
        ].map(f => (
          <button key={f.id} onClick={() => setFiltro(f.id)} style={{
            background: filtro === f.id ? C.purple + "20" : "transparent",
            border: `1px solid ${filtro === f.id ? C.purple + "60" : C.border}`,
            borderRadius: 8, padding: "5px 12px",
            color: filtro === f.id ? C.purple : C.sub,
            fontSize: 11, fontWeight: 700, cursor: "pointer",
            fontFamily: "'Barlow Condensed', sans-serif", letterSpacing: 1,
          }}>{f.label}</button>
        ))}
      </div>

      {jogosFiltrados.length === 0 ? (
        <div style={{ textAlign: "center", padding: "32px 0", color: C.muted }}>
          <div style={{ fontSize: 32, marginBottom: 10 }}>📭</div>
          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 15, fontWeight: 700 }}>Nenhum jogo neste filtro</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {jogosFiltrados.map(j => {
            const pendente = j.resultado === null
            const bordaEsq = pendente ? C.yellow : j.resultado === "green" ? C.green : C.red
            return (
              <div key={j.id} style={{
                background: C.surface, border: `1px solid ${C.border}`,
                borderLeft: `3px solid ${bordaEsq}`, borderRadius: 12, padding: "14px 16px",
              }}>
                <div className="ad-jogo-top" style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 8 }}>
                  <div>
                    <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 16, fontWeight: 800, color: C.text }}>
                      {j.mandante} <span style={{ color: C.muted, fontWeight: 400 }}>×</span> {j.visitante}
                    </div>
                    <div style={{ display: "flex", gap: 5, marginTop: 5, flexWrap: "wrap" }}>
                      <Badge color={C.blue}>{j.liga}</Badge>
                      <Badge color={C.purple}>{j.mercado}</Badge>
                      <Badge color={confCor(j.confianca)}>{j.confianca}</Badge>
                      {j.odd && <Badge color={C.yellow}>@ {j.odd}</Badge>}
                    </div>
                  </div>
                  <div>
                    {pendente && <Badge color={C.yellow}>⏳ Pendente</Badge>}
                    {j.resultado === "green" && <Badge color={C.green}>🟢 GREEN</Badge>}
                    {j.resultado === "red"   && <Badge color={C.red}>🔴 RED</Badge>}
                  </div>
                </div>

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4, alignItems: "center" }}>
                  {pendente ? (
                    <>
                      <Btn onClick={() => marcar(j.id, "green")} color={C.green} small>🟢 Green</Btn>
                      <Btn onClick={() => marcar(j.id, "red")} color={C.red} small outline>🔴 Red</Btn>
                    </>
                  ) : (
                    <button onClick={() => marcar(j.id, null)}
                      style={{ fontSize: 11, color: C.muted, background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>
                      Desfazer marcação
                    </button>
                  )}
                  <button onClick={() => remover(j.id)}
                    style={{ fontSize: 11, color: C.red + "99", background: "none", border: "none", cursor: "pointer", marginLeft: "auto" }}>
                    🗑 Remover
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Seção: Estatísticas ───────────────────────────────────
function SecaoEstatisticas() {
  const [jogos, setJogos]     = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch(`${API_BASE}/api/tracker`)
      .then(r => r.json())
      .then(d => { setJogos(Array.isArray(d) ? d : []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  if (loading) return <div style={{ textAlign: "center", padding: 48, color: C.muted }}>⏳ Carregando...</div>

  const finalizados = jogos.filter(j => j.resultado !== null)
  const greens      = finalizados.filter(j => j.resultado === "green").length
  const reds        = finalizados.filter(j => j.resultado === "red").length
  const pct         = finalizados.length > 0 ? Math.round(greens / finalizados.length * 100) : null
  const pctCor      = pct === null ? C.muted : pct >= 60 ? C.green : pct >= 45 ? C.yellow : C.red

  const comOdd = finalizados.filter(j => j.odd)
  let roi = null
  if (comOdd.length > 0) {
    const lucro = comOdd.reduce((s, j) => j.resultado === "green" ? s + (j.odd - 1) : s - 1, 0)
    roi = (lucro / comOdd.length * 100).toFixed(1)
  }

  const porConf = ["Alta", "Média", "Baixa"].map(c => {
    const sub = finalizados.filter(j => j.confianca === c)
    const g   = sub.filter(j => j.resultado === "green").length
    return { c, total: sub.length, greens: g, pct: sub.length > 0 ? Math.round(g / sub.length * 100) : null }
  })

  const mMap = {}
  finalizados.forEach(j => {
    if (!mMap[j.mercado]) mMap[j.mercado] = { total: 0, greens: 0 }
    mMap[j.mercado].total++
    if (j.resultado === "green") mMap[j.mercado].greens++
  })
  const topMercados = Object.entries(mMap)
    .map(([m, v]) => ({ m, ...v, pct: Math.round(v.greens / v.total * 100) }))
    .sort((a, b) => b.total - a.total).slice(0, 5)

  const StatBox = ({ label, val, color = C.text, sub }) => (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 16px", flex: 1, minWidth: 90 }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: C.muted, textTransform: "uppercase", fontFamily: "'Barlow Condensed', sans-serif", marginBottom: 4 }}>{label}</div>
      <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 26, fontWeight: 900, color, lineHeight: 1 }}>{val}</div>
      {sub && <div style={{ fontSize: 11, color: C.muted, marginTop: 3 }}>{sub}</div>}
    </div>
  )

  if (jogos.length === 0) return (
    <div style={{ textAlign: "center", padding: "48px 0", color: C.muted }}>
      <div style={{ fontSize: 36, marginBottom: 12 }}>📊</div>
      <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 16, fontWeight: 700 }}>Nenhum dado ainda</div>
    </div>
  )

  return (
    <div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 18 }}>
        <StatBox label="Total"     val={jogos.length}   color={C.blue}  sub={`${finalizados.length} finalizados`} />
        <StatBox label="🟢 Greens" val={greens}          color={C.green} />
        <StatBox label="🔴 Reds"   val={reds}            color={C.red}   />
        <StatBox label="% Acerto"  val={pct !== null ? pct + "%" : "—"} color={pctCor} sub={`${finalizados.length} amostras`} />
        {roi !== null && <StatBox label="ROI est." val={(parseFloat(roi) > 0 ? "+" : "") + roi + "%"} color={parseFloat(roi) >= 0 ? C.green : C.red} sub={`${comOdd.length} com odd`} />}
      </div>

      {finalizados.length > 0 && (
        <>
          <div style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 10, color: C.muted, fontWeight: 700, letterSpacing: 1, marginBottom: 6, fontFamily: "'Barlow Condensed', sans-serif" }}>APROVEITAMENTO GERAL</div>
            <div style={{ height: 10, borderRadius: 5, background: "rgba(255,255,255,0.06)", overflow: "hidden" }}>
              <div style={{ width: `${pct}%`, height: "100%", background: pctCor, borderRadius: 5, transition: "width 0.5s ease" }} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontSize: 10, color: C.muted }}>
              <span style={{ color: C.green }}>{greens} greens</span>
              <span style={{ color: pctCor, fontWeight: 700 }}>{pct}%</span>
              <span style={{ color: C.red }}>{reds} reds</span>
            </div>
          </div>

          <div style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 10, color: C.muted, fontWeight: 700, letterSpacing: 1, marginBottom: 8, fontFamily: "'Barlow Condensed', sans-serif" }}>ACERTO POR CONFIANÇA</div>
            <div style={{ display: "flex", gap: 8 }}>
              {porConf.map(({ c, total, greens: g, pct: p }) => {
                const cor = c === "Alta" ? C.green : c === "Média" ? C.yellow : C.red
                const barCor = p !== null ? (p >= 60 ? C.green : p >= 45 ? C.yellow : C.red) : C.muted
                return (
                  <div key={c} style={{ flex: 1, background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 12px", textAlign: "center" }}>
                    <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 13, fontWeight: 700, color: cor, marginBottom: 3 }}>{c}</div>
                    <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 22, fontWeight: 900, color: barCor, lineHeight: 1 }}>
                      {p !== null ? p + "%" : "—"}
                    </div>
                    <div style={{ fontSize: 10, color: C.muted, marginTop: 2 }}>{g}/{total}</div>
                  </div>
                )
              })}
            </div>
          </div>

          {topMercados.length > 0 && (
            <div>
              <div style={{ fontSize: 10, color: C.muted, fontWeight: 700, letterSpacing: 1, marginBottom: 8, fontFamily: "'Barlow Condensed', sans-serif" }}>TOP MERCADOS</div>
              {topMercados.map(({ m, total, greens: g, pct: p }) => (
                <div key={m} className="st-linha" style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                  <div style={{ flex: 1, fontSize: 12, color: C.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{m}</div>
                  <div style={{ flex: 2, height: 6, borderRadius: 3, background: "rgba(255,255,255,0.05)", overflow: "hidden" }}>
                    <div style={{ width: `${p}%`, height: "100%", background: p >= 60 ? C.green : p >= 45 ? C.yellow : C.red, borderRadius: 3 }} />
                  </div>
                  <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 13, fontWeight: 800, color: p >= 60 ? C.green : p >= 45 ? C.yellow : C.red, minWidth: 38, textAlign: "right" }}>{p}%</div>
                  <div style={{ fontSize: 11, color: C.muted, minWidth: 30, textAlign: "right" }}>{g}/{total}</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ─── Seção: Modelo (calibração, walk-forward, stacking) ─────
function SecaoModelo({ token }) {
  const [dados, setDados]     = useState(null)
  const [loading, setLoading] = useState(true)
  const [erro, setErro]       = useState("")
  const MERCADOS = ['Gols:Over 1.5', 'Gols:Over 2.5', 'Gols:Over 3.5', 'BTTS']

  // ✅ NOVO — alertas automáticos (GO/NO-GO e troca de técnica de calibração)
  const [alertas, setAlertas] = useState(null)
  const carregarAlertas = useCallback(() => {
    fetch(`${API_BASE}/api/alertas`, { headers: { "x-auth-token": token } })
      .then(r => (r.ok ? r.json() : null)).then(d => { if (d) setAlertas(d) }).catch(() => {})
  }, [token])
  useEffect(() => { carregarAlertas() }, [carregarAlertas])
  const verificarAgora = async () => {
    await fetch(`${API_BASE}/api/alertas/verificar`, { method: "POST", headers: { "x-auth-token": token } }).catch(() => {})
    carregarAlertas()
  }

  useEffect(() => {
    let vivo = true
    setLoading(true)
    Promise.all([
      checklistPreDeploy(),
      validacaoOutOfSample(),
      Promise.all(MERCADOS.map(m => validacaoStackingGols(m))),
      validacaoStacking1x2(), // ✅ NOVO — stacking do 1X2
    ])
      .then(([checklist, oos, stackingList, stacking1x2]) => {
        if (!vivo) return
        setDados({ checklist, oos, stacking: stackingList, stacking1x2 })
        setLoading(false)
      })
      .catch(e => { if (vivo) { setErro(e.message || 'Falha ao carregar'); setLoading(false) } })
    return () => { vivo = false }
  }, [])

  if (loading) return <div style={{ textAlign: "center", padding: 48, color: C.muted }}>⏳ Rodando walk-forward...</div>
  if (erro) return <div style={{ textAlign: "center", padding: 48, color: C.red }}>⚠️ {erro}</div>
  if (!dados) return null

  const { checklist, oos, stacking, stacking1x2 } = dados

  return (
    <div>
      {/* GO/NO-GO */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10, marginBottom: 18,
        background: checklist.podeDeployar ? C.green + "12" : C.red + "12",
        border: `1px solid ${checklist.podeDeployar ? C.green : C.red}40`,
        borderRadius: 10, padding: "12px 16px",
      }}>
        <span style={{ fontSize: 22 }}>{checklist.podeDeployar ? "✅" : "⛔"}</span>
        <div>
          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 16, fontWeight: 900, color: checklist.podeDeployar ? C.green : C.red }}>
            {checklist.podeDeployar ? "GO — pode subir versão nova" : "NO-GO — checklist bloqueado"}
          </div>
          <div style={{ fontSize: 11, color: C.muted }}>gerado {new Date(checklist.geradoEm).toLocaleString("pt-BR")}</div>
        </div>
      </div>

      {/* Motores */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 10, color: C.muted, fontWeight: 700, letterSpacing: 1, marginBottom: 8, fontFamily: "'Barlow Condensed', sans-serif" }}>MOTORES</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {checklist.motores.map(m => (
            <div key={m.motor} style={{ flex: "1 1 200px", background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 12px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 13, fontWeight: 800, color: C.text, textTransform: "capitalize" }}>{m.motor}</span>
                <Badge color={m.status === "ok" ? C.green : m.status === "bloqueado" ? C.red : C.muted}>{m.status}</Badge>
              </div>
              <div style={{ fontSize: 11, color: C.sub }}>{m.versaoAtual ?? "—"} · n={m.n} · Brier {m.brier ?? "—"} · LogLoss {m.logLoss ?? "—"}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Walk-forward: técnica de calibração */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 10, color: C.muted, fontWeight: 700, letterSpacing: 1, marginBottom: 8, fontFamily: "'Barlow Condensed', sans-serif" }}>
          WALK-FORWARD — FATOR × ISOTONIC × PLATT
        </div>
        {!oos.suficiente ? (
          <div style={{ fontSize: 12, color: C.muted }}>{oos.mensagem}</div>
        ) : (
          <>
            <div style={{ fontSize: 12, color: C.text, marginBottom: 8 }}>
              Técnica em produção agora: <strong style={{ color: C.yellow }}>{oos.melhorTecnica ?? "fator"}</strong> · {oos.numFolds} fold(s) · {oos.totalTeste} amostras de teste
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                <thead>
                  <tr style={{ color: C.muted }}>
                    <th style={{ textAlign: "left", padding: "4px 6px" }}>técnica</th>
                    <th style={{ padding: "4px 6px" }}>Brier</th>
                    <th style={{ padding: "4px 6px" }}>LogLoss</th>
                    <th style={{ padding: "4px 6px" }}>ECE</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    { nome: "bruto",    brier: oos.brierBruto,     ll: oos.logLossBruto,     ece: oos.eceBruto },
                    { nome: "fator",    brier: oos.brierCalibrado, ll: oos.logLossCalibrado, ece: oos.eceCalibrado },
                    { nome: "isotonic", brier: oos.brierIsotonic,  ll: oos.logLossIsotonic,  ece: oos.eceIsotonic },
                    { nome: "platt",    brier: oos.brierPlatt,     ll: oos.logLossPlatt,     ece: oos.ecePlatt },
                  ].map(r => (
                    <tr key={r.nome} style={{ color: r.nome === (oos.melhorTecnica ?? "fator") ? C.green : C.text, fontWeight: r.nome === (oos.melhorTecnica ?? "fator") ? 800 : 400 }}>
                      <td style={{ padding: "4px 6px" }}>{r.nome}</td>
                      <td style={{ padding: "4px 6px", textAlign: "right" }}>{r.brier ?? "—"}</td>
                      <td style={{ padding: "4px 6px", textAlign: "right" }}>{r.ll ?? "—"}</td>
                      <td style={{ padding: "4px 6px", textAlign: "right" }}>{r.ece ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

            {/* ✅ NOVO — Stacking do 1X2 (Forma / H2H / ELO) */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 10, color: C.muted, fontWeight: 700, letterSpacing: 1, marginBottom: 8, fontFamily: "'Barlow Condensed', sans-serif" }}>
          STACKING — 1X2 (FORMA / H2H / ELO)
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 12px" }}>
          <div style={{ flex: 1, fontSize: 12, color: C.text }}>Vitória Mandante/Visitante</div>
          {!stacking1x2.suficiente ? (
            <div style={{ fontSize: 11, color: C.muted }}>{stacking1x2.mensagem ?? `precisa de mais amostra (${stacking1x2.n ?? 0}/${stacking1x2.minimo ?? "?"})`}</div>
          ) : (
            <>
              <Badge color={stacking1x2.confiavel ? C.green : C.muted}>{stacking1x2.confiavel ? "em uso" : "não bate o heurístico"}</Badge>
              <div style={{ fontSize: 12, color: C.yellow, fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800 }}>
                {stacking1x2.confiavel
                  ? `F ${stacking1x2.pesoRecomendado.forma} · H ${stacking1x2.pesoRecomendado.h2h} · E ${stacking1x2.pesoRecomendado.elo}`
                  : "padrão F 0.55 · H 0.2 · E 0.25"}
              </div>
            </>
          )}
        </div>
      </div>

            {/* ✅ NOVO — Alertas automáticos (GO/NO-GO e troca de técnica) */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div style={{ fontSize: 10, color: C.muted, fontWeight: 700, letterSpacing: 1, fontFamily: "'Barlow Condensed', sans-serif" }}>
            ALERTAS AUTOMÁTICOS
          </div>
          <span onClick={verificarAgora} style={{ fontSize: 11, color: C.blue, cursor: "pointer" }}>verificar agora</span>
        </div>
        {alertas && (
          <div style={{ fontSize: 11, color: C.sub, marginBottom: 6 }}>
            Telegram: {alertas.telegramConfigurado ? "configurado" : "não configurado (só aparece aqui)"}
            {alertas.estado?.verificadoEm ? ` · última verificação ${new Date(alertas.estado.verificadoEm).toLocaleString("pt-BR")}` : ""}
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {alertas && alertas.alertas.length === 0 && (
            <div style={{ fontSize: 11, color: C.muted }}>Nenhum alerta ainda.</div>
          )}
          {(alertas?.alertas ?? []).map(a => (
            <div key={a.id} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 12px" }}>
              <div style={{ fontSize: 11, color: C.text, whiteSpace: "pre-line" }}>{a.mensagem}</div>
              <div style={{ fontSize: 10, color: C.muted, marginTop: 2 }}>{new Date(a.criado_em).toLocaleString("pt-BR")}{a.enviado ? " · Telegram ✓" : ""}</div>
            </div>
          ))}
        </div>
      </div>
      

      {/* Stacking por mercado */}
      <div>
        <div style={{ fontSize: 10, color: C.muted, fontWeight: 700, letterSpacing: 1, marginBottom: 8, fontFamily: "'Barlow Condensed', sans-serif" }}>
          STACKING — PESO POISSON POR MERCADO
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {stacking.map((r, i) => (
            <div key={MERCADOS[i]} style={{ display: "flex", alignItems: "center", gap: 10, background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 12px" }}>
              <div style={{ flex: 1, fontSize: 12, color: C.text }}>{MERCADOS[i]}</div>
              {!r.suficiente ? (
                <div style={{ fontSize: 11, color: C.muted }}>{r.mensagem ?? `precisa de mais amostra (${r.n ?? 0}/${r.minimo ?? "?"})`}</div>
              ) : (
                <>
                  <Badge color={r.confiavel ? C.green : C.muted}>{r.confiavel ? "em uso" : "não bate o heurístico"}</Badge>
                  <div style={{ fontSize: 12, color: C.yellow, fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800 }}>
                    {r.confiavel ? `peso ${r.pesoRecomendado}` : `heurístico ${r.pesoHeuristicoPadrao}`}
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── PAINEL ADMIN PRINCIPAL ────────────────────────────────
// Props: token, username, onLogout, onNavegar (função que recebe o nome da tela)
export default function AdminPanel({ token, username, onLogout, onNavegar }) {
  const [aba, setAba] = useState("status")

  const ABAS = [
    { id: "status",   label: "🖥️ Sistema",      cor: C.green },
    { id: "jogos",    label: "🎯 Jogos",         cor: C.yellow },
    { id: "usuarios", label: "👥 Usuários",      cor: C.purple },
    { id: "stats",    label: "📊 Estatísticas",  cor: C.blue },
    { id: "modelo",   label: "📐 Modelo",        cor: C.orange }, // ✅ NOVO — item 41
  ]

  // Telas do sistema que o admin pode acessar diretamente
  const TELAS = [
    { id: "tracker",  label: "Scout Tracker", icon: "📋", cor: C.green },
    { id: "analises", label: "Análises",       icon: "🔍", cor: C.blue },
    { id: "basquete", label: "Basquete",       icon: "🏀", cor: C.orange },
  ]

  const tabStyle = (id) => {
    const cor = ABAS.find(a => a.id === id)?.cor || C.blue
    return {
      flex: 1, border: "none", borderRadius: 8, padding: "9px 4px",
      fontFamily: "'Barlow Condensed', sans-serif", fontSize: 12, fontWeight: 700,
      letterSpacing: 0.8, cursor: "pointer", transition: "all 0.2s", textTransform: "uppercase",
      background: aba === id ? cor + "20" : "transparent",
      color: aba === id ? cor : C.muted,
      borderBottom: aba === id ? `2px solid ${cor}` : "2px solid transparent",
    }
  }

  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: "'Barlow', sans-serif", color: C.text }}>

      {/* ── Header ── */}
      <div style={{
        background: C.surface, borderBottom: `1px solid ${C.border}`,
        padding: "12px 20px", display: "flex", alignItems: "center",
        justifyContent: "space-between", position: "sticky", top: 0, zIndex: 10,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{
            background: C.purple + "20", border: `1px solid ${C.purple}40`,
            borderRadius: 8, padding: "4px 10px",
            fontFamily: "'Barlow Condensed', sans-serif", fontSize: 11,
            fontWeight: 700, color: C.purple, letterSpacing: 1.5,
          }}>⚙️ ADMIN</div>
          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 20, fontWeight: 900, color: C.text, letterSpacing: 1 }}>
            FOOTBALL <span style={{ color: C.purple }}>SCOUT IA</span>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 12, color: C.sub }}>👤 {username}</span>
          {onLogout && (
            <button onClick={onLogout} style={{
              background: "none", border: `1px solid ${C.red}40`,
              borderRadius: 6, padding: "4px 12px", color: C.red,
              fontSize: 11, cursor: "pointer", fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700,
            }}>SAIR</button>
          )}
        </div>
      </div>

      {/* ── Banner ── */}
      <div style={{
        background: C.purple + "0d", borderBottom: `1px solid ${C.purple}20`,
        padding: "8px 20px", fontSize: 11, color: C.purple + "cc", textAlign: "center",
      }}>
        🔐 Painel restrito — apenas administradores têm acesso
      </div>

      <div className="ad-wrap" style={{ maxWidth: 860, margin: "0 auto", padding: "20px 16px" }}>

        {/* ── Acesso rápido às telas do sistema ── */}
        {onNavegar && (
          <div className="ad-tabs" style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 10, color: C.muted, fontWeight: 700, letterSpacing: 1.5, marginBottom: 10, fontFamily: "'Barlow Condensed', sans-serif" }}>
              ACESSO RÁPIDO — TELAS DO SISTEMA
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {TELAS.map(t => (
                <button key={t.id} onClick={() => onNavegar(t.id)}
                  style={{
                    background: t.cor + "12", border: `1px solid ${t.cor}35`,
                    borderRadius: 10, padding: "8px 14px",
                    fontFamily: "'Barlow Condensed', sans-serif", fontSize: 13,
                    fontWeight: 700, color: t.cor, cursor: "pointer",
                    letterSpacing: 0.8, transition: "all 0.15s",
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = t.cor + "25"}
                  onMouseLeave={e => e.currentTarget.style.background = t.cor + "12"}
                >
                  {t.icon} {t.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ── Abas do painel ── */}
        <div style={{
          display: "flex", gap: 2, marginBottom: 20,
          background: "rgba(255,255,255,0.03)", borderRadius: 12, padding: 4,
        }}>
          {ABAS.map(a => (
            <button key={a.id} style={tabStyle(a.id)} onClick={() => setAba(a.id)}>
              {a.label}
            </button>
          ))}
        </div>

        {/* ── Conteúdo ── */}
        <div className="ad-panel" style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: 20 }}>
          {aba === "status"   && <SecaoStatus token={token} />}
          {aba === "jogos"    && <SecaoJogos token={token} />}
          {aba === "usuarios" && <SecaoUsuarios token={token} />}
          {aba === "stats"    && <SecaoEstatisticas />}
          {aba === "modelo"   && <SecaoModelo token={token} />}
        </div>

      </div>
    </div>
  )
}