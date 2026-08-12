"""job 06 — 배포 (명세 §2 job 06 [G1·G12]). ⚠ 이 잡의 실행(push)은 사람이 결정한다.

1. [G12·H5] data/review/APPROVED 마커 검사 — 부재 시 raise. 내용 = 승인한 manifest
   version. 현재 gold의 version과 대조해 불일치 시에도 raise (승인 후 끼어든
   재빌드의 무검수 배포 차단).
2. [L1] publish_docs/README.md·PRIVACY.md 실존 검사 — 부재 시 raise (orphan force-push가
   배포 브랜치를 통째로 교체하므로, push 집합에서 빠지면 스토어 등록
   개인정보처리방침 URL({SHARD_BASE}/PRIVACY.md)이 그 배포부터 404 — 공시 불성립).
   gold(manifest.json·popular.json·nbr/) + publish_docs/ 문서(배포 브랜치 루트) +
   [I12] .nojekyll 을 push. data/review/는 push 대상이 아니다.
   [H11] push 방식 = orphan 브랜치 단일 커밋 force-push — 매 배포 수백MB blob이
   이력에 누적되어 저장소 한도(1GB)를 넘는 것을 차단 (Pages는 최신 커밋만 서빙).
3. push 완료 후 APPROVED 마커 삭제 — 승인은 빌드 1회분에만 유효.
4. [J13] 최초 배포(또는 호스팅 설정 변경) 후 1회 수동 확인:
     curl -sI {SHARD_BASE}/nbr/0000.json.gz   → Content-Encoding 헤더 **없음**
       (있으면 브라우저 투명 해제 + DecompressionStream 재해제로 전 샤드 실패
        → 전량 링크 폴백 침묵 강등)
     curl -sI {SHARD_BASE}/PRIVACY.md         → 200 [L1]
"""
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from conf import settings

ROOT = Path(__file__).resolve().parents[2]
PAGES_BRANCH = "gh-pages"   # SHARD_BASE(프로젝트 Pages)가 서빙하는 배포 브랜치


def push_commands(staging, branch, version, remote_url):
    """[H11] orphan 단일 커밋 force-push — 이력을 가져오지 않고 브랜치를 통째로 교체."""
    return [
        ["git", "init", "-q", str(staging)],
        ["git", "-C", str(staging), "add", "-A"],
        ["git", "-C", str(staging), "commit", "-q", "-m", f"deploy v{version}"],
        ["git", "-C", str(staging), "push", "--force", remote_url, f"HEAD:{branch}"],
    ]


def _git_pusher(staging, branch, version):
    remote_url = subprocess.run(
        ["git", "-C", str(ROOT), "remote", "get-url", "origin"],
        capture_output=True, check=True).stdout.decode().strip()
    for cmd in push_commands(staging, branch, version, remote_url):
        subprocess.run(cmd, check=True)


def run(gold_dir=None, review_dir=None, docs_dir=None, pusher=None):
    gold = Path(gold_dir if gold_dir is not None else settings.GOLD_DIR)
    review = Path(review_dir if review_dir is not None else settings.REVIEW_DIR)
    docs = Path(docs_dir if docs_dir is not None else ROOT / "publish_docs")

    marker = review / "APPROVED"
    if not marker.exists():                                    # [G12] 검수 미완료 push 금지
        raise FileNotFoundError(f"APPROVED 마커 부재 — O4(d) 검수 후 수동 생성: {marker}")
    manifest = json.loads((gold / "manifest.json").read_text(encoding="utf-8"))
    approved = marker.read_text(encoding="utf-8").strip()
    if approved != str(manifest["version"]):                   # [H5] 빌드에 바인딩
        raise ValueError(f"APPROVED version 불일치: 승인 {approved} ≠ gold {manifest['version']}"
                         " — 승인 후 재빌드가 끼어듦, 재검수 필요")
    for name in ("README.md", "PRIVACY.md"):                   # [L1] 실존 검사
        if not (docs / name).exists():
            raise FileNotFoundError(f"publish_docs/{name} 부재 — push 집합에서 빠지면 "
                                    f"다음 배포부터 서빙 소멸(공시 불성립)")

    staging = Path(tempfile.mkdtemp(prefix="namu_deploy_"))
    try:
        shutil.copy2(gold / "manifest.json", staging / "manifest.json")
        shutil.copy2(gold / "popular.json", staging / "popular.json")
        shutil.copytree(gold / "nbr", staging / "nbr")
        for doc in docs.iterdir():                             # [L1] 배포 브랜치 루트에 배치
            if doc.is_file():
                shutil.copy2(doc, staging / doc.name)
        (staging / ".nojekyll").touch()                        # [I12] Jekyll 빌드 회피
        (pusher or _git_pusher)(staging, PAGES_BRANCH, manifest["version"])
    finally:
        shutil.rmtree(staging, ignore_errors=True)

    marker.unlink()                                            # 승인은 빌드 1회분에만 유효
    print(f"deployed v{manifest['version']} → {PAGES_BRANCH}. "
          f"[J13] 최초 배포라면 Content-Encoding 부재와 PRIVACY.md 200을 curl로 확인할 것")
    return manifest["version"]


if __name__ == "__main__":
    run()
