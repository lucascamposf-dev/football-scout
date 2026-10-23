// valueConfig.js — regras de "value bet" (edge mínimo) por categoria de mercado.
// ─────────────────────────────────────────────────────────────
// Antes: um único EDGE_MINIMO_VALUE = 5pp valia pra tudo (gols, 1X2, cartões,
// escanteios), independente da incerteza do modelo e da margem da casa.
// Agora o mínimo depende da CATEGORIA e da FAIXA DE ODD.
//
// edge (pp) = probabilidade do modelo (%) − probabilidade implícita da odd (%)
//
// ⚙️  Todos os números abaixo são pontos de partida (julgamento, não verdade
//     estatística) — ajuste conforme o seu Tracker mostrar.

/** Edge mínimo BASE (pontos percentuais) por categoria. */
export const EDGE_MINIMO_BASE = {
  gols:       5,  // totais de gols: mercado líquido, modelo mais calibrado (era o valor único antigo)
  '1x2':      6,  // resultado final: margem da casa maior e modelo mais incerto
  escanteios: 6,  // amostra menor, mais variância (árbitro/estilo) e margem da casa costuma ser maior
  cartoes:    6,  // idem — depende muito do árbitro
}

/** Acréscimo por faixa de odd: odd alta = probabilidade pequena = erro do modelo pesa mais. */
export const ACRESCIMO_POR_ODD = [
  { minOdd: 3.0, extra: 2 },
  { minOdd: 2.0, extra: 1 },
]

/** EV mínimo (fração: 0.03 = +3%) exigido junto com o edge. */
export const EV_MINIMO = 0.03

/** Ao vivo: true = "🔥 vale a pena" exige edge mínimo da categoria (além de EV > 0). false = só EV > 0 (regra antiga). */
export const APLICAR_EDGE_MINIMO_AO_VIVO = true

/** Normaliza nomes de categoria ("Cartões", "cartoes", "Gols", "1X2"...) pra chave de EDGE_MINIMO_BASE. */
export function categoriaValue(cat) {
  const t = String(cat || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
  if (t.startsWith('cart')) return 'cartoes'
  if (t.startsWith('escant')) return 'escanteios'
  if (t === '1x2') return '1x2'
  return 'gols'
}

/** Edge mínimo (pp) exigido para uma categoria numa determinada odd. */
export function edgeMinimoPara(categoria, odd) {
  const base = EDGE_MINIMO_BASE[categoriaValue(categoria)] ?? EDGE_MINIMO_BASE.gols
  const faixa = typeof odd === 'number' && odd > 1 ? ACRESCIMO_POR_ODD.find(f => odd >= f.minOdd) : null
  return base + (faixa ? faixa.extra : 0)
}

/** Edge em pp: prob do modelo (0–100) − 100/odd. null se faltar dado. */
/** Edge em pp: prob do modelo (0–100) − 100/odd. null se faltar dado. */
export function calcEdgePP(prob, odd) {
  if (prob == null || !odd || odd <= 1) return null
  return parseFloat((prob - 100 / odd).toFixed(1))
}

// ✅ NOVO — Fase 8, item 38: Kelly fracionário.
// Kelly CHEIO (f* = (b·p − (1−p)) / b, b = odd−1) maximiza crescimento de
// banca no longo prazo, mas é MUITO sensível a erro de estimativa de p — se
// o modelo errar a prob. por poucos pontos, Kelly cheio já sugere stake
// agressivo demais. Fracionário (aqui 1/4) sacrifica crescimento teórico por
// muito menos variância — é o padrão recomendado quando p vem de um modelo
// estatístico (não de informação certa).
export const KELLY_FRACAO = 0.25       // 1/4 Kelly
export const KELLY_STAKE_MAX_PCT = 5   // teto rígido de % da banca por entrada, mesmo se o Kelly sugerir mais

/** % da banca sugerida (Kelly fracionário) pra uma entrada. 0 se não há edge positivo, null se faltar dado. */
export function calcKellyFracionario(probPct, oddDecimal, fracao = KELLY_FRACAO, maxPct = KELLY_STAKE_MAX_PCT) {
  if (probPct == null || !oddDecimal || oddDecimal <= 1) return null
  const p = probPct / 100
  const b = oddDecimal - 1
  const kellyCheio = (b * p - (1 - p)) / b
  if (kellyCheio <= 0) return 0
  return Math.round(Math.min(maxPct, kellyCheio * fracao * 100) * 10) / 10
}

// ✅ NOVO — Fase 7, item 30: edge (pp) a partir do qual a divergência
// modelo×mercado é forte o bastante pra virar alerta proativo (bem acima
// do edge mínimo de value bet, que já dispara o "🔥 vale a pena" na tela).
export const DIVERGENCIA_FORTE_EDGE_PP = 15