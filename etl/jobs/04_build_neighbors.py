"""job 04 — 이웃 사전계산: FAISS 후보 ∪ 분류 후보 → 혼합 점수 재랭킹 (명세 §2 [N2]).

- 임베딩 후보: 전수 탐색 top-(FAISS_TOPK+1)에서 자기 자신 제외 — 근사 인덱스 금지 [K2]
- 분류 후보: 분류→구성원 역색인. 구성원 수 > CAT_MAX_SIZE인 분류는 역색인·Jaccard
  양쪽에서 통째로 무시, 남은 분류의 구성원은 pagerank 내림차순 CAT_CAND_PER_CAT개 절단
- 혼합 점수: nbr_score = (1−CAT_BLEND)·cos + CAT_BLEND·Jaccard
  [F1] Jaccard = |A∩B|/|A∪B|, |A∪B|=0 → 0. 산출 직후 전건 유한성 assert — 침묵 오염 금지
- [G3] percentile(d) = (pagerank ≤ pagerank(d)인 행 수)/총 행 수, 부재 문서 := 0.0
- [K2] GPU 허용(torch 청크 matmul — 전수 탐색이라 CPU IndexFlatIP와 산출 동일),
  쿼리 청크 체크포인트: 완료 청크는 재시작 시 스킵, 성공 완주 후 정리
- 로그에 후보 출처 통계(임베딩 전용/분류 전용/양쪽) — O4(d) 정성 검수 입력.
  중간 산출 스키마: title, nbr_title, nbr_score, pr_pct, src_kind('emb'|'cat'|'both')
"""
import shutil
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from conf import settings

COLUMNS = ["title", "nbr_title", "nbr_score", "pr_pct", "src_kind"]


def gpu_available():
    try:
        import torch
        return torch.cuda.is_available()
    except Exception:
        return False


def _make_search(emb, topk, use_gpu):
    """쿼리 행렬 → (sims, idxs) top-k. 전수 탐색 — GPU/CPU 산출 동일 [K2]."""
    topk = min(topk, emb.shape[0])
    if use_gpu:
        import torch
        base = torch.from_numpy(emb).cuda()

        def search(queries):
            out_s, out_i = [], []
            for s in range(0, queries.shape[0], 512):     # 6GB VRAM 상한 고려 서브배치
                q = torch.from_numpy(queries[s:s + 512]).cuda()
                ts, ti = torch.topk(q @ base.T, topk, dim=1)
                out_s.append(ts.cpu().numpy())
                out_i.append(ti.cpu().numpy())
            return np.concatenate(out_s), np.concatenate(out_i)
        return search

    import faiss
    index = faiss.IndexFlatIP(emb.shape[1])
    index.add(emb)
    return lambda queries: index.search(queries, topk)


def run(emb_path, titles_path, pagerank_path, docs_path, out_path, *,
        k=20, faiss_topk=None, cat_blend=None, cat_max_size=None,
        cat_cand_per_cat=None, chunk_rows=100_000, use_gpu=None):
    faiss_topk = settings.FAISS_TOPK if faiss_topk is None else faiss_topk
    cat_blend = settings.CAT_BLEND if cat_blend is None else cat_blend
    cat_max_size = settings.CAT_MAX_SIZE if cat_max_size is None else cat_max_size
    cat_cand_per_cat = (settings.CAT_CAND_PER_CAT if cat_cand_per_cat is None
                        else cat_cand_per_cat)
    if use_gpu is None:
        use_gpu = gpu_available()

    emb = np.load(emb_path)
    assert emb.dtype == np.float32, "[M7] embeddings는 float32 저장"
    titles = Path(titles_path).read_text(encoding="utf-8").splitlines()
    n = emb.shape[0]
    assert len(titles) == n

    pr = pd.read_parquet(pagerank_path)
    pct = pr["pagerank"].rank(pct=True, method="max")     # [G3] "≤인 행 수/총 행 수" 정의
    pct_map = dict(zip(pr["title"], pct))
    rank_map = dict(zip(pr["title"], pr["pagerank"]))
    idx_pct = np.array([pct_map.get(t, 0.0) for t in titles])   # [G3] 고립 문서 0.0
    idx_rank = np.array([rank_map.get(t, 0.0) for t in titles])

    # [N2] 분류 역색인 — CAT_MAX_SIZE 초과 분류는 역색인·Jaccard 양쪽에서 무시
    docs = pd.read_parquet(docs_path, columns=["title", "categories"])
    t2i = {t: i for i, t in enumerate(titles)}
    members = defaultdict(list)
    raw_cats = {}
    for t, cs in zip(docs["title"], docs["categories"]):
        i = t2i.get(t)
        if i is None:
            continue
        cs = [] if cs is None else list(cs)
        raw_cats[i] = cs
        for c in cs:
            members[c].append(i)
    kept = {c for c, m in members.items() if len(m) <= cat_max_size}
    empty = frozenset()
    doc_cats = {i: frozenset(c for c in cs if c in kept) for i, cs in raw_cats.items()}
    cat_cand = {c: sorted(members[c], key=lambda j: -idx_rank[j])[:cat_cand_per_cat]
                for c in kept}                            # pagerank 내림차순 절단

    search = _make_search(emb, faiss_topk + 1, use_gpu)
    print(f"neighbors: n={n:,}, backend={'gpu' if use_gpu else 'faiss-cpu'}", flush=True)

    out_path = Path(out_path)
    ckpt_dir = out_path.parent / (out_path.stem + "_chunks")
    ckpt_dir.mkdir(parents=True, exist_ok=True)
    chunk_files = []
    for start in range(0, n, chunk_rows):
        end = min(start + chunk_rows, n)
        f = ckpt_dir / f"chunk_{start:08d}.parquet"
        chunk_files.append(f)
        if f.exists():                                    # [K2] 재시작 시 완료 청크 스킵
            print(f"chunk {start:,}..{end:,} skipped (checkpoint)", flush=True)
            continue
        sims, idxs = search(emb[start:end])
        rows = []
        for q in range(start, end):
            cand = {}
            for s, j in zip(sims[q - start], idxs[q - start]):
                j = int(j)
                if j != q and j >= 0:
                    cand[j] = float(s)                    # 임베딩 후보 — cos 기지
            emb_set = set(cand)
            cset = set()
            for c in doc_cats.get(q, empty):
                cset.update(cat_cand[c])
            cset.discard(q)
            for j in cset - emb_set:
                cand[j] = float(emb[q] @ emb[j])          # 분류 전용 후보 — cos 직접 내적
            ca = doc_cats.get(q, empty)
            scored = []
            for j, cos in cand.items():
                cb = doc_cats.get(j, empty)
                union = len(ca | cb)
                jac = len(ca & cb) / union if union else 0.0   # [F1] 0/0 := 0
                kind = ("both" if j in emb_set and j in cset
                        else "emb" if j in emb_set else "cat")
                scored.append(((1.0 - cat_blend) * cos + cat_blend * jac, j, kind))
            scored.sort(key=lambda x: (-x[0], x[1]))      # 결정적 동률 순서
            rows.extend((titles[q], titles[j], score, float(idx_pct[j]), kind)
                        for score, j, kind in scored[:k])
        chunk = pd.DataFrame(rows, columns=COLUMNS)
        assert np.isfinite(chunk["nbr_score"]).all(), "[F1] nbr_score 비유한값 — 즉시 실패"
        tmp = f.with_suffix(".tmp")                       # 반쪽 체크포인트 방지
        chunk.to_parquet(tmp)
        tmp.replace(f)
        print(f"chunk {start:,}..{end:,} done ({len(rows):,} rows)", flush=True)

    df = pd.concat([pd.read_parquet(f) for f in chunk_files], ignore_index=True)
    assert np.isfinite(df["nbr_score"]).all(), "[F1] nbr_score 비유한값 — 즉시 실패"
    stats = df["src_kind"].value_counts().to_dict()       # O4(d) 후보 출처 통계
    print(f"neighbors: {df['title'].nunique():,} docs, {len(df):,} rows, "
          f"candidate sources {stats}", flush=True)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(out_path)
    shutil.rmtree(ckpt_dir)                               # 성공 완주 후 정리 — 스테일 재사용 방지
    return stats


if __name__ == "__main__":
    run(settings.EMBED_NPY, settings.EMBED_TITLES, settings.SILVER_PAGERANK,
        settings.SILVER_DOCS, settings.GOLD_NEIGHBORS)
