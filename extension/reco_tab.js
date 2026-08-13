// reco_tab.js — 상단 메뉴 "추천 문서" 드롭다운 (v11 §4.8).
// manifest에서 common.js → content.js 다음에 로드. 수집 로직(content.js)과 분리.
//
// 설계(docs/design_reco_tab_v11.md) 요지:
// - 발견은 a.pathname === "/RecentChanges" 기준 (난독화 클래스 하드코딩 금지)
// - 탭 룩은 이웃 메뉴 노드 deepClone으로 상속 (테마·빌드 변화에 자동 추종)
// - 패널은 특수 기능 드롭다운 실측 스타일(2026-08-12)을 JS style로 재현 (CSP 안전)
// - 미발견·실패는 조용히 스킵 — 페이지 무영향, 팝업이 폴백 UI
// - 데이터는 sw.js 메시징(get_recommendations) — IndexedDB는 origin별이라 직접 접근 불가

const TAB_ID = "namu-reco-tab";
const PANEL_ID = "namu-reco-panel";
const RECHECK_MS = 1000;              // SPA 재렌더 생존: 존재 확인 후 재주입

const recoTab = {
  // 메뉴 컨테이너 = "최근 변경"(/RecentChanges) 앵커의 부모. 사이트 변형 대비
  // /RecentDiscuss 폴백. 미발견 시 null (좁은 창의 반응형 헤더는 메뉴 자체가 숨음).
  findMenuContainer(anchors) {
    for (const path of ["/RecentChanges", "/RecentDiscuss"]) {
      for (const a of anchors) {
        if (a.pathname === path) return a.parentElement || null;
      }
    }
    return null;
  },

  reasonText(row) {                   // §4.7 [J8] 문구 규칙 재사용
    return row.reason_title
      ? `「${row.reason_title}」를 오래 읽으셔서`
      : (row.source === "popular" ? "인기 문서" : "");
  },

  isDarkBg(bg) {                      // body 배경 밝기로 테마 판별 (투명·미상은 라이트)
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(bg || "");
    if (!m) return false;
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return false;
    const [r, g, b] = [m[1], m[2], m[3]].map(Number);
    return 0.299 * r + 0.587 * g + 0.114 * b < 128;
  },

  itemHref(title) {                   // [J2] 단일 진실원
    return docUrlOf(title);
  },
};

if (typeof document !== "undefined" && typeof chrome !== "undefined" && chrome.runtime) (() => {
  let orphaned = false;
  let timer = null;
  let warned = false;

  const dark = () => recoTab.isDarkBg(getComputedStyle(document.body).backgroundColor);

  // 특수 기능 패널 실측값(라이트) + 다크 근사 — E15에서 다크 실측 확인
  const palette = () => dark()
    ? { bg: "rgb(38, 41, 43)", border: "1px solid rgba(255,255,255,.18)",
        color: "rgb(224, 226, 228)", sub: "rgb(150, 155, 160)" }
    : { bg: "rgb(255, 255, 255)", border: "1px solid rgb(206, 212, 218)",
        color: "rgb(33, 37, 41)", sub: "rgb(120, 128, 136)" };

  const closePanel = () => document.getElementById(PANEL_ID)?.remove();

  const renderPanel = (wrapper, rows) => {
    closePanel();
    const p = palette();
    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    Object.assign(panel.style, {                     // 실측 재현 (설계 §D2 표)
      position: "absolute", top: "100%", right: "0", zIndex: "520",
      minWidth: "220px", maxWidth: "300px", padding: "4px 0",
      background: p.bg, border: p.border, borderRadius: "6px",
      boxShadow: "0 10px 15px -3px rgba(0,0,0,.165), 0 4px 6px -4px rgba(0,0,0,.165)",
      maxHeight: "70vh", overflowY: "auto", textAlign: "left",
    });
    if (!rows.length) {
      const empty = document.createElement("div");
      empty.textContent = "아직 추천이 없어요 — 나무위키를 둘러보면 몇 분 안에 채워집니다";
      Object.assign(empty.style, { padding: "10px 12px", fontSize: "13px", color: p.sub });
      panel.append(empty);
    }
    for (const r of rows) {
      const a = document.createElement("a");
      a.href = recoTab.itemHref(r.title);            // 일반 앵커 — 이동이 곧 새 view 수집
      Object.assign(a.style, {                       // 항목 실측: 6px 12px / 15px / flex
        display: "flex", flexDirection: "column", padding: "6px 12px",
        fontSize: "15px", color: p.color, textDecoration: "none", lineHeight: "1.35",
      });
      a.textContent = r.title;
      const why = recoTab.reasonText(r);
      if (why) {
        const sub = document.createElement("span");
        sub.textContent = why;
        Object.assign(sub.style, { fontSize: "10.5px", color: p.sub, marginTop: "1px" });
        a.append(sub);
      }
      a.addEventListener("mouseenter", () => { a.style.background = dark() ? "rgba(255,255,255,.06)" : "rgba(0,0,0,.045)"; });
      a.addEventListener("mouseleave", () => { a.style.background = "transparent"; });
      panel.append(a);
    }
    wrapper.append(panel);
  };

  const togglePanel = (wrapper) => {
    if (document.getElementById(PANEL_ID)) { closePanel(); return; }
    if (!chrome.runtime?.id) { stop(); return; }     // [K3] 고아 선판정
    try {
      chrome.runtime.sendMessage({ type: "get_recommendations" }, (rows) => {
        if (chrome.runtime.lastError) return;        // SW 기동 실패 등 — 조용히 스킵
        renderPanel(wrapper, Array.isArray(rows) ? rows : []);
      });
    } catch (e) {
      stop();                                        // [K3] 고아 — 정지
    }
  };

  const stop = () => {
    if (orphaned) return;
    orphaned = true;
    clearInterval(timer);
    closePanel();
    document.getElementById(TAB_ID)?.remove();
    console.warn("namu-reco: 추천 탭 정지 (extension context invalidated)");
  };

  const inject = () => {
    const container = recoTab.findMenuContainer([...document.querySelectorAll("a")]);
    if (!container) {                                // 미발견(개편·모바일) — 조용히 스킵
      if (!warned) { console.warn("namu-reco: 메뉴바 미발견 — 탭 미표시(팝업 사용)"); warned = true; }
      return;
    }
    // 템플릿: 마지막 자식(특수 기능 래퍼 DIV — 드롭다운 구조·화살표까지 상속)
    // 없으면 "최근 변경" 앵커 자체를 복제
    const template = container.lastElementChild || container.firstElementChild;
    if (!template) return;
    const root = template.cloneNode(true);           // 리스너는 복사되지 않음 — 유령 내비 없음
    root.id = TAB_ID;
    const toggle = root.tagName === "A" ? root : (root.querySelector("a") || root);
    toggle.removeAttribute("href");
    toggle.style.cursor = "pointer";
    // 복제로 딸려온 특수 기능 아이콘(svg)은 제거하고 종이 두 장 이모지로 교체
    root.querySelectorAll("svg").forEach((el) => el.remove());
    const label = root.querySelector("span") || toggle;
    label.textContent = "📑 추천 문서";
    if (getComputedStyle(template).position === "static") root.style.position = "relative";
    toggle.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePanel(root);
    });
    container.append(root);
  };

  document.addEventListener("click", (e) => {        // 바깥 클릭 시 닫힘
    const tab = document.getElementById(TAB_ID);
    if (tab && !tab.contains(e.target)) closePanel();
  });

  timer = setInterval(() => {                        // 재렌더 생존: O(1) 존재 확인
    if (!chrome.runtime?.id) { stop(); return; }     // [K3]
    if (!document.getElementById(TAB_ID)) inject();
  }, RECHECK_MS);
  inject();
})();

globalThis.recoTab = recoTab;
if (typeof module !== "undefined") {
  module.exports = { recoTab };
}
