// nationsLeagueService.js — UEFA Nations League via FlashLive
// Mesmo padrão do europaLeagueService.js, gerado pela factory genérica.
// ─────────────────────────────────────────────────────────────

import { createLeagueService } from './leagueFactory.js'

const GOLS_MEDIA_LIGA = { marcados: 1.36, sofridos: 1.36 } // média histórica de gols na Nations League

const {
  etapa1_buscarJogos:        nl_etapa1_buscarJogos,
  etapa2_buscarHistoricos:   nl_etapa2_buscarHistoricos,
  etapa3_calcularProbabilidades: nl_etapa3_calcularProbabilidades,
} = createLeagueService({
  liga: 'nations_league',
  nomeCompeticao: 'UEFA Nations League',
  ligaCode: 'NL',
  mediaGolsLiga: GOLS_MEDIA_LIGA,
})

export { nl_etapa1_buscarJogos, nl_etapa2_buscarHistoricos, nl_etapa3_calcularProbabilidades }
