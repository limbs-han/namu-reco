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

// [G4] Node 접근용 가드 export — 반드시 파일 말미, 이 형태 그대로.
//      브라우저(content script·classic SW)에서는 typeof 검사가 false라 건너뛰므로 무해.
//      가드 없는 module.exports는 sw.js의 importScripts에서 예외 → 확장 전체 무동작 — 금지.
if (typeof module !== "undefined") {
  module.exports = { SHARD_BASE, NAMESPACES, FALLBACK_SIM, isNamespace, fnv1a32, shardIdOf, shardPath, docUrlOf };
}
