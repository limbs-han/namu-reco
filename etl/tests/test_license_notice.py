"""V-09: fixtures 원문(나무위키 실문서 30건) 출처·라이선스 고지 존재 검증 (명세 §0)."""
from pathlib import Path

NOTICE = Path(__file__).parent / "fixtures" / "README.md"


def test_fixtures_have_license_notice():
    assert NOTICE.exists(), "fixtures 출처·라이선스 고지 문서(README.md) 없음"
    text = NOTICE.read_text(encoding="utf-8")
    assert "나무위키" in text                      # 출처 표시
    assert "CC BY-NC-SA 2.0 KR" in text            # 라이선스 명시
    assert "namu.wiki" in text                     # 원문 연결(저작자 표시)
