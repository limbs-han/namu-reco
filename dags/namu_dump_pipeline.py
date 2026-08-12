"""Airflow DAG — 덤프 파이프라인 (명세 §3).

- [M8] pagerank·embed 직렬 — 32GB 단일 머신에서 동시 상주는 OOM 현실권
- [G1] build(job 05) → validate → publish(job 06) — 게이트가 실물 검사 후 push 차단
- validate는 O2·O4(a)(b)(c)·O6(a)(b)를 검사하고 O4(d) 검수 자료를 산출만 한다 [K1·G12]
  — O1은 pytest(etl/tests) 게이트, O3은 DAG 완주 자체가 판정이라 재검사하지 않는다
- [J10·K2] Airflow 컨테이너에는 jobs 실행 의존(python·ijson·spark-submit 등) 포함.
  job 03·04(GPU 사용 시)는 컨테이너 실행 비강제 — passthrough 미구성 환경에서는
  호스트 수동 실행 후 embed·build_neighbors 태스크를 산출물 실존 확인으로 대체하는
  운용을 허용한다(순서 강제·기록 용도, [M8] 직렬 제약은 유지)
"""
import gzip
import json
import random
import sys
from pathlib import Path

from airflow.decorators import dag, task
from airflow.operators.bash import BashOperator
import pendulum

ROOT = Path(__file__).resolve().parents[1]
ETL = ROOT / "etl"
sys.path.insert(0, str(ETL))

from conf import settings  # noqa: E402


def check_o2(stats_path=None, minimum=0.90):
    """O2 [K1]: job 01이 산출한 link_stats.json을 읽어 해석률 ≥ 90% 판정.

    파일 부재 시 raise — 측정 없는 통과 금지.
    """
    p = Path(stats_path if stats_path is not None else settings.SILVER_LINK_STATS)
    if not p.exists():
        raise FileNotFoundError(f"[K1] link_stats.json 부재 — 측정 없는 통과 금지: {p}")
    s = json.loads(p.read_text(encoding="utf-8"))
    rate = s["edges_post_join"] / s["edges_pre_join"] if s["edges_pre_join"] else 0.0
    print(f"O2: {s['edges_post_join']}/{s['edges_pre_join']} = {rate:.4f} (gate >= {minimum})")
    if rate < minimum:
        raise ValueError(f"O2 gate failed: link resolution {rate:.4f} < {minimum}")
    return rate


def _iter_shards(gold_dir):
    for f in sorted((Path(gold_dir) / "nbr").glob("*.json.gz")):
        raw = gzip.decompress(f.read_bytes())
        yield f, len(raw), json.loads(raw)


def check_o4(gold_dir, docs_path, floor=None,
             total_cap=500 * 2**20, max_cap=1 * 2**20):
    """O4(a)(b)(c) — 검사 대상은 job 05가 로컬 산출한 gold (.json.gz 압축 후 기준 [F3])."""
    floor = settings.NBR_SCORE_FLOOR if floor is None else floor
    gold_dir = Path(gold_dir)

    scores, pcts = [], []
    total_gz = max_gz = total_raw = 0
    for f, raw_len, payload in _iter_shards(gold_dir):
        size = f.stat().st_size
        total_gz += size
        max_gz = max(max_gz, size)
        total_raw += raw_len
        for entries in payload.values():
            for _, score, pct in entries:
                scores.append(score)
                pcts.append(pct)
    # [G9] 실측이 유일한 근거 — 매 실행 압축 전/후 총량·최대 샤드 기록
    print(f"O4(a): total {total_gz / 2**20:.1f} MB gz (cap 500), "
          f"max shard {max_gz / 2**20:.3f} MB (cap 1), raw {total_raw / 2**20:.1f} MB")
    if total_gz > total_cap or max_gz > max_cap:
        raise ValueError(f"O4(a) gate failed: total {total_gz} B / max {max_gz} B")

    popular = json.loads((gold_dir / "popular.json").read_text(encoding="utf-8"))
    docs_titles = set(__import__("pandas").read_parquet(docs_path, columns=["title"])["title"])
    if len(popular) != 100 or not set(popular) <= docs_titles:
        raise ValueError(f"O4(b) gate failed: popular {len(popular)}건 "
                         f"(실존 아님 {len(set(popular) - docs_titles)}건)")

    import numpy as np
    arr = np.array(scores, dtype=np.float64)
    parr = np.array(pcts, dtype=np.float64)
    if not (np.isfinite(arr).all() and np.isfinite(parr).all()):
        raise ValueError("O4(c) gate failed: NaN/Inf 발견 [F1]")
    mn, mx = float(arr.min()), float(arr.max())
    if mn < floor or mx > 1.0:
        q = np.quantile(arr, [0.001, 0.01, 0.05])
        print(f"O4(c) 실측 min={mn:.4f}, p0.1={q[0]:.4f}, p1={q[1]:.4f}, p5={q[2]:.4f}"
              f" — [G8] 재결정 절차 입력")
        raise ValueError(f"O4(c) gate failed: min {mn:.4f} < floor {floor} 또는 max {mx:.4f} > 1")
    return {"total_gz": total_gz, "max_gz": max_gz, "total_raw": total_raw,
            "min_score": mn, "max_score": mx}


def check_o6(gold_dir, docs_path):
    """O6 [N1·N2]: (a) 네임스페이스 접두 제목 0건, (b) categories 비어있지 않은 비율 ≥ 80%."""
    import pandas as pd

    def is_ns(t):
        i = t.find(":")
        return i > 0 and t[:i] in settings.NAMESPACES

    gold_dir = Path(gold_dir)
    docs = pd.read_parquet(docs_path, columns=["title", "categories"])
    offenders = [t for t in docs["title"] if is_ns(t)]
    popular = json.loads((gold_dir / "popular.json").read_text(encoding="utf-8"))
    offenders += [t for t in popular if is_ns(t)]
    for _, _, payload in _iter_shards(gold_dir):
        offenders += [t for t in payload if is_ns(t)]
    if offenders:
        raise ValueError(f"O6(a) gate failed: 네임스페이스 제목 {len(offenders)}건 예: {offenders[:5]}")

    nonempty = sum(1 for c in docs["categories"] if c is not None and len(c) > 0)
    ratio = nonempty / len(docs) if len(docs) else 0.0
    print(f"O6(b): categories 비어있지 않은 비율 {ratio:.4f} (gate >= 0.8)")
    if ratio < 0.8:
        raise ValueError(f"O6(b) gate failed: {ratio:.4f} < 0.8")
    return ratio


def write_sample50(gold_dir, neighbors_path, review_dir, measurements=None, n=50, seed=42):
    """O4(d) [G12]: 표본 50문서 top-5 + 후보 출처 통계 산출만 — 판정은 사람이 한다.

    [G9] check_o4의 크기·점수 실측(measurements)을 검수 자료에 함께 기록한다 —
    실측은 로그와 검수 자료 두 곳 모두에 남아야 한다.
    """
    import pandas as pd
    keys = []
    shard_data = {}
    for _, _, payload in _iter_shards(gold_dir):
        keys.extend(payload.keys())
        shard_data.update(payload)
    sample = sorted(random.Random(seed).sample(keys, min(n, len(keys))))
    samples = [{"title": t, "top": shard_data[t][:5]} for t in sample]
    stats = pd.read_parquet(neighbors_path, columns=["src_kind"])["src_kind"] \
        .value_counts().to_dict()                  # job 04 후보 출처 통계(임베딩/분류/양쪽)
    review_dir = Path(review_dir)
    review_dir.mkdir(parents=True, exist_ok=True)
    out = review_dir / "sample50.json"
    out.write_text(json.dumps(
        {"samples": samples, "candidate_sources": stats, "measurements": measurements},
        ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"O4(d) 검수 자료 산출: {out} — APPROVED 마커는 개발자가 수동 생성 [H5]")
    return out


@dag(schedule=None,  # 공식 덤프 배포 중단 상태 — 새 덤프 입수 시에만 수동 트리거
     start_date=pendulum.datetime(2026, 8, 1, tz="Asia/Seoul"),
     catchup=False, max_active_runs=1, tags=["namu"])
def namu_dump_pipeline():
    split     = BashOperator(task_id="split_dump",      bash_command="python etl/jobs/00_split_dump.py")
    parse     = BashOperator(task_id="parse_silver",    bash_command="spark-submit etl/jobs/01_bronze_to_silver.py")
    pagerank  = BashOperator(task_id="pagerank",        bash_command="python etl/jobs/02_pagerank.py")
    embed     = BashOperator(task_id="embed",           bash_command="python etl/jobs/03_embed.py")
    neighbors = BashOperator(task_id="build_neighbors", bash_command="python etl/jobs/04_build_neighbors.py")
    build     = BashOperator(task_id="build_shards",    bash_command="python etl/jobs/05_build_shards.py")   # [G1]

    @task
    def validate():
        # §5 O2·O4·O6 검사 [K1] — 하나라도 실패하면 raise → publish 차단
        check_o2(settings.SILVER_LINK_STATS)
        measurements = check_o4(settings.GOLD_DIR, settings.SILVER_DOCS)
        check_o6(settings.GOLD_DIR, settings.SILVER_DOCS)
        write_sample50(settings.GOLD_DIR, settings.GOLD_NEIGHBORS, settings.REVIEW_DIR,
                       measurements=measurements)   # [G9] 실측을 검수 자료에도 기록

    publish = BashOperator(task_id="publish", bash_command="python etl/jobs/06_publish.py")  # [G1·G12]
    split >> parse >> pagerank >> embed >> neighbors >> build >> validate() >> publish       # [M8] 직렬


namu_dump_pipeline()
