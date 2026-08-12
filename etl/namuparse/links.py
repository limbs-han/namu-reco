"""문서 내 하이퍼링크 대상 추출 (명세 §2 job 01). 순수 Python."""
import re
import unicodedata

_TARGET_RE = re.compile(r"\[\[([^|\]#]+)")


def _targets(text):
    for m in _TARGET_RE.finditer(text or ""):
        yield unicodedata.normalize("NFC", m.group(1)).strip()


def extract_links(text):
    return [t for t in _targets(text)
            if t and not t.startswith(("파일:", "분류:")) and "://" not in t]


def extract_categories(text):
    # 명세 §2 [N2]: NFC 정규화·trim·중복 제거
    names = (t[len("분류:"):].strip() for t in _targets(text) if t.startswith("분류:"))
    return list(dict.fromkeys(n for n in names if n))
