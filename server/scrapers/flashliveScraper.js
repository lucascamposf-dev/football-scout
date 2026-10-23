// server/scrapers/flashliveScraper.js
// ─────────────────────────────────────────────────────────────
// Fase 1, item 2 do roadmap: "cross-check com segunda fonte".
//
// O projeto já integra a FlashLive Sports API (RapidAPI) — é a mesma fonte
// usada hoje pelo frontend em src/services/flashliveService.js (médias de
// cartões/escanteios, escalações). Este módulo é a versão SERVER-SIDE dela,
// chamada direto pelo job de resolução pós-jogo (server/index.js), sem
// passar pelo proxy /api/flashlive (que exige token de usuário logado —
// aqui não tem usuário, é o servidor chamando sozinho).
//
// Importante: esta fonte é só para CROSS-CHECK. Ela nunca decide green/red
// sozinha — o veredito da aposta continua vindo 100% da fonte principal (fonte já
// validada em produção). Se a FlashLive não achar o jogo, ou os dados
// vierem incompletos, a função devolve null e o cross-check vira
// "sem_segunda_fonte" — o job segue normalmente com a fonte principal.
// ─────────────────────────────────────────────────────────────

const FLASHLIVE_HOST = 'flashlive-sports.p.rapidapi.com'
const FLASHLIVE_KEY  = process.env.FLASHLIVE_KEY || process.env.SPORT_KEY || ''
const SPORT_SOCCER   = 1

const norm = s => String(s || '').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]/g, '')

async function flFetch(endpoint, params = {}) {
  if (!FLASHLIVE_KEY) return null
  const query = new URLSearchParams({ locale: 'pt_BR', ...params }).toString()
  try {
    const res = await fetch(`https://${FLASHLIVE_HOST}/v1/${endpoint}?${query}`, {
      headers: { 'x-rapidapi-host': FLASHLIVE_HOST, 'x-rapidapi-key': FLASHLIVE_KEY },
    })
    if (!res.ok) return null
    const data = await res.json()
    return data?.DATA ?? null
  } catch (err) {
    console.warn('[FlashLive cross-check] fetch falhou:', err.message)
    return null
  }
}

// Localiza o evento na FlashLive pelo nome dos times + data do jogo.
// Mesma heurística de match usada no serviço do frontend (prefixo de 5
// caracteres normalizado): propositalmente frouxa pra não perder
// cross-checks por variação de grafia (ex.: "Atlético-MG" vs "Atletico
// Mineiro"), mas ainda muito improvável de casar times errados porque exige
// bater mandante E visitante ao mesmo tempo, dentro da rodada do dia certo.
async function buscarEventoFlashLive(mandante, visitante, dataJogo) {
  const hoje   = new Date()
  const alvo   = dataJogo ? new Date(dataJogo) : new Date()
  if (isNaN(alvo.getTime())) return null
  const diffMs = alvo.setHours(12) - hoje.setHours(12)
  const indentDays = Math.round(diffMs / (1000 * 60 * 60 * 24))
  if (Math.abs(indentDays) > 7) return null // fora do range que a API cobre

  const eventos = await flFetch('events/list', {
    sport_id: SPORT_SOCCER, timezone: -3, indent_days: indentDays,
  })
  if (!eventos) return null

  const nM = norm(mandante)
  const nV = norm(visitante)

  for (const torneio of eventos) {
    for (const ev of torneio.EVENTS ?? []) {
      const h = norm(ev.HOME_NAME ?? '')
      const a = norm(ev.AWAY_NAME ?? '')
      if (
        (h.includes(nM.slice(0, 5)) || nM.includes(h.slice(0, 5))) &&
        (a.includes(nV.slice(0, 5)) || nV.includes(a.slice(0, 5)))
      ) {
        return ev
      }
    }
  }
  return null
}

// Cartões (via incidentes do resumo — mais preciso) e escanteios (via
// estatísticas agregadas) de um evento específico da FlashLive.
async function buscarStatsEventoFlashLive(eventId) {
  const [statsData, summary] = await Promise.all([
    flFetch('events/statistics', { event_id: eventId }),
    flFetch('events/summary',    { event_id: eventId }),
  ])

  let escanteiosCasa = 0, escanteiosFora = 0
  for (const stage of Array.isArray(statsData) ? statsData : []) {
    for (const group of stage.GROUPS ?? []) {
      for (const item of group.ITEMS ?? []) {
        if (item.INCIDENT_NAME?.toLowerCase().includes('corner')) {
          escanteiosCasa = parseFloat(item.VALUE_HOME ?? 0) || 0
          escanteiosFora = parseFloat(item.VALUE_AWAY ?? 0) || 0
        }
      }
    }
  }

  let amarelosCasa = 0, amarelosFora = 0, vermelhosCasa = 0, vermelhosFora = 0
  for (const stage of Array.isArray(summary) ? summary : []) {
    for (const item of stage.ITEMS ?? []) {
      for (const inc of item.INCIDENT_PARTICIPANTS ?? []) {
        const casa = item.INCIDENT_TEAM === 1
        if (inc.INCIDENT_TYPE === 'YELLOW_CARD') casa ? amarelosCasa++ : amarelosFora++
        if (inc.INCIDENT_TYPE === 'RED_CARD')    casa ? vermelhosCasa++ : vermelhosFora++
      }
    }
  }

  return {
    cartoesAmarelosCasa: amarelosCasa, cartoesAmarelosFora: amarelosFora,
    cartoesVermelhosCasa: vermelhosCasa, cartoesVermelhosFora: vermelhosFora,
    cartoesTotal: amarelosCasa + amarelosFora + vermelhosCasa + vermelhosFora,
    escanteiosCasa, escanteiosFora, escanteiosTotal: escanteiosCasa + escanteiosFora,
  }
}

/**
 * Resultado real (gols/cartões/escanteios) da MESMA partida, visto pela
 * FlashLive — usado só como segunda fonte pra cross-check. Retorna null se
 * não achar o jogo, se ele ainda não tiver terminado do lado da FlashLive,
 * ou se faltar a chave da API — nesses casos o cross-check vira
 * "sem_segunda_fonte" e o job segue confiando só na fonte principal, como já era.
 */
export async function getResultadoRealFlashLive(mandante, visitante, dataJogo) {
  try {
    const ev = await buscarEventoFlashLive(mandante, visitante, dataJogo)
    if (!ev || ev.STAGE_TYPE !== 'FINISHED') return null

    const golsCasa = parseInt(ev.HOME_SCORE_CURRENT ?? '')
    const golsFora = parseInt(ev.AWAY_SCORE_CURRENT ?? '')
    if (Number.isNaN(golsCasa) || Number.isNaN(golsFora)) return null

    const stats = await buscarStatsEventoFlashLive(ev.EVENT_ID)
    return { golsCasa, golsFora, ...stats, fonte: 'flashlive' }
  } catch (err) {
    console.warn('[FlashLive cross-check] falhou:', err.message)
    return null
  }
}