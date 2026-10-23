"""
recalcular_elo.py — recalcula o ELO a partir do jogos_historico (ordem cronológica) usando
a MESMA fórmula do eloService.js (K=32, início 1500, sem vantagem de mando, empate=0.5).

Não mexe em elo_ratings por padrão. Grava o resultado em elo_historico (tabela nova).

  python recalcular_elo.py              # calcula, mostra top/bottom por liga, grava em elo_historico
  python recalcular_elo.py --aplicar    # copia elo_ratings para elo_ratings_backup e aplica o novo ELO
                                        # em elo_ratings (só times mapeados; os demais ficam como estão)

Variável de ambiente: DATABASE_URL.  Precisa da tabela times_mapa (mapa_nomes.py --gravar).
"""
import argparse, os, sys
from datetime import datetime, timedelta, timezone

K, ELO_INICIAL = 32, 1500.0

def esperado(a, b):
    return 1 / (1 + 10 ** ((b - a) / 400))

def data_utc(d):
    """Data do jogo em UTC (AAAA-MM-DD), igual aos 10 primeiros caracteres do utcDate que o app envia.
    data_jogo é TIMESTAMPTZ: o psycopg devolve no fuso da sessão, então converte antes de cortar."""
    if isinstance(d, datetime):
        if d.tzinfo is not None:
            d = d.astimezone(timezone.utc)
        return d.date()
    return d

def calcular(jogos, mapa):
    """jogos: [(liga, data, mandante, visitante, gm, gv)] já em ordem cronológica.
    mapa: {(liga, nome): fd_id}. Times sem ID recebem chave ('x', liga, nome) só em memória."""
    r, n = {}, {}
    for liga, _data, m, v, gm, gv in jogos:
        if gm is None or gv is None:
            continue
        hm = mapa.get((liga, m), ("x", liga, m))
        hv = mapa.get((liga, v), ("x", liga, v))
        em, ev = r.get(hm, ELO_INICIAL), r.get(hv, ELO_INICIAL)
        exp = esperado(em, ev)
        res = 1.0 if gm > gv else 0.0 if gm < gv else 0.5
        r[hm] = round(em + K * (res - exp), 1)
        r[hv] = round(ev + K * ((1 - res) - (1 - exp)), 1)
        n[hm], n[hv] = n.get(hm, 0) + 1, n.get(hv, 0) + 1
    return r, n

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--aplicar", action="store_true"); a = ap.parse_args()
    url = os.environ.get("DATABASE_URL")
    if not url: sys.exit("Defina DATABASE_URL no ambiente.")
    import psycopg
    with psycopg.connect(url) as con:
        mapa = {(l, n): i for l, n, i in con.execute("SELECT liga, nome_historico, fd_team_id FROM times_mapa")}
        jogos = con.execute("""SELECT liga, data_jogo, mandante, visitante, gols_mandante, gols_visitante
                               FROM jogos_historico WHERE gols_mandante IS NOT NULL
                               ORDER BY data_jogo, id""").fetchall()
        print(f"{len(jogos)} jogos | {len(mapa)} times mapeados")
        ratings, njogos = calcular(jogos, mapa)
        inv = {i: n for (_l, n), i in mapa.items()}
        reais = {k: v for k, v in ratings.items() if isinstance(k, int)}
        print(f"{len(reais)} times com ID da football-data.org | {len(ratings)-len(reais)} sem ID (só em memória)")
        for liga in sorted({l for l, _ in mapa}):
            ids = [i for (l, _), i in mapa.items() if l == liga and i in reais]
            top = sorted(set(ids), key=lambda i: -reais[i])
            print(f"\n{liga}  (topo / fundo)")
            for i in top[:3] + top[-2:]:
                print(f"  {reais[i]:7.1f}  {inv[i]}  ({njogos[i]} jogos)")
        con.execute("""CREATE TABLE IF NOT EXISTS elo_historico (
            team_id INTEGER PRIMARY KEY, rating NUMERIC(8,1) NOT NULL, jogos INTEGER NOT NULL,
            calculado_em TIMESTAMPTZ NOT NULL DEFAULT NOW())""")
        for i, rt in reais.items():
            con.execute("""INSERT INTO elo_historico (team_id, rating, jogos) VALUES (%s,%s,%s)
                           ON CONFLICT (team_id) DO UPDATE SET rating=EXCLUDED.rating, jogos=EXCLUDED.jogos, calculado_em=NOW()""",
                        (i, rt, njogos[i]))
        print(f"\nGravado em elo_historico: {len(reais)} times.")
        if a.aplicar:
            con.execute("DROP TABLE IF EXISTS elo_ratings_backup")
            con.execute("CREATE TABLE elo_ratings_backup AS SELECT * FROM elo_ratings")
            for i, rt in reais.items():
                con.execute("""INSERT INTO elo_ratings (team_id, rating, updated_at) VALUES (%s,%s,NOW())
                               ON CONFLICT (team_id) DO UPDATE SET rating=EXCLUDED.rating, updated_at=NOW()""", (i, rt))
            # marca os jogos do histórico como "já contados" (datas -1/0/+1 por causa de fuso), para o
            # servidor não aplicar de novo os mesmos jogos quando o app os vir nos "últimos 5"
            con.execute("SELECT pg_advisory_xact_lock(7421)")   # mesmo lock do servidor (/api/elo/jogos): sem corrida
            con.execute("""CREATE TABLE IF NOT EXISTS elo_jogos_processados (
                chave TEXT PRIMARY KEY, criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW())""")
            sem, chaves = 0, set()
            for liga, data, m, v, gm, gv in jogos:
                hm, hv = mapa.get((liga, m)), mapa.get((liga, v))
                if hm is None or hv is None or data is None:
                    continue
                base = data_utc(data)
                for delta in (-1, 0, 1):
                    d = (base + timedelta(days=delta)).strftime("%Y-%m-%d")
                    chaves.add(f"{hm}|{hv}|{d}")
                sem += 1
            with con.cursor() as cur:   # em lote: bem mais rápido que um INSERT por vez
                cur.executemany("INSERT INTO elo_jogos_processados (chave) VALUES (%s) ON CONFLICT DO NOTHING",
                                [(c,) for c in sorted(chaves)])
            print(f"APLICADO em elo_ratings (backup em elo_ratings_backup). {sem} jogos marcados como já contados.")
        con.commit()

if __name__ == "__main__":
    main()