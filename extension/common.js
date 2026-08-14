// extension/common.js — settings.py와의 정합은 O5가 게이트한다 [F4]
// 브라우저 API 참조 금지 [G4] — Node에서 require 가능해야 한다 (O5 실행 조건)
const SHARD_BASE = "https://limbs-han.github.io/namu-reco";    // [I2] 배포 원점 — 플레이스홀더 금지, 형식은 O5(e)가 게이트.
                                                               //      변경 시 확장 재배포만(파이프라인 무관)
const NAMESPACES = ["나무위키", "틀", "분류", "사용자", "파일", "휴지통"];
const FALLBACK_SIM = 0.4;                                      // [F2] §4.6 — NBR_SCORE_FLOOR와의 서열은 O5(d)가 게이트 [G6]

function fnv1a32(s) {                                          // [M1] Math.imul 필수 — (h*prime)>>>0은 곱이 2^53을 초과해 오답
  let h = 2166136261;
  for (const b of new TextEncoder().encode(s.normalize("NFC"))) {
    h ^= b;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function isNamespace(title) {
  const i = title.indexOf(":");
  return i > 0 && NAMESPACES.includes(title.slice(0, i));
}
// [UX-01·02] 한자 전용 제목 판정 — 한자 병기 관례(사족보행(四足步行))가 낱글자 문서
// 링크를 본문 선두에 심는다. 사용자 결정: 길이 무관, 전부 한자면 추천 후보에서 제외.
// 한글·혼합 제목(이족보행 등)은 통과. Chrome 92+·Node 모두 \p{Script=Han} 지원.
function isHanjaOnly(title) {
  return /^\p{Script=Han}+$/u.test(title);
}
// 문서 글리프 svg — 사이트 아이콘 문법과 동일한 solid fill·currentColor.
// 추천 탭·드롭다운 항목·연관 문서 위젯 공용 [UX-04 시각 언어 통일].
const DOC_GLYPH =
  '<svg width="16" height="16" viewBox="0 0 448 512" aria-hidden="true">' +
  '<path fill="currentColor" fill-rule="evenodd" d="M80 0C44.7 0 16 28.7 16 64v384' +
  'c0 35.3 28.7 64 64 64h288c35.3 0 64-28.7 64-64V160H288c-17.7 0-32-14.3-32-32V0H80z' +
  'M288 0v128h144L288 0zM112 240h224v40H112v-40zm0 104h224v40H112v-40z"/></svg>';

function shardIdOf(title) { return fnv1a32(title.normalize("NFC")) % 1024; }   // [F8]
function shardPath(id)    { return `nbr/${String(id).padStart(4, "0")}.json.gz`; }
function docPathOf(title) {                                    // [UX-10] 페이지 내 앵커용 상대 경로 —
  return "/w/" + encodeURIComponent(title).replace(/%2F/gi, "/");   // SPA 라우터를 타면 소프트 전환.
}                                                              //      encodeURIComponent 없이는 "C#"이 fragment로 잘리고(/w/C),
                                                               //      %2F 복원 없이는 "A/B"가 나무위키 관례(/w/A/B)와 갈린다
function docUrlOf(title) {                                     // [J2] 절대 URL — popup(chrome.tabs.create) 전용.
  return "https://namu.wiki" + docPathOf(title);               //      O5(g) 게이트 형식 불변
}

const LONG_READ_MS = 3 * 60 * 1000;   // [M2] 사유 "오래 읽으셔서" 문턱 — 누적 체류 3분

function josaOf(word, withBatchim, without) {   // [m1] 조사 — 끝 글자 받침 기준, 비한글은 병기
  const c = word.charCodeAt(word.length - 1);
  if (c < 0xAC00 || c > 0xD7A3) return `${without}(${withBatchim})`;   // [UX-B1] 명세 정본 와(과)
  return (c - 0xAC00) % 28 ? withBatchim : without;
}

// §4.7 [J8] 추천 사유 문구 — 단일 진실원 (reco_tab·popup 공용, 여기 외 정의 금지).
// [UX-06] 출처 × 체류 분화 — 전부 데이터로 증명 가능한 표현만:
// shard = 링크 그래프 유사도("가까운"), fallback = X 본문의 실제 링크("이어지는").
// "함께 읽히는" 같은 행동 데이터 주장 금지 [M2 과장 재발 방지].
function reasonText(row) {
  if (row.reason_title) {
    const t = row.reason_title;
    const long = (row.reason_dwell_ms || 0) >= LONG_READ_MS ? "오래 읽은 " : "";
    return row.source === "shard"
      ? `${long}「${t}」${josaOf(t, "과", "와")} 가까운 문서`
      : `${long}「${t}」에서 이어지는 문서`;
  }
  return row.source === "popular" ? "인기 문서" : "";
}

// [UX-A3] 렌더 시점 정화 — 구버전(≤0.6.0)이 recommendations에 남긴 한자 낱글자는
// 다음 rebuild 전까지 저장분 그대로다(업그레이드 직후가 정확히 이 창). 모든 표시
// 경로(드롭다운 = sw 메시지, 팝업 = IDB 직독)는 이 관문을 통과한다 — 필터 규칙이
// 바뀌어도 여기 한 곳. 마이그레이션 금지 원칙 유지.
// [E24-M1] excludeTitle = 현재 열람 문서 — 체류 중인 view는 아직 profile에 없어
// rebuild의 방문 제외를 비껴간다. "현재 문서"는 탭마다 다르므로 서빙 시점에 뺀다.
// 팝업(새 탭 의미론)은 미지정 = 제외 없음.
function presentableRows(rows, excludeTitle) {
  return rows.filter((r) => !isHanjaOnly(r.title) && r.title !== excludeTitle)
             .sort((a, b) => a.rank - b.rank);
}

function fmtDwell(ms) {   // [§7] 디버그 표기 — 검증 라운드의 dwell 경계 실측용 (E24)
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}분 ${s % 60}초`;
}

// [UX-B6] 소프트 전환 — the seed(Vue)는 앵커별 직접 리스너라 확장 DOM 앵커는 하드
// 내비게이션이 기본. 라우터의 popstate 구독을 이용한다(스파이크 실측 2026-08-14:
// 전진 3회+back 소프트 성공, popstate 후 #app 첫 변이 8.5ms — 로컬 렌더라 회선 무관).
// 3초 내 변이 0 = 라우터 침묵(사이트 개편 등) → 하드 폴백 — 최악이 현행과 동일.
// w/d는 Node 테스트 어댑터 — 브라우저 호출은 생략(호출 시점에만 window·document 평가 [G4]).
function softNavigate(path, w, d) {
  w = w || window; d = d || document;
  const app = d.getElementById("app");
  if (!app) return false;                        // SPA 루트 부재 — 기본 내비 유지
  w.history.pushState(null, "", path);
  w.dispatchEvent(new w.PopStateEvent("popstate", { state: null }));
  let alive = false;
  const mo = new w.MutationObserver(() => { alive = true; mo.disconnect(); });
  mo.observe(app, { childList: true, subtree: true, attributes: true });
  w.setTimeout(() => {
    mo.disconnect();
    if (!alive) w.location.href = path;          // 데드맨 — 하드 폴백
  }, 3000);
  return true;
}

// [G4] Node 접근용 가드 export — 반드시 파일 말미, 이 형태 그대로.
//      브라우저(content script·classic SW)에서는 typeof 검사가 false라 건너뛰므로 무해.
//      가드 없는 module.exports는 sw.js의 importScripts에서 예외 → 확장 전체 무동작 — 금지.
if (typeof module !== "undefined") {
  module.exports = { SHARD_BASE, NAMESPACES, FALLBACK_SIM, LONG_READ_MS, DOC_GLYPH,
    isNamespace, isHanjaOnly, fnv1a32, shardIdOf, shardPath, docPathOf, docUrlOf, josaOf, reasonText,
    presentableRows, softNavigate, fmtDwell };
}
