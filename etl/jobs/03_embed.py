"""job 03 — 임베딩 (Spark 아님, 단일 GPU 배치, 명세 §2).

docs.parquet를 청크로 순회, 본문 앞 1,000자만 e5-small(384d)로 인코딩.
e5 계열은 접두사 필수 — 대칭 유사도이므로 모델 카드 권고대로 "query: " 사용 [M7].
[M7] 추론은 fp16, 저장은 float32(FAISS 요구) — L2 정규화 후 embeddings.npy,
행 순서와 일치하는 titles.txt 저장. 1M×384 float32 ≈ 1.5GB (오프라인 전용, 허용).
"""
import sys
from pathlib import Path

import numpy as np
import pyarrow.dataset as ds

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from conf import settings


def _default_encoder():
    import torch
    from sentence_transformers import SentenceTransformer
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = SentenceTransformer(settings.EMBED_MODEL, device=device)
    if device == "cuda":
        model.half()
    print(f"encoder: {settings.EMBED_MODEL} on {device}")
    return lambda texts: model.encode(texts, batch_size=256, show_progress_bar=False,
                                      convert_to_numpy=True)


def run(docs_path, out_npy, out_titles, encoder=None, chunk_rows=20_000):
    encode = encoder or _default_encoder()
    chunks, titles, done = [], [], 0
    for batch in ds.dataset(str(docs_path), format="parquet").to_batches(
            columns=["title", "clean_text"], batch_size=chunk_rows):
        ts, texts = batch.column(0).to_pylist(), batch.column(1).to_pylist()
        vecs = encode(["query: " + t[:1000] for t in texts]).astype(np.float32)
        vecs /= np.linalg.norm(vecs, axis=1, keepdims=True)   # L2 정규화
        chunks.append(vecs)                                   # [M7] float32 저장 — fp16 캐스팅 금지
        titles.extend(ts)
        done += len(ts)
        print(f"embedded {done:,}", flush=True)
    np.save(out_npy, np.concatenate(chunks))
    Path(out_titles).write_text("\n".join(titles) + "\n", encoding="utf-8")


if __name__ == "__main__":
    run(settings.SILVER_DOCS, settings.EMBED_NPY, settings.EMBED_TITLES)
