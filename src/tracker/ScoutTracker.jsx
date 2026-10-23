import { useState, useEffect, useCallback } from "react"
import { invalidarCacheCalibration, relatorioCalibracaoCompleto, relatorioPorContexto, relatorioCalibracaoTenis, validacaoOutOfSample, checklistPreDeploy, relatorioDrift, relatorioDriftFeatures, categoriaClima, categoriaAltitude } from '../services/calibrationService'
import { PieChart, BarChart, HBarChart } from '../components/MiniCharts'

// ✅ NOVO — detecta o esporte a partir da liga escolhida, pra poder segmentar
// o dashboard (Futebol × Tênis × Basquete) sem precisar de um campo manual extra.
function detectarEsporte(liga) {
  const l = String(liga || '').toLowerCase()
  if (['atp', 'wta', 'itf', 'challenger'].some(k => l.includes(k))) return 'Tênis'
  if (['nba', 'euroleague', 'nbb', 'wnba', 'basquete'].some(k => l.includes(k))) return 'Basquete'
  return 'Futebol'
}

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
  muted:   "#3a4a62",
  text:    "#e8eeff",
  sub:     "#6b7a99",
}

// ─── Helpers de storage ────────────────────────────────────
const IS_PROD  = typeof window !== 'undefined' && window.location.hostname !== 'localhost'
const API_BASE = IS_PROD ? '' : 'http://localhost:3001'

async function storageGet() {
  try {
    const res = await fetch(`${API_BASE}/api/tracker`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } catch (err) {
    console.error('[tracker] Erro ao carregar:', err.message)
    return []
  }
}

async function storageSet(data, token) {
  if (!token) throw new Error('Token ausente — faça login novamente')
  const res = await fetch(`${API_BASE}/api/tracker`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': token,
    },
    body: JSON.stringify(data),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

// ✅ NOVO — Etapa 3: chamadas dos endpoints de reverificação/correção manual
async function apiReverificar(id, token) {
  const res = await fetch(`${API_BASE}/api/tracker/${id}/reverificar`, {
    method: 'POST',
    headers: { 'x-auth-token': token },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
  return body
}

async function apiCorrigir(id, resultado, placarFinal, token) {
  const res = await fetch(`${API_BASE}/api/tracker/${id}/corrigir`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': token },
    body: JSON.stringify({ resultado, placarFinal }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
  return body
}

async function apiAuditoria(id, token) {
  const res = await fetch(`${API_BASE}/api/tracker/${id}/auditoria`, {
    headers: { 'x-auth-token': token },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
  return body
}

// ─── Componentes base ──────────────────────────────────────
function Badge({ children, color = C.blue, size = 11 }) {
  return (
    <span style={{
      fontSize: size, fontWeight: 700, padding: "2px 8px", borderRadius: 20,
      color, background: color + "1a", border: `1px solid ${color}40`,
      fontFamily: "'Barlow Condensed', 'Oswald', sans-serif", letterSpacing: 1,
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
        fontFamily: "'Barlow Condensed', 'Oswald', sans-serif",
        fontSize: small ? 12 : 14, fontWeight: 800, letterSpacing: 1.5,
        textTransform: "uppercase", cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.4 : 1,
        transition: "all 0.15s",
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

// ─── Formulário: Adicionar jogo ────────────────────────────
const LIGAS = [
  "Brasileirão Série A", "Copa Libertadores", "Champions League",
  "Europa League", "Premier League", "La Liga", "Serie A Itália", "Bundesliga",
  "ATP", "WTA", "Challenger ATP", "ITF",
  "NBA", "EuroLeague", "NBB", "WNBA", "Outro",
]
const MERCADOS = [
  "Over 1.5 Gols", "Under 1.5 Gols", "Over 2.5 Gols", "Under 2.5 Gols",
  "Over 3.5 Gols", "Under 3.5 Gols", "BTTS Sim", "BTTS Não",
  "Vitória Mandante", "Empate", "Vitória Visitante",
  "Over 200.5 Pts", "Under 200.5 Pts", "Over 220.5 Pts", "Under 220.5 Pts",
  "Over 1.5 Cartões", "Under 1.5 Cartões", "Over 2.5 Cartões", "Under 2.5 Cartões",
  "Over 3.5 Cartões", "Under 3.5 Cartões", "Over 4.5 Cartões", "Under 4.5 Cartões",
  "Over 5.5 Cartões", "Under 5.5 Cartões", "Over 6.5 Cartões", "Under 6.5 Cartões",
  "Over 3.5 Escanteios", "Under 3.5 Escanteios", "Over 4.5 Escanteios", "Under 4.5 Escanteios",
  "Over 5.5 Escanteios", "Under 5.5 Escanteios", "Over 6.5 Escanteios", "Under 6.5 Escanteios",
  "Over 7.5 Escanteios", "Under 7.5 Escanteios", "Over 8.5 Escanteios", "Under 8.5 Escanteios",
  "Over 9.5 Escanteios", "Under 9.5 Escanteios", "Over 10.5 Escanteios", "Under 10.5 Escanteios",
  "Over 11.5 Escanteios", "Under 11.5 Escanteios", "Over 12.5 Escanteios", "Under 12.5 Escanteios",
  "Over 13.5 Escanteios", "Under 13.5 Escanteios", "Over 14.5 Escanteios", "Under 14.5 Escanteios",
  // ✅ NOVO — mercados de tênis
  "Vitória Jogador 1", "Vitória Jogador 2",
  "Handicap de Sets -1.5", "Handicap de Sets +1.5",
  "Vencer o 1º Set", "Vencer o 2º Set",
  "Over 21.5 Games", "Under 21.5 Games", "Over 22.5 Games", "Under 22.5 Games",
  "Over 23.5 Games", "Under 23.5 Games", "Over 24.5 Games", "Under 24.5 Games",
  "Haverá Tie-Break", "Não Haverá Tie-Break",
  "Outro",
]
const CONFIANCAS = ["Alta", "Média", "Baixa"]
// ✅ NOVO — tags opcionais de contexto (usadas pra montar os gráficos de
// desempenho por clima/altitude no Dashboard, conforme forem se acumulando)
const CLIMAS = ["Não informado", "Seco / Ameno", "Chuva", "Muito quente", "Muito frio", "Vento forte"]
const ALTITUDES = ["Não informado", "Baixa (< 500m)", "Moderada (500-1000m)", "Alta (1000-2000m)", "Muito alta (2000m+)"]

function FormAdicionarJogo({ onSalvar, onCancelar }) {
  const [mandante, setMandante]   = useState("")
  const [visitante, setVisitante] = useState("")
  const [liga, setLiga]           = useState(LIGAS[0])
  const [mercado, setMercado]     = useState(MERCADOS[2])
  const [confianca, setConfianca] = useState("Média")
  const [odd, setOdd]             = useState("")
  const [obs, setObs]             = useState("")
  const [clima, setClima]         = useState(CLIMAS[0])
  const [altitude, setAltitude]   = useState(ALTITUDES[0])

  const valido = mandante.trim() && visitante.trim()

  const salvar = () => {
    if (!valido) return
    onSalvar({
      id: Date.now() + "_" + Math.random().toString(36).slice(2, 7),
      mandante: mandante.trim(),
      visitante: visitante.trim(),
      liga, mercado, confianca,
      esporte: detectarEsporte(liga), // ✅ NOVO — pra segmentar o dashboard por esporte
      clima:    clima    !== CLIMAS[0]    ? clima    : null, // ✅ NOVO
      altitude: altitude !== ALTITUDES[0] ? altitude : null, // ✅ NOVO
      odd: odd ? parseFloat(odd) : null,
      obs: obs.trim(),
      resultado: null,
      criadoEm: new Date().toISOString(),
      criadoPor: "você",
    })
  }

  const labelStyle = {
    fontSize: 10, fontWeight: 700, letterSpacing: 1.5,
    color: C.muted, textTransform: "uppercase",
    fontFamily: "'Barlow Condensed', sans-serif",
    display: "block", marginBottom: 5,
  }
  const row = { marginBottom: 12 }
  const duo = { display: "flex", gap: 10 }

  return (
    <div className="st-form" style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: 20, marginBottom: 18 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 16, fontFamily: "'Barlow Condensed', sans-serif", letterSpacing: 1 }}>
        + ADICIONAR JOGO PARA ACOMPANHAR
      </div>

      <div className="st-duo" style={{ ...duo, ...row }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>{detectarEsporte(liga) === 'Tênis' ? 'Jogador 1' : 'Mandante'}</label>
          <Input value={mandante} onChange={setMandante} placeholder={detectarEsporte(liga) === 'Tênis' ? 'Ex: Djokovic' : 'Ex: Flamengo'} />
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>{detectarEsporte(liga) === 'Tênis' ? 'Jogador 2' : 'Visitante'}</label>
          <Input value={visitante} onChange={setVisitante} placeholder={detectarEsporte(liga) === 'Tênis' ? 'Ex: Alcaraz' : 'Ex: Palmeiras'} />
        </div>
      </div>

      <div style={{ ...duo, ...row }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Liga / Competição</label>
          <Select value={liga} onChange={setLiga} options={LIGAS.map(l => ({ value: l, label: l }))} />
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Mercado apostado</label>
          <Select value={mercado} onChange={setMercado} options={MERCADOS.map(m => ({ value: m, label: m }))} />
        </div>
      </div>

      {/* ✅ NOVO — tags opcionais de contexto: alimentam os gráficos de
          desempenho por clima/altitude no Dashboard conforme forem se acumulando */}
      <div style={{ ...duo, ...row }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Clima do jogo (opcional)</label>
          <Select value={clima} onChange={setClima} options={CLIMAS.map(c => ({ value: c, label: c }))} />
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Altitude do local (opcional)</label>
          <Select value={altitude} onChange={setAltitude} options={ALTITUDES.map(a => ({ value: a, label: a }))} />
        </div>
      </div>

      <div style={{ ...duo, ...row }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Confiança do modelo</label>
          <Select value={confianca} onChange={setConfianca} options={CONFIANCAS.map(c => ({ value: c, label: c }))} />
        </div>
        <div style={{ flex: "0 0 120px" }}>
          <label style={labelStyle}>Odd apostada</label>
          <Input value={odd} onChange={setOdd} placeholder="1.85" type="number" />
        </div>
      </div>

      <div style={row}>
        <label style={labelStyle}>Observação (opcional)</label>
        <Input value={obs} onChange={setObs} placeholder="Ex: H2H favorável, λ=2.4..." />
      </div>

      <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
        <Btn onClick={salvar} color={C.green} disabled={!valido}>💾 Salvar jogo</Btn>
        <Btn onClick={onCancelar} color={C.muted} outline>Cancelar</Btn>
      </div>
    </div>
  )
}

// ─── Card de jogo individual ───────────────────────────────
function JogoCard({ jogo, onMarcar, onRemover, onReverificar, onCorrigir, onAuditoria, onRegistrarFechamento }) {
  const [confirmRemover, setConfirmRemover] = useState(false)
  const [placarInput, setPlacarInput] = useState("") // ✅ NOVO
  const pendente = jogo.resultado === null
  // ✅ NOVO — Fase 5: CLV (Closing Line Value)
  const [oddFechamentoInput, setOddFechamentoInput] = useState("")
  const [salvandoFechamento, setSalvandoFechamento] = useState(false)
  const clv = (jogo.odd && jogo.oddFechamento)
    ? ((jogo.odd / jogo.oddFechamento - 1) * 100)
    : null
  async function handleRegistrarFechamento() {
    const val = parseFloat(oddFechamentoInput)
    if (!val || val <= 1) return
    setSalvandoFechamento(true)
    try {
      await onRegistrarFechamento(jogo.id, val)
      setOddFechamentoInput("")
    } finally {
      setSalvandoFechamento(false)
    }
  }
  const isGreen  = jogo.resultado === "green"
  const isRed    = jogo.resultado === "red"

  // ✅ NOVO — Etapa 3: reverificação manual (botão "Reverificar")
  const [reverificando, setReverificando] = useState(false)
  const [msgReverificar, setMsgReverificar] = useState(null)
  async function handleReverificar() {
    setReverificando(true)
    setMsgReverificar(null)
    try {
      const r = await onReverificar(jogo.id)
      if (r.mudou) setMsgReverificar(`✅ Liquidado: ${r.resultado}${r.placarFinal ? ` (${r.placarFinal})` : ""}`)
      else setMsgReverificar(`ℹ️ ${r.motivo || "Sem alteração"}`)
    } catch (err) {
      setMsgReverificar(`⚠️ ${err.message}`)
    } finally {
      setReverificando(false)
    }
  }

  // ✅ NOVO — Etapa 3: correção manual (botão "Corrigir")
  const [mostrarCorrigir, setMostrarCorrigir] = useState(false)
  const [corrigirResultado, setCorrigirResultado] = useState(jogo.resultado || "green")
  const [corrigirPlacarInput, setCorrigirPlacarInput] = useState(jogo.placarFinal || "")
  const [corrigindo, setCorrigindo] = useState(false)
  const [erroCorrigir, setErroCorrigir] = useState(null)
  async function handleCorrigir() {
    setCorrigindo(true)
    setErroCorrigir(null)
    try {
      const valor = corrigirResultado === "desfazer" ? null : corrigirResultado
      await onCorrigir(jogo.id, valor, valor ? corrigirPlacarInput.trim() : null)
      setMostrarCorrigir(false)
    } catch (err) {
      setErroCorrigir(err.message)
    } finally {
      setCorrigindo(false)
    }
  }

  // ✅ NOVO — Etapa 3: histórico de auditoria (botão "Ver auditoria")
  const [mostrarAuditoria, setMostrarAuditoria] = useState(false)
  const [auditoriaRows, setAuditoriaRows] = useState(null)
  const [carregandoAuditoria, setCarregandoAuditoria] = useState(false)
  async function handleVerAuditoria() {
    if (mostrarAuditoria) { setMostrarAuditoria(false); return }
    setMostrarAuditoria(true)
    if (auditoriaRows === null) {
      setCarregandoAuditoria(true)
      try { setAuditoriaRows(await onAuditoria(jogo.id)) }
      catch (err) { setAuditoriaRows([]) }
      finally { setCarregandoAuditoria(false) }
    }
  }

  const confCor = jogo.confianca === "Alta" ? C.green : jogo.confianca === "Média" ? C.yellow : C.red

  const data = new Date(jogo.criadoEm).toLocaleDateString("pt-BR", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  })

  const bordaEsq = pendente ? C.yellow : isGreen ? C.green : C.red

  return (
    <div style={{
      background: C.card, border: `1px solid ${C.border}`,
      borderLeft: `3px solid ${bordaEsq}`,
      borderRadius: 12, padding: "16px 18px", marginBottom: 10,
      transition: "border-color 0.3s",
    }}>
      <div className="st-jogo-top" style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 10 }}>
        <div>
          <div style={{
            fontFamily: "'Barlow Condensed', sans-serif", fontSize: 18,
            fontWeight: 800, color: C.text, lineHeight: 1.2,
          }}>
            {jogo.mandante} <span style={{ color: C.muted, fontWeight: 400 }}>×</span> {jogo.visitante}
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 5, flexWrap: "wrap" }}>
            <Badge color={C.blue}>{jogo.liga}</Badge>
            <Badge color={C.purple}>{jogo.mercado}</Badge>
            <Badge color={confCor}>{jogo.confianca}</Badge>
            {jogo.odd && <Badge color={C.yellow}>@ {jogo.odd}</Badge>}
            {jogo.oddFechamento && <Badge color={C.blue}>🔒 fech. {jogo.oddFechamento}</Badge>}
            {clv !== null && <Badge color={clv >= 0 ? C.green : C.red}>CLV {clv > 0 ? '+' : ''}{clv.toFixed(1)}%</Badge>}
            {categoriaClima(jogo) && <Badge color={C.blue}>🌦️ {categoriaClima(jogo)}</Badge>}
            {categoriaAltitude(jogo) && <Badge color={C.purple}>🏔️ {categoriaAltitude(jogo)}</Badge>}
            {jogo.placarFinal && <Badge color={C.text}>⚽ {jogo.placarFinal}</Badge>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {pendente && <Badge color={C.yellow}>⏳ Pendente</Badge>}
          {isGreen  && <Badge color={C.green}>🟢 GREEN</Badge>}
          {isRed    && <Badge color={C.red}>🔴 RED</Badge>}
        </div>
      </div>

      {jogo.obs && (
        <div style={{ fontSize: 12, color: C.sub, fontStyle: "italic", marginBottom: 10, borderLeft: `2px solid ${C.border}`, paddingLeft: 10 }}>
          {jogo.obs}
        </div>
      )}

      <div style={{ fontSize: 11, color: C.muted, marginBottom: 12 }}>
        Salvo em {data}
      </div>

      {/* ✅ NOVO — Fase 5: registrar odd de fechamento (para calcular CLV) */}
      {jogo.odd && !jogo.oddFechamento && onRegistrarFechamento && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, color: C.muted }}>Odd de fechamento:</span>
          <input
            type="number"
            value={oddFechamentoInput}
            onChange={e => setOddFechamentoInput(e.target.value)}
            placeholder="1.78"
            title="Odd do mercado pouco antes do início do jogo — usada para calcular o CLV"
            style={{
              width: 90, padding: "6px 8px", borderRadius: 7,
              border: `1px solid ${C.border}`, background: C.bg, color: C.text, fontSize: 12,
            }}
          />
          <Btn onClick={handleRegistrarFechamento} color={C.blue} small outline disabled={salvandoFechamento || !oddFechamentoInput}>
            {salvandoFechamento ? "Salvando..." : "💾 Salvar"}
          </Btn>
        </div>
      )}

      {pendente && onMarcar && (
        <div className="st-marcar" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 11, color: C.muted, alignSelf: "center", marginRight: 4 }}>Marcar resultado:</span>
          <input
            type="text"
            value={placarInput}
            onChange={e => setPlacarInput(e.target.value)}
            placeholder="Placar (ex: 2-1)"
            title="Opcional — alimenta os gráficos de pizza/gols do Tracker"
            style={{
              width: 110, padding: "8px 10px", borderRadius: 7,
              border: `1px solid ${C.border}`, background: C.bg, color: C.text, fontSize: 12,
            }}
          />
          <Btn onClick={() => onMarcar(jogo.id, "green", placarInput.trim())} color={C.green} small>🟢 Green (acertou)</Btn>
          <Btn onClick={() => onMarcar(jogo.id, "red", placarInput.trim())} color={C.red} small outline>🔴 Red (errou)</Btn>
          {jogo.eventoId && onReverificar && (
            <Btn onClick={handleReverificar} color={C.blue} small outline disabled={reverificando}>
              {reverificando ? "🔄 Verificando..." : "🔄 Reverificar"}
            </Btn>
          )}
          {/* ✅ NOVO — excluir jogo pendente (com confirmação, mesmo padrão do Histórico) */}
          {onRemover && (!confirmRemover
            ? <Btn onClick={() => setConfirmRemover(true)} color={C.red} small outline>🗑️ Excluir</Btn>
            : <>
                <Btn onClick={() => onRemover(jogo.id)} color={C.red} small>⚠️ Confirmar exclusão</Btn>
                <Btn onClick={() => setConfirmRemover(false)} color={C.muted} small outline>Cancelar</Btn>
              </>
          )}
        </div>
      )}
      {msgReverificar && (
        <div style={{ fontSize: 11, color: C.sub, marginTop: 6 }}>{msgReverificar}</div>
      )}

      {!pendente && onMarcar && (
        <div className="st-undo" style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
          <button onClick={() => onMarcar(jogo.id, null)}
            style={{ fontSize: 11, color: C.muted, background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>
            Desfazer marcação
          </button>
          {!confirmRemover
            ? <button onClick={() => setConfirmRemover(true)} style={{ fontSize: 11, color: C.red + "88", background: "none", border: "none", cursor: "pointer" }}>Remover</button>
            : <>
                <button onClick={() => onRemover(jogo.id)} style={{ fontSize: 11, color: C.red, background: "none", border: "none", cursor: "pointer", fontWeight: 700 }}>Confirmar remoção</button>
                <button onClick={() => setConfirmRemover(false)} style={{ fontSize: 11, color: C.muted, background: "none", border: "none", cursor: "pointer" }}>Cancelar</button>
              </>
          }
        </div>
      )}

      {(onCorrigir || onAuditoria) && (
        <div style={{ display: "flex", gap: 14, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
          {onCorrigir && !mostrarCorrigir && (
            <button onClick={() => setMostrarCorrigir(true)}
              style={{ fontSize: 11, color: C.purple, background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>
              ✏️ Corrigir manualmente
            </button>
          )}
          {onAuditoria && (
            <button onClick={handleVerAuditoria}
              style={{ fontSize: 11, color: C.blue, background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>
              📜 {mostrarAuditoria ? "Ocultar auditoria" : "Ver auditoria"}
            </button>
          )}
        </div>
      )}

      {mostrarCorrigir && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 8, padding: 10, background: C.bg, borderRadius: 8, border: `1px solid ${C.border}` }}>
          <select value={corrigirResultado} onChange={e => setCorrigirResultado(e.target.value)}
            style={{ padding: "6px 8px", borderRadius: 6, border: `1px solid ${C.border}`, background: C.card, color: C.text, fontSize: 12 }}>
            <option value="green">🟢 Green</option>
            <option value="red">🔴 Red</option>
            <option value="anulada">⚪ Anulada</option>
            <option value="desfazer">↩️ Desfazer (deixar pendente)</option>
          </select>
          {corrigirResultado !== "desfazer" && (
            <input type="text" value={corrigirPlacarInput} onChange={e => setCorrigirPlacarInput(e.target.value)}
              placeholder="Placar (opcional)"
              style={{ width: 110, padding: "6px 8px", borderRadius: 6, border: `1px solid ${C.border}`, background: C.card, color: C.text, fontSize: 12 }} />
          )}
          <Btn onClick={handleCorrigir} color={C.purple} small disabled={corrigindo}>{corrigindo ? "Salvando..." : "Confirmar"}</Btn>
          <button onClick={() => setMostrarCorrigir(false)}
            style={{ fontSize: 11, color: C.muted, background: "none", border: "none", cursor: "pointer" }}>
            Cancelar
          </button>
          {erroCorrigir && <div style={{ width: "100%", fontSize: 11, color: C.red }}>⚠️ {erroCorrigir}</div>}
        </div>
      )}

      {mostrarAuditoria && (
        <div style={{ marginTop: 8, fontSize: 11, color: C.sub, borderLeft: `2px solid ${C.border}`, paddingLeft: 10 }}>
          {carregandoAuditoria ? "Carregando..." : (
            auditoriaRows && auditoriaRows.length > 0 ? auditoriaRows.map(row => (
              <div key={row.id} style={{ padding: "3px 0" }}>
                {new Date(row.criado_em).toLocaleString("pt-BR")} · {row.resultado_anterior ?? "—"} → {row.resultado_novo}
                {row.placar_final ? ` (${row.placar_final})` : ""} · {row.fonte}{row.autor ? ` · ${row.autor}` : ""}
              </div>
            )) : "Sem histórico de auditoria."
          )}
        </div>
      )}
    </div>
  )
}

// ─── Dashboard de performance ──────────────────────────────
function Dashboard({ jogos }) {
  const finalizados = jogos.filter(j => j.resultado !== null)
  const greens = finalizados.filter(j => j.resultado === "green").length
  const reds   = finalizados.filter(j => j.resultado === "red").length
  const pct    = finalizados.length > 0 ? Math.round((greens / finalizados.length) * 100) : null

  const porConf = ["Alta", "Média", "Baixa"].map(c => {
    const sub = finalizados.filter(j => j.confianca === c)
    const g   = sub.filter(j => j.resultado === "green").length
    return { c, total: sub.length, greens: g, pct: sub.length > 0 ? Math.round((g / sub.length) * 100) : null }
  })

  const mercadoMap = {}
  finalizados.forEach(j => {
    if (!mercadoMap[j.mercado]) mercadoMap[j.mercado] = { total: 0, greens: 0 }
    mercadoMap[j.mercado].total++
    if (j.resultado === "green") mercadoMap[j.mercado].greens++
  })
  const porMercado = Object.entries(mercadoMap)
    .map(([m, v]) => ({ m, ...v, pct: Math.round((v.greens / v.total) * 100) }))
    .sort((a, b) => b.total - a.total).slice(0, 5)

  const comOdd = finalizados.filter(j => j.odd)
  let roi = null
  if (comOdd.length > 0) {
    const lucro = comOdd.reduce((s, j) => j.resultado === "green" ? s + (j.odd - 1) : s - 1, 0)
    roi = (lucro / comOdd.length * 100).toFixed(1)
  }

  // ✅ NOVO — Fase 5: CLV médio — bate a odd de entrada contra a odd de
  // fechamento, independente do resultado do jogo (mede "timing", não sorte)
  const comFechamento = jogos.filter(j => j.odd && j.oddFechamento)
  let clvMedio = null
  let clvPositivoPct = null
  if (comFechamento.length > 0) {
    const clvs = comFechamento.map(j => (j.odd / j.oddFechamento - 1) * 100)
    clvMedio = (clvs.reduce((s, v) => s + v, 0) / clvs.length).toFixed(1)
    clvPositivoPct = Math.round((clvs.filter(v => v > 0).length / clvs.length) * 100)
  }

  const boxStat = (label, val, color = C.text, sub = null) => (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 16px", flex: 1, minWidth: 90 }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: C.muted, textTransform: "uppercase", fontFamily: "'Barlow Condensed', sans-serif", marginBottom: 4 }}>{label}</div>
      <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 26, fontWeight: 900, color, lineHeight: 1 }}>{val}</div>
      {sub && <div style={{ fontSize: 11, color: C.muted, marginTop: 3 }}>{sub}</div>}
    </div>
  )

  if (jogos.length === 0) {
    return (
      <div style={{ textAlign: "center", padding: "32px 20px", color: C.muted }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>📊</div>
        <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 16, fontWeight: 700 }}>Nenhum jogo salvo ainda</div>
        <div style={{ fontSize: 12, marginTop: 6 }}>Adicione jogos e marque os resultados para ver as estatísticas aqui.</div>
      </div>
    )
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
        {boxStat("Total", jogos.length, C.blue, `${finalizados.length} finalizados`)}
        {boxStat("🟢 Greens", greens, C.green)}
        {boxStat("🔴 Reds", reds, C.red)}
        {pct !== null
          ? boxStat("% Acerto", pct + "%", pct >= 60 ? C.green : pct >= 45 ? C.yellow : C.red, `${finalizados.length} amostras`)
          : boxStat("% Acerto", "—", C.muted, "sem finalizados")}
        {roi !== null
          ? boxStat("ROI estimado", (roi > 0 ? "+" : "") + roi + "%", parseFloat(roi) >= 0 ? C.green : C.red, `${comOdd.length} com odd`)
          : boxStat("ROI", "—", C.muted, "sem odds")}
        {clvMedio !== null
          ? boxStat("CLV médio", (clvMedio > 0 ? "+" : "") + clvMedio + "%", parseFloat(clvMedio) >= 0 ? C.green : C.red, `${clvPositivoPct}% bateram o fechamento`)
          : boxStat("CLV médio", "—", C.muted, "sem odd de fechamento")}
      </div>

      {finalizados.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 10, color: C.muted, fontWeight: 700, letterSpacing: 1, marginBottom: 6, fontFamily: "'Barlow Condensed', sans-serif" }}>APROVEITAMENTO</div>
          <div style={{ height: 10, borderRadius: 5, background: "rgba(255,255,255,0.06)", overflow: "hidden", display: "flex" }}>
            <div style={{ width: `${pct}%`, background: pct >= 60 ? C.green : pct >= 45 ? C.yellow : C.red, borderRadius: 5, transition: "width 0.5s ease" }} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontSize: 10, color: C.muted }}>
            <span style={{ color: C.green }}>{greens} greens</span>
            <span style={{ color: pct >= 60 ? C.green : pct >= 45 ? C.yellow : C.red, fontWeight: 700 }}>{pct}%</span>
            <span style={{ color: C.red }}>{reds} reds</span>
          </div>
        </div>
      )}

      {finalizados.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 10, color: C.muted, fontWeight: 700, letterSpacing: 1, marginBottom: 8, fontFamily: "'Barlow Condensed', sans-serif" }}>ACERTO POR CONFIANÇA DO MODELO</div>
          <div style={{ display: "flex", gap: 8 }}>
            {porConf.map(({ c, total, greens: g, pct: p }) => {
              const cor = c === "Alta" ? C.green : c === "Média" ? C.yellow : C.red
              return (
                <div key={c} style={{ flex: 1, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 12px", textAlign: "center" }}>
                  <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 13, fontWeight: 700, color: cor, marginBottom: 3 }}>{c}</div>
                  <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 22, fontWeight: 900, color: p !== null ? (p >= 60 ? C.green : p >= 45 ? C.yellow : C.red) : C.muted, lineHeight: 1 }}>
                    {p !== null ? p + "%" : "—"}
                  </div>
                  <div style={{ fontSize: 10, color: C.muted, marginTop: 2 }}>{g}/{total} jogos</div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {porMercado.length > 0 && (
        <div>
          <div style={{ fontSize: 10, color: C.muted, fontWeight: 700, letterSpacing: 1, marginBottom: 8, fontFamily: "'Barlow Condensed', sans-serif" }}>TOP MERCADOS</div>
          {porMercado.map(({ m, total, greens: g, pct: p }) => (
            <div key={m} className="st-linha" style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
              <div style={{ flex: 1, fontSize: 12, color: C.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{m}</div>
              <div style={{ flex: 2, height: 6, borderRadius: 3, background: "rgba(255,255,255,0.05)", overflow: "hidden" }}>
                <div style={{ width: `${p}%`, height: "100%", background: p >= 60 ? C.green : p >= 45 ? C.yellow : C.red, borderRadius: 3, transition: "width 0.4s" }} />
              </div>
              <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 13, fontWeight: 800, color: p >= 60 ? C.green : p >= 45 ? C.yellow : C.red, minWidth: 38, textAlign: "right" }}>{p}%</div>
              <div style={{ fontSize: 11, color: C.muted, minWidth: 30, textAlign: "right" }}>{g}/{total}</div>
            </div>
          ))}
        </div>
      )}

      {/* ✅ NOVO — visão em gráficos: pizza geral + barras por esporte/clima/altitude */}
      {finalizados.length > 0 && (() => {
        const porEsporte = {}
        finalizados.forEach(j => {
          const esp = j.esporte || detectarEsporte(j.liga)
          if (!porEsporte[esp]) porEsporte[esp] = { total: 0, greens: 0 }
          porEsporte[esp].total++
          if (j.resultado === "green") porEsporte[esp].greens++
        })
        const esporteBarData = Object.entries(porEsporte).map(([esp, v]) => ({
          label: esp, value: v.greens,
          color: esp === 'Tênis' ? C.blue : esp === 'Basquete' ? C.purple : C.green,
        }))

        const porClima = {}
        finalizados.filter(j => categoriaClima(j)).forEach(j => {
          const k = categoriaClima(j)
          if (!porClima[k]) porClima[k] = { total: 0, greens: 0 }
          porClima[k].total++
          if (j.resultado === "green") porClima[k].greens++
        })
        const climaBarData = Object.entries(porClima).map(([c, v]) => ({
          label: c, value: Math.round((v.greens / v.total) * 100), color: C.blue,
        }))

        const porAltitude = {}
        finalizados.filter(j => categoriaAltitude(j)).forEach(j => {
          const k = categoriaAltitude(j)
          if (!porAltitude[k]) porAltitude[k] = { total: 0, greens: 0 }
          porAltitude[k].total++
          if (j.resultado === "green") porAltitude[k].greens++
        })
        const altitudeBarData = Object.entries(porAltitude).map(([a, v]) => ({
          label: a, value: Math.round((v.greens / v.total) * 100), color: C.purple,
        }))

        return (
          <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 20 }}>
            <div>
              <div style={{ fontSize: 10, color: C.muted, fontWeight: 700, letterSpacing: 1, marginBottom: 8, fontFamily: "'Barlow Condensed', sans-serif" }}>🍕 GREEN × RED (GERAL)</div>
              <PieChart data={[
                { label: "Green", value: greens, color: C.green },
                { label: "Red",   value: reds,   color: C.red },
              ]} />
            </div>

            {esporteBarData.length > 1 && (
              <div>
                <div style={{ fontSize: 10, color: C.muted, fontWeight: 700, letterSpacing: 1, marginBottom: 8, fontFamily: "'Barlow Condensed', sans-serif" }}>📊 GREENS POR ESPORTE</div>
                <BarChart data={esporteBarData} />
              </div>
            )}

            {climaBarData.length > 0 && (
              <div>
                <div style={{ fontSize: 10, color: C.muted, fontWeight: 700, letterSpacing: 1, marginBottom: 8, fontFamily: "'Barlow Condensed', sans-serif" }}>🌦️ % DE ACERTO POR CLIMA</div>
                <HBarChart data={climaBarData} maxValue={100} />
              </div>
            )}

            {altitudeBarData.length > 0 && (
              <div>
                <div style={{ fontSize: 10, color: C.muted, fontWeight: 700, letterSpacing: 1, marginBottom: 8, fontFamily: "'Barlow Condensed', sans-serif" }}>🏔️ % DE ACERTO POR ALTITUDE</div>
                <HBarChart data={altitudeBarData} maxValue={100} />
              </div>
            )}

            {climaBarData.length === 0 && altitudeBarData.length === 0 && (
              <div style={{ fontSize: 11, color: C.muted, fontStyle: "italic" }}>
                Marque clima/altitude ao salvar novos jogos pra esses gráficos aparecerem aqui.
              </div>
            )}
          </div>
        )
      })()}
    </div>
  )
}

// ─── ✅ NOVO — Ranking de times e confrontos que mais deram Green ─────
function RankingTimes({ jogos }) {
  const finalizados = jogos.filter(j => j.resultado !== null)

  if (finalizados.length === 0) {
    return (
      <div style={{ textAlign: "center", padding: "32px 0", color: C.muted }}>
        <div style={{ fontSize: 32, marginBottom: 10 }}>🏆</div>
        <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 16, fontWeight: 700 }}>Sem dados suficientes</div>
        <div style={{ fontSize: 12, marginTop: 6 }}>Marque resultados no histórico para o ranking aparecer aqui.</div>
      </div>
    )
  }

  // Por CONFRONTO (mandante x visitante)
  const confrontoMap = {}
  finalizados.forEach(j => {
    const chave = `${j.mandante} x ${j.visitante}`
    if (!confrontoMap[chave]) confrontoMap[chave] = { total: 0, greens: 0 }
    confrontoMap[chave].total++
    if (j.resultado === "green") confrontoMap[chave].greens++
  })
  const porConfronto = Object.entries(confrontoMap)
    .map(([confronto, v]) => ({ confronto, ...v, pct: Math.round((v.greens / v.total) * 100) }))
    .filter(c => c.greens > 0)
    .sort((a, b) => b.greens - a.greens || b.pct - a.pct)
    .slice(0, 10)

  // Por TIME (conta o time como mandante ou visitante)
  const timeMap = {}
  finalizados.forEach(j => {
    ;[j.mandante, j.visitante].forEach(time => {
      if (!time) return
      if (!timeMap[time]) timeMap[time] = { total: 0, greens: 0 }
      timeMap[time].total++
      if (j.resultado === "green") timeMap[time].greens++
    })
  })
  const porTime = Object.entries(timeMap)
    .map(([time, v]) => ({ time, ...v, pct: Math.round((v.greens / v.total) * 100) }))
    .filter(t => t.greens > 0)
    .sort((a, b) => b.greens - a.greens || b.pct - a.pct)
    .slice(0, 10)

  const linha = (label, total, greens, pct, key) => (
    <div key={key} className="st-linha" style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
      <div style={{ flex: 1, fontSize: 12, color: C.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</div>
      <div style={{ flex: 2, height: 6, borderRadius: 3, background: "rgba(255,255,255,0.05)", overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: pct >= 60 ? C.green : pct >= 45 ? C.yellow : C.red, borderRadius: 3 }} />
      </div>
      <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 13, fontWeight: 800, color: pct >= 60 ? C.green : pct >= 45 ? C.yellow : C.red, minWidth: 38, textAlign: "right" }}>{pct}%</div>
      <div style={{ fontSize: 11, color: C.green, minWidth: 46, textAlign: "right" }}>{greens}🟢/{total}</div>
    </div>
  )

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 10, color: C.muted, fontWeight: 700, letterSpacing: 1, marginBottom: 8, fontFamily: "'Barlow Condensed', sans-serif" }}>
          🏆 TIMES COM MAIS GREEN
        </div>
        {porTime.length === 0
          ? <div style={{ fontSize: 12, color: C.muted }}>Nenhum green registrado ainda.</div>
          : porTime.map(t => linha(t.time, t.total, t.greens, t.pct, t.time))}
      </div>

      <div>
        <div style={{ fontSize: 10, color: C.muted, fontWeight: 700, letterSpacing: 1, marginBottom: 8, fontFamily: "'Barlow Condensed', sans-serif" }}>
          🎯 CONFRONTOS COM MAIS GREEN
        </div>
        {porConfronto.length === 0
          ? <div style={{ fontSize: 12, color: C.muted }}>Nenhum green registrado ainda.</div>
          : porConfronto.map(c => linha(c.confronto, c.total, c.greens, c.pct, c.confronto))}
      </div>
    </div>
  )
}

// ─── ✅ NOVO — Gráficos (pizza e barras) ───────────────────────
const ULTIMOS_N = 30

function parsePlacar(p) {
  const m = /^(\d+)\s*[-x×]\s*(\d+)$/.exec(String(p || "").trim())
  return m ? { h: parseInt(m[1], 10), a: parseInt(m[2], 10) } : null
}

const corPct = (p) => p == null ? C.muted : p >= 60 ? C.green : p >= 45 ? C.yellow : C.red

const tituloGrafico = {
  fontSize: 10, color: C.muted, fontWeight: 700, letterSpacing: 1,
  marginBottom: 10, fontFamily: "'Barlow Condensed', sans-serif", textTransform: "uppercase",
}
const caixaGrafico = {
  background: C.surface, border: `1px solid ${C.border}`,
  borderRadius: 10, padding: 14, flex: 1, minWidth: 240,
}

function PieChartSvg({ data, size = 120 }) {
  const total = data.reduce((s, d) => s + d.value, 0)
  if (total === 0) return null
  const r = size / 2 - 4, cx = size / 2, cy = size / 2
  const visiveis = data.filter(d => d.value > 0)
  let ang = -Math.PI / 2
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }}>
      {visiveis.length === 1
        ? <circle cx={cx} cy={cy} r={r} fill={visiveis[0].color} />
        : visiveis.map(d => {
            const fatia = (d.value / total) * Math.PI * 2
            const x1 = cx + r * Math.cos(ang), y1 = cy + r * Math.sin(ang)
            ang += fatia
            const x2 = cx + r * Math.cos(ang), y2 = cy + r * Math.sin(ang)
            return (
              <path key={d.label}
                d={`M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${fatia > Math.PI ? 1 : 0} 1 ${x2},${y2} Z`}
                fill={d.color} stroke={C.surface} strokeWidth="2" />
            )
          })}
    </svg>
  )
}

function PieCard({ titulo, data }) {
  const total = data.reduce((s, d) => s + d.value, 0)
  return (
    <div style={caixaGrafico}>
      <div style={tituloGrafico}>{titulo}</div>
      {total === 0 ? (
        <div style={{ fontSize: 12, color: C.muted }}>Sem dados ainda.</div>
      ) : (
        <div className="st-pie" style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <PieChartSvg data={data} />
          <div>
            {data.map(d => (
              <div key={d.label} style={{ fontSize: 12, color: C.text, marginBottom: 5, display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 10, height: 10, borderRadius: 2, background: d.color, display: "inline-block" }} />
                {d.label}: <strong>{d.value}</strong> <span style={{ color: C.muted }}>({Math.round((d.value / total) * 100)}%)</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function BarraH({ label, pct, texto, sub, cor }) {
  return (
    <div className="st-barra" style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
      <div style={{ width: 118, fontSize: 12, color: C.text }}>{label}</div>
      <div style={{ flex: 1, height: 10, borderRadius: 5, background: "rgba(255,255,255,0.05)", overflow: "hidden" }}>
        <div style={{ width: `${Math.max(0, Math.min(100, pct))}%`, height: "100%", background: cor, borderRadius: 5 }} />
      </div>
      <div style={{ minWidth: 40, textAlign: "right", fontFamily: "'Barlow Condensed', sans-serif", fontSize: 14, fontWeight: 800, color: cor }}>{texto}</div>
      {sub != null && <div style={{ fontSize: 10, color: C.muted, minWidth: 34, textAlign: "right" }}>{sub}</div>}
    </div>
  )
}

// ordem = [[chave, rótulo], ...]
function taxaPorFaixa(finalizados, classificar, ordem) {
  const mapa = {}
  finalizados.forEach(j => {
    const f = classificar(j)
    if (!f) return
    if (!mapa[f]) mapa[f] = { total: 0, greens: 0 }
    mapa[f].total++
    if (j.resultado === "green") mapa[f].greens++
  })
  return ordem.map(([key, label]) => {
    const v = mapa[key] || { total: 0, greens: 0 }
    return { key, label, total: v.total, greens: v.greens, pct: v.total ? Math.round((v.greens / v.total) * 100) : null }
  })
}

// Só futebol entra nas pizzas/gols: placar de tênis (sets) e basquete (pontos)
// distorceria "Over 2.5 gols" e a média de gols.
function ehFutebol(j) {
  const esp = String(j.esporte || "").toLowerCase()
  if (esp && !["futebol", "football", "soccer"].includes(esp)) return false
  return detectarEsporte(j.liga) === "Futebol"
}

// Mesma partida pode ter até 3 entradas (gols + cartões + escanteios) com o
// mesmo placar — conta o jogo UMA vez só.
function chaveDoJogo(j) {
  return String(j.eventoId ?? `${j.mandante}|${j.visitante}|${String(j.dataJogo || j.marcadoEm || j.criadoEm || "").slice(0, 10)}`)
}

const AUTO_REFRESH_MS = 60 * 1000

// ✅ Busca os dados ATUAIS do sistema (/api/tracker) ao abrir a aba, a cada 60s
// e no botão "Atualizar" — não depende mais do que foi carregado quando o
// Tracker abriu. Mantém os últimos dados se uma atualização falhar.
function GraficosTracker({ jogosIniciais, filtroLiga = "Todas", versao = null }) {
  const [timeSel, setTimeSel] = useState("Todos")
  const [dados, setDados] = useState(Array.isArray(jogosIniciais) ? jogosIniciais : [])
  const [atualizando, setAtualizando] = useState(true)
  const [ultimaAtualizacao, setUltimaAtualizacao] = useState(null)
  const [erroAtualizar, setErroAtualizar] = useState(false)

  const atualizar = useCallback(async () => {
    setAtualizando(true)
    try {
      const res = await fetch(`${API_BASE}/api/tracker`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setDados(Array.isArray(data) ? data : [])
      setUltimaAtualizacao(new Date())
      setErroAtualizar(false)
    } catch (err) {
      console.warn("[gráficos] falha ao atualizar:", err.message)
      setErroAtualizar(true)
    } finally {
      setAtualizando(false)
    }
  }, [])

  useEffect(() => {
    atualizar()
    const timer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") atualizar()
    }, AUTO_REFRESH_MS)
    return () => clearInterval(timer)
  }, [atualizar, versao]) // `versao` muda quando o Tracker salva/sincroniza/zera → rebusca na hora

  const base = filtroLiga === "Todas" ? dados : dados.filter(j => j.liga === filtroLiga)
  const finalizados = base.filter(j => j.resultado === "green" || j.resultado === "red")
  const ordenados = [...finalizados].sort(
    (a, b) => new Date(b.marcadoEm || b.criadoEm) - new Date(a.marcadoEm || a.criadoEm)
  )

  // 1 linha por partida de futebol com placar (mais recentes primeiro)
  const vistos = new Set()
  const comPlacar = []
  for (const j of ordenados) {
    if (!ehFutebol(j)) continue
    const p = parsePlacar(j.placarFinal)
    if (!p) continue
    const chave = chaveDoJogo(j)
    if (vistos.has(chave)) continue
    vistos.add(chave)
    comPlacar.push({ j, p })
  }
  const ultimos = comPlacar.slice(0, ULTIMOS_N)

  // ── Pizza 1: casa / empate / fora ──
  const pizzaResultado = [
    { label: "Casa",   value: ultimos.filter(x => x.p.h > x.p.a).length,  color: C.green },
    { label: "Empate", value: ultimos.filter(x => x.p.h === x.p.a).length, color: C.yellow },
    { label: "Fora",   value: ultimos.filter(x => x.p.h < x.p.a).length,  color: C.blue },
  ]

  // ── Pizza 2: over / under 2.5 ──
  const pizzaOU = [
    { label: "Over 2.5",  value: ultimos.filter(x => x.p.h + x.p.a > 2.5).length,  color: C.green },
    { label: "Under 2.5", value: ultimos.filter(x => x.p.h + x.p.a <= 2.5).length, color: C.red },
  ]

  // ── Barras: gols marcados/sofridos casa x fora (todos ou por time) ──
  const times = ["Todos", ...Array.from(new Set(
    comPlacar.flatMap(x => [x.j.mandante, x.j.visitante]).filter(Boolean)
  )).sort()]
  const timeAtivo = times.includes(timeSel) ? timeSel : "Todos"
  let casaJ = 0, casaM = 0, casaS = 0, foraJ = 0, foraM = 0, foraS = 0
  comPlacar.forEach(({ j, p }) => {
    if (timeAtivo === "Todos") {
      casaJ++; casaM += p.h; casaS += p.a
      foraJ++; foraM += p.a; foraS += p.h
    } else if (j.mandante === timeAtivo) { casaJ++; casaM += p.h; casaS += p.a }
    else if (j.visitante === timeAtivo)  { foraJ++; foraM += p.a; foraS += p.h }
  })
  const med = (s, n) => n ? +(s / n).toFixed(2) : null
  const barrasGols = [
    { label: `Casa · marcados (${casaJ}j)`,  v: med(casaM, casaJ), cor: C.green },
    { label: `Casa · sofridos`,              v: med(casaS, casaJ), cor: C.red },
    { label: `Fora · marcados (${foraJ}j)`,  v: med(foraM, foraJ), cor: C.green },
    { label: `Fora · sofridos`,              v: med(foraS, foraJ), cor: C.red },
  ]
  const escalaGols = Math.max(3, ...barrasGols.map(b => b.v ?? 0))

  // ── Barras: % green por clima / altitude ──
  // Entradas manuais guardam clima/altitude como texto do formulário; as
  // automáticas (análise) guardam um objeto com temperatura/chuva/vento/altitude.
  // categoriaClima/categoriaAltitude unificam os dois formatos nos mesmos rótulos.
  const porCategoria = (lista, extrair, ordem) => {
    const mapa = {}
    lista.forEach(j => {
      const k = extrair(j)
      if (!k) return
      if (!mapa[k]) mapa[k] = { total: 0, greens: 0 }
      mapa[k].total++
      if (j.resultado === "green") mapa[k].greens++
    })
    const pos = k => { const i = ordem.indexOf(k); return i < 0 ? 99 : i }
    return Object.entries(mapa)
      .map(([key, v]) => ({
        key, label: key, total: v.total, greens: v.greens,
        pct: v.total ? Math.round((v.greens / v.total) * 100) : null,
      }))
      .sort((a, b) => pos(a.key) - pos(b.key))
  }
  const porChuva = porCategoria(finalizados, categoriaClima, CLIMAS)
  const porAlt   = porCategoria(finalizados, categoriaAltitude, ALTITUDES)

  const blocoFaixas = (titulo, dadosFaixa) => (
    <div style={{ ...caixaGrafico, marginBottom: 12 }}>
      <div style={tituloGrafico}>{titulo}</div>
      {!dadosFaixa.some(d => d.total > 0)
        ? <div style={{ fontSize: 12, color: C.muted }}>Ainda sem entradas finalizadas com esse dado — os jogos analisados já gravam clima/altitude automaticamente.</div>
        : dadosFaixa.map(d => (
            <BarraH key={d.key} label={d.label} pct={d.pct ?? 0} cor={corPct(d.pct)}
              texto={d.pct == null ? "—" : `${d.pct}%`} sub={`${d.greens}/${d.total}`} />
          ))}
    </div>
  )

  const hhmm = ultimaAtualizacao
    ? ultimaAtualizacao.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
    : null

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: C.muted, flex: 1, minWidth: 200 }}>
          Dados atuais do sistema · {finalizados.length} entradas finalizadas · {comPlacar.length} jogos de futebol com placar
          {hhmm ? ` · atualizado às ${hhmm}` : ""}
        </div>
        <Btn small outline onClick={atualizar} disabled={atualizando}>
          {atualizando ? "Atualizando…" : "↻ Atualizar"}
        </Btn>
      </div>

      {erroAtualizar && (
        <div style={{ fontSize: 11, color: C.red, marginBottom: 12 }}>
          ⚠️ Não foi possível atualizar agora — mostrando os últimos dados carregados.
        </div>
      )}

      {finalizados.length === 0 ? (
        <div style={{ textAlign: "center", padding: "32px 0", color: C.muted }}>
          <div style={{ fontSize: 32, marginBottom: 10 }}>📈</div>
          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 16, fontWeight: 700 }}>Sem dados suficientes</div>
          <div style={{ fontSize: 12, marginTop: 6 }}>Os gráficos aparecem assim que houver jogos finalizados.</div>
        </div>
      ) : (
        <>
          <div style={{ fontSize: 11, color: C.muted, marginBottom: 12 }}>
            Pizzas e gols: últimos {Math.min(ULTIMOS_N, comPlacar.length)} jogos de futebol com placar (cada jogo conta uma vez) · Clima/altitude: % de green nas {finalizados.length} entradas finalizadas.
          </div>

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
            <PieCard titulo="Resultado (casa / empate / fora)" data={pizzaResultado} />
            <PieCard titulo="Over / Under 2.5 gols" data={pizzaOU} />
          </div>

          <div style={{ ...caixaGrafico, marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 8, flexWrap: "wrap" }}>
              <div style={{ ...tituloGrafico, marginBottom: 0 }}>Gols por jogo — casa x fora</div>
              <Select value={timeAtivo} onChange={setTimeSel} options={times.map(t => ({ value: t, label: t }))} />
            </div>
            {casaJ + foraJ === 0
              ? <div style={{ fontSize: 12, color: C.muted }}>Sem placares registrados para esse filtro.</div>
              : barrasGols.map(b => (
                  <BarraH key={b.label} label={b.label} pct={b.v == null ? 0 : (b.v / escalaGols) * 100}
                    cor={b.cor} texto={b.v == null ? "—" : b.v.toFixed(2)} />
                ))}
          </div>

          {blocoFaixas("% Green — por condição climática", porChuva)}
          {blocoFaixas("% Green — por faixa de altitude", porAlt)}
        </>
      )}
    </div>
  )
}

// ─── APP PRINCIPAL ─────────────────────────────────────────

function CalibracaoPanel({ refreshKey }) {
  const [rel, setRel] = useState(null)
  const [ctx, setCtx] = useState(null) // ✅ NOVO — relatório unificado por esporte/clima/altitude
    const [ten, setTen] = useState(null) // ✅ NOVO — calibração separada do tênis
  const [oos, setOos] = useState(null) // ✅ NOVO — Fase 3, item 10: validação out-of-sample
  const [gate, setGate] = useState(null) // ✅ NOVO — Fase 3, item 12: checklist pré-deploy
  const [drift, setDrift] = useState(null) // ✅ NOVO — Fase 4: monitoramento de drift
  const [driftFeatures, setDriftFeatures] = useState(null) // ✅ NOVO — Fase 7, item 41: drift de features
  const [segmentoReliability, setSegmentoReliability] = useState('global') // ✅ NOVO — Fase 7, item 40
  const [loading, setLoading] = useState(true)
  const [erro, setErro] = useState(null)

  useEffect(() => {
    let dead = false
    setLoading(true)
    setErro(null)
    Promise.all([relatorioCalibracaoCompleto(), relatorioPorContexto(), relatorioCalibracaoTenis(), validacaoOutOfSample(), checklistPreDeploy(), relatorioDrift(), relatorioDriftFeatures()])
      .then(([r, c, t, o, g, d, df]) => { if (!dead) { setRel(r); setCtx(c); setTen(t); setOos(o); setGate(g); setDrift(d); setDriftFeatures(df) } })
      .catch(e => { if (!dead) setErro(e.message || 'Falha ao carregar') })
      .finally(() => { if (!dead) setLoading(false) })
    return () => { dead = true }
  }, [refreshKey])

  if (loading) {
    return <div style={{ padding: 24, color: C.muted, textAlign: 'center' }}>📊 Calculando previsto × real…</div>
  }
  if (erro) {
    return <div style={{ padding: 24, color: C.red }}>Erro: {erro}</div>
  }
  if ((!rel || rel.totalFinalizados === 0) && !(ten && ten.totalFinalizados > 0)) {
    return (
      <div style={{ padding: 28, textAlign: 'center', color: C.muted }}>
        <div style={{ fontSize: 32, marginBottom: 10 }}>📊</div>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>Sem dados de calibração ainda</div>
        <div style={{ fontSize: 13, lineHeight: 1.5 }}>
          Salve jogos da análise no Tracker e marque 🟢 ou 🔴 após o resultado.<br/>
          Com ~20+ finalizados o painel mostra se o modelo está calibrado.
        </div>
      </div>
    )
  }

  const statusCor = (st) => {
    if (st === 'calibrado') return C.green
    if (st === 'subestima') return C.yellow
    if (st === 'superestima') return C.red
    return C.muted
  }

  return (
    <div className="st-cal" style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Resumo */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
        {[
          { l: 'Finalizados', v: rel.totalFinalizados, c: C.blue },
          { l: 'Taxa acerto', v: rel.taxaAcertoGeral != null ? `${rel.taxaAcertoGeral}%` : '—', c: C.green },
          { l: 'Brier Score', v: rel.brierScore != null ? rel.brierScore : '—', c: C.yellow, t: 'Menor = melhor (0 = perfeito)' },
        ].map(x => (
          <div key={x.l} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: '12px 14px' }}>
            <div style={{ fontSize: 11, color: C.muted, fontWeight: 700, letterSpacing: 1 }}>{x.l}</div>
            <div style={{ fontSize: 22, fontWeight: 900, color: x.c, fontFamily: "'Barlow Condensed', sans-serif" }} title={x.t || ''}>{x.v}</div>
          </div>
        ))}
      </div>

            {rel.arquivadas > 0 && (
        <div style={{ fontSize: 11, color: C.sub, background: C.blue + '0d', border: `1px solid ${C.blue}20`, borderRadius: 8, padding: '8px 12px', lineHeight: 1.5 }}>
          🗄️ {rel.arquivadas} dos {rel.totalFinalizados} finalizados são de antes do último "Zerar histórico": continuam calibrando o modelo, mas não aparecem no Histórico, Dashboard, Ranking nem Gráficos.
        </div>
      )}

      {/* ✅ NOVO — Fase 3, item 12: banner GO/NO-GO pré-deploy */}
      {gate && (
        <div style={{
          background: gate.podeDeployar ? C.green + '15' : C.red + '15',
          border: `1px solid ${gate.podeDeployar ? C.green : C.red}40`,
          borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 900, fontSize: 15, letterSpacing: 1, color: gate.podeDeployar ? C.green : C.red }}>
            {gate.podeDeployar ? '✅ GO — pode subir versão nova' : '🚫 NO-GO — não subir versão nova'}
          </div>
          {gate.motores.map(m => (
            <div key={m.motor} style={{ fontSize: 12, color: C.sub }}>
              <strong>{m.motor}</strong> (v{m.versaoAtual}, n={m.n}, Brier={m.brier ?? '—'}): {m.status === 'bloqueado' ? `🚫 ${m.motivos?.join('; ')}` : '✅ ok'}
            </div>
          ))}
        </div>
      )}

      {/* ✅ NOVO — Fase 4: monitoramento de drift */}
      {drift && (
        drift.geral ? (
          <div style={{
            background: drift.geral.status === 'drift' ? C.red + '15' : C.surface,
            border: `1px solid ${drift.geral.status === 'drift' ? C.red + '40' : C.border}`,
            borderRadius: 12, padding: 14,
          }}>
            <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800, fontSize: 15, marginBottom: 8, letterSpacing: 1, color: drift.geral.status === 'drift' ? C.red : undefined }}>
              {drift.geral.status === 'drift' ? '⚠️ DRIFT DETECTADO' : '📈 MONITORAMENTO DE DRIFT'}
            </div>
            <div style={{ fontSize: 12, color: C.sub, lineHeight: 1.5 }}>
              Últimas {drift.geral.n} entradas: {drift.geral.taxaJanela}% de acerto (IC 95%: {drift.geral.icBaixo}–{drift.geral.icAlto}%) vs {drift.geral.taxaHistorico}% no histórico anterior ({drift.geral.nHistorico} entradas).
              {drift.geral.status === 'drift' && ' A taxa histórica está acima do teto do IC da janela recente — queda provavelmente real, não ruído.'}
            </div>
            {drift.porVersaoMotor?.length > 0 && (
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {drift.porVersaoMotor.map(v => (
                  <div key={v.motorVersao} style={{ fontSize: 11, color: v.drift.status === 'drift' ? C.red : C.muted }}>
                    {v.drift.status === 'drift' ? '⚠️' : '·'} <strong>{v.motorVersao}</strong>: {v.drift.taxaJanela}% (últimas {v.drift.n}) vs {v.drift.taxaHistorico}% histórico
                  </div>
                ))}
              </div>
            )}

                  {/* ✅ NOVO — Fase 7, item 41: drift na distribuição das features (não só na taxa de acerto) */}
      {driftFeatures?.porLiga?.length > 0 && (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, marginBottom: 12 }}>
          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800, fontSize: 15, marginBottom: 8, letterSpacing: 1 }}>
            📊 DRIFT DE FEATURES POR LIGA
          </div>
          {driftFeatures.porLiga.map(l => (
            <div key={l.liga} style={{ fontSize: 12, marginBottom: 6, color: (l.lambdaEsperado?.status === 'drift' || l.oddImplicita?.status === 'drift') ? C.red : C.muted }}>
              <strong>{l.liga}</strong>
              {l.lambdaEsperado && ` · gols esperados: ${l.lambdaEsperado.mediaHistorico} → ${l.lambdaEsperado.mediaJanela} (z=${l.lambdaEsperado.zScore})${l.lambdaEsperado.status === 'drift' ? ' ⚠️' : ''}`}
              {l.oddImplicita && ` · prob. de mercado: ${(l.oddImplicita.mediaHistorico * 100).toFixed(1)}% → ${(l.oddImplicita.mediaJanela * 100).toFixed(1)}% (z=${l.oddImplicita.zScore})${l.oddImplicita.status === 'drift' ? ' ⚠️' : ''}`}
            </div>
          ))}
        </div>
      )}
          </div>
        ) : (
          <div style={{ fontSize: 11, color: C.muted, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 12px' }}>
            📈 Drift: ainda sem amostra suficiente (precisa de pelo menos {30 + 10} finalizados; janela de 30 + histórico anterior).
          </div>
        )
      )}

      {/* ✅ NOVO — Fase 3, item 10: validação out-of-sample */}
      {gate && (
        <div style={{
          background: gate.podeDeployar ? C.green + '14' : C.red + '14',
          border: `1px solid ${gate.podeDeployar ? C.green : C.red}40`,
          borderRadius: 12, padding: 14,
        }}>
          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800, fontSize: 15, marginBottom: 8, letterSpacing: 1, color: gate.podeDeployar ? C.green : C.red }}>
            {gate.podeDeployar ? '✅ OK PRA SUBIR VERSÃO NOVA' : '🚫 NÃO SUBA VERSÃO NOVA AINDA'}
          </div>
          {gate.motores.map(m => (
            <div key={m.motor} style={{ marginBottom: 8, fontSize: 12, lineHeight: 1.5 }}>
              <div style={{ fontWeight: 700, textTransform: 'uppercase', color: C.muted, fontSize: 11 }}>
                {m.motor} {m.versaoAtual ? `— ${m.versaoAtual}` : ''}
              </div>
              {m.motivos.map((mo, i) => <div key={i} style={{ color: m.status === 'bloqueado' ? C.red : C.sub }}>• {mo}</div>)}
            </div>
          ))}
          {gate.oos.suficiente === false && (
            <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>ℹ️ Validação out-of-sample ainda sem amostra suficiente (ver seção abaixo).</div>
          )}
        </div>
      )}

      {/* ✅ NOVO — Fase 3, item 10: validação out-of-sample */}
      {oos && (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14 }}>
          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800, fontSize: 15, marginBottom: 10, letterSpacing: 1 }}>
            VALIDAÇÃO FORA DA AMOSTRA (OUT-OF-SAMPLE)
          </div>
          {!oos.suficiente ? (
            <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5 }}>{oos.mensagem}</div>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 11, color: C.muted, fontWeight: 700 }}>TREINO / TESTE</div>
                  <div style={{ fontSize: 16, fontWeight: 800 }}>{oos.totalTreino} / {oos.totalTeste}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: C.muted, fontWeight: 700 }}>BRIER BRUTO (SEM CALIBRAR)</div>
                  <div style={{ fontSize: 16, fontWeight: 800 }}>{oos.brierBruto ?? '—'}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: C.muted, fontWeight: 700 }}>BRIER CALIBRADO</div>
                  <div style={{ fontSize: 16, fontWeight: 800, color: oos.melhorou ? C.green : C.red }}>{oos.brierCalibrado ?? '—'}</div>
                </div>
              </div>
              <div style={{ fontSize: 12, color: oos.melhorou ? C.green : C.red, fontWeight: 700, marginBottom: oos.mercados?.length ? 10 : 0 }}>
                {oos.melhorou
                  ? '✅ A calibração generaliza: no teste (jogos que o fator nunca viu), o Brier calibrado ficou melhor que o bruto.'
                  : '⚠️ A calibração não melhorou o teste fora da amostra — pode ser ruído do treino ou amostra ainda pequena. Acompanhe nas próximas rodadas.'}
              </div>
              {oos.mercados?.length > 0 && (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ color: C.muted, textAlign: 'left' }}>
                        {['Mercado', 'N (teste)', 'Taxa real (IC 95%)', 'Brier bruto', 'Brier calibrado', 'Fator (treino)'].map(h => (
                          <th key={h} style={{ padding: '6px 8px', borderBottom: `1px solid ${C.border}`, fontWeight: 700 }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {oos.mercados.map(m => (
                        <tr key={m.mercado}>
                          <td style={{ padding: '8px', fontWeight: 700 }}>{m.mercado}</td>
                          <td style={{ padding: '8px' }}>{m.n}</td>
                          <td style={{ padding: '8px' }}>
                            {m.taxaRealPct}%
                            {m.icBaixo != null && (
                              <div style={{ fontSize: 10, color: C.muted }}>[{m.icBaixo}–{m.icAlto}%]</div>
                            )}
                          </td>
                          <td style={{ padding: '8px' }}>{m.brierBruto}</td>
                          <td style={{ padding: '8px', color: m.brierCalibrado < m.brierBruto ? C.green : C.red }}>{m.brierCalibrado}</td>
                          <td style={{ padding: '8px' }}>×{m.fatorUsado}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
          <div style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>
            Treino = 70% dos finalizados mais antigos (calcula o fator). Teste = os 30% mais recentes (nunca entram no cálculo do fator) — o Brier é comparado só nesse grupo "não visto".
          </div>
        </div>
      )}

      {/* Por mercado */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14 }}>
        <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800, fontSize: 15, marginBottom: 10, letterSpacing: 1 }}>
          PREVISTO × REAL POR MERCADO
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ color: C.muted, textAlign: 'left' }}>
                {['Mercado', 'N', 'Previsto', 'Real (IC 95%)', 'Erro', 'Fator', 'Status'].map(h => (
                  <th key={h} style={{ padding: '6px 8px', borderBottom: `1px solid ${C.border}`, fontWeight: 700 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rel.mercados.map(m => (
                <tr key={m.mercado}>
                  <td style={{ padding: '8px', fontWeight: 700 }}>{m.mercado}</td>
                  <td style={{ padding: '8px' }}>{m.n}</td>
                  <td style={{ padding: '8px' }}>{m.previsto}%</td>
                  <td style={{ padding: '8px' }}>
                    {m.real}%
                    {m.icBaixo != null && (
                      <div style={{ fontSize: 10, color: C.muted }}>[{m.icBaixo}–{m.icAlto}%]</div>
                    )}
                  </td>
                  <td style={{ padding: '8px', color: Math.abs(m.erro) <= 5 ? C.green : C.yellow }}>
                    {m.erro > 0 ? '+' : ''}{m.erro}pp
                  </td>
                  <td style={{ padding: '8px' }}>×{m.fator}</td>
                  <td style={{ padding: '8px', color: statusCor(m.status), fontWeight: 700 }}>{m.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>
          Erro = real − previsto. Positivo = modelo subestimava. Fator &lt; 1 reduz a % na próxima análise.
        </div>
      </div>

      {/* Por faixa */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14 }}>
        <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800, fontSize: 15, marginBottom: 10, letterSpacing: 1 }}>
          CALIBRAÇÃO POR FAIXA DE PROBABILIDADE
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rel.faixas.map(f => (
            <div key={f.faixa} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ width: 64, fontWeight: 800, fontSize: 13 }}>{f.faixa}%</div>
              <div style={{ flex: 1, minWidth: 120, height: 10, background: C.border, borderRadius: 6, overflow: 'hidden', position: 'relative' }}>
                {f.n > 0 && (
                  <>
                    <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${Math.min(100, f.previsto)}%`, background: C.blue + '90' }} title={`previsto ${f.previsto}%`} />
                    <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${Math.min(100, f.real)}%`, background: C.green + '55', borderRight: `2px solid ${C.green}` }} title={`real ${f.real}%`} />
                  </>
                )}
              </div>
              <div style={{ fontSize: 12, color: C.sub, minWidth: 160 }}>
                {f.n === 0 ? 'sem dados' : `n=${f.n} · prev ${f.previsto}% · real ${f.real}% · err ${f.erro > 0 ? '+' : ''}${f.erro}pp`}
              </div>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>
          Barra azul = previsto · verde = real. Ideal: as duas próximas.
        </div>
      </div>

      {/* ✅ REVISADO — Fase 7, item 40: reliability diagram seletável por mercado/liga */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800, fontSize: 15, letterSpacing: 1 }}>
            RELIABILITY DIAGRAM
          </div>
          <select
            value={segmentoReliability}
            onChange={e => setSegmentoReliability(e.target.value)}
            style={{ background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: '4px 8px', fontSize: 12 }}
          >
            <option value="global">Global</option>
            {Object.keys(rel.faixasPorMercado || {}).length > 0 && (
              <optgroup label="Por mercado">
                {Object.keys(rel.faixasPorMercado).sort().map(m => (
                  <option key={`m:${m}`} value={`mercado:${m}`}>{m}</option>
                ))}
              </optgroup>
            )}
            {Object.keys(rel.faixasPorLiga || {}).length > 0 && (
              <optgroup label="Por liga">
                {Object.keys(rel.faixasPorLiga).sort().map(l => (
                  <option key={`l:${l}`} value={`liga:${l}`}>{l}</option>
                ))}
              </optgroup>
            )}
          </select>
        </div>
        {(() => {
          let faixasAtivas = rel.faixas
          if (segmentoReliability.startsWith('mercado:')) {
            faixasAtivas = rel.faixasPorMercado?.[segmentoReliability.slice(8)] || rel.faixas
          } else if (segmentoReliability.startsWith('liga:')) {
            faixasAtivas = rel.faixasPorLiga?.[segmentoReliability.slice(5)] || rel.faixas
          }
          return (
            <>
              <svg viewBox="0 0 240 220" style={{ width: '100%', maxWidth: 320, display: 'block', margin: '0 auto' }}>
                <line x1={40} y1={190} x2={220} y2={190} stroke={C.border} strokeWidth={1} />
                <line x1={40} y1={190} x2={40} y2={10} stroke={C.border} strokeWidth={1} />
                <line x1={40} y1={190} x2={220} y2={10} stroke={C.muted} strokeWidth={1} strokeDasharray="4 3" />
                {[0, 50, 100].map(t => (
                  <g key={t}>
                    <text x={40 + (t / 100) * 180} y={204} fontSize={9} fill={C.muted} textAnchor="middle">{t}%</text>
                    <text x={30} y={190 - (t / 100) * 180 + 3} fontSize={9} fill={C.muted} textAnchor="end">{t}%</text>
                  </g>
                ))}
                {faixasAtivas.filter(f => f.n > 0).map(f => {
                  const cx = 40 + (f.previsto / 100) * 180
                  const cy = 190 - (f.real / 100) * 180
                  const r = Math.min(16, 4 + Math.sqrt(f.n) * 1.2)
                  const cor = Math.abs(f.erro) <= 5 ? C.green : C.yellow
                  return (
                    <g key={f.faixa}>
                      <circle cx={cx} cy={cy} r={r} fill={cor + '55'} stroke={cor} strokeWidth={1.5} />
                      <title>{`${f.faixa}%: n=${f.n} · previsto ${f.previsto}% · real ${f.real}% · erro ${f.erro > 0 ? '+' : ''}${f.erro}pp`}</title>
                    </g>
                  )
                })}
              </svg>
              <div style={{ fontSize: 11, color: C.muted, marginTop: 6, textAlign: 'center' }}>
                Eixo X = probabilidade prevista · Eixo Y = taxa real de acerto · tamanho do ponto = N da faixa. Pontos sobre a diagonal tracejada = calibração perfeita.
                {segmentoReliability !== 'global' && <><br />Segmentos com menos de 15 entradas não aparecem na lista.</>}
              </div>
            </>
          )
        })()}
      </div>

      {/* ✅ NOVO — Fase 1, item 4: acerto/Brier por versão do motor (futebol) */}
      {rel.porVersaoMotor?.length > 1 && (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14 }}>
          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800, fontSize: 15, marginBottom: 10, letterSpacing: 1 }}>
            ⚙️ FUTEBOL — POR VERSÃO DO MOTOR
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ color: C.muted, textAlign: 'left' }}>
                  {['Versão', 'N', 'Greens', 'Reds', 'Previsto', 'Real', 'Brier'].map(h => (
                    <th key={h} style={{ padding: '6px 8px', borderBottom: `1px solid ${C.border}`, fontWeight: 700 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rel.porVersaoMotor.map(v => (
                  <tr key={v.motorVersao}>
                    <td style={{ padding: '8px', fontWeight: 700 }}>{v.motorVersao}</td>
                    <td style={{ padding: '8px' }}>{v.n}</td>
                    <td style={{ padding: '8px', color: C.green }}>{v.greens}</td>
                    <td style={{ padding: '8px', color: C.red }}>{v.reds}</td>
                    <td style={{ padding: '8px' }}>{v.previsto}%</td>
                    <td style={{ padding: '8px' }}>{v.real}%</td>
                    <td style={{ padding: '8px' }}>{v.brierScore}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>
            Só aparece quando há mais de uma versão no histórico. Serve pra ver se uma mudança no motor melhorou ou piorou o acerto real.
          </div>
        </div>
      )}

            {/* ✅ NOVO — calibração separada do TÊNIS */}
      {ten && ten.totalFinalizados > 0 && (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14 }}>
          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800, fontSize: 15, marginBottom: 10, letterSpacing: 1 }}>
            🎾 TÊNIS — PREVISTO × REAL ({ten.totalFinalizados} finalizados · acerto {ten.taxaAcertoGeral}% · Brier {ten.brierScore})
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ color: C.muted, textAlign: 'left' }}>
                  {['Mercado', 'N', 'Previsto', 'Real', 'Erro', 'Fator', 'Status'].map(h => (
                    <th key={h} style={{ padding: '6px 8px', borderBottom: `1px solid ${C.border}`, fontWeight: 700 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ten.mercados.map(m => (
                  <tr key={m.mercado}>
                    <td style={{ padding: '8px', fontWeight: 700 }}>{m.mercado.replace('Tênis:', '')}</td>
                    <td style={{ padding: '8px' }}>{m.n}</td>
                    <td style={{ padding: '8px' }}>{m.previsto}%</td>
                    <td style={{ padding: '8px' }}>{m.real}%</td>
                    <td style={{ padding: '8px', color: Math.abs(m.erro) <= 5 ? C.green : C.yellow }}>
                      {m.erro > 0 ? '+' : ''}{m.erro}pp
                    </td>
                    <td style={{ padding: '8px' }}>×{m.fator}</td>
                    <td style={{ padding: '8px', color: statusCor(m.status), fontWeight: 700 }}>{m.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>
            Só entram entradas de tênis com probabilidade salva. Fator só sai de 1.0 com 8+ finalizados no mercado.
          </div>

          {/* ✅ NOVO — Fase 1, item 4: acerto/Brier por versão do motor (tênis) */}
          {ten.porVersaoMotor?.length > 1 && (
            <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${C.border}` }}>
              <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800, fontSize: 13, marginBottom: 8, letterSpacing: 1 }}>
                ⚙️ POR VERSÃO DO MOTOR
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ color: C.muted, textAlign: 'left' }}>
                      {['Versão', 'N', 'Greens', 'Reds', 'Previsto', 'Real', 'Brier'].map(h => (
                        <th key={h} style={{ padding: '6px 8px', borderBottom: `1px solid ${C.border}`, fontWeight: 700 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {ten.porVersaoMotor.map(v => (
                      <tr key={v.motorVersao}>
                        <td style={{ padding: '8px', fontWeight: 700 }}>{v.motorVersao}</td>
                        <td style={{ padding: '8px' }}>{v.n}</td>
                        <td style={{ padding: '8px', color: C.green }}>{v.greens}</td>
                        <td style={{ padding: '8px', color: C.red }}>{v.reds}</td>
                        <td style={{ padding: '8px' }}>{v.previsto}%</td>
                        <td style={{ padding: '8px' }}>{v.real}%</td>
                        <td style={{ padding: '8px' }}>{v.brierScore}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ✅ NOVO — relatório unificado por contexto (todos os esportes) */}
      {ctx && ctx.totalFinalizados > 0 && (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14 }}>
          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800, fontSize: 15, marginBottom: 4, letterSpacing: 1 }}>
            ONDE VOCÊ MAIS ERRA (TODOS OS ESPORTES)
          </div>
          <div style={{ fontSize: 11, color: C.muted, marginBottom: 12 }}>
            Cruza futebol, tênis e basquete pelo tracker atual (só dados desde o último "Zerar histórico") — inclui clima e altitude registrados na análise ou marcados ao salvar.
          </div>

          {ctx.porEsporte.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 10, color: C.muted, fontWeight: 700, letterSpacing: 1, marginBottom: 8 }}>% DE ACERTO POR ESPORTE</div>
              <HBarChart maxValue={100} data={ctx.porEsporte.map(x => ({
                label: `${x.chave} (${x.n})`, value: x.pctAcerto,
                color: x.pctAcerto >= 60 ? C.green : x.pctAcerto >= 45 ? C.yellow : C.red,
              }))} />
            </div>
          )}

          {ctx.porClima.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 10, color: C.muted, fontWeight: 700, letterSpacing: 1, marginBottom: 8 }}>% DE ACERTO POR CLIMA</div>
              <HBarChart maxValue={100} data={ctx.porClima.map(x => ({
                label: `${x.chave} (${x.n})`, value: x.pctAcerto,
                color: x.pctAcerto >= 60 ? C.green : x.pctAcerto >= 45 ? C.yellow : C.red,
              }))} />
            </div>
          )}

          {ctx.porAltitude.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 10, color: C.muted, fontWeight: 700, letterSpacing: 1, marginBottom: 8 }}>% DE ACERTO POR ALTITUDE</div>
              <HBarChart maxValue={100} data={ctx.porAltitude.map(x => ({
                label: `${x.chave} (${x.n})`, value: x.pctAcerto,
                color: x.pctAcerto >= 60 ? C.green : x.pctAcerto >= 45 ? C.yellow : C.red,
              }))} />
            </div>
          )}

          {ctx.porLiga.length > 0 && (
            <div>
              <div style={{ fontSize: 10, color: C.muted, fontWeight: 700, letterSpacing: 1, marginBottom: 8 }}>% DE ACERTO POR LIGA/COMPETIÇÃO</div>
              <HBarChart maxValue={100} data={ctx.porLiga.slice(0, 8).map(x => ({
                label: `${x.chave} (${x.n})`, value: x.pctAcerto,
                color: x.pctAcerto >= 60 ? C.green : x.pctAcerto >= 45 ? C.yellow : C.red,
              }))} />
            </div>
          )}

          {ctx.porClima.length === 0 && ctx.porAltitude.length === 0 && (
            <div style={{ fontSize: 11, color: C.muted, fontStyle: 'italic', marginTop: 4 }}>
              Marque clima/altitude ao salvar novos jogos pra esses cortes aparecerem aqui também.
            </div>
          )}
        </div>
      )}
    </div>
  )
}


export default function ScoutTracker({ token, userRole, onVoltar }) {
  const [jogos, setJogos]             = useState([])
  const [carregando, setCarregando]   = useState(true)
  const [salvando, setSalvando]       = useState(false)
  const [erroSalvar, setErroSalvar]   = useState(null)
  const [mostraForm, setMostraForm]   = useState(false)
  const [aba, setAba]                 = useState("pendentes")
  const [filtroLiga, setFiltroLiga]   = useState("Todas")
  const [ultimoSync, setUltimoSync]   = useState(null)
  const [confirmZerar, setConfirmZerar] = useState(false) // ✅ NOVO — painel de confirmação do "Zerar histórico"
  const [zerando, setZerando]           = useState(false)
  const [msgZerar, setMsgZerar]         = useState(null)  // { tipo: 'ok' | 'erro', texto }

  // ── FIX: Loga o token recebido para diagnóstico ──────────
  useEffect(() => {
    console.log('[ScoutTracker] token recebido:', token ? `${token.slice(0,8)}...` : 'AUSENTE')
    console.log('[ScoutTracker] userRole:', userRole)
  }, [token, userRole])

  // Carrega dados ao iniciar
  useEffect(() => {
    storageGet().then(data => {
      setJogos(Array.isArray(data) ? data : [])
      setCarregando(false)
      setUltimoSync(new Date())
    })
  }, [])

  // ── FIX: persistir agora mostra erro claro se falhar ─────
  const persistir = useCallback(async (novosJogos) => {
    setSalvando(true)
    setErroSalvar(null)
    try {
      await storageSet(novosJogos, token)
      invalidarCacheCalibration() // alimenta calibração automática na próxima análise
      setUltimoSync(new Date())
    } catch (err) {
      console.error('[tracker] Erro ao salvar:', err.message)
      setErroSalvar(err.message)
    } finally {
      setSalvando(false)
    }
  }, [token])

  const adicionarJogo = useCallback(async (jogo) => {
    const novos = [jogo, ...jogos]
    setJogos(novos)
    setMostraForm(false)
    await persistir(novos)
  }, [jogos, persistir])

  const marcarResultado = useCallback(async (id, resultado, placarFinal) => {
    const novos = jogos.map(j =>
      j.id === id ? {
        ...j, resultado, marcadoEm: resultado ? new Date().toISOString() : null,
        placarFinal: resultado ? (placarFinal || null) : null, // ✅ NOVO — alimenta os gráficos de pizza/gols
      } : j
    )
    setJogos(novos)
    await persistir(novos)
  }, [jogos, persistir])

  // ✅ NOVO — Fase 5: registra a odd de fechamento do mercado (para CLV)
  const registrarFechamento = useCallback(async (id, oddFechamento) => {
    const novos = jogos.map(j =>
      j.id === id ? { ...j, oddFechamento, fechamentoRegistradoEm: new Date().toISOString() } : j
    )
    setJogos(novos)
    await persistir(novos)
  }, [jogos, persistir])

  // ✅ NOVO — Etapa 3: reverificação/correção manual chamam os endpoints dedicados
  // (liquidam direto no banco) — depois sincronizamos o estado local com o servidor.
  const reverificarJogo = useCallback(async (id) => {
    const resultado = await apiReverificar(id, token)
    if (resultado.mudou) {
      const atualizados = await storageGet()
      setJogos(Array.isArray(atualizados) ? atualizados : [])
      setUltimoSync(new Date())
    }
    return resultado
  }, [token])

  const corrigirJogo = useCallback(async (id, resultado, placarFinal) => {
    await apiCorrigir(id, resultado, placarFinal, token)
    const atualizados = await storageGet()
    setJogos(Array.isArray(atualizados) ? atualizados : [])
    setUltimoSync(new Date())
  }, [token])

  const buscarAuditoria = useCallback((id) => apiAuditoria(id, token), [token])

  const removerJogo = useCallback(async (id) => {
    const novos = jogos.filter(j => j.id !== id)
    setJogos(novos)
    await persistir(novos)
  }, [jogos, persistir])

  // ── FIX: botão salvar manual (força sincronização) ───────
  const salvarManual = useCallback(async () => {
    await persistir(jogos)
  }, [jogos, persistir])

  const recarregar = useCallback(() => {
    setCarregando(true)
    storageGet().then(data => {
      setJogos(Array.isArray(data) ? data : [])
      setCarregando(false)
      setUltimoSync(new Date())
    })
  }, [])

  // ✅ NOVO — "Zerar histórico": arquiva green/red/anulada (o servidor guarda tudo em
  // tracker_archive). Histórico, dashboard, gráficos e ranking recomeçam do zero, e a
  // calibração continua usando os green/red arquivados + os novos que forem entrando.
  const zerarHistorico = useCallback(async () => {
    setZerando(true)
    setMsgZerar(null)
    try {
      const res = await fetch(`${API_BASE}/api/tracker/zerar-historico`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-auth-token': token },
        body: JSON.stringify({ confirmar: true }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      const atualizados = await storageGet()
      setJogos(Array.isArray(atualizados) ? atualizados : [])
      invalidarCacheCalibration()
      setUltimoSync(new Date())
      setFiltroLiga("Todas")
      setConfirmZerar(false)
      setMsgZerar({
        tipo: 'ok',
        texto: `Histórico zerado — ${body.arquivadas} entradas arquivadas (${body.greens} green · ${body.reds} red · ${body.anuladas} anuladas). Calibração mantida.`,
      })
    } catch (err) {
      setMsgZerar({ tipo: 'erro', texto: `Não foi possível zerar: ${err.message}` })
    } finally {
      setZerando(false)
    }
  }, [token])

  // Ao abrir o painel de confirmação, relê o tracker pra mostrar as contagens reais de agora
  const alternarConfirmZerar = useCallback(async () => {
    setMsgZerar(null)
    if (confirmZerar) { setConfirmZerar(false); return }
    try {
      const res = await fetch(`${API_BASE}/api/tracker`)
      if (res.ok) {
        const data = await res.json()
        if (Array.isArray(data)) setJogos(data)
      }
    } catch { /* mantém o que já está na tela */ }
    setConfirmZerar(true)
  }, [confirmZerar])

  const ligas = ["Todas", ...Array.from(new Set(jogos.map(j => j.liga)))]
  const jogosFiltrados = filtroLiga === "Todas" ? jogos : jogos.filter(j => j.liga === filtroLiga)
  const pendentes   = jogosFiltrados.filter(j => j.resultado === null)
  const finalizados = jogosFiltrados.filter(j => j.resultado !== null)
    .sort((a, b) => new Date(b.marcadoEm || b.criadoEm) - new Date(a.marcadoEm || a.criadoEm))

  const greensTotal = jogos.filter(j => j.resultado === "green").length
  const redsTotal   = jogos.filter(j => j.resultado === "red").length
  const anuladasTotal  = jogos.filter(j => j.resultado === "anulada").length
  const liquidadasTotal = greensTotal + redsTotal + anuladasTotal
  const pendentesTotal  = jogos.filter(j => j.resultado === null).length
  const pctTotal    = (greensTotal + redsTotal) > 0
    ? Math.round(greensTotal / (greensTotal + redsTotal) * 100) : null

  const tabStyle = (id) => ({
    flex: 1, border: "none", borderRadius: 7, padding: "8px 4px",
    fontFamily: "'Barlow Condensed', sans-serif", fontSize: 13, fontWeight: 700,
    letterSpacing: 1, cursor: "pointer", transition: "all 0.2s", textTransform: "uppercase",
    background: aba === id ? C.blue + "20" : "transparent",
    color: aba === id ? C.blue : C.muted,
    borderTop: aba === id ? `2px solid ${C.blue}` : "2px solid transparent",
  })

  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: "'Barlow', sans-serif", color: C.text }}>
      {/* Header */}
      <div className="st-header" style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, padding: "12px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 10, flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {onVoltar && (
            <button className="fs-hide-m" onClick={onVoltar} style={{
              background: "none", border: `1px solid ${C.border}`,
              borderRadius: 8, padding: "5px 12px", color: C.sub,
              fontSize: 12, fontWeight: 700, cursor: "pointer",
              fontFamily: "'Barlow Condensed', sans-serif", letterSpacing: 1,
            }}>← Voltar</button>
          )}
          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 20, fontWeight: 900, color: C.text, letterSpacing: 1 }}>
            SCOUT<span style={{ color: C.green }}>TRACKER</span>
          </div>
          {pctTotal !== null && (
            <div style={{ background: (pctTotal >= 60 ? C.green : pctTotal >= 45 ? C.yellow : C.red) + "20", border: `1px solid ${(pctTotal >= 60 ? C.green : pctTotal >= 45 ? C.yellow : C.red)}40`, borderRadius: 20, padding: "3px 10px", fontSize: 12, fontWeight: 700, color: pctTotal >= 60 ? C.green : pctTotal >= 45 ? C.yellow : C.red, fontFamily: "'Barlow Condensed', sans-serif" }}>
              {pctTotal}% acerto · {greensTotal}🟢 {redsTotal}🔴
            </div>
          )}
        </div>

        {/* Controles do header */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {salvando && (
            <span style={{ fontSize: 11, color: C.yellow }}>💾 Salvando...</span>
          )}
          {!salvando && ultimoSync && !erroSalvar && (
            <span style={{ fontSize: 10, color: C.muted }}>
              ✅ Salvo {ultimoSync.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
          {erroSalvar && (
            <span style={{ fontSize: 11, color: C.red }} title={erroSalvar}>
              ⚠️ Erro ao salvar
            </span>
          )}

          {/* ── BOTÃO SALVAR MANUAL ── */}
          {userRole === 'admin' && (
            <button onClick={salvarManual} disabled={salvando}
              style={{
                background: salvando ? C.muted + "20" : C.green + "15",
                border: `1px solid ${salvando ? C.muted : C.green}60`,
                borderRadius: 6, padding: "5px 12px",
                color: salvando ? C.muted : C.green,
                fontSize: 12, fontWeight: 700, cursor: salvando ? "not-allowed" : "pointer",
                fontFamily: "'Barlow Condensed', sans-serif", letterSpacing: 1,
                transition: "all 0.2s",
              }}>
              💾 SALVAR
            </button>
          )}

          <button onClick={recarregar}
            style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 6, padding: "4px 10px", color: C.sub, fontSize: 11, cursor: "pointer" }}>
            ↻ Sincronizar
          </button>
        </div>
      </div>

      {/* Banner de erro persistente */}
      {erroSalvar && (
        <div style={{ background: C.red + "15", borderBottom: `1px solid ${C.red}40`, padding: "8px 20px", fontSize: 12, color: C.red, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>⚠️ Não foi possível salvar: <strong>{erroSalvar}</strong></span>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={salvarManual} style={{ fontSize: 12, color: C.green, background: "none", border: `1px solid ${C.green}60`, borderRadius: 5, padding: "3px 10px", cursor: "pointer", fontWeight: 700 }}>
              Tentar novamente
            </button>
            <button onClick={() => setErroSalvar(null)} style={{ fontSize: 12, color: C.muted, background: "none", border: "none", cursor: "pointer" }}>✕</button>
          </div>
        </div>
      )}

      {/* Info banner */}
      <div style={{ background: C.blue + "0d", borderBottom: `1px solid ${C.blue}20`, padding: "8px 20px", fontSize: 11, color: C.blue + "cc", textAlign: "center" }}>
        🌐 Dados compartilhados — qualquer pessoa com acesso a este painel vê e pode marcar os resultados
      </div>

      <div className="st-wrap" style={{ maxWidth: 760, margin: "0 auto", padding: "20px 16px" }}>
        {carregando ? (
          <div style={{ textAlign: "center", padding: 48, color: C.muted }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>
            <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 16 }}>Carregando dados compartilhados...</div>
          </div>
        ) : (
          <>
            <div style={{ display: "flex", gap: 10, marginBottom: 16, alignItems: "center", flexWrap: "wrap" }}>
              {!mostraForm && userRole === 'admin' && (
                <Btn onClick={() => setMostraForm(true)} color={C.green}>+ Adicionar jogo</Btn>
              )}
              {!mostraForm && userRole === 'admin' && (
                <Btn onClick={alternarConfirmZerar} color={C.red} outline small>🧹 Zerar histórico</Btn>
              )}
              {ligas.length > 1 && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
                  <span style={{ fontSize: 11, color: C.muted }}>Filtrar:</span>
                  <Select value={filtroLiga} onChange={setFiltroLiga} options={ligas.map(l => ({ value: l, label: l }))} />
                </div>
              )}
            </div>

            {msgZerar && (
              <div style={{
                background: (msgZerar.tipo === 'ok' ? C.green : C.red) + "15",
                border: `1px solid ${(msgZerar.tipo === 'ok' ? C.green : C.red)}40`,
                borderRadius: 10, padding: "10px 14px", marginBottom: 16, fontSize: 12,
                color: msgZerar.tipo === 'ok' ? C.green : C.red,
                display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10,
              }}>
                <span>{msgZerar.tipo === 'ok' ? "✅" : "⚠️"} {msgZerar.texto}</span>
                <button onClick={() => setMsgZerar(null)} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 13 }}>✕</button>
              </div>
            )}

            {confirmZerar && userRole === 'admin' && (
              <div style={{ background: C.red + "0d", border: `1px solid ${C.red}40`, borderRadius: 12, padding: 16, marginBottom: 16 }}>
                <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 16, fontWeight: 800, color: C.red, letterSpacing: 1, marginBottom: 8 }}>
                  ZERAR HISTÓRICO DE GREEN / RED?
                </div>
                {liquidadasTotal === 0 ? (
                  <div style={{ fontSize: 12, color: C.sub, lineHeight: 1.6 }}>Não há entradas liquidadas para arquivar — o histórico já está zerado.</div>
                ) : (
                  <div style={{ fontSize: 12, color: C.text, lineHeight: 1.6 }}>
                    Vão para o arquivo <strong>{liquidadasTotal} entradas liquidadas</strong> ({greensTotal} 🟢 · {redsTotal} 🔴{anuladasTotal > 0 ? ` · ${anuladasTotal} anuladas` : ""}).
                    Histórico, Dashboard, Ranking e Gráficos recomeçam do zero; os <strong>{pendentesTotal} pendentes continuam</strong> e contam como dado novo quando forem liquidados.
                    <br />
                    <span style={{ color: C.green }}>A calibração atual é mantida</span> — as entradas ficam guardadas (nada é apagado) e continuam alimentando os fatores; os novos greens/reds entram por cima.
                  </div>
                )}
                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <Btn small color={C.red} onClick={zerarHistorico} disabled={zerando || liquidadasTotal === 0}>
                    {zerando ? "Zerando…" : "Confirmar e zerar"}
                  </Btn>
                  <Btn small outline color={C.sub} onClick={() => setConfirmZerar(false)} disabled={zerando}>Cancelar</Btn>
                </div>
              </div>
            )}

            {mostraForm && (
              <FormAdicionarJogo onSalvar={adicionarJogo} onCancelar={() => setMostraForm(false)} />
            )}

            <div className="st-tabs" style={{ display: "flex", gap: 2, marginBottom: 16, background: "rgba(255,255,255,0.03)", borderRadius: 10, padding: 4 }}>
              <button style={tabStyle("pendentes")} onClick={() => setAba("pendentes")}>
                ⏳ Pendentes ({pendentes.length})
              </button>
              <button style={tabStyle("historico")} onClick={() => setAba("historico")}>
                📋 Histórico ({finalizados.length})
              </button>
              <button style={tabStyle("dashboard")} onClick={() => setAba("dashboard")}>
                📊 Dashboard
              </button>
              <button style={tabStyle("ranking")} onClick={() => setAba("ranking")}>
                🏆 Ranking
              </button>

                            <button style={tabStyle("graficos")} onClick={() => setAba("graficos")}>
                📈 Gráficos
              </button>

              <button style={tabStyle("calibracao")} onClick={() => setAba("calibracao")}>
                📊 Calibração
              </button>
            </div>

            {aba === "pendentes" && (
              <div>
                {pendentes.length === 0 ? (
                  <div style={{ textAlign: "center", padding: "32px 0", color: C.muted }}>
                    <div style={{ fontSize: 32, marginBottom: 10 }}>✅</div>
                    <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 16, fontWeight: 700 }}>Nenhum jogo pendente</div>
                    <div style={{ fontSize: 12, marginTop: 6 }}>Adicione um jogo ou veja o histórico.</div>
                  </div>
                ) : (
                  pendentes.map(j => (
                    <JogoCard key={j.id} jogo={j}
                      onMarcar={userRole === 'admin' ? marcarResultado : null}
                      onRemover={userRole === 'admin' ? removerJogo : null}
                      onReverificar={userRole === 'admin' ? reverificarJogo : null}
                      onCorrigir={userRole === 'admin' ? corrigirJogo : null}
                      onAuditoria={userRole === 'admin' ? buscarAuditoria : null}
                      onRegistrarFechamento={userRole === 'admin' ? registrarFechamento : null}
                    />
                  ))
                )}
              </div>
            )}

            {aba === "historico" && (
              <div>
                {finalizados.length === 0 ? (
                  <div style={{ textAlign: "center", padding: "32px 0", color: C.muted }}>
                    <div style={{ fontSize: 32, marginBottom: 10 }}>📭</div>
                    <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 16, fontWeight: 700 }}>Histórico vazio</div>
                    <div style={{ fontSize: 12, marginTop: 6 }}>Marque resultados dos jogos pendentes para aparecerem aqui.</div>
                  </div>
                ) : (
                  finalizados.map(j => (
                    <JogoCard key={j.id} jogo={j}
                      onMarcar={userRole === 'admin' ? marcarResultado : null}
                      onRemover={userRole === 'admin' ? removerJogo : null}
                      onCorrigir={userRole === 'admin' ? corrigirJogo : null}
                      onAuditoria={userRole === 'admin' ? buscarAuditoria : null}
                      onRegistrarFechamento={userRole === 'admin' ? registrarFechamento : null}
                    />
                  ))
                )}
              </div>
            )}

            {aba === "dashboard" && (
              <div className="st-panel" style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: 20 }}>
                <Dashboard jogos={jogos} />
              </div>
            )}

            {aba === "ranking" && (
              <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: 20 }}>
                <RankingTimes jogos={jogos} />
              </div>
            )}

                        {aba === "graficos" && (
              <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: 20 }}>
                <GraficosTracker jogosIniciais={jogos} filtroLiga={filtroLiga} versao={ultimoSync ? ultimoSync.getTime() : null} />
              </div>
            )}

            {aba === "calibracao" && (
              <CalibracaoPanel refreshKey={jogos.length + greensTotal + redsTotal} />
            )}

          </>
        )}
      </div>

      <div style={{ textAlign: "center", padding: "16px 0", fontSize: 10, color: C.muted, borderTop: `1px solid ${C.border}`, marginTop: 24 }}>
        SCOUT TRACKER · Dados persistentes e compartilhados entre todos os usuários
      </div>
    </div>
  )
}