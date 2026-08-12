"""job 05 (빌드 전용 [G1]) — 샤딩·직렬화·manifest·popular 검증.

- [M5·F3] 소수 4자리 반올림 + 직렬화 고정(ensure_ascii=False, allow_nan=False,
  separators=(",",":")) + gzip 레벨 9
- [I9] version := 빌드 시각 epoch초 (이전 값 +1 금지)
- [F4] manifest.namespaces = settings.NAMESPACES 정렬 배열
- [B2] popular.json = docs 실존 제목과 조인 후 pagerank 내림차순 상위 100 제목 배열
"""
import gzip
import importlib.util
import json
import sys
import time
from pathlib import Path

import pandas as pd
import pytest

ETL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ETL))
from conf import settings  # noqa: E402


def _load():
    spec = importlib.util.spec_from_file_location("job05", ETL / "jobs" / "05_build_shards.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _inputs(tmp_path, nbr_rows, doc_titles, pr):
    nbr = pd.DataFrame(nbr_rows, columns=["title", "nbr_title", "nbr_score", "pr_pct", "src_kind"])
    nbr.to_parquet(tmp_path / "neighbors.parquet")
    pd.DataFrame({"title": doc_titles,
                  "clean_text": ["x"] * len(doc_titles),
                  "categories": [[] for _ in doc_titles]}).to_parquet(tmp_path / "docs.parquet")
    pd.DataFrame({"title": list(pr), "pagerank": list(pr.values())}) \
        .to_parquet(tmp_path / "pagerank.parquet")
    return dict(neighbors_path=tmp_path / "neighbors.parquet",
                docs_path=tmp_path / "docs.parquet",
                pagerank_path=tmp_path / "pagerank.parquet",
                out_dir=tmp_path / "gold")


def test_shards_rounding_order_and_fixed_serialization(tmp_path):
    job05 = _load()
    io = _inputs(
        tmp_path,
        [("하츠네 미쿠", "카가미네 린", 0.912345, 0.71119, "emb"),
         ("하츠네 미쿠", "메구리네 루카", 0.95, 0.6, "both"),
         ("파이썬", "루비(프로그래밍 언어)", 0.88, 0.5, "emb")],
        ["하츠네 미쿠", "파이썬", "카가미네 린"],
        {"하츠네 미쿠": 0.5, "파이썬": 0.4, "카가미네 린": 0.3})
    job05.run(**io)

    files = sorted((io["out_dir"] / "nbr").glob("*.json.gz"))
    assert len(files) == 1024                       # 빈 버킷 포함 전체 파일 셋

    sid = job05.fnv1a32("하츠네 미쿠") % 1024
    assert sid == 233                               # [F8] 기대 샤드
    raw = gzip.decompress((io["out_dir"] / "nbr" / "0233.json.gz").read_bytes())
    payload = json.loads(raw)
    # 점수 내림차순 + 소수 4자리 반올림 [M5]
    assert payload["하츠네 미쿠"] == [["메구리네 루카", 0.95, 0.6], ["카가미네 린", 0.9123, 0.7112]]
    text = raw.decode("utf-8")
    assert ", " not in text and ": " not in text    # separators=(",",":") [F3]
    assert "하츠네" in text                          # ensure_ascii=False — \uXXXX 아님
    assert "src_kind" not in text                   # 중간 산출 전용 필드는 샤드에 미포함


def test_manifest_version_epoch_and_namespaces(tmp_path):
    job05 = _load()
    io = _inputs(tmp_path, [("A", "B", 0.9, 0.5, "emb")], ["A", "B"], {"A": 0.5, "B": 0.3})
    before = int(time.time())
    v = job05.run(**io)
    after = int(time.time())

    m = json.loads((io["out_dir"] / "manifest.json").read_text(encoding="utf-8"))
    assert m["version"] == v
    assert before <= v <= after                     # [I9] 빌드 시각 epoch초 — counter 아님
    assert m["shards"] == 1024
    assert m["namespaces"] == sorted(settings.NAMESPACES)   # [F4] 런타임 대조용
    assert "built_at" in m


def test_popular_titles_only_docs_joined_top100(tmp_path):
    job05 = _load()
    titles = [f"문서{i:03d}" for i in range(120)]
    pr = {t: 1.0 - i * 0.001 for i, t in enumerate(titles)}
    pr["유령문서"] = 2.0                             # docs에 없음 — popular에서 배제 [B2]
    io = _inputs(tmp_path, [("문서000", "문서001", 0.9, 0.5, "emb")], titles, pr)
    job05.run(**io)

    popular = json.loads((io["out_dir"] / "popular.json").read_text(encoding="utf-8"))
    assert popular == titles[:100]                  # 제목 배열, pagerank 내림차순 100건
    assert "유령문서" not in popular


def test_allow_nan_false_raises(tmp_path):
    job05 = _load()
    io = _inputs(tmp_path, [("A", "B", float("nan"), 0.5, "emb")], ["A", "B"], {"A": 0.5})
    with pytest.raises(ValueError):                 # [F1] 최종 방어선 — 침묵 오염 금지
        job05.run(**io)


def test_fnv1a32_reference_vectors():
    job05 = _load()
    assert job05.fnv1a32("") == 2166136261          # FNV offset basis
    assert job05.fnv1a32("하츠네 미쿠") == 1875581161   # 명세 §2 기대값
    import unicodedata
    nfd = unicodedata.normalize("NFD", "하츠네 미쿠")
    assert job05.fnv1a32(nfd) == 1875581161         # NFC 정규화 포함
