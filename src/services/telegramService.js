// telegramService.js — envia o texto pronto (jogos + múltipla sugerida) pro
// bot do Telegram já configurado no servidor (TELEGRAM_BOT_TOKEN/CHAT_ID no Railway).
// ─────────────────────────────────────────────────────────────

const IS_PROD  = typeof window !== 'undefined' && window.location.hostname !== 'localhost'
const API_BASE = IS_PROD ? '' : 'http://localhost:3001'
const TELEGRAM_URL = `${API_BASE}/api/telegram/enviar-jogos`

function authHeaders(extra = {}) {
  const token = typeof localStorage !== 'undefined' ? localStorage.getItem('scout_token') : null
  return token ? { ...extra, 'x-auth-token': token } : extra
}

export async function enviarParaTelegram(texto) {
  if (!texto?.trim()) return { ok: false, erro: 'Texto vazio' }
  try {
    const res  = await fetch(TELEGRAM_URL, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ texto }),
    })
    const body = await res.json().catch(() => null)
    if (!res.ok) return { ok: false, erro: body?.error || `Erro ${res.status}` }
    return { ok: true, enviado: body?.enviado ?? true }
  } catch (err) {
    return { ok: false, erro: err.message }
  }
}
