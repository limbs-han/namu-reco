"""경로·파티션·모델·NAMESPACES·분류 상수(CAT_*)·NBR_SCORE_FLOOR (명세 §1)."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
BRONZE_DUMP = DATA / "bronze" / "namuwiki.json"   # 단일 거대 JSON 배열 (~30GB)
BRONZE_JSONL = DATA / "bronze" / "jsonl"
SILVER_DOCS = DATA / "silver" / "docs.parquet"
SILVER_LINKS = DATA / "silver" / "links.parquet"
SILVER_PAGERANK = DATA / "silver" / "pagerank.parquet"
SILVER_LINK_STATS = DATA / "silver" / "link_stats.json"   # [K1] job 01 산출 → validate O2 판정
EMBED_MODEL = "intfloat/multilingual-e5-small"    # 384차원 [M7]
EMBED_NPY = DATA / "silver" / "embeddings.npy"
EMBED_TITLES = DATA / "silver" / "titles.txt"
GOLD_NEIGHBORS = DATA / "gold" / "neighbors.parquet"      # job 04 중간 산출
GOLD_DIR = DATA / "gold"
REVIEW_DIR = DATA / "review"                      # [G12] 검수 자료·APPROVED 마커 — push 대상 아님

SHARD_BYTES = 256 * 2**20
DRIVER_MEMORY = "20g"
MAX_PARTITION_BYTES = 128 * 2**20   # O3 실패 시 64MB로 축소 (명세 §5)
SHUFFLE_PARTITIONS = 240

# [N1] extension/common.js의 JS 상수와 반드시 동일하게 유지 [F4] — 정합은 O5가 게이트
NAMESPACES = {"나무위키", "틀", "분류", "사용자", "파일", "휴지통"}

# [N2] job 04 분류 확장 상수 (v3에서 확정)
CAT_BLEND = 0.2
CAT_MAX_SIZE = 1000
CAT_CAND_PER_CAT = 30
FAISS_TOPK = 40

# [F2] O4(c) 하한 게이트 — common.js FALLBACK_SIM(0.4)과의 서열은 O5(d)가 게이트 [G6]
NBR_SCORE_FLOOR = 0.45
