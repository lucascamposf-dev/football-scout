// server/modelVersion.js — versionamento do motor de previsão (Fase 1, item 4)
// Cópia server-side de src/services/modelVersion.js — ver comentários lá
// pra explicação completa. Os dois arquivos devem ser alterados JUNTOS
// quando a versão de um motor muda (não há bundler compartilhando os dois
// lados aqui, então a sincronia é manual).

export const MOTOR_FUTEBOL       = 'futebol'
export const MOTOR_TENIS_PREJOGO = 'tenis_prejogo'
export const MOTOR_TENIS_AOVIVO  = 'tenis_aovivo'

export const MOTOR_VERSAO_ATUAL = {
  [MOTOR_FUTEBOL]:       '1.0.1',
  [MOTOR_TENIS_PREJOGO]: '1.0.0',
  [MOTOR_TENIS_AOVIVO]:  '1.0.0',
}

/** Versão atual de um motor, já prefixada com o nome dele (ex.: "futebol@1.0.0")
 *  — ver comentário completo em src/services/modelVersion.js. */
export function versaoAtual(motor) {
  const v = MOTOR_VERSAO_ATUAL[motor]
  return v ? `${motor}@${v}` : null
}
