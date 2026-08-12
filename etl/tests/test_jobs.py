"""jobs 00/01 검증. 숫자로 시작하는 파일명이라 importlib 경유 로드.

job 01 검증 항목 (v10):
- [B1] 길이 필터는 redirect 분리 후 실문서에만
- [I10] title 읽기 직후·redirect_to 파싱 직후 NFC — NFD 입력이 NFC 키로 산출
- [N1] 네임스페이스 문서 docs 제외, dst의 네임스페이스는 inner join에서 자동 소멸
- [K1] link_stats.json에 edges_pre_join/edges_post_join 기록 (validate O2 입력)
"""
import importlib.util
import json
import sys
import unicodedata
from pathlib import Path

import pytest

ETL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ETL))


def _load(name, relpath):
    spec = importlib.util.spec_from_file_location(name, ETL / relpath)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# Windows 호스트는 winutils 없이 Hadoop NativeIO가 죽어 Spark 실행 불가 —
# job 01 테스트는 컨테이너(spark:python3)에서 실행한다 [J10]
pytestmark_spark = pytest.mark.skipif(
    sys.platform == "win32", reason="Spark on Windows host requires winutils; run in container")


@pytest.fixture(scope="module")
def spark():
    job01 = _load("job01", "jobs/01_bronze_to_silver.py")
    s = job01.build_spark(driver_memory="2g", max_partition_bytes=4 * 2**20,
                          shuffle_partitions=4)
    yield s
    s.stop()


NFD = lambda s: unicodedata.normalize("NFD", s)


@pytestmark_spark
def test_job01_end_to_end(tmp_path, spark):
    job01 = _load("job01", "jobs/01_bronze_to_silver.py")
    rows = [
        # title NFD — [I10] 경계 NFC 정규화 검증. 링크: 실존/redirect/부재/네임스페이스
        {"title": NFD("가문서"),
         "text": "[[나문서]] [[별칭]] [[없는문서]] [[틀:상자]] [[분류:테스트]] " + "본문 " * 100},
        {"title": "나문서", "text": "그냥 " + "내용 " * 100},
        # redirect 대상 NFD — [I10] redirect_to NFC 검증 (미정규화면 distinct가 2행으로 갈림)
        {"title": "별칭", "text": "#redirect " + NFD("나문서")},
        # 네임스페이스 문서 — 길이 200+여도 docs에서 제외 [N1]
        {"title": "틀:상자", "text": "틀 본문 " + "내용 " * 100},
    ]
    bronze = tmp_path / "jsonl"
    bronze.mkdir()
    (bronze / "part-0000.jsonl").write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in rows), encoding="utf-8")
    out_docs, out_links = tmp_path / "docs.parquet", tmp_path / "links.parquet"
    out_stats = tmp_path / "link_stats.json"

    stats = job01.run(spark, bronze, out_docs, out_links, out_stats)

    docs = spark.read.parquet(str(out_docs))
    assert set(docs.columns) == {"title", "clean_text", "categories"}
    by_title = {r.title: r for r in docs.collect()}
    # redirect·네임스페이스 문서 제외, title은 NFC 키 [I10·N1]
    assert set(by_title) == {"가문서", "나문서"}
    assert by_title["가문서"].categories == ["테스트"]

    edges = {(r.src, r.dst) for r in spark.read.parquet(str(out_links)).collect()}
    # 별칭→나문서 치환(NFC라 직접 링크와 distinct 병합), 없는문서·틀:상자는 join에서 소멸
    assert edges == {("가문서", "나문서")}

    # [K1] pre_join: (가문서,나문서)·(가문서,없는문서)·(가문서,틀:상자) = 3 — NFC 실패 시 4
    recorded = json.loads(out_stats.read_text(encoding="utf-8"))
    assert recorded == {"edges_pre_join": 3, "edges_post_join": 1}
    assert stats == recorded


def test_split_shards_and_roundtrip(tmp_path):
    job00 = _load("job00", "jobs/00_split_dump.py")
    docs = [{"title": f"문서{i}", "text": "가나다 " * 100} for i in range(50)]
    src = tmp_path / "dump.json"
    src.write_text(json.dumps(docs, ensure_ascii=False), encoding="utf-8")
    out = tmp_path / "jsonl"
    job00.split(str(src), str(out), shard_bytes=4096)
    parts = sorted(out.glob("part-*.jsonl"))
    assert len(parts) > 1, "샤드가 여러 개로 분할되어야 함"
    back = [json.loads(line) for p in parts
            for line in p.read_text(encoding="utf-8").splitlines()]
    assert back == docs, "한글 포함 무손실 라운드트립"
