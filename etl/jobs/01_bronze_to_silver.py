"""job 01 — NamuMark 파싱 + 링크·분류 추출 (PySpark local[*], 명세 §2).

- [B1] 200자 길이 필터는 redirect 분리 이후 실문서에만
- [I10] title은 읽기 직후, redirect_to는 파싱 직후 NFC 정규화
- [N1] 네임스페이스 문서는 고정 목록 판정으로 docs에서 제거,
       콜론 접두 빈도 상위 20을 로그로 출력 (누락 네임스페이스 점검)
- [K1] redirect 치환 후·실존 join 이전 distinct 엣지 수(edges_pre_join)와
       join 이후 엣지 수(edges_post_join)를 link_stats.json으로 산출 — validate O2 입력
"""
import json
import os
import sys
import unicodedata
from pathlib import Path

ETL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ETL))
# UDF는 워커 프로세스에서 namuparse를 import한다 — 드라이버 sys.path만으로는 부족
os.environ["PYTHONPATH"] = str(ETL) + os.pathsep + os.environ.get("PYTHONPATH", "")

from pyspark import StorageLevel
from pyspark.sql import SparkSession, functions as F, types as T

from conf import settings
from namuparse.links import extract_categories, extract_links
from namuparse.parser import strip_namumark


def build_spark(driver_memory=settings.DRIVER_MEMORY,
                max_partition_bytes=settings.MAX_PARTITION_BYTES,
                shuffle_partitions=settings.SHUFFLE_PARTITIONS):
    return (SparkSession.builder.master("local[*]")
            .config("spark.driver.memory", driver_memory)
            .config("spark.sql.files.maxPartitionBytes", max_partition_bytes)
            .config("spark.sql.shuffle.partitions", shuffle_partitions)
            .getOrCreate())


def run(spark, bronze_jsonl, out_docs, out_links, out_stats):
    nfc_udf = F.udf(lambda s: unicodedata.normalize("NFC", s) if s else s,
                    T.StringType())                               # [I10]

    raw = spark.read.json(str(bronze_jsonl)).withColumn("title", nfc_udf("title"))

    # [N1] 콜론 접두 빈도 상위 20 — 누락 네임스페이스가 보이면 상수에 추가 후 재실행
    top20 = (raw.filter(F.col("title").contains(":"))
             .groupBy(F.substring_index("title", ":", 1).alias("prefix"))
             .count().orderBy(F.desc("count")).limit(20).collect())
    print("[N1] colon-prefix top20:", [(r["prefix"], r["count"]) for r in top20])

    parse_udf = F.udf(strip_namumark, T.StructType([
        T.StructField("clean_text", T.StringType()),
        T.StructField("is_redirect", T.BooleanType()),
        T.StructField("redirect_to", T.StringType()),
    ]))
    links_udf = F.udf(extract_links, T.ArrayType(T.StringType()))
    cats_udf = F.udf(extract_categories, T.ArrayType(T.StringType()))   # [N2]

    parsed = (raw
              .withColumn("p", parse_udf("text"))
              .withColumn("links", links_udf("text"))
              .withColumn("categories", cats_udf("text"))
              .select("title", "p.*", "links", "categories")
              .withColumn("redirect_to", nfc_udf("redirect_to")))  # [I10] 조인 키 정규화

    is_ns = (F.col("title").contains(":")                          # [N1] 고정 목록 판정
             & F.substring_index("title", ":", 1).isin(list(settings.NAMESPACES)))

    redirects = parsed.filter("is_redirect").select("title", "redirect_to")
    docs = (parsed.filter("NOT is_redirect")
            .filter(~is_ns)                                        # [N1]
            .filter(F.length("clean_text") > 200)                  # [B1] 실문서에만
            .drop("is_redirect", "redirect_to")
            .persist(StorageLevel.MEMORY_AND_DISK))    # 액션마다 UDF 재파싱 방지

    resolved = (docs.select("title", F.explode("links").alias("dst"))
                .join(redirects.withColumnRenamed("title", "dst"), "dst", "left")
                .withColumn("dst", F.coalesce("redirect_to", "dst"))  # redirect → 실문서 치환
                .select(F.col("title").alias("src"), "dst")
                .distinct()                                        # [K1] O2 분모
                .persist(StorageLevel.MEMORY_AND_DISK))
    edges = (resolved
             .join(docs.select(F.col("title").alias("dst")).distinct(), "dst", "inner")
             .select("src", "dst"))          # 실존 문서만 — 네임스페이스 dst도 자동 소멸 [N1]

    docs.drop("links").write.mode("overwrite").parquet(str(out_docs))  # categories 포함 [N2]
    edges.write.mode("overwrite").parquet(str(out_links))

    # [K1] write 이후 카운트 — 잡 실패 시 파일 미산출 → validate가 raise
    stats = {"edges_pre_join": resolved.count(), "edges_post_join": edges.count()}
    Path(out_stats).write_text(json.dumps(stats), encoding="utf-8")    # [H10]
    ratio = stats["edges_post_join"] / stats["edges_pre_join"] if stats["edges_pre_join"] else 0.0
    print(f"O2 preview: {stats['edges_post_join']}/{stats['edges_pre_join']} = {ratio:.4f} (gate >= 0.90)")
    return stats


if __name__ == "__main__":
    run(build_spark(), settings.BRONZE_JSONL, settings.SILVER_DOCS, settings.SILVER_LINKS,
        settings.SILVER_LINK_STATS)
