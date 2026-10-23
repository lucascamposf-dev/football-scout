"""
mapa_nomes.py — liga os nomes de times do jogos_historico aos team_id da football-data.org
(os mesmos IDs que o elo_ratings usa) e grava na tabela nova times_mapa.

Variáveis de ambiente (nunca escreva no arquivo):
  DATABASE_URL   URL pública do Postgres (já com a senha NOVA)
  FD_KEY         token da football-data.org (o mesmo FD_KEY do Railway)

Uso:
  python mapa_nomes.py            # busca times, casa nomes, grava CSV de revisão (NÃO grava no banco)
  python mapa_nomes.py --gravar   # depois de revisar o CSV, grava em times_mapa
"""
import argparse, csv, difflib, os, re, sys, time, unicodedata
import requests

COMPETICOES = {"ENG-Premier League": "PL", "ESP-La Liga": "PD", "FRA-Ligue 1": "FL1",
               "GER-Bundesliga": "BL1", "ITA-Serie A": "SA"}
ANOS = [2021, 2022, 2023, 2024, 2025]          # ano de início da temporada

# apelidos do Football-Data.co.uk que o fuzzy não acerta (normalizado -> trecho do nome na football-data.org)
APELIDOS = {
    "man united": "manchester united", "man city": "manchester city", "nottm forest": "nottingham forest",
    "nott'm forest": "nottingham forest", "spurs": "tottenham", "wolves": "wolverhampton", "sheffield weds": "sheffield wednesday",
    "ath madrid": "atletico madrid", "ath bilbao": "athletic", "betis": "real betis", "sociedad": "real sociedad",
    "vallecano": "rayo vallecano", "espanol": "espanyol", "celta": "celta de vigo", "alaves": "alaves",
    "paris sg": "paris saint-germain", "st etienne": "saint-etienne", "dortmund": "borussia dortmund",
    "m'gladbach": "borussia monchengladbach", "mgladbach": "borussia monchengladbach", "leverkusen": "bayer 04 leverkusen",
    "ein frankfurt": "eintracht frankfurt", "fc koln": "1 fc koln", "koln": "1 fc koln", "mainz": "1 fsv mainz 05",
    "hoffenheim": "tsg 1899 hoffenheim", "union berlin": "1 fc union berlin", "heidenheim": "1 fc heidenheim",
    "stuttgart": "vfb stuttgart", "wolfsburg": "vfl wolfsburg", "bochum": "vfl bochum", "freiburg": "sc freiburg",
    "augsburg": "fc augsburg", "werder bremen": "sv werder bremen", "bayern munich": "fc bayern", "inter": "internazionale",
    "milan": "ac milan", "verona": "hellas verona", "roma": "as roma", "lyon": "olympique lyonnais",
    "marseille": "olympique de marseille", "monaco": "as monaco", "nice": "ogc nice", "lille": "losc lille",
    "rennes": "stade rennais", "lens": "rc lens", "strasbourg": "rc strasbourg", "nantes": "fc nantes", "brest": "stade brestois",
    "reims": "stade de reims", "clermont": "clermont foot", "ajaccio": "ac ajaccio", "angers": "angers sco",
}

def norm(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"[^a-z0-9' ]+", " ", s)
    s = re.sub(r"\b(fc|cf|afc|sc|ssc|ud|cd|rcd|ac|as|us|the|calcio|1899|04|05|1)\b", " ", s) if False else s
    return re.sub(r"\s+", " ", s).strip()

def limpo(s):  # versão sem prefixos/sufixos genéricos, só para comparar
    s = norm(s)
    s = re.sub(r"\b(fc|cf|afc|sc|ssc|ud|cd|rcd|ac|as|us|calcio|sv|vfb|vfl|tsg|fsv|1|04|05|1899|de|the)\b", " ", s)
    return re.sub(r"\s+", " ", s).strip()

def casar(nome, candidatos):
    """candidatos: {fd_id: [nomes]} -> (fd_id, nome_fd, metodo, score)"""
    n = norm(nome)
    alvo = norm(APELIDOS.get(n, nome))
    metodo = "apelido" if n in APELIDOS else "auto"
    melhor = (None, None, 0.0)
    for fid, nomes in candidatos.items():
        for cn in nomes:
            a, b = limpo(alvo), limpo(cn)
            if a == b or norm(alvo) == norm(cn):
                sc = 1.0
            elif a and (a in b or b in a):
                sc = 0.92
            else:
                sc = difflib.SequenceMatcher(None, a, b).ratio()
            if sc > melhor[2]:
                melhor = (fid, cn, sc)
    return melhor[0], melhor[1], metodo, melhor[2]

def buscar_times(chave):
    cand = {c: {} for c in COMPETICOES.values()}
    for comp in COMPETICOES.values():
        for ano in ANOS:
            r = requests.get(f"https://api.football-data.org/v4/competitions/{comp}/teams",
                             params={"season": ano}, headers={"X-Auth-Token": chave}, timeout=30)
            if r.status_code != 200:
                print(f"  aviso: {comp} {ano} -> HTTP {r.status_code}"); time.sleep(7); continue
            for t in r.json().get("teams", []):
                cand[comp].setdefault(t["id"], set()).update(x for x in (t.get("name"), t.get("shortName"), t.get("tla")) if x)
            print(f"  {comp} {ano} ok"); time.sleep(7)       # plano grátis: 10 req/min
    return {c: {i: sorted(n) for i, n in d.items()} for c, d in cand.items()}

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--gravar", action="store_true"); a = ap.parse_args()
    url, chave = os.environ.get("DATABASE_URL"), os.environ.get("FD_KEY")
    if not url: sys.exit("Defina DATABASE_URL no ambiente.")
    import psycopg
    if not a.gravar:
        if not chave: sys.exit("Defina FD_KEY no ambiente.")
        with psycopg.connect(url) as con:
            nomes = con.execute("""SELECT liga, mandante AS n FROM jogos_historico UNION SELECT liga, visitante FROM jogos_historico
                                   ORDER BY 1, 2""").fetchall()
        print(f"{len(nomes)} nomes distintos. Buscando times na football-data.org...")
        cand = buscar_times(chave)
        saida = []
        for liga, nome in nomes:
            fid, nfd, met, sc = casar(nome, cand[COMPETICOES[liga]])
            status = "ok" if sc >= 0.85 else "REVISAR"
            if status == "REVISAR": fid, nfd = "", f"(sugestao fraca: {nfd})"   # não grava palpite ruim
            saida.append((liga, nome, fid, nfd, met, round(sc, 2), status))
        with open("mapa_nomes_revisao.csv", "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f); w.writerow(["liga", "nome_historico", "fd_team_id", "nome_fd", "metodo", "score", "status"]); w.writerows(saida)
        rev = [s for s in saida if s[-1] != "ok"]
        print(f"Casados: {len(saida)-len(rev)} | Para revisar: {len(rev)}  -> veja mapa_nomes_revisao.csv")
        for s in rev: print("  ", s[:2], s[3])
        print("(nada gravado; confira o CSV e rode com --gravar)"); return
    # --gravar: NÃO busca na API de novo; lê o CSV como está. Linhas REVISAR são ignoradas
    # (para forçar uma, preencha fd_team_id e troque o status para ok).
    with open("mapa_nomes_revisao.csv", encoding="utf-8") as f: linhas = list(csv.DictReader(f))
    with psycopg.connect(url) as con:
        con.execute("""CREATE TABLE IF NOT EXISTS times_mapa (
            liga TEXT NOT NULL, nome_historico TEXT NOT NULL, fd_team_id INTEGER NOT NULL, nome_fd TEXT,
            PRIMARY KEY (liga, nome_historico))""")
        n = 0
        for l in linhas:
            if l["fd_team_id"] and l["status"] == "ok":
                con.execute("""INSERT INTO times_mapa VALUES (%s,%s,%s,%s) ON CONFLICT (liga, nome_historico)
                               DO UPDATE SET fd_team_id=EXCLUDED.fd_team_id, nome_fd=EXCLUDED.nome_fd""",
                            (l["liga"], l["nome_historico"], int(l["fd_team_id"]), l["nome_fd"])); n += 1
        con.commit()
    print(f"OK: {n} times gravados em times_mapa ({len(linhas)-n} ignorados).")

if __name__ == "__main__":
    main()