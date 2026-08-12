"""O5 크로스 언어 정합 게이트 — 명세 §5 O5 (a)~(g) 전 항목, 단일 파일 [J13].

Python 측 값은 직접 계산(레퍼런스 = job 05의 fnv1a32 + conf.settings 상수),
JS 측은 node subprocess로 extension/common.js를 require한 출력을 대조한다 [G4].
실행: python -m pytest etl/tests/test_o5.py
"""
import importlib.util
import json
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

import pytest

ETL = Path(__file__).resolve().parents[1]
ROOT = ETL.parent
COMMON_JS = ROOT / "extension" / "common.js"
sys.path.insert(0, str(ETL))

from conf import settings  # noqa: E402

_spec = importlib.util.spec_from_file_location("job05", ETL / "jobs" / "05_build_shards.py")
job05 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(job05)

# (a) ASCII · 한글(기대값 고정) · 한글 혼합 장문 제목 — 한글 벡터가 판정 핵심
VECTORS = ["abc", "하츠네 미쿠", "리그 오브 레전드/2021 월드 챔피언십 결승전 (11월 6일)"]
# (f) isNamespace 행동 벡터 [I11]
NS_VECTORS = ["나무위키:대문", "Re:제로부터 시작하는 이세계 생활", ":틀:x"]
NS_EXPECTED = [True, False, False]
# (g) docUrlOf 벡터 [J2] — JS 단독 게이트
URL_VECTORS = ["C#", "A/B", "하츠네 미쿠"]
URL_EXPECTED = ["https://namu.wiki/w/C%23", "https://namu.wiki/w/A/B",
                "https://namu.wiki/w/%ED%95%98%EC%B8%A0%EB%84%A4%20%EB%AF%B8%EC%BF%A0"]

HARNESS = r"""
const c = require(process.argv[2]);
const input = JSON.parse(require("fs").readFileSync(process.argv[3], "utf8"));
process.stdout.write(JSON.stringify({
  fnv: input.vectors.map(v => c.fnv1a32(v)),
  shard_ids: input.vectors.map(v => c.shardIdOf(v)),
  shard_paths: input.vectors.map(v => c.shardPath(c.shardIdOf(v))),
  namespaces_canon: JSON.stringify([...c.NAMESPACES].sort()),
  fallback_sim: c.FALLBACK_SIM,
  shard_base: c.SHARD_BASE,
  is_ns: input.ns_vectors.map(v => c.isNamespace(v)),
  doc_urls: input.url_vectors.map(v => c.docUrlOf(v)),
  url_233: c.SHARD_BASE + "/" + c.shardPath(233),
}));
"""


@pytest.fixture(scope="module")
def js(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("o5")
    harness = tmp / "o5_harness.js"
    harness.write_text(HARNESS, encoding="utf-8")
    inp = tmp / "input.json"
    # ensure_ascii 기본(True) — \uXXXX 이스케이프라 콘솔 인코딩과 무관하게 안전
    inp.write_text(json.dumps({"vectors": VECTORS, "ns_vectors": NS_VECTORS,
                               "url_vectors": URL_VECTORS}), encoding="utf-8")
    r = subprocess.run(["node", str(harness), str(COMMON_JS), str(inp)],
                       capture_output=True, check=True)
    return json.loads(r.stdout.decode("utf-8"))


def _py_shard_id(title):
    return job05.fnv1a32(title) % 1024


def _py_is_ns(title):
    """job 01 판정식과 동일 로직 — 첫 ':' 앞부분의 고정 목록 소속 [I11]."""
    i = title.find(":")
    return i > 0 and title[:i] in settings.NAMESPACES


def test_o5a_fnv1a32_vectors_match(js):
    py = [job05.fnv1a32(v) for v in VECTORS]
    assert py[1] == 1875581161                     # 명세 기대값 고정
    assert js["fnv"] == py


def test_o5b_shard_id_and_filename_match(js):
    py_ids = [_py_shard_id(v) for v in VECTORS]
    py_paths = [f"nbr/{i:04d}.json.gz" for i in py_ids]
    assert py_ids[1] == 233                        # "하츠네 미쿠" → 233 [F8]
    assert py_paths[1] == "nbr/0233.json.gz"
    assert js["shard_ids"] == py_ids
    assert js["shard_paths"] == py_paths


def test_o5c_namespaces_canonical_serialization(js):
    # [I12] BMP 문자 전제 — Array.sort()는 UTF-16 단위, sorted는 코드포인트 순서
    py = json.dumps(sorted(settings.NAMESPACES), ensure_ascii=False, separators=(",", ":"))
    assert js["namespaces_canon"] == py


def test_o5d_fallback_below_floor(js):
    assert js["fallback_sim"] < settings.NBR_SCORE_FLOOR   # [G6] 서열 드리프트 차단


def test_o5e_shard_base_format(js):
    base = js["shard_base"]
    assert base.startswith("https://")
    assert not any(ch in base for ch in "<> ")     # 미치환 플레이스홀더 차단 [I2]
    assert not base.endswith("/")
    u = urlparse(js["url_233"])
    assert u.scheme == "https" and u.netloc and u.path.endswith("/nbr/0233.json.gz")


def test_o5f_isnamespace_behavior_vectors(js):
    py = [_py_is_ns(v) for v in NS_VECTORS]
    assert py == NS_EXPECTED
    assert js["is_ns"] == NS_EXPECTED


def test_o5g_doc_url_vectors(js):
    assert js["doc_urls"] == URL_EXPECTED
