"""job 00 — 단일 거대 JSON 배열 → 256MB JSONL 샤드 (ijson 스트리밍, 명세 §2).

명세 §2 코드 기반. 수정 2건: Windows 기본 인코딩(cp949) 대신 UTF-8 명시,
마지막 샤드 close 누락 보완.
"""
import json
import sys
from pathlib import Path

import ijson

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from conf import settings


def split(dump_path, out_dir, shard_bytes=256 * 2**20):
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    shard, size, written = 0, 0, None
    with open(dump_path, "rb") as f:
        for doc in ijson.items(f, "item"):
            line = json.dumps(doc, ensure_ascii=False) + "\n"
            if written is None or size > shard_bytes:
                if written:
                    written.close()
                written = open(f"{out_dir}/part-{shard:04d}.jsonl", "w", encoding="utf-8")
                shard += 1
                size = 0
            written.write(line)
            size += len(line.encode())
    if written:
        written.close()


if __name__ == "__main__":
    split(settings.BRONZE_DUMP, settings.BRONZE_JSONL, settings.SHARD_BYTES)
