// modelVersion.js — versionamento do motor de previsão (Fase 1, item 4)
// ─────────────────────────────────────────────────────────────
// Cada previsão salva no Tracker passa a carregar QUAL versão do motor a
// gerou (campo `motorVersao`). Isso é o que permite, daqui pra frente:
//   • separar, num relatório de calibração, "esse mercado piorou porque a
//     amostra mudou" de "esse mercado piorou porque mudei a fórmula";
//   • fazer backtesting/drift (Fases 4 e 7) comparando só previsões da
//     MESMA versão, em vez de misturar lógicas diferentes na mesma métrica;
//   • saber, olhando uma entrada antiga, exatamente qual lógica a gerou.
//
// Existem hoje 3 motores independentes que alimentam o Tracker — cada um
// tem seu próprio número de versão, porque mudam em datas diferentes:
//   • 'futebol'        → src/services/groqService.js (pré-jogo)
//   • 'tenis_prejogo'   → server/scrapers/tennisScraper.js (pré-jogo)
//   • 'tenis_aovivo'    → src/services/liveOddsService.js (in-play)
//
// Convenção de versão (semver manual, MAJOR.MINOR.PATCH):
//   MAJOR — muda a fórmula estatística central (Poisson/ELO/blend de mercado)
//   MINOR — novo mercado, novo fator de calibração, nova fonte de dado
//   PATCH — ajuste de constante/threshold, correção de bug sem mudar a lógica
//
// ⚠️ Ao alterar a lógica de um motor: suba o número AQUI e acrescente uma
// entrada em HISTORICO_VERSOES (nunca apague entradas antigas — é o
// histórico que permite reconstruir o que gerou uma previsão passada).
// Este arquivo tem uma cópia server-side em server/modelVersion.js — ao
// mudar um dos dois, revisar se o outro também precisa mudar.

export const MOTOR_FUTEBOL       = 'futebol'
export const MOTOR_TENIS_PREJOGO = 'tenis_prejogo'
export const MOTOR_TENIS_AOVIVO  = 'tenis_aovivo'

export const MOTOR_VERSAO_ATUAL = {
  [MOTOR_FUTEBOL]:       '1.0.1',
  [MOTOR_TENIS_PREJOGO]: '1.0.0',
  [MOTOR_TENIS_AOVIVO]:  '1.0.0',
}

// Histórico de mudanças por motor. Baseline em 1.0.0: o motor já em
// produção (com tudo que a roadmap marca como ✅ até a Fase 1/item 3)
// passa a ser rastreado a partir de agora — mudanças anteriores a esta
// data não têm número de versão porque não eram rastreadas.
export const HISTORICO_VERSOES = {
  [MOTOR_FUTEBOL]: [
    { versao: '1.0.0', data: '2026-09-23', mudancas: [
      'Baseline rastreada: Poisson + H2H blend, ELO persistente, blend com mercado (remove overround), calibração automática do Tracker, mercado real de cartões/escanteios (árbitro + clima), camada de validação qualitativa por IA.',
    ]},
    { versao: '1.0.1', data: '2026-10-14', mudancas: [
      'Correção do sinal do fator ELO (fatorAdversario): antes o time mais forte recebia fator menor; agora o fator sobe com a vantagem de ELO do atacante. Rotas /api/elo passaram a enviar o token de login, e os jogos recentes são aplicados ao ELO no servidor uma única vez por jogo (/api/elo/jogos). ELO recalculado a partir do histórico 2021-26. Backtest: log-loss 1X2 1,0901 -> 1,0177.',
    ]},
  ],
  [MOTOR_TENIS_PREJOGO]: [
    { versao: '1.0.0', data: '2026-09-23', mudancas: [
      'Baseline rastreada: modelo de sets (race-to-N) + H2H + forma recente por superfície + fadiga + risco de desistência + calibração automática do Tracker.',
    ]},
  ],
  [MOTOR_TENIS_AOVIVO]: [
    { versao: '1.0.0', data: '2026-09-23', mudancas: [
      'Baseline rastreada: probabilidade de vencer o set/partida a partir do placar ao vivo + Poisson pra Total de Games + calibração automática do Tracker.',
    ]},
  ],
}

/** Versão atual de um motor, já prefixada com o nome dele (ex.: "futebol@1.0.0").
 *  O prefixo existe porque relatórios que juntam mais de um motor (ex.: tênis
 *  pré-jogo + tênis ao vivo, no mesmo relatório de calibração) não podem
 *  confundir a v1.0.0 de um motor com a v1.0.0 de outro — cada motor evolui
 *  e é versionado de forma independente.
 *  Retorna null se o nome do motor não existir no registro. */
export function versaoAtual(motor) {
  const v = MOTOR_VERSAO_ATUAL[motor]
  return v ? `${motor}@${v}` : null
}

// ✅ NOVO — item 29: versionamento do DATASET (fontes de dado), separado da
// versão do MOTOR (fórmula). Sobe quando uma fonte muda de forma estrutural
// (schema novo do scraper, troca de provedor de odds, etc.) — não quando só
// a fórmula do motor muda. Sem isso, um backtest antigo pode ficar
// irreproduzível se os dados-fonte mudarem retroativamente sem deixar rastro.
export const DATASET_VERSAO = '2026-10-14'

export const HISTORICO_DATASET = [
  { versao: '2026-09-24', mudancas: ['Baseline rastreada: Sofascore + FlashLive + AllSports + fbref + clima, como estão hoje.'] },
  { versao: '2026-10-14', mudancas: [
    'Sofascore removido das fontes (FlashLive + AllSports + fbref + clima permanecem).',
    'Novo histórico jogos_historico (2021-26; Premier League, La Liga, Serie A, Bundesliga e Ligue 1) com odds de abertura/fechamento, via coletor Python (soccerdata / Football-Data.co.uk).',
    'Novo mapa times_mapa (nome do histórico -> id football-data.org) e novas tabelas elo_historico / elo_ratings_backup; elo_ratings recalculado a partir do histórico.',
  ] },
]
