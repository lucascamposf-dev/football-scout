// testeCalibracao.mjs — verifica a CORREÇÃO da calibração (futebol).
// Rodar na raiz do projeto:   node testeCalibracao.mjs
// (usa os arquivos de src/services; se existir src/services/calibrationService.ORIGINAL.js,
//  também reproduz o bug "antes" pra comparar)
import { existsSync } from 'node:fs'

// ── stubs de navegador (os serviços foram feitos pro browser) ──────────────
globalThis.window = { location: { hostname: 'localhost' } }
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }

// ── tracker sintético servido no lugar de /api/tracker/calibracao-dados ────
let TRACKER = { atuais: [], arquivadas: [] }
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => TRACKER })

let seed = 12345
const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296
const iso = d => new Date(Date.now() - d * 86400000).toISOString()

/** Histórico SINTÉTICO (não é o seu banco): apostas de Gols/BTTS escolhidas (probs 50–85%)
 *  com taxa de acerto em DEGRAU (78% abaixo de 65%, 90% acima — relação monótona, mas não
 *  linear, que é onde a isotonic costuma "vencer" a validação) + Cartões/Escanteios com
 *  acerto ~93%. Serve pra reproduzir o MECANISMO do bug; qual técnica o original escolhe
 *  no seu histórico real depende dos seus dados. */
function montarTracker(nGols = 260, nCE = 160) {
  const arr = []
  const mk = (i, mercado, probBruta, pAcerto) => ({
    mandante: 'A', visitante: 'B', liga: 'Brasileirão', mercado, probBruta, probabilidade: probBruta,
    resultado: rnd() < pAcerto ? 'green' : 'red', criadoEm: iso(1 + i * 0.4), origem: 'auto',
  })
  const golsMk = ['Over 1.5 Gols', 'Over 2.5 Gols', 'Under 2.5 Gols', 'Under 3.5 Gols', 'BTTS Sim', 'Over 3.5 Gols']
  for (let i = 0; i < nGols; i++) {
    const p = 50 + rnd() * 35
    arr.push(mk(i, golsMk[i % golsMk.length], p, p < 65 ? 0.78 : 0.90))
  }
  const ceMk = ['Cartões Over 3.5', 'Cartões Over 4.5', 'Escanteios Over 7.5', 'Escanteios Over 8.5']
  for (let i = 0; i < nCE; i++) arr.push(mk(i, ceMk[i % ceMk.length], 65 + rnd() * 28, 0.93))
  return { atuais: arr, arquivadas: [] }
}

/** Cenário que REPRODUZ o bug no arquivo original: histórico pequeno (100 apostas de Gols/BTTS
 *  com ~90% de acerto, quase constante) + 60 de Cartões/Escanteios. Nele a validação do
 *  original elege a isotonic, e a curva devolve o MESMO "piso" pra qualquer probabilidade baixa.
 *  (histórico sintético — no seu banco real o piso depende dos seus greens/reds) */
function montarTrackerBug() {
  seed = 40 * 977
  const arr = []
  const mk = (i, mercado, probBruta, pAcerto) => ({
    mandante: 'A', visitante: 'B', liga: 'Brasileirão', mercado, probBruta, probabilidade: probBruta,
    resultado: rnd() < pAcerto ? 'green' : 'red', criadoEm: iso(1 + i * 0.3), origem: 'auto',
  })
  const gm = ['Over 1.5 Gols', 'Over 2.5 Gols', 'Under 2.5 Gols', 'Under 3.5 Gols', 'BTTS Sim', 'Over 3.5 Gols']
  for (let i = 0; i < 100; i++) arr.push(mk(i, gm[i % 6], 50 + rnd() * 35, 0.9))
  const cm = ['Cartões Over 3.5', 'Escanteios Over 7.5']
  for (let i = 0; i < 60; i++) arr.push(mk(i, cm[i % 2], 65 + rnd() * 28, 0.93))
  return { atuais: arr, arquivadas: [] }
}

// ── utilidades de teste ────────────────────────────────────────────────────
let falhas = 0, passou = 0
const ok = (cond, msg) => { if (cond) { passou++; console.log('  ✅', msg) } else { falhas++; console.log('  ❌', msg) } }
const titulo = t => console.log(`\n━━ ${t}`)
const pois = (l, k) => Math.exp(-l + k * Math.log(l) - [...Array(k)].reduce((s, _, i) => s + Math.log(i + 1), 0))
const overPois = (l, linha) => { let c = 0; for (let k = 0; k <= Math.floor(linha); k++) c += pois(l, k); return Math.round((1 - c) * 100) }

const novo = await import('./src/services/calibrationService.js')
const T = novo.__teste
const orig = existsSync('./src/services/calibrationService.ORIGINAL.js')
  ? await import('./src/services/calibrationService.ORIGINAL.js') : null
const groq = await import('./src/services/groqService.js')

/** stats sintéticos de um time que marca/sofre `g` gols por jogo (λ_total ≈ 2g). */
function statsTime(g) {
  const l = 2 * g
  const r = (n) => Math.round(overPois(l, n))
  return {
    semDados: false, nJogos: 8, mediaGolsMarcados: g, mediaGolsSofridos: g, mediaTotalGols: l,
    fatorTendencia: 1, perfil: 'neutro', formaSimbolo: [],
    over15Rate: r(1), over25Rate: r(2), under25Rate: 100 - r(2), over35Rate: r(3), bttsRate: 52,
  }
}
const jogoComLambda = g => groq.calcMercadoGols(statsTime(g), statsTime(g), null, 1, 1, 'BSA', null, null, null)

// ═══════════════════════════════════════════════════════════════════════════
titulo('1) Reproduzindo o bug com o arquivo ORIGINAL (antes)')
TRACKER = montarTrackerBug()
const LAMBDAS = [['λ≈2,29 (Palmeiras×Corinthians)', 1.145], ['λ≈2,88', 1.44], ['λ≈3,13', 1.565]]
const brutasDe = j => ({ over15: j.over15, under15: j.under15, over25: j.over25, under25: j.under25, over35: j.over35, under35: j.under35, btts: j.btts })
const antes = []
if (orig) {
  const o = await import('./src/services/calibrationService.ORIGINAL.js?cenario=bug') // cópia nova (sem cache)
  const oosO = await o.validacaoOutOfSample()
  console.log(`  técnica que o ORIGINAL elege neste histórico: ${oosO.melhorTecnica}`)
  const fatO = await o.calcFatoresCalibration()
  for (const [nome, g] of LAMBDAS) {
    const j = jogoComLambda(g), b = brutasDe(j)
    const c = await o.aplicarMelhorCalibracao(b, fatO)
    const esc = o.escolherMelhorMercadoCalibrado(o.normalizarParesOverUnder(c), fatO, 16)
    antes.push({ nome, lambda: j.mediaEsperada, b, c, esc })
    console.log(`  ${nome} λ=${j.mediaEsperada} | Over 3.5: bruto ${b.over35}% → ORIGINAL ${c.over35}% | Over 2.5: ${b.over25}% → ${c.over25}% | melhor=${esc.mercadoGolsLimpo} (${esc.melhor?.prob}%)`)
  }
  ok(oosO.melhorTecnica === 'isotonic', 'ORIGINAL elege a isotonic neste histórico')
  ok(antes.every(x => x.c.over35 >= 70), 'ORIGINAL: Over 3.5 sai ≥ 70% nos 3 jogos (bruto era 20–38%)')
  ok(new Set(antes.map(x => x.c.over35)).size === 1, 'ORIGINAL: os 3 jogos saem com Over 3.5 IDÊNTICO — é o "piso" da curva, não uma previsão por jogo')
  ok(antes.every(x => x.c.over25 === x.c.over35), 'ORIGINAL: Over 2.5 e Over 3.5 saem IGUAIS entre si em cada jogo (a curva ignora a entrada abaixo do treino)')
} else {
  console.log('  (calibrationService.ORIGINAL.js não encontrado — pulando a comparação "antes")')
}

// ═══════════════════════════════════════════════════════════════════════════
titulo('2) Palmeiras × Corinthians — DEPOIS (arquivo corrigido, configuração padrão, MESMO histórico)')
novo.invalidarCacheCalibration()
const j229 = jogoComLambda(1.145)
const brutas229 = { over15: j229.over15, under15: j229.under15, over25: j229.over25, under25: j229.under25, over35: j229.over35, under35: j229.under35, btts: j229.btts }
const fat = await novo.calcFatoresCalibration()
const cal229 = await novo.aplicarMelhorCalibracao(brutas229, fat)
console.log(`  λ=${j229.mediaEsperada} | Over 3.5 BRUTO=${brutas229.over35}% → CALIBRADO=${cal229.over35}% | técnica=${cal229.calibracaoTecnica} | alertas=${cal229.calibracaoAlertas.length}`)
ok(cal229.calibracaoTecnica === 'fator', 'produção usa o fator simples (curvas desligadas)')
ok(cal229.over35 <= 30, `Over 3.5 voltou pra faixa realista (${cal229.over35}% ≤ 30%)`)
ok(Math.abs(cal229.over35 - brutas229.over35) <= T.MAX_MOVIMENTO_CALIBRACAO_PP, 'calibração moveu ≤ 10pp')
ok(cal229.over35 + cal229.under35 === 100, 'Over 3.5 + Under 3.5 = 100')

// ═══════════════════════════════════════════════════════════════════════════
titulo('3) λ diferentes → probabilidades DIFERENTES e coerentes (pipeline completo, antes × depois)')
const saidas = []
for (const [nome, g] of LAMBDAS) {
  const j = jogoComLambda(g), b = brutasDe(j)
  const c = await novo.aplicarMelhorCalibracao(b, fat)
  const esc = novo.escolherMelhorMercadoCalibrado(novo.normalizarParesOverUnder(c), fat, 16)
  const ant = antes.find(x => x.nome === nome)
  saidas.push({ nome, lambda: j.mediaEsperada, b, c, esc })
  console.log(`  ${nome} λ=${j.mediaEsperada} | O1.5 ${b.over15}→${c.over15} | O2.5 ${b.over25}→${c.over25} | O3.5 ${b.over35}→${c.over35} | melhor=${esc.mercadoGolsLimpo}${ant ? `   [antes: O3.5=${ant.c.over35}%, melhor=${ant.esc.mercadoGolsLimpo} ${ant.esc.melhor?.prob}%]` : ''}`)
}
ok(new Set(saidas.map(s => s.c.over35)).size === 3, 'os 3 jogos geram Over 3.5 distintos')
ok(new Set(saidas.map(s => s.c.over25)).size === 3, 'os 3 jogos geram Over 2.5 distintos')
ok(saidas[0].c.over35 < saidas[1].c.over35 && saidas[1].c.over35 < saidas[2].c.over35, 'Over 3.5 cresce com o λ')
ok(saidas.every(s => s.c.over15 >= s.c.over25 && s.c.over25 >= s.c.over35), 'linhas coerentes (O1.5 ≥ O2.5 ≥ O3.5) nos 3 jogos')
ok(saidas.every(s => s.c.over35 < 50), 'nenhum jogo com Over 3.5 ≥ 50% (modelo base limita em 50%)')
ok(saidas.every(s => !(s.esc.melhorOver?.nome === 'Over 3.5 Gols' && s.esc.melhorOver.prob >= 50)), 'ranking não elege "Over 3.5" com prob. alta')
ok(saidas.every(s => Math.abs(s.c.over35 - overPois(s.lambda, 3)) <= 20), 'Over 3.5 final fica a ≤ 20pp do Poisson puro do λ do jogo')
ok(saidas.every(s => s.esc.melhor == null || s.esc.melhor.nome !== 'Over 3.5 Gols'), 'a "melhor entrada" deixou de ser Over 3.5 (o piso da curva)')

// ═══════════════════════════════════════════════════════════════════════════
titulo('4) Curva FORÇADA (como se alguém ligasse a chave): grade de 5% a 95%')
TRACKER = montarTracker()
novo.invalidarCacheCalibration()
const { pares, nReais } = T.paresParaCurva(TRACKER.atuais)
console.log(`  treino da curva: ${nReais} apostas de Gols/BTTS (Cartões/Escanteios excluídos de ${TRACKER.atuais.length} entradas)`)
ok(nReais === 260, 'treino da curva só contém Gols/BTTS (Cartões/Escanteios fora)')
const isoM = T.fitIsotonic(pares), plM = T.fitPlatt(pares)
console.log(`  domínio de treino: ${(isoM.min * 100).toFixed(0)}%–${(isoM.max * 100).toFixed(0)}%`)
for (const tecnica of ['isotonic', 'platt']) {
  const modelo = tecnica === 'isotonic' ? isoM : plM
  let maxMov = 0, nan = 0, forma = 0, espelhoRuim = 0, extrapolou = 0
  for (let p = 5; p <= 95; p++) {
    const brutas = { over15: p, under15: 100 - p, over25: p, under25: 100 - p, over35: p, under35: 100 - p, btts: p }
    const cal = T.travaSeguranca(brutas, T.aplicarCurvaProducao(brutas, { tecnica, curva: { isotonic: isoM, platt: plM } }), tecnica)
    for (const k of ['over15', 'over25', 'over35', 'btts']) {
      if (typeof cal[k] !== 'number' || Number.isNaN(cal[k])) nan++
      maxMov = Math.max(maxMov, Math.abs(cal[k] - p))
    }
    if (cal.over35 + cal.under35 !== 100) espelhoRuim++
    const x = p / 100
    const fora = x < modelo.min - 1e-9 || x > modelo.max + 1e-9
    if (fora && cal.over35 !== p) extrapolou++
  }
  console.log(`  ${tecnica}: maior movimento na grade = ${maxMov}pp`)
  ok(maxMov <= T.MAX_MOVIMENTO_CALIBRACAO_PP + 2, `${tecnica}: nunca move mais que o limite (10pp + 2 de arredondamento)`)
  ok(nan === 0, `${tecnica}: nenhum NaN/indefinido`)
  ok(espelhoRuim === 0, `${tecnica}: Over + Under = 100 em toda a grade`)
  ok(extrapolou === 0, `${tecnica}: fora da faixa de treino devolve o valor bruto (sem extrapolar)`)
}
// o caso exato do bug: bruto 20% numa curva treinada só com 50–85%
const soAltas = T.paresParaCurva(TRACKER.atuais.filter(e => e.probBruta >= 50)).pares.filter(p => p.x >= 0.5)
const curvaSoAltas = T.fitIsotonic(soAltas)
ok(T.applyIsotonic(curvaSoAltas, 0.20) === null, 'isotonic treinada só em probabilidades altas devolve null pra 20% (antes devolvia o piso ~83%)')
ok(T.applyPlatt(T.fitPlatt(soAltas), 0.20) === null, 'platt treinada só em probabilidades altas devolve null pra 20%')

// ═══════════════════════════════════════════════════════════════════════════
titulo('5) Validação: elegibilidade, teste de estresse e cobertura')
novo.invalidarCacheCalibration()
const oos = await novo.validacaoOutOfSample()
console.log(`  suficiente=${oos.suficiente} | melhorTecnica(produção)=${oos.melhorTecnica} | validada=${oos.melhorTecnicaValidada}`)
const d = oos.diagnosticoCurvas
console.log(`  amostras Gols/BTTS=${d.amostrasGolsBtts} | domínio=${JSON.stringify(d.dominioTreino)} | fora do domínio=${d.foraDominioPct}%`)
console.log(`  isotonic: elegível=${d.isotonic.elegivel} (${d.isotonic.estresse.motivo}) | platt: elegível=${d.platt.elegivel} (${d.platt.estresse.motivo})`)
ok(oos.melhorTecnica === 'fator', 'melhorTecnica reportada = fator (chave desligada)')
ok(d.dominioTreino && d.dominioTreino.minPct <= 15 && d.dominioTreino.maxPct >= 85, 'domínio de treino cobre as probabilidades baixas (treino simétrico)')
ok(['isotonic', 'platt'].every(t => d[t].estresse.maxDesvioPP == null || typeof d[t].estresse.ok === 'boolean'), 'teste de estresse roda nas duas técnicas')
// curva que distorce deve ser REPROVADA no estresse
const curvaRuim = T.fitIsotonic([...Array(60)].map((_, i) => ({ x: 0.05 + i * 0.015, y: 0.9 })))
ok(T.testeEstresseCurva('isotonic', curvaRuim).ok === false, 'curva que move probabilidades > 10pp é reprovada no teste de estresse')
if (orig) {
  const oosOrig = await orig.validacaoOutOfSample()
  console.log(`  (original) melhorTecnica=${oosOrig.melhorTecnica} — o original escolheria isso neste mesmo histórico`)
}

// ═══════════════════════════════════════════════════════════════════════════
titulo('6) Trava de segurança')
const brutaOk = { over15: 78, under15: 22, over25: 52, under25: 48, over35: 24, under35: 76, btts: 55 }
let t = T.travaSeguranca(brutaOk, { ...brutaOk, over35: 85, under35: 15 }, 'teste')
ok(t.over35 === 24 && t.under35 === 76 && t.calibracaoAlertas.length >= 1, 'Over 3.5 de 24% → 85% é barrado: volta pra 24% com aviso')
t = T.travaSeguranca(brutaOk, { ...brutaOk, over25: 20, under25: 80 }, 'teste')
ok(t.over25 === 52, 'queda grande (52% → 20%) também é barrada')
t = T.travaSeguranca(brutaOk, { ...brutaOk, over25: 60, under25: 40, over35: 62, under35: 38 }, 'teste')
ok(t.over35 <= t.over25 || t.calibracaoAlertas.length >= 1, 'linhas incoerentes (Over 3.5 > Over 2.5) são corrigidas/avisadas')
t = T.travaSeguranca(brutaOk, { ...brutaOk, over35: 30, under35: 70 }, 'teste')
ok(t.over35 === 30 && t.calibracaoAlertas.length === 0, 'ajuste pequeno e coerente passa sem aviso')

// ═══════════════════════════════════════════════════════════════════════════
titulo('7) Fator simples também respeita o teto de movimento')
const fatForte = { 'Gols:Over 3.5': 1.30, 'Gols:Under 3.5': 0.70, 'Gols:Over 2.5': 1.30, 'Gols:Under 2.5': 0.70, 'Gols:Over 1.5': 1.30, 'Gols:Under 1.5': 0.70, BTTS: 1.30 }
const cf = novo.aplicarCalibration({ over15: 78, under15: 22, over25: 60, under25: 40, over35: 40, under35: 60, btts: 60 }, fatForte)
console.log(`  fatores extremos (×1,30/×0,70): O1.5 ${cf.over15} | O2.5 ${cf.over25} | O3.5 ${cf.over35} | BTTS ${cf.btts}`)
ok(Math.abs(cf.over35 - 40) <= 12 && Math.abs(cf.over25 - 60) <= 12 && Math.abs(cf.btts - 60) <= 10, 'fator extremo não passa do teto de movimento')

console.log(`\n${falhas === 0 ? '🎉' : '⚠️'}  ${passou} verificações ok, ${falhas} falha(s)`)
process.exit(falhas ? 1 : 0)
