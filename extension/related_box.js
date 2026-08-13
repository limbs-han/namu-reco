// related_box.js — 우측 사이드바 "연관 문서" 위젯 (v11 §4.9, v0.5.0 개정).
// manifest에서 common.js → content.js → reco_tab.js 다음에 로드.
//
// 현재 문서의 **본문 내부 링크**(content.js와 동일 수집기 — namuContent 전역)를
// "최근 변경" 위젯 바로 아래에 같은 디자인으로 표시한다. v0.4.x의 샤드 이웃
// 방식에서 교체(사용자 결정): 기존·신설 문서가 동일하게 동작하고, SW 왕복·
// 네트워크 fetch가 전혀 없어 완전 오프라인이다.
// - 발견: a.pathname === "/RecentChanges" 앵커의 부모(±1) 중 직계 UL 행 목록 보유
//   (페이지 래퍼 오인 방지 — 회귀 테스트) — 클래스 하드코딩 금지
// - 룩: 위젯 박스 통째 deepClone → 헤더 텍스트·행 내용만 교체 (테마·빌드 자동 추종)
// - SPA 주의: URL이 DOM보다 먼저 바뀌므로 제목 1틱 디바운스 후 수집 (오귀속 방지,
//   [J3]과 같은 원리)
// - 링크 없는 문서·비-/w/·네임스페이스·위젯 미발견: 박스 미표시 — 페이지 무영향

const RELATED_BOX_ID = "namu-reco-related";
const RELATED_POLL_MS = 1000;
const RELATED_TOP_N = 10;

const relatedBox = {
  // 사이드바 위젯 = /RecentChanges 앵커의 부모(±1단계) 중 **직계 UL 행 목록**
  // (:scope > ul > li > a, /w/ 행 3개 이상)을 가진 박스. 실측 구조: 박스 = [헤더A, UL].
  // 얕은 상승 + 직계 조건이어야 함 — 깊은 상승("어딘가에 ul li a")은 상단 메뉴 앵커의
  // 조상인 페이지 전체 래퍼를 위젯으로 오인해 페이지 통째 clone 사고를 낸다(회귀 테스트).
  findWidgetBox(anchors) {
    for (const a of anchors) {
      if (a.pathname !== "/RecentChanges") continue;
      let box = a.parentElement;
      for (let i = 0; i < 2 && box; i++) {
        if (box.querySelectorAll) {
          const rows = [...box.querySelectorAll(":scope > ul > li > a")];
          if (rows.length >= 3 &&
              rows.some((r) => typeof r.pathname === "string" && r.pathname.startsWith("/w/"))) {
            return box;
          }
        }
        box = box.parentElement;
      }
    }
    return null;
  },

  // 본문 링크 배열 → 표시 행. 자기 자신(목차 앵커 유래) 제외, 상위 n개.
  rowData(links, selfTitle, n = RELATED_TOP_N) {
    return links.filter((t) => t !== selfTitle).slice(0, n)
      .map((title) => ({ title, href: docUrlOf(title) }));   // [J2]
  },
};

if (typeof document !== "undefined" && typeof chrome !== "undefined" && chrome.runtime) (() => {
  let orphaned = false;
  let timer = null;
  let warned = false;
  let lastTitle = null;
  let pendingTitle = null;                         // 1틱 디바운스 — DOM 렌더 대기
  let retry = { title: null, left: 0 };            // 빈 수집 재시도 예산 (문서당 5회)

  const stop = () => {
    if (orphaned) return;
    orphaned = true;
    clearInterval(timer);
    document.getElementById(RELATED_BOX_ID)?.remove();
    console.warn("namu-reco: 연관 문서 위젯 정지 (extension context invalidated)");
  };

  const removeBox = () => document.getElementById(RELATED_BOX_ID)?.remove();

  const build = (widget, rows) => {
    const box = widget.cloneNode(true);            // 리스너 미복사 — 유령 내비 없음
    box.id = RELATED_BOX_ID;
    box.style.marginTop = "14px";
    // 위젯 부속물 제거 — 자동 새로고침 진행바(회색 바) 등 헤더·목록 외 요소는
    // 클론에 딸려오면 죽은 채 남는다. 직계 자식은 헤더 A + UL만 유지(화이트리스트).
    const head = [...box.children].find((c) => c.tagName === "A");
    const ul = [...box.children].find((c) => c.tagName === "UL");
    for (const child of [...box.children]) {
      if (child !== head && child !== ul) child.remove();
    }
    box.querySelectorAll("progress, [role=progressbar]").forEach((el) => el.remove());
    if (head) {                                    // 헤더: 타이포 클래스는 유지, 내용만 교체
      while (head.firstChild) head.firstChild.remove();
      head.append(document.createTextNode("연관 문서"));
      head.removeAttribute("href");
      head.style.cursor = "default";
    }
    const tpl = ul && ul.querySelector("li");
    if (!ul || !tpl) return null;                  // 구조 상이 — 표시 포기
    const blank = tpl.cloneNode(true);
    while (ul.firstChild) ul.firstChild.remove();
    for (const r of rows) {
      const li = blank.cloneNode(true);
      const a = li.querySelector("a");
      if (!a) continue;
      a.href = r.href;
      a.title = r.title;
      a.querySelector("time")?.remove();           // 시각 자리 제거 (연관도엔 불필요)
      const label = a.querySelector("span") || a;
      label.textContent = r.title;
      ul.append(li);
    }
    // 스크롤 추종(사용자 요구): 레일이 본문 전체 높이(실측 50,762px·flex·overflow
    // visible)라 sticky가 성립한다. 고정 헤더 없음 → top 12px. 사이트 위젯과 같은
    // 마크업이라 이질감 없음 — 최근 변경은 스크롤에 밀려 올라가고 이 박스만 남아 따라온다.
    Object.assign(box.style, { position: "sticky", top: "12px" });
    widget.parentElement.insertBefore(box, widget.nextSibling);   // "최근 변경 바로 밑"
    return box;
  };

  const refresh = () => {
    if (!chrome.runtime?.id) { stop(); return; }   // [K3] — 타이머 정리용 (네트워크·메시징 없음)
    const title = globalThis.namuContent ? namuContent.viewTitleFor(location.pathname) : null;
    if (!title) {                                  // 대문·네임스페이스·비-/w/ — 박스 없음
      lastTitle = null;
      pendingTitle = null;
      removeBox();
      return;
    }
    if (title === lastTitle && document.getElementById(RELATED_BOX_ID)) return;   // 변화 없음
    if (title !== pendingTitle) {                  // 제목이 방금 바뀜 — DOM 렌더를 1틱 대기
      pendingTitle = title;                        // (URL이 DOM보다 먼저 바뀌는 SPA 특성)
      return;
    }
    const widget = relatedBox.findWidgetBox([...document.querySelectorAll("a")]);
    if (!widget) {                                 // 사이드바 없음(좁은 화면 등) — 스킵
      if (!warned) { console.warn("namu-reco: 최근 변경 위젯 미발견 — 연관 문서 미표시"); warned = true; }
      removeBox();
      return;
    }
    if (title !== retry.title) retry = { title, left: 5 };   // 새 문서 — 재시도 예산 리셋
    const links = namuContent.collectLinks(namuContent.findContentRoot(document));
    const rows = links ? relatedBox.rowData(links, title) : [];
    removeBox();
    if (!rows.length) {                            // 본문 미렌더·링크 없는 문서
      if (retry.left > 0) retry.left--;            // lastTitle 미설정 → 다음 틱 재수집
      else lastTitle = title;                      // 예산 소진 — 이 문서는 미표시 확정
      return;
    }
    lastTitle = title;
    build(widget, rows);
  };

  timer = setInterval(refresh, RELATED_POLL_MS);   // 전환 감지 + 재렌더 생존 겸용
  refresh();
})();

globalThis.relatedBox = relatedBox;
if (typeof module !== "undefined") {
  module.exports = { relatedBox };
}
