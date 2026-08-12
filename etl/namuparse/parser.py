"""NamuMark → 순수 텍스트. 순수 Python — Spark 없이 pytest 가능 (명세 §1).

처리 순서는 명세 §2 job 01 준수 (중첩 문법 때문에 순서 변경 금지):
redirect → {{{}}} 블록(깊이 스캐너) → 표/각주/매크로 → 링크/강조 → 공백 정리.
"""
import re

_REDIRECT_RE = re.compile(r"^\s*#(?:redirect|넘겨주기)[ \t]+(\S[^\n]*)", re.IGNORECASE)
_LINK_RE = re.compile(r"\[\[([^\]|]*?)(?:\|(.*?))?\]\]", re.DOTALL)
_MACRO_HEAD_RE = re.compile(r"[a-zA-Z가-힣0-9_]+")
_BRACE_HEADER_RE = re.compile(r"^(?:[+\-][1-5]|#[0-9a-fA-F]{3,8}|#[a-zA-Z]+)[ \t]+")


def strip_namumark(text):
    if not text:
        return "", False, None

    m = _REDIRECT_RE.match(text)
    if m:
        return "", True, _redirect_target(m.group(1))

    t = _strip_braces(text)
    t = re.sub(r"^##[^\n]*$", "", t, flags=re.M)          # 주석 줄
    t = _strip_tables(t)                                   # 표 행 (여러 줄 셀 포함)
    t = _strip_bracket_spans(t)                            # [* 각주], [매크로] — 중첩 대괄호 안전
    t = _LINK_RE.sub(_link_repl, t)                        # [[대상|표시]]
    t = re.sub(r"'''|''|~~|__|\^\^|,,", "", t)             # 인라인 강조
    t = re.sub(r"^[ \t]*=+#?[ \t]*(.*?)[ \t]*#?=+[ \t]*$", r"\1", t, flags=re.M)  # 헤더
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r" ?\n ?", "\n", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t.strip(), False, None


def _redirect_target(s):
    s = s.strip()
    m = re.match(r"\[\[([^\]|]+)", s)   # "#redirect [[문서]]" 형태 허용
    return (m.group(1) if m else s).strip()


def _strip_braces(text):
    """{{{...}}} 중첩 블록 제거, 내부 평문 보존 (깊이 카운팅 — 정규식 불가)."""
    out, i, n = [], 0, len(text)
    while i < n:
        if text.startswith("{{{", i):
            j = _matching_close(text, i + 3)
            inner = _brace_inner(text[i + 3 : j])
            out.append(_strip_braces(inner))
            i = j + 3
        else:
            out.append(text[i])
            i += 1
    return "".join(out)


def _matching_close(text, start):
    depth, i, n = 1, start, len(text)
    while i < n:
        if text.startswith("{{{", i):
            depth += 1
            i += 3
        elif text.startswith("}}}", i):
            depth -= 1
            if depth == 0:
                return i
            i += 3
        else:
            i += 1
    return n  # 짝 안 맞는 원문 — 문서 끝까지를 블록으로 간주


def _brace_inner(body):
    """블록 헤더 제거: #!wiki/#!folding/#!syntax 등은 첫 줄, 크기/색상은 첫 토큰."""
    if body.startswith("#!"):
        return body.partition("\n")[2]
    m = _BRACE_HEADER_RE.match(body)
    if m:
        return body[m.end():]
    return body  # {{{리터럴}}} — 그대로 보존


def _strip_tables(text):
    """||로 시작하는 표 행 제거. 셀이 여러 줄로 이어지면 줄 끝 ||가 닫을 때까지 제거."""
    lines = text.split("\n")
    out, i, n = [], 0, len(lines)
    while i < n:
        s = lines[i].strip()
        if s.startswith("||"):
            if s.endswith("||") and len(s) > 2:
                i += 1                     # 한 줄에서 닫힌 행
                continue
            j = i + 1
            while j < n and not lines[j].rstrip().endswith("||"):
                j += 1
            i = j + 1 if j < n else i + 1  # 닫힘을 못 찾으면 이 줄만 제거 (문서 잔여 보호)
            continue
        out.append(lines[i])
        i += 1
    return "\n".join(out)


def _strip_bracket_spans(text):
    """[* 각주]와 [include(...)] 등 매크로 제거. 내부 [[링크]] 중첩 때문에 깊이 스캔."""
    out, i, n = [], 0, len(text)
    while i < n:
        c = text[i]
        if c == "[" and not text.startswith("[[", i) and (i == 0 or text[i - 1] != "["):
            is_footnote = text.startswith("[*", i)
            m = _MACRO_HEAD_RE.match(text, i + 1)
            is_macro = m is not None and m.end() < n and text[m.end()] in "(]"
            if is_footnote or is_macro:
                name = m.group().lower() if m else ""
                depth, j = 1, i + 1
                while j < n and depth:
                    if text[j] == "[":
                        depth += 1
                    elif text[j] == "]":
                        depth -= 1
                    j += 1
                out.append("\n" if name == "br" else "")
                i = j
                continue
        out.append(c)
        i += 1
    return "".join(out)


def _link_repl(m):
    target = m.group(1).strip()
    display = m.group(2)
    if target.startswith(("파일:", "분류:")):
        return ""                       # 이미지 파라미터/메타데이터는 본문 아님
    if "://" in target:
        return (display or "").strip()  # 외부 URL 자체는 본문 아님
    return (display if display is not None else target).strip()
