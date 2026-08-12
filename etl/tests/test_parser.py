"""O1: fixtures 30건에서 잔존 마크업 문자({{{, ||, [[) 비율 < 0.1% (명세 §5)."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # etl/ 를 import 루트로

from namuparse.parser import strip_namumark

FIXTURES = Path(__file__).parent / "fixtures"
ALL = sorted(FIXTURES.glob("*.txt"))
REDIRECTS = [p for p in ALL if p.name.startswith("redirect_")]
DOCS = [p for p in ALL if not p.name.startswith("redirect_")]
MARKUP_TOKENS = ("{{{", "||", "[[")


def read(p):
    return p.read_text(encoding="utf-8")


# ---------- fixtures 자체 검증 (회귀 방지) ----------

def test_corpus_has_30_real_docs():
    assert len(ALL) == 30
    raws = [read(p) for p in DOCS]
    assert any("||" in r for r in raws), "표 포함 문서 없음"
    assert any("#!folding" in r for r in raws), "folding 포함 문서 없음"
    assert any("[include(" in r for r in raws), "틀(include) 포함 문서 없음"
    assert len(REDIRECTS) >= 1, "redirect 문서 없음"


# ---------- O1 게이트 ----------

def test_o1_residual_markup_ratio_below_0_1_percent():
    cleans = [strip_namumark(read(p))[0] for p in DOCS]
    total = sum(len(c) for c in cleans)
    assert total > 0
    residue = sum(c.count(tok) * len(tok) for c in cleans for tok in MARKUP_TOKENS)
    ratio = residue / total
    per_doc = {
        p.name: round(
            sum(c.count(t) * len(t) for t in MARKUP_TOKENS) / max(len(c), 1), 5
        )
        for p, c in zip(DOCS, cleans)
    }
    worst = sorted(per_doc.items(), key=lambda kv: -kv[1])[:5]
    print(f"\nO1 aggregate ratio = {ratio:.6f} (threshold 0.001), worst 5: {worst}")
    assert ratio < 0.001, f"O1 실패: {ratio:.6f} >= 0.001, worst: {worst}"


# ---------- redirect ----------

@pytest.mark.parametrize("p", REDIRECTS, ids=lambda p: p.name)
def test_redirect_detected(p):
    clean, is_redirect, target = strip_namumark(read(p))
    assert is_redirect is True
    assert target
    assert clean == ""


@pytest.mark.parametrize("p", DOCS, ids=lambda p: p.name)
def test_content_doc_not_redirect(p):
    _, is_redirect, target = strip_namumark(read(p))
    assert is_redirect is False
    assert target is None


# ---------- 명세 §2 처리 규칙 단위 테스트 ----------

def test_redirect_line_parsing():
    assert strip_namumark("#redirect 대한민국") == ("", True, "대한민국")
    assert strip_namumark("#넘겨주기 리그 오브 레전드") == ("", True, "리그 오브 레전드")
    assert strip_namumark("#redirect [[세종(조선)]]") == ("", True, "세종(조선)")


def test_folding_block_removed_but_inner_text_kept():
    src = "앞\n{{{#!folding [ 펼치기 · 접기 ]\n숨은 내용\n}}}\n뒤"
    clean, _, _ = strip_namumark(src)
    assert "숨은 내용" in clean
    assert "{{{" not in clean and "folding" not in clean and "펼치기" not in clean


def test_nested_wiki_block():
    src = "{{{#!wiki style=\"margin:0\"\n바깥 {{{#!wiki style=\"x\"\n안쪽 [[링크]]\n}}} 텍스트\n}}}"
    clean, _, _ = strip_namumark(src)
    assert "바깥" in clean and "안쪽" in clean and "링크" in clean
    assert "{{{" not in clean and "style" not in clean


def test_table_rows_removed():
    src = "본문 시작\n|| 셀1 || 셀2 ||\n||<width=100> 셀3 ||\n본문 끝"
    clean, _, _ = strip_namumark(src)
    assert "||" not in clean
    assert "본문 시작" in clean and "본문 끝" in clean


def test_multiline_table_row_spanning_lines_removed():
    src = "앞\n|| 셀 시작\n계속되는 셀 내용\n마지막 줄 ||\n뒤"
    clean, _, _ = strip_namumark(src)
    assert "||" not in clean
    assert "앞" in clean and "뒤" in clean


def test_macros_and_footnotes_removed():
    src = "나이는 [age(1990-01-01)]세.[* 각주 안 [[링크]] 포함] [include(틀:상위 문서, top1=음악)] 끝 [각주]"
    clean, _, _ = strip_namumark(src)
    assert "age" not in clean and "include" not in clean and "각주" not in clean
    assert "[[" not in clean and "[" not in clean
    assert "나이는" in clean and "끝" in clean


def test_links_keep_display_text():
    src = "[[대상 문서|표시 텍스트]]와 [[그냥 링크]], [[파일:example.png|width=90]], [[분류:음악]], [[https://example.com|외부]]"
    clean, _, _ = strip_namumark(src)
    assert "표시 텍스트" in clean and "그냥 링크" in clean and "외부" in clean
    assert "대상 문서" not in clean
    assert "example.png" not in clean and "width" not in clean
    assert "분류" not in clean
    assert "[[" not in clean


def test_inline_emphasis_stripped():
    clean, _, _ = strip_namumark("'''굵게'''와 ''기울임'', __밑줄__, ~~취소~~, ^^윗첨자^^")
    for word in ("굵게", "기울임", "밑줄", "취소", "윗첨자"):
        assert word in clean
    assert "'''" not in clean and "~~" not in clean and "__" not in clean


def test_whitespace_collapsed():
    clean, _, _ = strip_namumark("가     나\n\n\n\n다")
    assert clean == "가 나\n\n다"


def test_empty_and_none_input():
    assert strip_namumark("") == ("", False, None)
    assert strip_namumark(None) == ("", False, None)
