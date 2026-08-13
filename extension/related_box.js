// related_box.js — 우측 사이드바 "연관 문서" 위젯 (v11 §4.9).
// manifest에서 common.js → content.js → reco_tab.js 다음에 로드.
//
// 현재 보고 있는 문서의 gold 샤드 이웃(top-10)을 "최근 변경" 위젯 바로 아래에
// 같은 디자인으로 표시한다. 설계 원칙은 추천 탭(§4.8)과 동일:
// - 발견: a.pathname === "/RecentChanges" 앵커에서 UL 행 목록을 가진 조상으로 상승
//   (상단 메뉴의 동일 href 앵커는 행 목록이 없어 자연 배제) — 클래스 하드코딩 금지
// - 룩: 위젯 박스 통째 deepClone → 헤더 텍스트·행 내용만 교체 (테마·빌드 자동 추종)
// - 데이터: sw.js get_related 메시징 (샤드 온디맨드 fetch + nbr_cache 편입)
// - 실패·미보유·비-/w/ 페이지: 박스 미표시 — 페이지 무영향

const RELATED_BOX_ID = "namu-reco-related";
const RELATED_POLL_MS = 1000;
const RELATED_TOP_N = 10;

const relatedBox = {
  // 사이드바 위젯 = /RecentChanges 앵커의 조상 중 ul li a(행 목록)를 가진 첫 요소
  findWidgetBox(anchors) {
    for (const a of anchors) {
      if (a.pathname !== "/RecentChanges") continue;
      let n = a.parentElement;
      for (let i = 0; i < 4 && n; i++) {
        if (n.querySelector && n.querySelector("ul li a")) return n;
        n = n.parentElement;
      }
    }
    return null;
  },

  // 샤드 엔트리 [["이웃제목", nbr_score, pr_pct], ...] → 표시 행
  rowData(entries, n = RELATED_TOP_N) {
    return entries.slice(0, n).map(([title]) => ({ title, href: docUrlOf(title) }));   // [J2]
  },
};

if (typeof document !== "undefined" && typeof chrome !== "undefined" && chrome.runtime) (() => {
  let orphaned = false;
  let timer = null;
  let warned = false;
  let lastTitle = null;

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
    const head = box.querySelector("a");
    if (head) {                                    // 헤더: 타이포 클래스는 유지, 내용만 교체
      while (head.firstChild) head.firstChild.remove();
      head.append(document.createTextNode("연관 문서"));
      head.removeAttribute("href");
      head.style.cursor = "default";
    }
    const ul = box.querySelector("ul");
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
    widget.parentElement.insertBefore(box, widget.nextSibling);   // "최근 변경 바로 밑"
    return box;
  };

  const refresh = () => {
    if (!chrome.runtime?.id) { stop(); return; }   // [K3]
    const title = globalThis.namuContent ? namuContent.viewTitleFor(location.pathname) : null;
    if (!title) {                                  // 대문·네임스페이스·비-/w/ — 박스 없음
      lastTitle = null;
      removeBox();
      return;
    }
    if (title === lastTitle && document.getElementById(RELATED_BOX_ID)) return;   // 변화 없음
    const widget = relatedBox.findWidgetBox([...document.querySelectorAll("a")]);
    if (!widget) {                                 // 사이드바 없음(좁은 화면 등) — 스킵
      if (!warned) { console.warn("namu-reco: 최근 변경 위젯 미발견 — 연관 문서 미표시"); warned = true; }
      removeBox();
      return;
    }
    lastTitle = title;                             // 응답 대기 중 재요청 방지
    try {
      chrome.runtime.sendMessage({ type: "get_related", title }, (entries) => {
        if (chrome.runtime.lastError) return;
        removeBox();
        const now = namuContent.viewTitleFor(location.pathname);
        if (now !== title) return;                 // 응답 전 전환 — 폐기
        if (!Array.isArray(entries) || !entries.length) return;   // 미보유 — 박스 없음
        build(widget, relatedBox.rowData(entries));
      });
    } catch (e) {
      stop();                                      // [K3]
    }
  };

  timer = setInterval(refresh, RELATED_POLL_MS);   // 전환 감지 + 재렌더 생존 겸용
  refresh();
})();

globalThis.relatedBox = relatedBox;
if (typeof module !== "undefined") {
  module.exports = { relatedBox };
}
