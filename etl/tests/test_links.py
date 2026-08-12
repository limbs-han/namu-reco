"""links.py: 명세 §2 — \\[\\[([^|\\]#]+) 추출, NFC+trim, 파일:/외부 제외, 분류:는 categories로."""
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from namuparse.links import extract_categories, extract_links


def test_extract_links_basic():
    src = "[[대상 문서|표시]]와 [[다른 문서#앵커]], [[파일:x.png]], [[분류:음악]], [[https://example.com|외부]]"
    assert extract_links(src) == ["대상 문서", "다른 문서"]


def test_extract_links_nfc_normalized():
    nfd = unicodedata.normalize("NFD", "한국")
    assert extract_links(f"[[{nfd}]]") == ["한국"]


def test_extract_links_trimmed_and_keeps_duplicates():
    assert extract_links("[[ 문서 ]] [[문서]]") == ["문서", "문서"]  # 중복 제거는 job 01 distinct 몫


def test_extract_categories():
    assert extract_categories("[[분류:음악]] [[분류: 게임 ]] [[일반 문서]]") == ["음악", "게임"]


def test_extract_categories_deduplicated():
    # 명세 §2: extract_categories는 NFC 정규화·trim·중복 제거해 배열로 반환 [N2]
    assert extract_categories("[[분류:음악]] [[분류:음악]] [[분류: 음악 ]]") == ["음악"]


def test_empty_input():
    assert extract_links("") == []
    assert extract_links(None) == []
    assert extract_categories(None) == []
