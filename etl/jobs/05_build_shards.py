"""job 05 — 샤딩·직렬화 (빌드 전용 — push 금지 [G1]). 로컬 data/gold/ 산출까지만.

- 샤드 키: fnv1a32(NFC(title)) % 1024 — silver title은 이미 NFC [I10]
- [M5·F3] nbr_score·pagerank_percentile 소수 4자리 반올림, 직렬화 고정:
  json.dumps(shard, ensure_ascii=False, allow_nan=False, separators=(",",":"))
  → gzip 레벨 9 → nbr/{0000..1023}.json.gz. allow_nan=False는 [F1]의 최종 방어선
- [I9] manifest version := 빌드 시각 epoch초 — "이전 값 +1" 금지(counter 리셋 충돌)
- [F4] manifest.namespaces = settings.NAMESPACES 정렬 배열 (확장 런타임 대조용)
- [B2] popular.json = pagerank를 docs 실존 제목과 조인 후 내림차순 상위 100 제목 배열
"""
import gzip
import json
import sys
import time
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from conf import settings


def fnv1a32(s):
    """FNV-1a 32bit — extension/common.js와 동일 구현 필수 [M1], 정합은 O5가 게이트."""
    h = 2166136261
    for b in unicodedata.normalize("NFC", s).encode("utf-8"):
        h ^= b
        h = (h * 16777619) & 0xFFFFFFFF
    return h


def run(neighbors_path, docs_path, pagerank_path, out_dir, shards=1024):
    nbr = pd.read_parquet(neighbors_path)
    buckets = [{} for _ in range(shards)]
    for title, grp in nbr.groupby("title", sort=False):
        grp = grp.sort_values("nbr_score", ascending=False, kind="stable")
        buckets[fnv1a32(title) % shards][title] = [
            [r.nbr_title, round(float(r.nbr_score), 4), round(float(r.pr_pct), 4)]
            for r in grp.itertuples(index=False)]                  # [M5] 4자리 반올림

    out_dir = Path(out_dir)
    (out_dir / "nbr").mkdir(parents=True, exist_ok=True)
    for sid, payload in enumerate(buckets):
        blob = json.dumps(payload, ensure_ascii=False, allow_nan=False,
                          separators=(",", ":")).encode("utf-8")   # [F3] 고정 직렬화
        (out_dir / "nbr" / f"{sid:04d}.json.gz").write_bytes(
            gzip.compress(blob, compresslevel=9))

    # [B2] popular.json — docs 실존 제목과 조인 (docs가 이미 네임스페이스 배제 [N1])
    docs_titles = set(pd.read_parquet(docs_path, columns=["title"])["title"])
    pr = pd.read_parquet(pagerank_path)
    top = pr[pr["title"].isin(docs_titles)].nlargest(100, "pagerank")["title"].tolist()
    (out_dir / "popular.json").write_text(
        json.dumps(top, ensure_ascii=False, allow_nan=False, separators=(",", ":")),
        encoding="utf-8")

    version = int(time.time())                                     # [I9] 상태 없이 단조
    (out_dir / "manifest.json").write_text(
        json.dumps({"version": version, "shards": shards,
                    "built_at": datetime.now(timezone.utc).isoformat(),
                    "namespaces": sorted(settings.NAMESPACES)},    # [F4]
                   ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8")

    sizes = [f.stat().st_size for f in (out_dir / "nbr").glob("*.json.gz")]
    # 로그는 ASCII 한정 — Windows 호스트 cp949 콘솔에서 print 크래시 방지 (H10과 동일 클래스)
    print(f"built v{version}: {shards} shards, total {sum(sizes) / 2**20:.1f} MB, "
          f"max {max(sizes) / 2**20:.3f} MB (gzipped; gate check in validate [G9])")
    return version


if __name__ == "__main__":
    run(settings.GOLD_NEIGHBORS, settings.SILVER_DOCS, settings.SILVER_PAGERANK,
        settings.GOLD_DIR)
