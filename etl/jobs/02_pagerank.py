"""job 02 — PageRank (igraph, 명세 §2). damping 0.85.

[M8] 문자열 컬럼을 pandas object로 상주시킨 채 Graph.TupleList로 넘기지 말 것 —
제목을 정수로 factorize한 뒤 정수 엣지 배열로 그래프를 만든다.
"""
import sys
from pathlib import Path

import igraph as ig
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from conf import settings


def run(edges_path, out_path):
    edges = pd.read_parquet(edges_path)
    codes, titles = pd.factorize(
        pd.concat([edges["src"], edges["dst"]], ignore_index=True))
    n = len(edges)
    del edges                                              # 문자열 조기 해제 [M8]
    g = ig.Graph(n=len(titles),
                 edges=np.column_stack([codes[:n], codes[n:]]), directed=True)
    pd.DataFrame({"title": titles, "pagerank": g.pagerank(damping=0.85)}) \
        .to_parquet(out_path)
    print(f"pagerank: {g.vcount():,} vertices, {g.ecount():,} edges")


if __name__ == "__main__":
    run(settings.SILVER_LINKS, settings.SILVER_PAGERANK)
