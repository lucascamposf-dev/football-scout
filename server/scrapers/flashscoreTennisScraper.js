// server/scrapers/flashscoreTennisScraper.js
// ─────────────────────────────────────────────────────────────
// TÊNIS via FlashLive Sports (RapidAPI) — substitui a fonte antiga (SofaScore) como
// fonte de jogos do dia, ao vivo, H2H, ranking e odds de tênis.
//
// ✅ Diferente da primeira tentativa (que chutava nomes de campo), os
// endpoints e campos abaixo vêm da documentação oficial confirmada em
// https://flashlive.rapi.one/Complete_Tutorial (25/09/2026):
//   - sport_id=2 é TÊNIS (1=Soccer, 2=Tennis, 3=Basketball, 4=Hockey...)
//   - /v1/events/odds e /v1/events/live-odds existem e têm estrutura
//     documentada (BETTING_TYPE > PERIODS > GROUPS > MARKETS > ODD_CELL_*)
//   - /v1/events/h2h existe (HOME_PARTICIPANT/AWAY_PARTICIPANT/CURRENT_RESULT)
//   - /v1/rankings/list?sport_id=2 confirmado devolvendo "ATP Singles" e
//     "WTA Singles" como RANKING_LABEL
//
// ⚠️ O QUE AINDA NÃO ESTÁ CONFIRMADO (por isso getDiagnosticoTenis existe):
// os nomes REAIS de torneio de tênis que a API devolve em events/list
// (ex.: se vem "ATP Shanghai" ou "World: ATP - Shanghai" etc.) e se existe
// campo de piso/superfície (clay/hard/grass) por evento. O filtro ATP/WTA
// abaixo é por palavra-chave no nome — mesma estratégia já validada em
// produção para o futebol (flashscoreScraper.js). Se o filtro não achar
// nada, rode GET /api/sportsdata/flashlive/tenis/diagnostico e me mande
// o resultado pra eu ajustar as palavras-chave.
// ─────────────────────────────────────────────────────────────

const FLASHLIVE_HOST = 'flashlive-sports.p.rapidapi.com'
const FLASHLIVE_KEY  = process.env.FLASHLIVE_KEY || process.env.SPORT_KEY || ''
const SPORT_TENIS    = 2
const DECAY_FORMA = 0.85

const norm = s => String(s || '').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9 ]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()

async function flFetch(endpoint, params = {}, tentativa = 0) {
  if (!FLASHLIVE_KEY) return null
  const query = new URLSearchParams({ locale: 'pt_BR', ...params }).toString()
  try {
    const res = await fetch(`https://${FLASHLIVE_HOST}/v1/${endpoint}?${query}`, {
      headers: { 'x-rapidapi-host': FLASHLIVE_HOST, 'x-rapidapi-key': FLASHLIVE_KEY },
    })
    if ((res.status === 429 || res.status >= 500) && tentativa < 3) {
      console.warn(`[FlashLive Tênis] HTTP ${res.status} em ${endpoint} — tentativa ${tentativa + 1}/3`)
      await new Promise(r => setTimeout(r, 700 * (tentativa + 1)))
      return flFetch(endpoint, params, tentativa + 1)
    }
    if (!res.ok) {
      console.warn(`[FlashLive Tênis] HTTP ${res.status} em ${endpoint}`)
      return null
    }
    const data = await res.json()
    return data?.DATA ?? null
  } catch (err) {
    console.warn('[FlashLive Tênis] fetch falhou:', err.message)
    return null
  }
}

// Mesmas categorias excluídas já validadas no motor antigo (tennisScraper.js)
// — nível abaixo do tour principal. "chall" cobre a forma abreviada real que
// a FlashLive usa ("4 Chall. Homens") — "challenger" por extenso nunca batia.
const CATEGORIAS_EXCLUIDAS = [
  'challenger', 'chall', 'itf', 'utr', 'exhibition', 'exibicao', 'boys', 'girls',
  'juniors', 'junior', 'wheelchair', 'legends', 'saudi', 'ptt', 'wta 125',
]

function categoriaEhPrincipal(nome = '') {
  const n = norm(nome)
  return !CATEGORIAS_EXCLUIDAS.some(termo => n.includes(termo))
}

// ── Piso/superfície: não vem em campo isolado — vem embutido no texto do
// NAME ("China: Chengdu ATP, piso duro", "..., saibro", "..., grama").
function extrairSuperficie(nome = '') {
  const n = norm(nome)
  if (n.includes('saibro')) return 'saibro'
  if (n.includes('grama')) return 'grama'
  if (n.includes('piso duro') || n.includes(' duro')) return 'duro'
  if (n.includes('indoor')) return 'indoor'
  return null
}

// ── Filtra fora duplas ([7,8]) e seleção/equipe ([17]) — o motor de
// previsão só faz sentido pra simples ([2]). Se o campo não vier, não
// bloqueia (fail-open), pra não sumir com jogo por engano.
function ehSimples(ev) {
  const tipos = ev.HOME_PARTICIPANT_TYPES ?? ev.AWAY_PARTICIPANT_TYPES ?? null
  if (!Array.isArray(tipos) || !tipos.length) return true
  return tipos.length === 1 && tipos[0] === 2
}

function generoDoTorneio(nome = '') {
  const n = norm(nome)
  if (n.includes('wta')) return 'feminino'
  if (n.includes('atp')) return 'masculino'
  return null // grand slams costumam ter chave WTA/ATP separada; se não bater, fica null
}

function nomeTorneio(t) {
  return t.NAME ?? t.CATEGORY_NAME ?? t.TOURNAMENT_NAME ?? t.NAME_PART_2 ?? ''
}

function extrairStartTimestamp(ev) {
  const bruto = ev.START_TIME ?? ev.START_UTC_TIME ?? ev.START_TIMESTAMP ?? null
  if (bruto == null) return null
  const n = Number(bruto)
  if (!Number.isFinite(n)) return null
  return n > 1e12 ? Math.floor(n / 1000) : n
}

async function buscarEventosTenis(indentDays) {
  return await flFetch('events/list', {
    sport_id: SPORT_TENIS, timezone: -3, indent_days: indentDays,
  })
}

// ─────────────────────────────────────────────────────────────
// JOGOS DE TÊNIS DE HOJE (ou hoje+amanhã) — ATP/WTA principal
// ─────────────────────────────────────────────────────────────
export async function getJogosTenisHoje(incluirAmanha = false) {
  const eventosHoje = await buscarEventosTenis(0)
  if (!eventosHoje) return { erro: 'FlashLive não respondeu (verifique FLASHLIVE_KEY)' }

  const extrair = (grupos, usandoAmanha) => {
    const torneios = []
    for (const t of grupos) {
      const nome = nomeTorneio(t)
      if (!categoriaEhPrincipal(nome)) continue
      const genero = generoDoTorneio(nome)
      const superficie = extrairSuperficie(nome)
      const jogos = (t.EVENTS ?? [])
        .filter(ehSimples)
        .map(ev => {
          const placarSets = placarSetsDoEventoFL(ev)
          return {
            id: ev.EVENT_ID,
            mandante: ev.HOME_NAME ?? 'Jogador A',
            visitante: ev.AWAY_NAME ?? 'Jogador B',
            mandanteId: ev.HOME_PARTICIPANT_IDS?.[0] ?? null,
            visitanteId: ev.AWAY_PARTICIPANT_IDS?.[0] ?? null,
            status: mapearStatusTenis(ev),           // vocabulário do motor (inprogress/notstarted/finished...)
            statusDescricao: ev.STAGE ?? '',
            startTimestamp: extrairStartTimestamp(ev),
            usandoAmanha,
            piso: superficie, // ✅ sem isso, taxaSetAjustadaComSuperficie nunca ativa
            competicao: nome,
            genero,
            // ✅ sem bestOf o motor assumia sempre melhor de 3 (Grand Slam masculino é bo5)
            bestOf: bestOfDoEventoFL(nome, genero, placarSets),
            placarSets,
          }
        })
      if (jogos.length) {
        torneios.push({ torneio: nome, genero, superficie, tournamentStageId: t.TOURNAMENT_STAGE_ID ?? t.TOURNAMENT_ID ?? null, jogos })
      }
    }
    return torneios
  }

  // ✅ Fix: hoje + amanhã eram só concatenados — o mesmo torneio aparecia 2x no
  // dropdown (ex.: "Wuhan WTA" e "Xangai ATP" repetidos). Agora une pelo nome
  // normalizado e dedup de jogos pelo id. O id do torneio é sempre preenchido
  // (fallback = slug do nome), senão <option value="null"> quebrava a seleção.
  const unir = (lista) => {
    const mapa = new Map()
    for (const t of lista) {
      const chave = norm(t.torneio)
      const existente = mapa.get(chave)
      if (!existente) { mapa.set(chave, { ...t, jogos: [...t.jogos] }); continue }
      const ids = new Set(existente.jogos.map(j => j.id))
      for (const j of t.jogos) if (!ids.has(j.id)) existente.jogos.push(j)
      existente.tournamentStageId = existente.tournamentStageId ?? t.tournamentStageId
    }
    return [...mapa.values()].map(t => ({
      ...t,
      tournamentStageId: t.tournamentStageId ?? `t_${norm(t.torneio).replace(/ /g, '_')}`,
      jogos: t.jogos.sort((a, b) => (a.startTimestamp ?? 0) - (b.startTimestamp ?? 0)),
    }))
  }

  let torneios = extrair(eventosHoje, false)

  if (!torneios.length || incluirAmanha) {
    const eventosAmanha = await buscarEventosTenis(1)
    if (eventosAmanha) torneios = [...torneios, ...extrair(eventosAmanha, true)]
  }
  torneios = unir(torneios)

  if (!torneios.length) return { erro: 'Nenhum jogo de tênis ATP/WTA encontrado (FlashLive)' }

  return { fonte: 'flashlive', torneios }
}

// ─────────────────────────────────────────────────────────────
// TÊNIS AO VIVO AGORA — formato que a tela "Jogos ao vivo → Tênis" espera
// (mesmos campos do contrato antigo: placarSets, bestOf, piso, competicao...)
// ─────────────────────────────────────────────────────────────
const SLAMS_TENIS = ['australian open', 'open da australia', 'australia open', 'roland garros', 'french open', 'wimbledon', 'us open', 'open dos eua']

function placarSetsDoEventoFL(ev) {
  const sets = [1, 2, 3, 4, 5].map(n => {
    const c = parseInt(ev[`HOME_SCORE_PART_${n}`])
    const f = parseInt(ev[`AWAY_SCORE_PART_${n}`])
    return { casa: Number.isFinite(c) ? c : null, fora: Number.isFinite(f) ? f : null }
  }).filter(s => s.casa != null || s.fora != null)
  return {
    sets,
    totalCasa: parseInt(ev.HOME_SCORE_CURRENT ?? '') || 0, // sets ganhos
    totalFora: parseInt(ev.AWAY_SCORE_CURRENT ?? '') || 0,
  }
}

// Grand Slam masculino = melhor de 5; resto = melhor de 3. Se o placar já provar bo5
// (3 sets ganhos ou 4+ sets jogados), vira 5 mesmo sem achar o nome do torneio.
function bestOfDoEventoFL(nomeT, genero, placar) {
  const ehSlam = SLAMS_TENIS.some(s => norm(nomeT).includes(s))
  if (ehSlam && genero === 'masculino') return 5
  if (Math.max(placar.totalCasa, placar.totalFora) >= 3 || placar.sets.length >= 4) return 5
  return 3
}

function montarJogoTenisAoVivo(ev, nomeT, categoria = null) {
  const genero     = generoDoTorneio(nomeT)
  const superficie = extrairSuperficie(nomeT)
  const placarSets = placarSetsDoEventoFL(ev)
  return {
    id: ev.EVENT_ID,
    competicao: nomeT || categoria || 'Torneio',
    torneio: nomeT || null,
    categoria,
    genero,
    superficie,
    piso: superficie,
    mandante: ev.HOME_NAME ?? 'Jogador A',
    visitante: ev.AWAY_NAME ?? 'Jogador B',
    mandanteId: ev.HOME_PARTICIPANT_IDS?.[0] ?? null,
    visitanteId: ev.AWAY_PARTICIPANT_IDS?.[0] ?? null,
    bestOf: bestOfDoEventoFL(nomeT, genero, placarSets),
    status: ev.STAGE_TYPE ?? null,
    statusDescricao: ev.STAGE ?? '',
    placarSets,
    setsMandante: placarSets.totalCasa,
    setsVisitante: placarSets.totalFora,
    startTimestamp: extrairStartTimestamp(ev),
  }
}

export async function getJogosTenisAoVivo() {
  const dados = await flFetch('events/live-list', { sport_id: SPORT_TENIS, timezone: -3 })
  if (!dados) return { erro: 'FlashLive não respondeu (verifique FLASHLIVE_KEY)', jogos: [] }

  // Resposta pode vir agrupada por torneio (mesmo formato de events/list) ou achatada.
  const grupos = Array.isArray(dados) && dados[0]?.EVENTS ? dados : [{ NAME: null, EVENTS: dados }]

  const jogos = []
  for (const t of grupos) {
    const nome = nomeTorneio(t)
    if (nome && !categoriaEhPrincipal(nome)) continue
    for (const ev of (t.EVENTS ?? []).filter(ehSimples)) {
      jogos.push(montarJogoTenisAoVivo(ev, nome, t.CATEGORY_NAME ?? null))
    }
  }

  jogos.sort((a, b) => (b.setsMandante + b.setsVisitante) - (a.setsMandante + a.setsVisitante))
  return { fonte: 'flashlive', jogos, total: jogos.length }
}

// Converte o status da FlashLive pro vocabulário que o Tracker (index.js) já entende
// (finished / retired / walkover / canceled / postponed / abandoned / suspended / inprogress / notstarted).
// Retirement e WO vêm em STAGE com STAGE_TYPE "FINISHED" — por isso são checados antes.
function mapearStatusTenis(ev) {
  const t = String(ev.STAGE_TYPE ?? '').toUpperCase()
  const s = String(ev.STAGE ?? '').toUpperCase()
  const txt = `${t} ${s}`
  if (/POSTPONED|ADIADO/.test(txt))               return 'postponed'
  if (/CANCEL/.test(txt))                         return 'canceled'
  if (/WALKOVER|\bW\.?O\.?(\s|$)/.test(txt))      return 'walkover'
  if (/RETIRED|DESIST|RETIRAD/.test(txt))         return 'retired'
  if (/ABANDON/.test(txt))                        return 'abandoned'
  if (/SUSPEND|INTERRUPT/.test(txt))              return 'suspended'
  if (t === 'FINISHED')                           return 'finished'
  if (['NOT_STARTED', 'SCHEDULED', 'FIXTURE'].includes(t)) return 'notstarted'
  return 'inprogress'
}
/** Estatísticas ao vivo (placar por set + games do set atual) de UMA partida de tênis. */
export async function getEstatisticasTenisAoVivo(matchId) {
  if (!matchId) return { erro: 'matchId obrigatório' }
  const dados = await flFetch('events/data', { event_id: String(matchId) })
  const ev = [dados, dados?.EVENT, dados?.EVENTS?.[0], Array.isArray(dados) ? dados[0] : null]
    .find(c => c && typeof c === 'object' && (c.HOME_NAME || c.EVENT_ID))
  if (!ev) return { erro: `Partida ${matchId} não encontrada na FlashLive` }

  const nomeT = ev.TOURNAMENT_NAME ?? ev.NAME ?? ''
  const j = montarJogoTenisAoVivo({ ...ev, EVENT_ID: ev.EVENT_ID ?? String(matchId) }, nomeT)
  return {
    id: j.id, mandante: j.mandante, visitante: j.visitante, competicao: j.competicao,
    bestOf: j.bestOf, status: mapearStatusTenis(ev), statusDescricao: j.statusDescricao,
    placarSets: j.placarSets, setsMandante: j.setsMandante, setsVisitante: j.setsVisitante,
    fonte: 'flashlive_live_stats',
  }
}

// ─────────────────────────────────────────────────────────────
// H2H de uma partida específica
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// H2H DO CONFRONTO — formato real confirmado em 25/09/2026: DATA é um
// array de "abas" (Todos os pisos, Grama, Piso duro, Saibro), cada uma já
// com sua própria "Confrontos diretos" — a FlashLive separa por piso
// sozinha, não precisa agrupar na mão como no motor antigo.
// H_RESULT vem sempre null no grupo "Confrontos diretos"; quem diz o
// vencedor é o "*" na frente do nome — inclusive em RETIRED com placar
// de sets empatado, onde comparar sets erraria o resultado.
// ─────────────────────────────────────────────────────────────
const SURFACE_ABA_MAP = { 'Grama': 'grama', 'Piso duro': 'duro', 'Saibro': 'saibro', 'Indoor': 'indoor' }

const limparNomeVencedor = (nome = '') => nome.startsWith('*') ? nome.slice(1) : nome
const ehVencedor = (nome = '') => nome.startsWith('*')

function parseConfrontosDiretos(itemsBrutos, eventIdHoje) {
  const jogoHoje = itemsBrutos.find(it => it.EVENT_ID === eventIdHoje)
  if (!jogoHoje) return { confrontos: [], mandanteHoje: null, visitanteHoje: null }

  const mandanteHoje  = limparNomeVencedor(jogoHoje.HOME_PARTICIPANT ?? '')
  const visitanteHoje = limparNomeVencedor(jogoHoje.AWAY_PARTICIPANT ?? '')

  const confrontos = itemsBrutos
    .filter(it => it.EVENT_ID !== eventIdHoje)
    .map(it => {
      const nomeMandante = limparNomeVencedor(it.HOME_PARTICIPANT ?? '')
      const mandanteVenceu = ehVencedor(it.HOME_PARTICIPANT ?? '')
      const mandanteHojeEraMandante = nomeMandante === mandanteHoje
      const vencedorFoiMandanteDeHoje = mandanteHojeEraMandante ? mandanteVenceu : !mandanteVenceu

      const [s1, s2] = String(it.CURRENT_RESULT ?? '').split(':').map(n => parseInt(n))
      const setsMandanteHoje  = mandanteHojeEraMandante ? s1 : s2
      const setsVisitanteHoje = mandanteHojeEraMandante ? s2 : s1

      return {
        data: it.START_TIME ? new Date(it.START_TIME * 1000).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '?',
        competicao: it.EVENT_NAME ?? 'Desconhecida',
        setsMandante: Number.isFinite(setsMandanteHoje) ? setsMandanteHoje : null,
        setsVisitante: Number.isFinite(setsVisitanteHoje) ? setsVisitanteHoje : null,
        vencedor: vencedorFoiMandanteDeHoje ? 'mandante' : 'visitante',
        eventId: it.EVENT_ID,
        timestamp: it.START_TIME ?? null,
      }
    })
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))

  return { confrontos, mandanteHoje, visitanteHoje }
}

export async function getH2HTenis(eventId) {
  if (!eventId) return { confrontos: [], totalJogos: 0, semDados: true }

  const dados = await flFetch('events/h2h', { event_id: eventId })
  if (!dados) return { confrontos: [], totalJogos: 0, semDados: true, fonte: 'flashlive_h2h' }

  const abaGeral = (Array.isArray(dados) ? dados : []).find(a => a.TAB_NAME === 'Todos os pisos') ?? dados?.[0]
  const grupoGeral = (abaGeral?.GROUPS ?? []).find(g => g.GROUP_LABEL === 'Confrontos diretos')
  const { confrontos, mandanteHoje, visitanteHoje } = parseConfrontosDiretos(grupoGeral?.ITEMS ?? [], eventId)

  if (!confrontos.length) return { confrontos: [], totalJogos: 0, semDados: true, fonte: 'flashlive_h2h' }

  const totalJogos        = confrontos.length
  const vitoriasMandante  = confrontos.filter(c => c.vencedor === 'mandante').length
  const vitoriasVisitante = confrontos.filter(c => c.vencedor === 'visitante').length

  let vitoriasMandantePonderada = 0, totalJogosPonderado = 0
  confrontos.forEach((c, i) => {
    const peso = Math.pow(DECAY_FORMA, i)
    totalJogosPonderado += peso
    if (c.vencedor === 'mandante') vitoriasMandantePonderada += peso
  })

  // ── Recorte por superfície — a FlashLive já traz isso pronto em abas ──
  const porSuperficie = {}
  for (const aba of Array.isArray(dados) ? dados : []) {
    const chave = SURFACE_ABA_MAP[aba.TAB_NAME]
    if (!chave) continue
    const grupo = (aba.GROUPS ?? []).find(g => g.GROUP_LABEL === 'Confrontos diretos')
    const { confrontos: confrontosAba } = parseConfrontosDiretos(grupo?.ITEMS ?? [], eventId)
    if (confrontosAba.length) {
      porSuperficie[chave] = {
        vitoriasMandante: confrontosAba.filter(c => c.vencedor === 'mandante').length,
        vitoriasVisitante: confrontosAba.filter(c => c.vencedor === 'visitante').length,
        totalJogos: confrontosAba.length,
      }
    }
  }

  return {
    confrontos,
    totalJogos,
    semDados: false,
    mandante: mandanteHoje,
    visitante: visitanteHoje,
    resumo: {
      vitoriasMandante,
      vitoriasVisitante,
      totalJogos,
      probMandanteH2H: Math.round((vitoriasMandante / totalJogos) * 100),
      probVisitanteH2H: Math.round((vitoriasVisitante / totalJogos) * 100),
      vitoriasMandantePonderada,
      totalJogosPonderado,
    },
    porSuperficie,
    fonte: 'flashlive_h2h_completo',
  }
}

// ─────────────────────────────────────────────────────────────
// RANKING ATP / WTA
// ─────────────────────────────────────────────────────────────
let _rankingIdsCache = null // { 'ATP Singles': 'xxxx', 'WTA Singles': 'yyyy' }

async function getRankingIds() {
  if (_rankingIdsCache) return _rankingIdsCache
  const lista = await flFetch('rankings/list', { sport_id: SPORT_TENIS })
  if (!lista) return null
  const mapa = {}
  for (const r of lista) {
    if (r.RANKING_LABEL) mapa[r.RANKING_LABEL] = r.RANKING_ID
  }
  _rankingIdsCache = mapa
  return mapa
}

const ehRankingSimples = l => {
  const n = norm(l)
  return (n.includes('singles') || n.includes('simples')) && !n.includes('race') && !n.includes('corrida')
}
// IDs vistos no diagnóstico (rankings/list), usados só se o rótulo mudar
const RANKING_ID_FALLBACK = { ATP: 'dSJr14Y8', WTA: 'hfDiar3L' }

/** tipo: 'ATP' ou 'WTA' */
export async function getRankingTenis(tipo = 'ATP') {
  const mapa = await getRankingIds()
  if (!mapa) return { erro: 'FlashLive não respondeu (verifique FLASHLIVE_KEY)' }

  const label = Object.keys(mapa).find(l => norm(l).includes(norm(tipo)) && ehRankingSimples(l))
  const rankingId = label ? mapa[label] : RANKING_ID_FALLBACK[tipo]
  if (!rankingId) return { erro: `Ranking '${tipo}' não encontrado`, rankingsDisponiveis: Object.keys(mapa) }

  const dados = await flFetch('rankings/data', { ranking_id: rankingId })
  if (!dados) return { erro: 'FlashLive não respondeu ao buscar o ranking' }

  return { tipo, label: label ?? `${tipo} (id fixo)`, fonte: 'flashlive', dados }
}

// ─────────────────────────────────────────────────────────────
// ÍNDICE DE RANKING (ATP + WTA singles) — alimenta o sinal de ranking do
// motor de previsão. Antes NINGUÉM preenchia jogo.rankingMandante/Visitante
// (o comentário do motor dizia que a FlashLive mandava no evento, mas o
// scraper nunca copiava) — então o sinal de ranking só funcionava com a
// chave opcional do AllSports.
//
// ⚠️ O formato exato de /v1/rankings/data NÃO está confirmado — por isso o
// parser é defensivo (procura a lista de linhas e aceita vários nomes de
// campo) e existe getDiagnosticoRankingTenis() pra ver a resposta crua.
// ─────────────────────────────────────────────────────────────
const _pick = (obj, chaves) => { for (const k of chaves) if (obj?.[k] != null && obj[k] !== '') return obj[k]; return null }

const RE_RANK = /^(rank|ranking|position|pos|place|team_?rank|participant_?rank|current_?rank)$/i

function _campo(obj, re) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (re.test(k) && v != null && v !== '' && typeof v !== 'object') return v
  }
  return null
}

// Devolve { rank, id, nome } ou null. Aceita nome/id no próprio objeto ou num sub-objeto (TEAM/PARTICIPANT/PLAYER).
function linhaDeRanking(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null
  const rank = parseInt(String(_campo(o, RE_RANK) ?? '').replace(/[^\d]/g, ''))
  if (!Number.isFinite(rank) || rank <= 0) return null
  const fontes = [o, ...Object.values(o).filter(v => v && typeof v === 'object' && !Array.isArray(v))]
  let id = null, nome = null
  for (const f of fontes) {
    id   ??= _campo(f, /^(team_?id|participant_?id|player_?id|id)$/i)
    nome ??= _campo(f, /^(team_?name|participant_?name|player_?name|name|short_?name|team)$/i)
  }
  if (id == null && nome == null) return null
  return { rank, id: id != null ? String(id) : null, nome: nome != null ? String(nome) : null }
}

function acharLinhasRanking(dados, prof = 0) {
  if (prof > 6 || dados == null || typeof dados !== 'object') return []
  if (Array.isArray(dados)) {
    const diretas = dados.map(linhaDeRanking).filter(Boolean)
    if (diretas.length >= Math.max(1, dados.length * 0.5)) return diretas
    return dados.flatMap(d => acharLinhasRanking(d, prof + 1))
  }
  const proprio = linhaDeRanking(dados)
  if (proprio) return [proprio]
  return Object.values(dados).flatMap(v => acharLinhasRanking(v, prof + 1))
}

let _rankIndexCache = null
let _rankIndexExpira = 0
const TTL_RANK_INDEX = 6 * 60 * 60 * 1000

/** { porId: Map(id → rank), porNome: Map(nomeNormalizado → rank), total } — nunca lança erro. */
export async function getIndiceRankingTenis() {
  if (_rankIndexCache && Date.now() < _rankIndexExpira) return _rankIndexCache
  const porId = new Map(), porNome = new Map()
  try {
    for (const tipo of ['ATP', 'WTA']) {
      const r = await getRankingTenis(tipo)
      if (!r || r.erro) continue
      for (const linha of acharLinhasRanking(r.dados)) {
        if (linha.id != null) porId.set(linha.id, linha.rank)
        if (linha.nome) porNome.set(norm(linha.nome), linha.rank)
      }
    }
  } catch (e) {
    console.warn('[FlashLive Tênis] índice de ranking falhou:', e.message)
  }
  const indice = { porId, porNome, total: porId.size }
  if (porId.size || porNome.size) { _rankIndexCache = indice; _rankIndexExpira = Date.now() + TTL_RANK_INDEX }
  return indice
}

/** Ranking de um jogador: tenta pelo id da FlashLive; se não, pelo nome ("Sobrenome I." ↔ nome igual). */
export function rankingDoJogador(indice, id, nome) {
  if (!indice) return null
  if (id != null && indice.porId.has(String(id))) return indice.porId.get(String(id))
  const n = norm(nome)
  if (n && indice.porNome.has(n)) return indice.porNome.get(n)
  return null
}

/** Diagnóstico: devolve a resposta CRUA de rankings/list e rankings/data (ATP) pra conferir os campos. */
export async function getDiagnosticoRankingTenis() {
  const lista = await flFetch('rankings/list', { sport_id: SPORT_TENIS })
  if (!lista) return { flashliveRespondeu: false, chaveConfigurada: !!FLASHLIVE_KEY }
  const mapa = await getRankingIds()
  const labelAtp = Object.keys(mapa ?? {}).find(l => norm(l).includes('atp') && ehRankingSimples(l))
  const dados = await flFetch('rankings/data', { ranking_id: labelAtp ? mapa[labelAtp] : RANKING_ID_FALLBACK.ATP })
  const linhas = acharLinhasRanking(dados)
  return {
    rankingsDisponiveis: lista.map(r => ({ RANKING_ID: r.RANKING_ID, RANKING_LABEL: r.RANKING_LABEL })),
    labelAtpUsado: labelAtp ?? null,
    linhasReconhecidas: linhas.length,
    exemploLinha: linhas[0] ?? null,
    amostraCrua: Array.isArray(dados) ? dados.slice(0, 2) : dados,
  }
}

// ─────────────────────────────────────────────────────────────
// ODDS — pré-jogo e ao vivo
// Estrutura confirmada na doc oficial: DATA[].BETTING_TYPE > PERIODS[] >
// GROUPS[] > MARKETS[] > { BOOKMAKER_NAME, ODD_CELL_FIRST/SECOND/THIRD }
// ─────────────────────────────────────────────────────────────
function extrairCasasOdds(mercadoRaw) {
  const casas = []
  for (const periodo of mercadoRaw.PERIODS ?? []) {
    for (const grupo of periodo.GROUPS ?? []) {
      for (const mkt of grupo.MARKETS ?? []) {
        casas.push({
          casaId: mkt.BOOKMAKER_ID ?? null,
          casa: mkt.BOOKMAKER_NAME ?? 'Casa desconhecida',
          periodo: periodo.ODDS_STAGE ?? null,
          odd1: mkt.ODD_CELL_FIRST?.VALUE ?? null,
          odd2: mkt.ODD_CELL_SECOND?.VALUE ?? null,
          odd3: mkt.ODD_CELL_THIRD?.VALUE ?? null, // tênis normalmente não tem 3ª opção (sem empate)
        })
      }
    }
  }
  return casas
}

/** Odds pré-jogo de uma partida de tênis (todas as casas que a FlashLive trouxer). */
export async function getOddsTenisEvento(eventId) {
  if (!eventId) return { erro: 'eventId obrigatório' }
  const dados = await flFetch('events/odds', { event_id: eventId })
  if (!dados) return { erro: 'Sem odds disponíveis para este evento (ou fora do período coberto)' }

  const mercados = (Array.isArray(dados) ? dados : []).map(m => ({
    mercado: m.BETTING_TYPE ?? 'Desconhecido',
    casas: extrairCasasOdds(m),
  }))

  return { eventId, mercados, fonte: 'flashlive_odds' }
}

/** Odds ao vivo — a FlashLive exige informar a casa de apostas (book_id). Padrão: 16 = bet365. */
export async function getOddsTenisAoVivo(eventId, bookId = 16) {
  if (!eventId) return { erro: 'eventId obrigatório' }
  const dados = await flFetch('events/live-odds', { event_id: eventId, book_id: bookId })
  if (!dados) return { erro: 'Sem odds ao vivo disponíveis para este evento/casa' }

  return { eventId, bookId, dados, fonte: 'flashlive_live_odds' }
}

// ─────────────────────────────────────────────────────────────
// DIAGNÓSTICO — abre no navegador. Mostra os nomes reais de torneio de
// tênis que a FlashLive está devolvendo hoje (pra confirmar palavras-chave
// ATP/WTA e checar se existe campo de piso/superfície).
// ─────────────────────────────────────────────────────────────
export async function getDiagnosticoTenis() {
  const eventos = await buscarEventosTenis(0)
  if (!eventos) return { flashliveRespondeu: false, chaveConfigurada: !!FLASHLIVE_KEY }

  return {
    flashliveRespondeu: true,
    totalTorneios: eventos.length,
    torneios: eventos.map(t => ({
      NAME: t.NAME ?? null,
      NAME_PART_1: t.NAME_PART_1 ?? null,
      NAME_PART_2: t.NAME_PART_2 ?? null,
      CATEGORY_NAME: t.CATEGORY_NAME ?? null,
      COUNTRY_NAME: t.COUNTRY_NAME ?? null,
      totalJogos: (t.EVENTS ?? []).length,
      // primeiro evento cru do torneio, pra ver TODOS os campos que vêm
      // (inclusive procurar se existe algo tipo GROUND/SURFACE)
      exemploEvento: t.EVENTS?.[0] ?? null,
    })),
  }
}

// ─────────────────────────────────────────────────────────────
// DIAGNÓSTICO — histórico de jogador. Antes de escrever o motor de
// previsão (fadiga/forma/risco de desistência) em cima da FlashLive,
// precisamos confirmar o formato real de /v1/teams/results — a doc
// oficial não mostra exemplo de resposta pra esse endpoint específico.
// ─────────────────────────────────────────────────────────────
export async function getDiagnosticoHistoricoTenis(playerId) {
  if (!playerId) return { erro: 'playerId obrigatório (pegue um mandanteId/visitanteId de /flashlive/tenis/jogos)' }
  const dados = await flFetch('teams/results', { sport_id: SPORT_TENIS, team_id: playerId, page: 1 })
  if (!dados) return { erro: 'FlashLive não respondeu (verifique FLASHLIVE_KEY ou se o playerId está certo)' }
  const todos = achatarEventosTeamResults(dados)
  const doJogador = todos.filter(ev => ev.HOME_PARTICIPANT_IDS?.[0] === playerId || ev.AWAY_PARTICIPANT_IDS?.[0] === playerId)
  const historico = await getHistoricoJogadorTenis(playerId, 8)
  return {
    playerId,
    totalRecebido: Array.isArray(dados) ? dados.length : null,
    resumo: {
      eventosNoTotal: todos.length,
      eventosDoJogadorPorId: doJogador.length,
      comTiposDeParticipante: doJogador.filter(e => Array.isArray(e.HOME_PARTICIPANT_TYPES)).length,
      finalizados: doJogador.filter(e => e.STAGE_TYPE === 'FINISHED').length,
      comWinner: doJogador.filter(e => e.WINNER != null).length,
      aproveitadosNoModelo: historico.length,
    },
    exemploEvento: todos[0] ?? null,
    resultadoCru: dados,
  }
}

// ─────────────────────────────────────────────────────────────
// HISTÓRICO DE JOGADOR (via FlashLive /v1/teams/results) — substitui
// getHistoricoJogadorTenis do motor antigo. Confirmado com
// dados reais em 25/09/2026: STAGE_TYPE sempre "FINISHED"; quem diz se foi
// retirement/walkover é STAGE. O vencedor vem pronto em WINNER (1=casa,
// 2=fora) — não dá pra inferir comparando sets, porque num retirement o
// placar de sets pode ficar empatado (ex.: 1-1) mesmo tendo vencedor.
// ─────────────────────────────────────────────────────────────
// FlashLive manda placar como STRING ('6'); sem converter, '6'+'4' vira '64'
const numOuNull = v => { const n = parseInt(v); return Number.isFinite(n) ? n : null }
 // Lê o placar por set de qualquer nome comum (HOME_SCORE_PART_1, _PERIOD_1, _SET_1...).
// O regex termina em $, então chaves de tiebreak (…_PART_2_TIEBREAK) não entram.
function partesDoEvento(ev, lado /* 'HOME' | 'AWAY' */) {
  const out = {}
  for (const [k, v] of Object.entries(ev ?? {})) {
    const m = /^(HOME|AWAY)_SCORE_(?:PART|PERIOD|SET|P)_?(\d+)$/i.exec(k)
    if (!m || m[1].toUpperCase() !== lado) continue
    const val = numOuNull(v)
    if (val != null) out[parseInt(m[2])] = val
  }
  return out
}

function setsDetalheDoEvento(ev, ehCasa) {
  const meu = partesDoEvento(ev, ehCasa ? 'HOME' : 'AWAY')
  const adv = partesDoEvento(ev, ehCasa ? 'AWAY' : 'HOME')
  const ns = [...new Set([...Object.keys(meu), ...Object.keys(adv)].map(Number))].sort((a, b) => a - b)
  return ns
    .map(n => ({ jogador: meu[n] ?? null, adversario: adv[n] ?? null }))
    .filter(s => s.jogador != null && s.adversario != null)
}
const DESC_INVALIDAS_STAGE = ['RETIRED', 'WALKOVER', 'DEFAULT', 'ABANDONED', 'CANCELED', 'INTERRUPTED']

function achatarEventosTeamResults(dados) {
  const eventos = []
  for (const grupo of Array.isArray(dados) ? dados : []) {
    const torneioNome = nomeTorneio(grupo)
    for (const ev of grupo.EVENTS ?? []) {
      eventos.push({ ...ev, _torneioNome: torneioNome })
    }
  }
  return eventos
}

// WINNER (1=casa, 2=fora); se faltar, cai pro placar de sets (só quando não empatado)
function vencedorDoEvento(ev) {
  const w = parseInt(ev.WINNER)
  if (w === 1 || w === 2) return w
  const c = parseInt(ev.HOME_SCORE_CURRENT), f = parseInt(ev.AWAY_SCORE_CURRENT)
  if (Number.isFinite(c) && Number.isFinite(f) && c !== f) return c > f ? 1 : 2
  return null
}

/** Histórico de um jogador — só partidas de SIMPLES (filtra duplas pelo lado dele mesmo). */
export async function getHistoricoJogadorTenis(playerId, limit = 8) {
  if (!playerId) return []

  const dados = await flFetch('teams/results', { sport_id: SPORT_TENIS, team_id: playerId, page: 1 })
  if (!dados) return []

  const todosEventos = achatarEventosTeamResults(dados)

  const doJogador = todosEventos.filter(ev => {
    const ehCasa = ev.HOME_PARTICIPANT_IDS?.[0] === playerId
    const ehFora = ev.AWAY_PARTICIPANT_IDS?.[0] === playerId
    if (!ehCasa && !ehFora) return false
    const tipos = ehCasa ? ev.HOME_PARTICIPANT_TYPES : ev.AWAY_PARTICIPANT_TYPES
    // fail-open: se a API não mandar o tipo, não descarta o jogo (antes sumia TODO o histórico)
    if (!Array.isArray(tipos) || !tipos.length) return true
    return tipos.length === 1 && tipos[0] === 2
  })

  // ── Risco de desistência ──
  const LIMITE_RISCO_DESISTENCIA = 15
  const finalizadosRisco = doJogador
    .filter(ev => ev.STAGE_TYPE === 'FINISHED')
    .sort((a, b) => (b.START_TIME ?? 0) - (a.START_TIME ?? 0))
    .slice(0, LIMITE_RISCO_DESISTENCIA)
  const retirementsRecentes = finalizadosRisco.filter(ev => DESC_INVALIDAS_STAGE.includes(ev.STAGE)).length
  const riscoDesistencia = {
    totalChecados: finalizadosRisco.length,
    retirements: retirementsRecentes,
    taxa: finalizadosRisco.length ? retirementsRecentes / finalizadosRisco.length : 0,
  }

  // ── Forma recente (exclui retirement/walkover/etc) ──
  const finalizados = doJogador
    .filter(ev => ev.STAGE_TYPE === 'FINISHED' && !DESC_INVALIDAS_STAGE.includes(ev.STAGE) && vencedorDoEvento(ev) != null)
    .sort((a, b) => (b.START_TIME ?? 0) - (a.START_TIME ?? 0))
    .slice(0, limit)

  const historico = finalizados.map(ev => {
    const ehCasa = ev.HOME_PARTICIPANT_IDS?.[0] === playerId
    const venceu = ehCasa ? vencedorDoEvento(ev) === 1 : vencedorDoEvento(ev) === 2
    const setsGanhos   = parseInt((ehCasa ? ev.HOME_SCORE_CURRENT : ev.AWAY_SCORE_CURRENT) ?? '0') || 0
    const setsPerdidos = parseInt((ehCasa ? ev.AWAY_SCORE_CURRENT : ev.HOME_SCORE_CURRENT) ?? '0') || 0

    const setsDetalhe = setsDetalheDoEvento(ev, ehCasa)

    return {
      resultado: venceu ? 'V' : 'D',
      setsGanhos,
      setsPerdidos,
      foiStraightSets: setsPerdidos === 0 && setsGanhos >= 2,
      setsDetalhe,
      eventId: ev.EVENT_ID,
      data: ev.START_TIME ?? null,
      competicao: ev._torneioNome ?? 'Desconhecida',
      piso: extrairSuperficie(ev._torneioNome ?? ''),
      adversario: ehCasa ? (ev.AWAY_NAME ?? '?') : (ev.HOME_NAME ?? '?'),
      adversarioId: ehCasa ? ev.AWAY_PARTICIPANT_IDS?.[0] : ev.HOME_PARTICIPANT_IDS?.[0],
    }
  })

  historico.riscoDesistencia = riscoDesistencia
  return historico
}