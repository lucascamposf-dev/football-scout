// tennisService.js — jogos do dia via FlashLive; histórico/probabilidades
// ainda no motor antigo (Fase 2 da migração, ainda não feita)
// ─────────────────────────────────────────────────────────────

const IS_PROD  = typeof window !== 'undefined' && window.location.hostname !== 'localhost'
const API_BASE = IS_PROD ? '' : 'http://localhost:3001'
const TENIS_URL            = `${API_BASE}/api/sportsdata/tenis`             // motor de previsão (dados FlashLive)
const FLASHLIVE_TENIS_URL  = `${API_BASE}/api/sportsdata/flashlive/tenis`   // jogos/ao-vivo/h2h/ranking/odds (novo)

// cache em memória da última busca, pra ts_buscarJogosTorneio não rebuscar tudo
let _ultimosTorneios = []

// ── Horário/data (fuso de Brasília) a partir do startTimestamp que a FlashLive manda.
// A tela de seleção e o Tracker leem jogo.horario / jogo.dataJogo (como no futebol).
function formatHorario(ts) {
  if (!ts) return null
  return new Date(ts * 1000).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })
}
function formatDataJogo(ts) {
  if (!ts) return null
  return new Date(ts * 1000).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Sao_Paulo' })
}
const comHorario = j => ({
  ...j,
  horario:  j.horario  ?? formatHorario(j.startTimestamp)  ?? '—',
  dataJogo: j.dataJogo ?? formatDataJogo(j.startTimestamp) ?? '—',
})

// Jogos já encerrados não entram na análise PRÉ-jogo: o modelo trata placar final como
// "jogo decidido" e devolve 100% x 0% (foi o que apareceu em Hurkacz x Zhou).
const ENCERRADOS = new Set(['finished', 'canceled', 'cancelled', 'walkover', 'retired', 'abandoned'])
const jogosAbertos = t => (t.jogos ?? []).filter(j => !ENCERRADOS.has(j.status))

// ── Etapa 0: lista de torneios ativos (ATP/WTA) pro dropdown ──
export async function ts_buscarTorneiosAtivos(incluirAmanha = false) {
  const url = `${FLASHLIVE_TENIS_URL}/jogos${incluirAmanha ? '?incluirAmanha=1' : ''}`
  const res = await fetch(url)
  const json = await res.json()

  if (json.status !== 'ok') {
    throw new Error(json.mensagem || 'Erro ao buscar torneios de tênis')
  }

  _ultimosTorneios = json.data.torneios ?? []

  return _ultimosTorneios.filter(t => jogosAbertos(t).length > 0).map(t => {
    const total = jogosAbertos(t).length
    const aoVivo = jogosAbertos(t).some(j => j.status === 'inprogress')
    return {
      id: t.tournamentStageId,
      nome: t.torneio,   // já vem completo da FlashLive (ex.: "China: Wuhan WTA, piso duro")
      genero: t.genero,
      superficie: t.superficie ?? null,
      totalJogos: total,
      temAoVivo: aoVivo,
      // rótulo pronto pro <option> — o App.jsx lia campos que não existiam (categoria/qtdJogosHoje)
      rotulo: `${aoVivo ? '🔴 ' : ''}${t.torneio} — ${total} jogo${total === 1 ? '' : 's'}`,
    }
  })
}

// ── Etapa 1: jogos do torneio escolhido ──
export async function ts_buscarJogosTorneio(torneioId, incluirAmanha = false) {
  if (!torneioId) throw new Error('Selecione um torneio antes de buscar os jogos')

  if (!_ultimosTorneios.length) {
    await ts_buscarTorneiosAtivos(incluirAmanha)
  }

  const torneio = _ultimosTorneios.find(t => String(t.tournamentStageId) === String(torneioId))
  if (!torneio) throw new Error('Torneio não encontrado (tente buscar a lista de novo)')

  const abertos = jogosAbertos(torneio)
  if (!abertos.length) throw new Error('Todos os jogos deste torneio já terminaram (ou foram cancelados).')
  return abertos.map(comHorario)
}

// ── Etapa 2: histórico + H2H — continua no motor antigo por enquanto ──
export async function ts_buscarHistoricos(jogos) {
  if (!jogos?.length) throw new Error('Nenhum jogo selecionado')

  const res = await fetch(`${TENIS_URL}/historicos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jogos }),
  })

  if (!res.ok) throw new Error(`Erro ao buscar históricos (${res.status})`)
  const json = await res.json()
  if (json.status !== 'ok') throw new Error(json.mensagem || 'Erro ao buscar históricos')

  return json.data.jogos ?? []
}

// ── Etapa 3: cálculo de probabilidades — idem, motor antigo ──
export async function ts_calcularProbabilidades(jogosComHistorico) {
  if (!jogosComHistorico?.length) throw new Error('Nenhum jogo com histórico para calcular')

  const res = await fetch(`${TENIS_URL}/probabilidades`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jogos: jogosComHistorico }),
  })

  if (!res.ok) throw new Error(`Erro ao calcular probabilidades (${res.status})`)
  const json = await res.json()
  if (json.status !== 'ok') throw new Error(json.mensagem || 'Erro ao calcular probabilidades')

  return json.data
}