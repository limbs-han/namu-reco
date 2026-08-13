// content.js — namu.wiki 체류 측정 + 본문 링크 수집 (명세 §4.2). 데이터는 기기 밖으로 안 나감.
// manifest에서 common.js가 앞서 로드된다 [N1·F4] — isNamespace 등은 거기서만 온다(인라인 금지).
// 순수 로직은 namuContent 객체에 두고, DOM·chrome 배선은 아래 가드 블록에만 둔다(node 테스트용).

const POLL_MS = 1000;                 // [M4] 문서 전환 감지 = 1초 주기 URL 폴링 (pushState 후킹 금지)
const HEARTBEAT_MS = 30 * 1000;       // [B3] 30초 heartbeat
const CLIP_MS = 30 * 60 * 1000;       // §4.2 dwell 상한 30분 클리핑
const MAX_LINKS = 40;                 // [J4] links 상한
// [J4] 본문 컨테이너 식별 상수 — 실DOM은 클래스명이 빌드마다 난독화되어 래퍼 셀렉터가 불안정.
//      섹션 앵커 id(s-1, s-2…)는 URL 프래그먼트라 안정적이므로, 이 앵커들의 최소 공통
//      조상을 본문 래퍼로 확정한다. 미발견 시 수집 skip (오염보다 결손 [J4]).
const CONTENT_ANCHOR_SELECTOR = 'a[id^="s-"]';

const namuContent = {
  // [G11·I1·H9] title 파생 — 유일한 원천은 URL pathname. null이면 그 URL에서 view 없음.
  deriveTitle(pathname) {
    if (!pathname.startsWith("/w/")) return null;              // [I1] 대문(/)·검색 등 제외
    try {
      return decodeURIComponent(pathname.replace(/^\/w\//, "")).normalize("NFC");
    } catch (e) {
      return null;                    // [H9] URIError — 이 URL 무시, 폴링·전환 감지는 계속
    }
  },

  // [N1] 네임스페이스 문서는 view 세션 자체를 시작하지 않는다
  viewTitleFor(pathname) {
    const t = namuContent.deriveTitle(pathname);
    return t && !isNamespace(t) ? t : null;
  },

  // [J4] 본문 래퍼 = 섹션 앵커들의 최소 공통 조상. 2개 미만이면 식별 불가 → null
  findContentRoot(doc) {
    const anchors = [...doc.querySelectorAll(CONTENT_ANCHOR_SELECTOR)];
    if (anchors.length < 2) return null;
    let lca = anchors[0];
    for (const el of anchors) {
      while (lca && !lca.contains(el)) lca = lca.parentElement;
    }
    return lca;
  },

  // [J4·H3·I12] 본문 컨테이너 한정 links 수집 — root 미발견(null)이면 null 반환(수집 skip 신호).
  // 후보 선별·제목 파생 모두 앵커 pathname 프로퍼티 기준 — href 문자열 파싱 금지 [H3·I12].
  // v0.6.0 [M1]: 출현 빈도 내림차순 상위 MAX_LINKS. 둘러보기 틀·정보상자(<table> 내부)
  // 앵커는 제외 — 틀 링크(각 1회 등장)가 DOM 순서만으로 상위를 점령하던 오염 차단.
  collectLinks(root) {
    if (!root) return null;
    const count = new Map();                   // 삽입 순서 = 본문 첫 등장 순서 (동률 tiebreak)
    for (const a of root.querySelectorAll("a")) {
      const p = a.pathname;
      if (typeof p !== "string" || !p.startsWith("/w/")) continue;
      if (a.closest && a.closest("table")) continue;   // [M1] 시맨틱 태그 판정 — 난독화 클래스 금지
      let t;
      try {
        t = decodeURIComponent(p.replace(/^\/w\//, "")).normalize("NFC");
      } catch (e) {
        continue;                              // URIError 앵커는 건너뜀 [H3]
      }
      if (t && !isNamespace(t)) count.set(t, (count.get(t) || 0) + 1);   // [N1] 네임스페이스 제외
    }
    return [...count.keys()]
      .sort((x, y) => count.get(y) - count.get(x))   // 빈도 내림차순 — Array.sort는 안정 정렬
      .slice(0, MAX_LINKS);
  },
};

if (typeof document !== "undefined" && typeof chrome !== "undefined" && chrome.runtime) (() => {
  let orphaned = false;
  let pollTimer = null;
  let hbTimer = null;
  let view = null;                    // { id, title, ts, accum, visibleSince, links }
  let lastPath = location.pathname;

  const visibleNow = () => document.visibilityState === "visible" && document.hasFocus();
  const settle = () => {
    if (view && view.visibleSince !== null) {
      view.accum += Date.now() - view.visibleSince;   // 가시 상태 구간만 누적 §4.2
      view.visibleSince = null;
    }
  };
  const resume = () => {
    if (view && view.visibleSince === null && visibleNow()) view.visibleSince = Date.now();
  };

  const orphanStop = () => {          // [K3] 고아 판정 → 타이머 전부 정리·수집 정지
    if (orphaned) return;
    orphaned = true;
    clearInterval(pollTimer);
    clearInterval(hbTimer);
    view = null;
    console.warn("namu-reco: extension context invalidated — 이 탭 수집 정지 (새로고침 시 재개)");
  };

  const send = (ended) => {           // [K3] 모든 sendMessage는 try/catch
    if (!view || orphaned) return;
    if (!chrome.runtime?.id) { orphanStop(); return; }   // throw 이전 선판정 [K3]
    settle();
    try {
      chrome.runtime.sendMessage({
        type: "view",
        view_id: view.id,
        ts: view.ts,                  // view 시작 시각 (불변) [B3]
        title: view.title,
        dwell_ms: Math.min(view.accum, CLIP_MS),   // 누적, 30분 클리핑
        links: view.links,            // [H7] referrer_title 없음 — 소비처 없는 수집 금지
        ended: ended ? 1 : 0,
      });
    } catch (e) {
      orphanStop();
      return;
    }
    if (!ended) resume();
  };

  // [J3] links 스냅숏 재수집 — view 시작 직후·heartbeat·pagehide 직전.
  //      컨테이너 미발견이면 직전 스냅숏 유지(수집 skip). 경고는 view당 1회 —
  //      SPA 렌더 지연·섹션 없는 짧은 문서에서 매 시점 도배 방지.
  const recollect = () => {
    if (!view) return;
    const links = namuContent.collectLinks(namuContent.findContentRoot(document));
    if (links === null) {
      if (!view.warnedLinks) {
        console.warn("namu-reco: 본문 컨테이너 미발견 — links 수집 skip");
        view.warnedLinks = true;
      }
    } else {
      view.links = links;
    }
  };

  const startView = () => {
    const title = namuContent.viewTitleFor(location.pathname);
    if (!title) return;               // [I1·N1·H9] view 대상 아님 — 이벤트 0건
    view = {
      id: crypto.randomUUID(),        // [B3] (Chrome 92+ [J12])
      title,
      ts: Date.now(),
      accum: 0,
      visibleSince: visibleNow() ? Date.now() : null,
      links: [],
    };
    recollect();                      // [J3] 시작 직후 스냅숏 (SPA 렌더 지연 시 다음 heartbeat가 채움)
  };

  const endView = (recollectFirst) => {
    if (!view) return;
    if (recollectFirst) recollect();  // pagehide 경로만 — 소프트 전환은 재수집 금지 [J3]
    send(true);
    view = null;
  };

  document.addEventListener("visibilitychange",
    () => (document.visibilityState === "visible" ? resume() : settle()));
  window.addEventListener("blur", settle);
  window.addEventListener("focus", resume);
  window.addEventListener("pagehide", () => endView(true));

  pollTimer = setInterval(() => {     // [M4] URL 폴링 — MAIN world 주입·pushState 후킹 금지
    if (!chrome.runtime?.id) { orphanStop(); return; }        // [K3]
    const cur = location.pathname;
    if (cur === lastPath) return;
    lastPath = cur;
    endView(false);                   // [I8] view를 시작하지 않는 전환 포함, 직전 view 정상 마감
    startView();                      //      [J3] 종료 메시지는 마지막 스냅숏 사용(재수집 금지)
  }, POLL_MS);

  hbTimer = setInterval(() => {       // 30초 heartbeat — 행 수는 늘지 않는다(upsert [B3])
    if (!view) return;
    recollect();                      // [J3]
    send(false);
  }, HEARTBEAT_MS);

  startView();                        // 최초 주입 시점 (document_idle)
})();

globalThis.namuContent = namuContent;
if (typeof module !== "undefined") {  // node 테스트용 — 브라우저에선 건너뜀
  module.exports = { namuContent, CONTENT_ANCHOR_SELECTOR };
}
