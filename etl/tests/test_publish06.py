"""job 06 (배포) — 코드 검증만. 실제 push는 절대 수행하지 않는다(가짜 pusher 주입).

- [G12·H5] APPROVED 마커 부재/version 불일치 시 raise, push 후 마커 삭제
- [L1] publish_docs/README.md·PRIVACY.md 실존 검사 — 부재 시 raise
- [H11] orphan 단일 커밋 force-push 커맨드 구성 (배포 브랜치 통째 교체)
- [I12] 커밋에 .nojekyll 포함, data/review/는 push 집합이 아님
"""
import importlib.util
import json
import sys
from pathlib import Path

import pytest

ETL = Path(__file__).resolve().parents[1]
ROOT = ETL.parent
sys.path.insert(0, str(ETL))


def _load():
    spec = importlib.util.spec_from_file_location("job06", ETL / "jobs" / "06_publish.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def env(tmp_path):
    gold = tmp_path / "gold"
    (gold / "nbr").mkdir(parents=True)
    (gold / "nbr" / "0000.json.gz").write_bytes(b"\x1f\x8b_fake")
    (gold / "manifest.json").write_text(
        json.dumps({"version": 1754990000, "shards": 1024}), encoding="utf-8")
    (gold / "popular.json").write_text("[]", encoding="utf-8")
    review = tmp_path / "review"
    review.mkdir()
    (review / "APPROVED").write_text("1754990000", encoding="utf-8")   # [H5] 내용 = version
    docs = tmp_path / "publish_docs"
    docs.mkdir()
    for name in ("README.md", "PRIVACY.md", "LICENSE"):
        (docs / name).write_text(f"{name} 내용", encoding="utf-8")
    return {"gold": gold, "review": review, "docs": docs}


def test_raises_without_approved_marker(env):
    job06 = _load()
    (env["review"] / "APPROVED").unlink()
    calls = []
    with pytest.raises(Exception, match="APPROVED"):
        job06.run(env["gold"], env["review"], env["docs"], pusher=lambda *a: calls.append(a))
    assert not calls                                # 검수 없는 push 시도조차 없음


def test_raises_on_version_mismatch(env):
    job06 = _load()
    (env["review"] / "APPROVED").write_text("999", encoding="utf-8")   # 승인 후 재빌드 모사
    calls = []
    with pytest.raises(Exception, match="version"):
        job06.run(env["gold"], env["review"], env["docs"], pusher=lambda *a: calls.append(a))
    assert not calls
    assert (env["review"] / "APPROVED").exists()    # 실패 시 마커 보존


@pytest.mark.parametrize("missing", ["README.md", "PRIVACY.md"])
def test_raises_when_publish_doc_missing(env, missing):
    job06 = _load()
    (env["docs"] / missing).unlink()                # [L1] 서빙 소멸 차단
    with pytest.raises(Exception, match=missing):
        job06.run(env["gold"], env["review"], env["docs"], pusher=lambda *a: None)


def test_staging_set_and_marker_lifecycle(env):
    job06 = _load()
    seen = {}

    def fake_pusher(staging, branch, version):
        staging = Path(staging)
        seen["files"] = sorted(str(p.relative_to(staging)).replace("\\", "/")
                               for p in staging.rglob("*") if p.is_file())
        seen["branch"] = branch
        seen["version"] = version

    job06.run(env["gold"], env["review"], env["docs"], pusher=fake_pusher)

    assert seen["files"] == [".nojekyll", "LICENSE", "PRIVACY.md", "README.md",
                             "manifest.json", "nbr/0000.json.gz", "popular.json"]
    assert seen["branch"] == "gh-pages"             # 배포 브랜치 루트에 문서 배치 [L1]
    assert seen["version"] == 1754990000
    assert not (env["review"] / "APPROVED").exists()   # push 후 삭제 — 승인은 1회분


def test_orphan_force_push_command_shape(env):
    """[H11] 실행 없이 커맨드 구성만 검증 — git init→add→commit→push --force HEAD:branch."""
    job06 = _load()
    cmds = []
    job06.run(env["gold"], env["review"], env["docs"],
              pusher=lambda s, b, v: cmds.extend(job06.push_commands(s, b, v, "URL")))
    joined = [" ".join(c) for c in cmds]
    assert any("init" in c for c in joined)
    assert any("--force" in c and "HEAD:gh-pages" in c and "URL" in c for c in joined)
    assert not any("pull" in c or "fetch" in c for c in joined)   # 이력 미보존 — 단일 커밋 교체


# ---------- 저장소 실물 publish_docs — 배포 게이트가 실패하지 않도록 [L1·J9·M9·J7·L2] ----------

def test_repo_publish_docs_exist_with_required_clauses():
    docs = ROOT / "publish_docs"
    readme = (docs / "README.md").read_text(encoding="utf-8")
    privacy = (docs / "PRIVACY.md").read_text(encoding="utf-8")
    assert (docs / "LICENSE").exists()
    # [J9] SA 선언 — 출처 고지만으로는 부족
    assert "CC BY-NC-SA 2.0 KR" in readme and "나무위키" in readme
    # [J7] 보존기간 + [L2] 내부 링크 수집 문구 — 공시 범주(Website content)와 일치
    assert "90일" in privacy
    assert "내부 링크" in privacy
    assert "외부" in privacy and "전송" in privacy
