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
function shardIdOf(title) { return fnv1a32(title.normalize("NFC")) % 1024; }   // [F8]
function shardPath(id)    { return `nbr/${String(id).padStart(4, "0")}.json.gz`; }
function docUrlOf(title) {                                     // [J2] 추천 클릭 URL — O5(g)가 게이트.
  return "https://namu.wiki/w/" + encodeURIComponent(title).replace(/%2F/gi, "/");
}                                                              //      encodeURIComponent 없이는 "C#"이 fragment로 잘리고(/w/C),
                                                               //      %2F 복원 없이는 "A/B"가 나무위키 관례(/w/A/B)와 갈린다

const LONG_READ_MS = 3 * 60 * 1000;   // [M2] 사유 "오래 읽으셔서" 문턱 — 누적 체류 3분

function eulReul(word) {              // [m1] 목적격 조사 — 마지막 글자 받침 기준, 비한글은 병기
  const c = word.charCodeAt(word.length - 1);
  if (c < 0xAC00 || c > 0xD7A3) return "을(를)";
  return (c - 0xAC00) % 28 ? "을" : "를";
}

// §4.7 [J8] 추천 사유 문구 — 단일 진실원 (reco_tab·popup 공용, 여기 외 정의 금지).
// [M2] 체류 계층: 3분 이상만 "오래", 미만·미상(reason_dwell_ms 없는 구버전 행)은
// "읽으셔서" — 20초 열람에 "오래 읽으셔서"를 붙이던 과장 제거.
function reasonText(row) {
  if (row.reason_title) {
    const long = (row.reason_dwell_ms || 0) >= LONG_READ_MS;
    return `「${row.reason_title}」${eulReul(row.reason_title)} ${long ? "오래 " : ""}읽으셔서`;
  }
  return row.source === "popular" ? "인기 문서" : "";
}

// [G4] Node 접근용 가드 export — 반드시 파일 말미, 이 형태 그대로.
//      브라우저(content script·classic SW)에서는 typeof 검사가 false라 건너뛰므로 무해.
//      가드 없는 module.exports는 sw.js의 importScripts에서 예외 → 확장 전체 무동작 — 금지.
if (typeof module !== "undefined") {
  module.exports = { SHARD_BASE, NAMESPACES, FALLBACK_SIM, LONG_READ_MS,
    isNamespace, fnv1a32, shardIdOf, shardPath, docUrlOf, eulReul, reasonText };
}
