"""
coletor.py — baixa jogos + odds (soccerdata / Football-Data.co.uk) e grava em jogos_historico.

Uso (dentro da pasta coletor, com o venv ativo):
  python coletor.py --dry                        # só mostra o que seria gravado (não precisa de banco)
  python coletor.py                              # Premier League etc. 2024-25 -> grava no banco
  python coletor.py --temporadas 2022-23 2023-24 2024-25
  python coletor.py --ligas "ENG-Premier League" "ESP-La Liga"

A URL do banco vem da variável de ambiente DATABASE_URL (nunca escreva no arquivo):
  PowerShell:  $env:DATABASE_URL = "postgresql://..."   (a URL PÚBLICA do Postgres no Railway)
"""
import argparse
import os
import sys
import warnings
from datetime import datetime

import pandas as pd

warnings.filterwarnings("ignore", category=pd.errors.PerformanceWarning)

# (coluna_no_banco, coluna_na_fonte, tipo_sql) — fonte única: o DDL do Node deve espelhar esta lista
SPEC = [
    ("gols_mandante",      "FTHG",   "SMALLINT"),
    ("gols_visitante",     "FTAG",   "SMALLINT"),
    ("resultado",          "FTR",    "CHAR(1)"),
    ("gols_ht_mandante",   "HTHG",   "SMALLINT"),
    ("gols_ht_visitante",  "HTAG",   "SMALLINT"),
    ("chutes_mandante",    "HS",     "SMALLINT"),
    ("chutes_visitante",   "AS",     "SMALLINT"),
    ("chutes_alvo_mandante",  "HST", "SMALLINT"),
    ("chutes_alvo_visitante", "AST", "SMALLINT"),
    ("escanteios_mandante",   "HC",  "SMALLINT"),
    ("escanteios_visitante",  "AC",  "SMALLINT"),
    ("amarelos_mandante",  "HY",     "SMALLINT"),
    ("amarelos_visitante", "AY",     "SMALLINT"),
    ("vermelhos_mandante", "HR",     "SMALLINT"),
    ("vermelhos_visitante", "AR",    "SMALLINT"),
    ("odds_pin_h",         "PSH",    "NUMERIC(8,3)"),
    ("odds_pin_d",         "PSD",    "NUMERIC(8,3)"),
    ("odds_pin_a",         "PSA",    "NUMERIC(8,3)"),
    ("odds_pin_fech_h",    "PSCH",   "NUMERIC(8,3)"),
    ("odds_pin_fech_d",    "PSCD",   "NUMERIC(8,3)"),
    ("odds_pin_fech_a",    "PSCA",   "NUMERIC(8,3)"),
    ("odds_med_h",         "AvgH",   "NUMERIC(8,3)"),
    ("odds_med_d",         "AvgD",   "NUMERIC(8,3)"),
    ("odds_med_a",         "AvgA",   "NUMERIC(8,3)"),
    ("odds_med_fech_h",    "AvgCH",  "NUMERIC(8,3)"),
    ("odds_med_fech_d",    "AvgCD",  "NUMERIC(8,3)"),
    ("odds_med_fech_a",    "AvgCA",  "NUMERIC(8,3)"),
    ("over25_pin",         "P>2.5",  "NUMERIC(8,3)"),
    ("under25_pin",        "P<2.5",  "NUMERIC(8,3)"),
    ("over25_med",         "Avg>2.5", "NUMERIC(8,3)"),
    ("under25_med",        "Avg<2.5", "NUMERIC(8,3)"),
    ("over25_pin_fech",    "PC>2.5", "NUMERIC(8,3)"),
    ("under25_pin_fech",   "PC<2.5", "NUMERIC(8,3)"),
    ("over25_med_fech",    "AvgC>2.5", "NUMERIC(8,3)"),
    ("under25_med_fech",   "AvgC<2.5", "NUMERIC(8,3)"),
]
FIXAS = ["liga", "temporada", "jogo_chave", "data_jogo", "mandante", "visitante"]
COLUNAS = FIXAS + [c for c, _, _ in SPEC] + ["dados_brutos"]


def py(v):
    """Converte valores do pandas/numpy para tipos Python puros (NaN -> None)."""
    if v is None or (not isinstance(v, str) and pd.isna(v)):
        return None
    if isinstance(v, (pd.Timestamp, datetime)):
        return v.to_pydatetime() if isinstance(v, pd.Timestamp) else v
    if hasattr(v, "item"):
        return v.item()
    return v


def linhas(df):
    """DataFrame do soccerdata -> lista de tuplas na ordem de COLUNAS."""
    from psycopg.types.json import Jsonb  # import tardio: o --dry não precisa do psycopg
    d = df.reset_index()
    saida = []
    for _, r in d.iterrows():
        fixas = [
            py(r["league"]), str(r["season"]), py(r["game"]), py(r.get("date")),
            py(r.get("home_team")), py(r.get("away_team")),
        ]
        spec = []
        for _, src, _t in SPEC:
            v = py(r[src]) if src in d.columns else None
            spec.append(v)
        bruto = {}
        for k, v in r.items():
            v = py(v)
            if v is not None:
                bruto[str(k)] = v.isoformat() if isinstance(v, datetime) else v
        saida.append(tuple(fixas + spec + [Jsonb(bruto)]))
    return saida


def sql_upsert():
    cols = ", ".join(COLUNAS)
    marcadores = ", ".join(["%s"] * len(COLUNAS))
    atualiza = ", ".join(f"{c} = EXCLUDED.{c}" for c in COLUNAS if c not in ("liga", "temporada", "jogo_chave")) + ", atualizado_em = NOW()"
    return (f"INSERT INTO jogos_historico ({cols}) VALUES ({marcadores}) "
            f"ON CONFLICT (liga, temporada, jogo_chave) DO UPDATE SET {atualiza}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ligas", nargs="+", default=["ENG-Premier League"])
    ap.add_argument("--temporadas", nargs="+", default=["2024-25"])
    ap.add_argument("--dry", action="store_true", help="não grava no banco, só mostra um resumo")
    a = ap.parse_args()

    import soccerdata as sd
    import soccerdata.match_history as _mh

    # Alguns CSVs antigos do Football-Data começam com BOM; lidos como latin-1, a coluna "Div"
    # vira "ï»¿Div" e a liga some (NULL). Este conserto limpa o nome das colunas.
    _parse_original = _mh._parse_csv

    def _parse_csv_sem_bom(raw_data, lkey, skey):
        d = _parse_original(raw_data, lkey, skey)
        d.columns = [str(c).replace("\ufeff", "").replace("\u00ef\u00bb\u00bf", "") for c in d.columns]
        return d

    _mh._parse_csv = _parse_csv_sem_bom

    df = sd.MatchHistory(leagues=a.ligas, seasons=a.temporadas).read_games()
    rows = linhas(df)
    print(f"{len(rows)} jogos lidos | ligas={a.ligas} | temporadas={a.temporadas}")

    sem_liga = [r for r in rows if r[0] is None]
    if sem_liga:
        sys.exit(f"ERRO: {len(sem_liga)} jogos sem liga (ex.: {sem_liga[0][1]} {sem_liga[0][2]}). Nada foi gravado.")

    if a.dry:
        for linha in rows[:3]:
            print({c: v for c, v in zip(COLUNAS[:-1], linha[:-1])})
        print("(dry) nada foi gravado.")
        return

    url = os.environ.get("DATABASE_URL")
    if not url:
        sys.exit("Defina DATABASE_URL antes (veja o topo do arquivo).")
    import psycopg
    with psycopg.connect(url) as con:
        with con.cursor() as cur:
            cur.executemany(sql_upsert(), rows)
        con.commit()
    print(f"OK: {len(rows)} jogos gravados/atualizados em jogos_historico.")


if __name__ == "__main__":
    main()