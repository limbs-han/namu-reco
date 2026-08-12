"""DAG validate() 게이트 검증 (명세 §3/§5 v10).

- validate는 O2·O4(a)(b)(c)·O6(a)(b)만 검사 [K1] — O1은 pytest, O3은 DAG 완주가 판정
- [M8] 태스크 체인 직렬 (pagerank·embed 병렬 금지)
- 호스트에 airflow 미설치(Windows 미지원)라 최소 스텁으로 DAG 모듈을 로드한다.
  게이트 함수는 airflow 없이 순수 Python으로 실행 가능해야 한다.
"""
import gzip
import importlib.util
import json
import sys
import types
from pathlib import Path

import pandas as pd
import pytest

ETL = Path(__file__).resolve().parents[1]
ROOT = ETL.parent
sys.path.insert(0, str(ETL))

_dag_kwargs = {}
_chain = []          # (lhs_task_id, rhs_task_id) — [M8] 직렬 체인 검증용


def _fake_airflow():
    class Op:
        def __init__(self, *a, task_id="?", **k):
            self.task_id = task_id

        def __rshift__(self, other):
            _chain.append((self.task_id, getattr(other, "task_id", repr(other))))
            return other

    dec = types.ModuleType("airflow.decorators")

    def dag(*a, **k):
        _dag_kwargs.clear()
        _dag_kwargs.update(k)
        return lambda f: f

    dec.dag = dag
    dec.task = lambda f: (lambda *a, **k: Op(task_id=f.__name__))
    bash = types.ModuleType("airflow.operators.bash")
    bash.BashOperator = Op
    sys.modules.setdefault("airflow", types.ModuleType("airflow"))
    sys.modules["airflow.decorators"] = dec
    sys.modules["airflow.operators.bash"] = bash
    if "pendulum" not in sys.modules:
        pendulum = types.ModuleType("pendulum")
        pendulum.datetime = lambda *a, **k: None
        sys.modules["pendulum"] = pendulum


@pytest.fixture(scope="module")
def dag_mod():
    _fake_airflow()
    _chain.clear()
    spec = importlib.util.spec_from_file_location(
        "namu_dump_pipeline", ROOT / "dags" / "namu_dump_pipeline.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_dag_manual_trigger_and_serial_chain(dag_mod):
    """§3: schedule=None·catchup=False·max_active_runs=1, [M8] 완전 직렬 체인."""
    assert _dag_kwargs["schedule"] is None
    assert _dag_kwargs["catchup"] is False
    assert _dag_kwargs["max_active_runs"] == 1
    assert _chain == [
        ("split_dump", "parse_silver"),
        ("parse_silver", "pagerank"),
        ("pagerank", "embed"),                     # [M8] 병렬 금지 — 직렬
        ("embed", "build_neighbors"),
        ("build_neighbors", "build_shards"),       # [G1] build → validate → publish
        ("build_shards", "validate"),
        ("validate", "publish"),
    ]


# ---------- O2 [K1]: link_stats.json 판정 ----------

def test_o2_pass_fail_by_recorded_stats(dag_mod, tmp_path):
    p = tmp_path / "link_stats.json"
    p.write_text(json.dumps({"edges_pre_join": 100, "edges_post_join": 95}), encoding="utf-8")
    assert dag_mod.check_o2(p) == pytest.approx(0.95)

    p.write_text(json.dumps({"edges_pre_join": 100, "edges_post_join": 50}), encoding="utf-8")
    with pytest.raises(ValueError, match="O2"):
        dag_mod.check_o2(p)


def test_o2_raises_when_stats_missing(dag_mod, tmp_path):
    with pytest.raises(FileNotFoundError):          # [K1] 측정 없는 통과 금지
        dag_mod.check_o2(tmp_path / "absent.json")


# ---------- O4·O6: 합성 gold 빌드 후 판정 ----------

def _load_job05():
    spec = importlib.util.spec_from_file_location("job05", ETL / "jobs" / "05_build_shards.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def gold(tmp_path):
    """120 문서 합성 gold — popular 100건 성립, 점수는 FLOOR 이상."""
    job05 = _load_job05()
    titles = [f"문서{i:03d}" for i in range(120)]
    nbr = pd.DataFrame(
        [(titles[i], titles[(i + 1) % 120], 0.5 + (i % 40) * 0.01, 0.5, "emb")
         for i in range(120)],
        columns=["title", "nbr_title", "nbr_score", "pr_pct", "src_kind"])
    nbr.to_parquet(tmp_path / "neighbors.parquet")
    pd.DataFrame({"title": titles, "clean_text": ["x"] * 120,
                  "categories": [["분류A"] if i % 10 else [] for i in range(120)]}) \
        .to_parquet(tmp_path / "docs.parquet")     # 비어있지 않은 비율 90% ≥ 80%
    pd.DataFrame({"title": titles, "pagerank": [1.0 - i * 0.001 for i in range(120)]}) \
        .to_parquet(tmp_path / "pagerank.parquet")
    job05.run(tmp_path / "neighbors.parquet", tmp_path / "docs.parquet",
              tmp_path / "pagerank.parquet", tmp_path / "gold")
    return tmp_path


def test_o4_passes_and_measures(dag_mod, gold):
    m = dag_mod.check_o4(gold / "gold", gold / "docs.parquet")
    assert m["total_gz"] <= 500 * 2**20 and m["max_gz"] <= 1 * 2**20
    assert m["min_score"] >= 0.45 and m["max_score"] <= 1.0


def test_o4a_size_cap_injected_failure(dag_mod, gold):
    with pytest.raises(ValueError, match="O4"):
        dag_mod.check_o4(gold / "gold", gold / "docs.parquet", max_cap=10)


def test_o4b_popular_must_be_100_existing(dag_mod, gold):
    pop = gold / "gold" / "popular.json"
    titles = json.loads(pop.read_text(encoding="utf-8"))
    pop.write_text(json.dumps(titles[:99], ensure_ascii=False), encoding="utf-8")
    with pytest.raises(ValueError, match="O4"):
        dag_mod.check_o4(gold / "gold", gold / "docs.parquet")


def test_o4c_floor_violation_raises_with_quantiles(dag_mod, gold, capsys):
    # 샤드 하나에 FLOOR 미만 점수 주입 [F2]
    job05 = _load_job05()
    sid = job05.fnv1a32("문서000") % 1024
    f = gold / "gold" / "nbr" / f"{sid:04d}.json.gz"
    payload = json.loads(gzip.decompress(f.read_bytes()))
    payload["문서000"][0][1] = 0.2
    f.write_bytes(gzip.compress(json.dumps(
        payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), 9))

    with pytest.raises(ValueError, match="O4"):
        dag_mod.check_o4(gold / "gold", gold / "docs.parquet")
    out = capsys.readouterr().out
    assert "p0.1" in out and "p1" in out and "p5" in out   # [G8] 재결정 입력 로그


def test_o6a_namespace_title_in_gold_raises(dag_mod, gold):
    # popular에 네임스페이스 제목 주입 [N1]
    pop = gold / "gold" / "popular.json"
    titles = json.loads(pop.read_text(encoding="utf-8"))
    titles[0] = "틀:오염"
    pop.write_text(json.dumps(titles, ensure_ascii=False), encoding="utf-8")
    with pytest.raises(ValueError, match="O6"):
        dag_mod.check_o6(gold / "gold", gold / "docs.parquet")


def test_o6b_empty_categories_ratio_gate(dag_mod, gold):
    assert dag_mod.check_o6(gold / "gold", gold / "docs.parquet") >= 0.8

    titles = [f"문서{i:03d}" for i in range(120)]
    pd.DataFrame({"title": titles, "clean_text": ["x"] * 120,
                  "categories": [["분류A"] if i < 60 else [] for i in range(120)]}) \
        .to_parquet(gold / "docs.parquet")         # 50% < 80%
    with pytest.raises(ValueError, match="O6"):
        dag_mod.check_o6(gold / "gold", gold / "docs.parquet")


def test_sample50_written_for_manual_review(dag_mod, gold):
    review = gold / "review"
    measurements = dag_mod.check_o4(gold / "gold", gold / "docs.parquet")
    out = dag_mod.write_sample50(gold / "gold", gold / "neighbors.parquet", review,
                                 measurements=measurements)
    data = json.loads(Path(out).read_text(encoding="utf-8"))
    assert 0 < len(data["samples"]) <= 50          # [G12] 표본 50문서 top-5
    assert all(len(s["top"]) <= 5 for s in data["samples"])
    assert data["candidate_sources"] == {"emb": 120}   # job 04 후보 출처 통계
    # [G9] 크기 실측은 로그뿐 아니라 검수 자료에도 기록 — O4(d) 승인 근거
    m = data["measurements"]
    assert m["total_gz"] > 0 and m["max_gz"] > 0 and m["total_raw"] > 0
    assert 0.45 <= m["min_score"] <= m["max_score"] <= 1.0
