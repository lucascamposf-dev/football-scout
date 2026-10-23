// amistososService.js — Amistosos Internacionais de seleções via FlashLive
// Mesmo padrão do europaLeagueService.js, gerado pela factory genérica.
// ─────────────────────────────────────────────────────────────

import { createLeagueService } from './leagueFactory.js'

const GOLS_MEDIA_LIGA = { marcados: 1.40, sofridos: 1.40 } // média histórica de gols em amistosos

const {
  etapa1_buscarJogos:        am_etapa1_buscarJogos,
  etapa2_buscarHistoricos:   am_etapa2_buscarHistoricos,
  etapa3_calcularProbabilidades: am_etapa3_calcularProbabilidades,
} = createLeagueService({
  liga: 'amistosos',
  nomeCompeticao: 'Amistosos Internacionais',
  ligaCode: 'FRIENDLY',
  mediaGolsLiga: GOLS_MEDIA_LIGA,
})

export { am_etapa1_buscarJogos, am_etapa2_buscarHistoricos, am_etapa3_calcularProbabilidades }
