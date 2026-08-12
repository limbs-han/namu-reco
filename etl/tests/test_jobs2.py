"""jobs 02–04 검증 (Spark 불필요 — 호스트 실행). 숫자 시작 파일명이라 importlib 로드.

v10 검증 항목:
- job 02 [M8] factorize 정수 엣지 (산출 동일성은 hub 그래프로 검증)
- job 03 [M7] float32 저장 + L2 정규화 + "query: " 접두 + 앞 1,000자
- job 04 [N2] 혼합 점수(0.8·cos + 0.2·Jaccard), 분류 후보 확장, [F1] Jaccard 0/0=0 +
  유한성 assert, [G3] percentile(≤ 정의)·고립 문서 0.0, [K2] 청크 체크포인트·GPU/CPU 동일
"""
import importlib.util
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

ETL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ETL))


def _load(name, relpath):
    spec = importlib.util.spec_from_file_location(name, ETL / relpath)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ---------- job 02 ----------

def test_pagerank_hub_ranks_higher(tmp_path):
    job02 = _load("job02", "jobs/02_pagerank.py")
    edges = pd.DataFrame({"src": ["a", "b", "c", "d"], "dst": ["hub", "hub", "hub", "a"]})
    edges_path = tmp_path / "links.parquet"
    edges.to_parquet(edges_path)
    out = tmp_path / "pagerank.parquet"

    job02.run(edges_path, out)

    pr = pd.read_parquet(out).set_index("title")["pagerank"]
    assert set(pr.index) == {"a", "b", "c", "d", "hub"}
    assert pr["hub"] == pr.max()          # 모두가 가리키는 hub가 최고 랭크
    assert pr["hub"] > pr["b"]
    assert pr.sum() == pytest.approx(1.0, rel=1e-6)


# ---------- job 03 ----------

def test_embed_chunked_order_prefix_and_dtype(tmp_path):
    job03 = _load("job03", "jobs/03_embed.py")
    docs = pd.DataFrame({
        "title": ["문서A", "문서B", "문서C"],
        "clean_text": ["가" * 1500, "나짧음", "다" * 999],
        "categories": [[], [], []],
    })
    docs_path = tmp_path / "docs.parquet"
    docs.to_parquet(docs_path)
    seen = []

    def fake_encoder(texts):
        seen.extend(texts)
        # 결정적 비단위 벡터 — L2 정규화가 job 03 책임임을 검증
        return np.stack([np.full(4, float(len(t)), dtype=np.float32) for t in texts])

    out_npy, out_titles = tmp_path / "embeddings.npy", tmp_path / "titles.txt"
    job03.run(docs_path, out_npy, out_titles, encoder=fake_encoder, chunk_rows=2)

    emb = np.load(out_npy)
    assert emb.dtype == np.float32        # [M7] 저장은 float32 — FAISS 요구
    assert emb.shape == (3, 4)
    np.testing.assert_allclose(np.linalg.norm(emb, axis=1), 1.0, rtol=1e-6)
    assert out_titles.read_text(encoding="utf-8").splitlines() == ["문서A", "문서B", "문서C"]
    assert all(t.startswith("query: ") for t in seen)      # [M7] 프리픽스 필수
    assert max(len(t) for t in seen) <= len("query: ") + 1000   # 앞 1,000자만


# ---------- job 04 ----------

def _unit(rows):
    a = np.array(rows, dtype=np.float32)
    return a / np.linalg.norm(a, axis=1, keepdims=True)


def _setup(tmp_path, emb, titles, cats, pr):
    """공용 입력 산출: emb.npy(f32)·titles.txt·docs.parquet(categories)·pr.parquet"""
    np.save(tmp_path / "emb.npy", emb.astype(np.float32))
    (tmp_path / "titles.txt").write_text("\n".join(titles) + "\n", encoding="utf-8")
    pd.DataFrame({"title": titles, "categories": cats}).to_parquet(tmp_path / "docs.parquet")
    pd.DataFrame({"title": list(pr), "pagerank": list(pr.values())}) \
        .to_parquet(tmp_path / "pr.parquet")
    return dict(emb_path=tmp_path / "emb.npy", titles_path=tmp_path / "titles.txt",
                pagerank_path=tmp_path / "pr.parquet",
                docs_path=tmp_path / "docs.parquet", out_path=tmp_path / "neighbors.parquet")


def _rows(out_path):
    df = pd.read_parquet(out_path)
    assert set(df.columns) == {"title", "nbr_title", "nbr_score", "pr_pct", "src_kind"}
    return df


def test_mixed_score_emb_and_cat_sources(tmp_path):
    job04 = _load("job04", "jobs/04_build_neighbors.py")
    emb = _unit([[1.0, 0.0], [0.999, 0.045], [0.0, 1.0]])   # A≈B, C⊥A
    io = _setup(tmp_path, emb, ["A", "B", "C"],
                [["공유"], [], ["공유"]], {"A": 0.5, "B": 0.3, "C": 0.2})
    job04.run(**io, faiss_topk=1, k=20)

    df = _rows(io["out_path"])
    a = df[df.title == "A"].set_index("nbr_title")
    cos_ab = float(emb[0] @ emb[1])
    # B: 임베딩 후보(top-1), 분류 무공유 → Jaccard 0 [F1] → 0.8·cos
    assert a.loc["B", "nbr_score"] == pytest.approx(0.8 * cos_ab, abs=1e-6)
    assert a.loc["B", "src_kind"] == "emb"
    # C: cos 0이지만 분류 "공유" 경유 후보 → 0.8·0 + 0.2·1.0
    assert a.loc["C", "nbr_score"] == pytest.approx(0.2, abs=1e-6)
    assert a.loc["C", "src_kind"] == "cat"
    assert not (df.title == df.nbr_title).any()             # 자기 자신 제외


def test_both_source_and_partial_jaccard(tmp_path):
    job04 = _load("job04", "jobs/04_build_neighbors.py")
    emb = _unit([[1.0, 0.0], [0.999, 0.045]])
    io = _setup(tmp_path, emb, ["A", "B"],
                [["x", "y"], ["x"]], {"A": 0.5, "B": 0.3})
    job04.run(**io, faiss_topk=1, k=20)

    a = _rows(io["out_path"]).query("title == 'A'").set_index("nbr_title")
    cos_ab = float(emb[0] @ emb[1])
    jac = 1 / 2                                             # |{x}| / |{x,y}|
    assert a.loc["B", "nbr_score"] == pytest.approx(0.8 * cos_ab + 0.2 * jac, abs=1e-6)
    assert a.loc["B", "src_kind"] == "both"


def test_cat_max_size_ignored_in_index_and_jaccard(tmp_path):
    job04 = _load("job04", "jobs/04_build_neighbors.py")
    emb = _unit([[1.0, 0.0], [0.999, 0.045], [0.0, 1.0]])
    # 전원이 "거대" 분류 소속 — cat_max_size=2 < 3이라 역색인·Jaccard 양쪽 무시
    io = _setup(tmp_path, emb, ["A", "B", "C"],
                [["거대"], ["거대"], ["거대"]], {"A": 0.5, "B": 0.3, "C": 0.2})
    job04.run(**io, faiss_topk=1, k=20, cat_max_size=2)

    a = _rows(io["out_path"]).query("title == 'A'").set_index("nbr_title")
    assert list(a.index) == ["B"]                           # C는 분류 경유 후보로 못 들어옴
    cos_ab = float(emb[0] @ emb[1])
    assert a.loc["B", "nbr_score"] == pytest.approx(0.8 * cos_ab, abs=1e-6)   # Jaccard 항 0


def test_cat_cand_per_cat_truncated_by_pagerank(tmp_path):
    job04 = _load("job04", "jobs/04_build_neighbors.py")
    emb = _unit(np.eye(4))                                  # 전부 직교 — cos 0
    # faiss_topk=0 → 임베딩 후보 없음(자기 자신뿐), 분류 경유만
    io = _setup(tmp_path, emb, ["A", "B", "C", "D"],
                [["c"], ["c"], ["c"], ["c"]],
                {"A": 0.5, "B": 0.3, "C": 0.2})             # D는 pagerank 부재 → 최하위
    job04.run(**io, faiss_topk=0, k=20, cat_cand_per_cat=2)

    df = _rows(io["out_path"])
    # 분류 c의 절단 구성원 = pagerank 상위 2 = [A, B] → A의 후보 {B}, C의 후보 {A,B}
    assert set(df[df.title == "A"].nbr_title) == {"B"}
    assert set(df[df.title == "C"].nbr_title) == {"A", "B"}


def test_percentile_le_definition_ties_and_isolated_zero(tmp_path):
    job04 = _load("job04", "jobs/04_build_neighbors.py")
    emb = _unit([[1.0, 0.0], [0.99, 0.14], [0.98, 0.2], [0.0, 1.0]])
    # D는 pagerank.parquet에 없음(고립 문서) → percentile 0.0 [G3]
    io = _setup(tmp_path, emb, ["A", "B", "C", "D"],
                [["c"], ["c"], ["c"], ["c"]], {"A": 0.5, "B": 0.3, "C": 0.3})
    job04.run(**io, faiss_topk=3, k=20)

    df = _rows(io["out_path"])
    pct = dict(zip(df.nbr_title, df.pr_pct))
    assert pct["A"] == pytest.approx(1.0)       # ≤0.5 인 행 3/3
    assert pct["B"] == pytest.approx(2 / 3)     # ≤0.3 인 행 2/3 (동률 포함 ≤ 정의)
    assert pct["C"] == pytest.approx(2 / 3)
    assert pct["D"] == 0.0                      # [G3] 고립 문서 채움
    assert (df.nbr_score <= 1.0 + 1e-9).all() and np.isfinite(df.nbr_score).all()


def test_nonfinite_score_raises(tmp_path):
    job04 = _load("job04", "jobs/04_build_neighbors.py")
    emb = np.array([[1.0, 0.0], [np.nan, 0.5]], dtype=np.float32)   # 정규화 없이 NaN 주입
    io = _setup(tmp_path, emb, ["A", "B"], [["c"], ["c"]], {"A": 0.5, "B": 0.3})
    with pytest.raises(Exception):              # [F1] 비유한값 즉시 실패 — 침묵 오염 금지
        job04.run(**io, faiss_topk=1, k=20)
    assert not io["out_path"].exists()


def test_chunk_checkpoint_resume_skips_completed(tmp_path):
    job04 = _load("job04", "jobs/04_build_neighbors.py")
    emb = _unit([[1.0, 0.0], [0.999, 0.045], [0.9, 0.436], [0.8, 0.6]])
    io = _setup(tmp_path, emb, ["A", "B", "C", "D"],
                [[], [], [], []], {"A": 0.5, "B": 0.3, "C": 0.2, "D": 0.1})
    # 중단된 이전 실행 모사: 첫 청크(문서 A·B)의 체크포인트가 이미 존재
    ckpt = tmp_path / "neighbors_chunks"
    ckpt.mkdir()
    cols = ["title", "nbr_title", "nbr_score", "pr_pct", "src_kind"]
    pd.DataFrame([("A", "Z", 0.123, 0.0, "emb"), ("B", "Z", 0.456, 0.0, "emb")],
                 columns=cols).to_parquet(ckpt / "chunk_00000000.parquet")

    job04.run(**io, faiss_topk=2, k=20, chunk_rows=2)

    df = pd.read_parquet(io["out_path"])
    # [K2] 재시작 시 완료 청크 스킵 — 센티널 행이 그대로 최종 산출에 존재(재계산 안 함)
    assert set(df[df.title == "A"].nbr_title) == {"Z"}
    assert not df[df.title == "C"].empty      # 미완료 청크(C·D)는 계산됨
    assert "Z" not in set(df[df.title == "C"].nbr_title)
    assert not ckpt.exists()                  # 성공 완주 후 체크포인트 정리 — 다음 실행은 전체 재계산


def _cuda_available():
    try:
        import torch
        return torch.cuda.is_available()
    except Exception:
        return False


@pytest.mark.skipif(not _cuda_available(),
                    reason="CUDA 미확보 — GPU/CPU 동일성은 GPU 머신에서 검증")
def test_gpu_cpu_identical_results(tmp_path):
    job04 = _load("job04", "jobs/04_build_neighbors.py")
    rng = np.random.default_rng(42)
    emb = _unit(rng.normal(size=(50, 8)))
    titles = [f"T{i}" for i in range(50)]
    pr = {t: float(r) for t, r in zip(titles, rng.random(50))}
    io = _setup(tmp_path, emb, titles, [[] for _ in titles], pr)

    job04.run(**io, faiss_topk=5, k=5, use_gpu=False)
    cpu = pd.read_parquet(io["out_path"])
    job04.run(**io, faiss_topk=5, k=5, use_gpu=True)   # 성공 완주 후 체크포인트는 정리됨
    gpu = pd.read_parquet(io["out_path"])

    # [K2] 전수 탐색이므로 산출 동일 (부동소수 오차 허용)
    key = lambda d: {(r.title, r.nbr_title): r.nbr_score for r in d.itertuples()}
    ck, gk = key(cpu), key(gpu)
    assert set(ck) == set(gk)
    for pair in ck:
        assert ck[pair] == pytest.approx(gk[pair], abs=1e-4)
