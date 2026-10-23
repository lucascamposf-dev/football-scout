"""
backtest_mercado.py — mede o NÚCLEO de gols do seu modelo contra o mercado (odds de fechamento),
só com dados do jogos_historico. NÃO altera nada no app nem no banco (só lê).

O que reproduz do groqService.js: últimos 5 jogos (mando se >=3), shrinkage K=7.5 para a média da liga,
λ = 55% ataque + 45% defesa adversária, fator ELO (bruto 0.80–1.25, depois 0.90–1.12), matriz Poisson com Dixon-Coles (ρ por liga).
O que NÃO reproduz (não há esses dados no histórico): H2H, tendência, perfil over/under, clima, desfalques, stacking.
Logo, mede o "esqueleto" do modelo, não a análise completa.

Compara 3 versões do fator ELO:  off (sem ELO) | app (fórmula atual do eloService.js) | fix (sinal invertido)

Uso:  python backtest_mercado.py        (variável de ambiente DATABASE_URL)
      python backtest_mercado.py --grid (testa várias faixas do fator ELO e mostra a de menor log-loss)

Os limites abaixo (LIM_BRUTO / LIM_GOLS) espelham ELO_FATOR_BRUTO / ELO_LIMITES_GOLS de src/services/eloService.js.
Se mudar lá, mude aqui (e vice-versa). Atenção: o backtest aplica o fator direto no λ (caminho dos GOLS);
o 1X2 do app usa o ELO como 25% de um blend (forma/H2H/ELO), que o backtest NÃO reproduz — por isso o --grid
decide o limite de GOLS (ELO_LIMITES_GOLS), não o do 1X2.
"""
import math, os, sys
from collections import defaultdict, deque

COD = {"ENG-Premier League": "PL", "ESP-La Liga": "PD", "FRA-Ligue 1": "FL1", "GER-Bundesliga": "BL1", "ITA-Serie A": "SA"}
MEDIA_GOLS = {"PL": 1.42, "PD": 1.28, "SA": 1.30, "BL1": 1.48, "FL1": 1.35, "DEFAULT": 1.30}
RHO = {"BL1": -0.10, "PL": -0.09, "PD": -0.12, "SA": -0.13, "FL1": -0.10, "DEFAULT": -0.10}
K_SHR, K_ELO, ELO0 = 7.5, 32.0, 1500.0
VARIANTES = ("off", "app", "fix")
LIM_BRUTO = (0.80, 1.25)   # = ELO_FATOR_BRUTO  (eloService.js)
LIM_GOLS  = (0.90, 1.12)   # = ELO_LIMITES_GOLS (eloService.js)
GRADE = [(0.90, 1.12), (0.88, 1.12), (0.85, 1.15), (0.85, 1.20), (0.80, 1.25), (0.95, 1.05)]
EPS = 1e-9

clamp = lambda x, a, b: max(a, min(b, x))

def pmf(l, k):
    return math.exp(-l + k * math.log(l) - math.lgamma(k + 1))

def matriz(lm, lv, cod):
    base = RHO.get(cod, RHO["DEFAULT"])
    tot = lm + lv
    rho = clamp(base + (-0.02 if tot < 2.0 else 0.02 if tot > 3.2 else 0), -0.15, -0.05)
    m, massa = [], 0.0
    for i in range(9):
        lin = []
        for j in range(9):
            p = pmf(lm, i) * pmf(lv, j)
            if i == 0 and j == 0: t = 1 - lm * lv * rho
            elif i == 0 and j == 1: t = 1 + lm * rho
            elif i == 1 and j == 0: t = 1 + lv * rho
            elif i == 1 and j == 1: t = 1 - rho
            else: t = 1
            p = max(0.0, p * t); lin.append(p); massa += p
        m.append(lin)
    return [[x / massa for x in lin] for lin in m]

def probs_matriz(lm, lv, cod):
    lm, lv = clamp(lm, 0.35, 2.30), clamp(lv, 0.35, 2.30)
    m = matriz(lm, lv, cod)
    h = d = a = o25 = 0.0
    for i in range(9):
        for j in range(9):
            p = m[i][j]
            if i > j: h += p
            elif i == j: d += p
            else: a += p
            if i + j >= 3: o25 += p
    return (h, d, a), o25

def shrink(media, n, liga):
    return (n * media + K_SHR * liga) / (n + K_SHR)

def desvig(*odds):
    inv = [1.0 / o for o in odds]
    s = sum(inv)
    return tuple(x / s for x in inv)

def odds_mercado(r):
    """1X2 e over/under 2.5 de fechamento: Pinnacle; se faltar, média do mercado."""
    def pega(pin, med):
        if all(r.get(c) for c in pin): return desvig(*[float(r[c]) for c in pin])
        if all(r.get(c) for c in med): return desvig(*[float(r[c]) for c in med])
        return None
    x12 = pega(("odds_pin_fech_h", "odds_pin_fech_d", "odds_pin_fech_a"), ("odds_med_fech_h", "odds_med_fech_d", "odds_med_fech_a"))
    ou = pega(("over25_pin_fech", "under25_pin_fech"), ("over25_med_fech", "under25_med_fech"))
    return x12, (ou[0] if ou else None)

def fator_elo(diff, lim):
    """1 + diferença/1000, limitado primeiro ao bruto e depois ao limite do consumidor (igual ao app)."""
    return clamp(clamp(1 + diff / 1000, *LIM_BRUTO), *lim)

def rodar(jogos, lim=LIM_GOLS, variantes=VARIANTES):
    """jogos: lista de dicts em ordem cronológica. Devolve lista de registros avaliáveis."""
    elo = defaultdict(lambda: ELO0)
    casa = defaultdict(lambda: deque(maxlen=5))   # (gf, ga) jogando em casa
    fora = defaultdict(lambda: deque(maxlen=5))
    geral = defaultdict(lambda: deque(maxlen=5))
    primeira = {}
    for r in jogos: primeira.setdefault(r["liga"], r["temporada"])
    saida = []
    for r in jogos:
        liga, m, v = r["liga"], r["mandante"], r["visitante"]
        gm, gv = r["gols_mandante"], r["gols_visitante"]
        if gm is None or gv is None: continue
        cod = COD.get(liga, "DEFAULT"); mg = MEDIA_GOLS.get(cod, MEDIA_GOLS["DEFAULT"])
        km, kv = (liga, m), (liga, v)
        ok = len(geral[km]) >= 3 and len(geral[kv]) >= 3
        if ok and r["temporada"] != primeira[liga]:
            x12, ou = odds_mercado(r)
            if x12 is not None:
                sm = casa[km] if len(casa[km]) >= 3 else geral[km]
                sv = fora[kv] if len(fora[kv]) >= 3 else geral[kv]
                n1, n2 = len(sm), len(sv)
                mM = shrink(sum(a for a, _ in sm) / n1, n1, mg); sM = shrink(sum(b for _, b in sm) / n1, n1, mg)
                mV = shrink(sum(a for a, _ in sv) / n2, n2, mg); sV = shrink(sum(b for _, b in sv) / n2, n2, mg)
                eM, eV = elo[km], elo[kv]
                fq = {"off": (1.0, 1.0),
                      "app": (fator_elo(eV - eM, lim), fator_elo(eM - eV, lim)),   # sinal antigo (invertido)
                      "fix": (fator_elo(eM - eV, lim), fator_elo(eV - eM, lim))}   # sinal atual do app
                fq = {n: fq[n] for n in variantes}
                reg = {"temporada": r["temporada"], "liga": liga, "res": 0 if gm > gv else 1 if gm == gv else 2,
                       "over": 1 if gm + gv >= 3 else 0, "mkt_x12": x12, "mkt_ou": ou, "mod": {}}
                for nome, (fm, fv) in fq.items():
                    lm = (mM * .55 + sV * .45) * fm
                    lv = (mV * .55 + sM * .45) * fv
                    reg["mod"][nome] = probs_matriz(lm, lv, cod)
                saida.append(reg)
        # atualiza estado depois do jogo
        casa[km].append((gm, gv)); fora[kv].append((gv, gm)); geral[km].append((gm, gv)); geral[kv].append((gv, gm))
        eM, eV = elo[km], elo[kv]
        exp = 1 / (1 + 10 ** ((eV - eM) / 400)); res = 1.0 if gm > gv else 0.0 if gm < gv else 0.5
        elo[km] = round(eM + K_ELO * (res - exp), 1); elo[kv] = round(eV + K_ELO * ((1 - res) - (1 - exp)), 1)
    return saida

def ll3(p, y): return -math.log(max(p[y], EPS))
def brier3(p, y): return sum((p[k] - (1 if k == y else 0)) ** 2 for k in range(3))
def rps3(p, y):
    o = [1 if k == y else 0 for k in range(3)]
    return ((p[0] - o[0]) ** 2 + (p[0] + p[1] - o[0] - o[1]) ** 2) / 2
def ll2(p, y): return -math.log(max(p if y else 1 - p, EPS))
def br2(p, y): return (p - y) ** 2
def media(xs): return sum(xs) / len(xs) if xs else float("nan")

def melhor_mistura(pares, ll):
    """pares: [(p_mercado, p_modelo, y)] -> (w_melhor, ll_w0, ll_melhor). w=peso do modelo."""
    res = []
    for k in range(11):
        w = k / 10
        res.append((media([ll(tuple((1 - w) * a + w * b for a, b in zip(pm, pd)) if isinstance(pm, tuple) else (1 - w) * pm + w * pd, y)
                           for pm, pd, y in pares]), w))
    melhor = min(res)
    return melhor[1], res[0][0], melhor[0]

def relatorio(reg):
    print(f"\nJogos avaliados (com odds de fechamento): {len(reg)}")
    print("\n=== 1X2  (menor = melhor) ===")
    print(f"{'':14}{'log-loss':>10}{'Brier':>9}{'RPS':>9}")
    print(f"{'mercado':14}{media([ll3(r['mkt_x12'], r['res']) for r in reg]):10.4f}{media([brier3(r['mkt_x12'], r['res']) for r in reg]):9.4f}{media([rps3(r['mkt_x12'], r['res']) for r in reg]):9.4f}")
    for n in VARIANTES:
        print(f"{'modelo '+n:14}{media([ll3(r['mod'][n][0], r['res']) for r in reg]):10.4f}{media([brier3(r['mod'][n][0], r['res']) for r in reg]):9.4f}{media([rps3(r['mod'][n][0], r['res']) for r in reg]):9.4f}")
    ou = [r for r in reg if r["mkt_ou"] is not None]
    print(f"\n=== Over 2.5  ({len(ou)} jogos) ===")
    print(f"{'':14}{'log-loss':>10}{'Brier':>9}")
    print(f"{'mercado':14}{media([ll2(r['mkt_ou'], r['over']) for r in ou]):10.4f}{media([br2(r['mkt_ou'], r['over']) for r in ou]):9.4f}")
    for n in VARIANTES:
        print(f"{'modelo '+n:14}{media([ll2(r['mod'][n][1], r['over']) for r in ou]):10.4f}{media([br2(r['mod'][n][1], r['over']) for r in ou]):9.4f}")
    print("\n=== Mistura mercado + modelo (w = peso do modelo; w=0 é só o mercado) ===")
    for n in VARIANTES:
        w, l0, lb = melhor_mistura([(r["mkt_x12"], r["mod"][n][0], r["res"]) for r in reg], ll3)
        print(f"1X2   modelo {n:4}: melhor w={w:.1f}  log-loss {l0:.4f} -> {lb:.4f}  (ganho {l0-lb:+.4f})")
    for n in VARIANTES:
        w, l0, lb = melhor_mistura([(r["mkt_ou"], r["mod"][n][1], r["over"]) for r in ou], ll2)
        print(f"O2.5  modelo {n:4}: melhor w={w:.1f}  log-loss {l0:.4f} -> {lb:.4f}  (ganho {l0-lb:+.4f})")
    print("\n=== Calibração Over 2.5 do modelo 'fix' (previsto x real) ===")
    faixas = defaultdict(list)
    for r in ou: faixas[min(int(r["mod"]["fix"][1] * 10), 9)].append((r["mod"]["fix"][1], r["over"], r["mkt_ou"]))
    print(f"{'faixa':>9}{'n':>6}{'modelo':>9}{'mercado':>9}{'real':>8}")
    for f in sorted(faixas):
        v = faixas[f]
        print(f"{f*10:>3}-{f*10+10:<4}%{len(v):>6}{media([a for a,_,_ in v])*100:8.1f}%{media([c for _,_,c in v])*100:8.1f}%{media([b for _,b,_ in v])*100:7.1f}%")
    print("\n=== Por temporada (1X2 log-loss: mercado | off | app | fix) ===")
    for t in sorted({r["temporada"] for r in reg}):
        s = [r for r in reg if r["temporada"] == t]
        print(f"{t}  n={len(s):5}  {media([ll3(r['mkt_x12'], r['res']) for r in s]):.4f} | " +
              " | ".join(f"{media([ll3(r['mod'][n][0], r['res']) for r in s]):.4f}" for n in VARIANTES))

def grade(jogos):
    """Roda o modelo 'fix' (sinal atual do app) com várias faixas do fator ELO e compara o log-loss."""
    print(f"\n=== Grade de faixas do fator ELO (modelo 'fix'; menor log-loss = melhor) ===")
    print(f"{'faixa':>12}{'1X2 ll':>9}{'1X2 mist.':>11}{'O2.5 ll':>9}{'O2.5 mist.':>12}")
    linhas = []
    for lim in GRADE:
        reg = rodar(jogos, lim, ("fix",))
        ou = [r for r in reg if r["mkt_ou"] is not None]
        l12 = media([ll3(r["mod"]["fix"][0], r["res"]) for r in reg])
        m12 = melhor_mistura([(r["mkt_x12"], r["mod"]["fix"][0], r["res"]) for r in reg], ll3)[2]
        l25 = media([ll2(r["mod"]["fix"][1], r["over"]) for r in ou])
        m25 = melhor_mistura([(r["mkt_ou"], r["mod"]["fix"][1], r["over"]) for r in ou], ll2)[2]
        linhas.append((lim, l12, m12, l25, m25))
        marca = "  <- atual" if lim == LIM_GOLS else ""
        print(f"{lim[0]:5.2f}-{lim[1]:<5.2f}{l12:9.4f}{m12:11.4f}{l25:9.4f}{m25:12.4f}{marca}")
    melhor = min(linhas, key=lambda x: x[3])
    print(f"\nMenor log-loss O2.5 (gols): {melhor[0][0]:.2f}-{melhor[0][1]:.2f}  ({melhor[3]:.4f})")
    print("Só troque ELO_LIMITES_GOLS se o ganho for consistente (veja também por temporada no relatório normal).")

def main():
    url = os.environ.get("DATABASE_URL")
    if not url: sys.exit("Defina DATABASE_URL no ambiente.")
    import psycopg
    from psycopg.rows import dict_row
    with psycopg.connect(url, row_factory=dict_row) as con:
        jogos = con.execute("""SELECT liga, temporada, data_jogo, mandante, visitante, gols_mandante, gols_visitante,
            odds_pin_fech_h, odds_pin_fech_d, odds_pin_fech_a, odds_med_fech_h, odds_med_fech_d, odds_med_fech_a,
            over25_pin_fech, under25_pin_fech, over25_med_fech, under25_med_fech
            FROM jogos_historico WHERE gols_mandante IS NOT NULL ORDER BY data_jogo, id""").fetchall()
    print(f"{len(jogos)} jogos lidos")
    if "--grid" in sys.argv:
        grade(jogos)
    else:
        relatorio(rodar(jogos))

if __name__ == "__main__":
    main()