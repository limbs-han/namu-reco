// namuContent 순수 로직 검증 — 실행: node --test extension/tests/content.test.js
// E13(비-/w/ 유령 제목 차단)·E9(네임스페이스 view 불가)·[H9] URIError 가드·
// [J4·H3·I12] links 수집 규칙의 로직 레벨. 실브라우저 판정은 manual-checklist.html.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

Object.assign(globalThis, require(path.join(__dirname, "..", "common.js")));
const { namuContent } = require(path.join(__dirname, "..", "content.js"));

test("[G11] title 파생 — 디코드 + NFC, 슬래시 제목은 잔여 전체", () => {
  assert.equal(namuContent.deriveTitle("/w/%ED%95%98%EC%B8%A0%EB%84%A4%20%EB%AF%B8%EC%BF%A0"),
               "하츠네 미쿠");
  assert.equal(namuContent.deriveTitle("/w/A/B"), "A/B");
  const nfd = "가".normalize("NFD");
  assert.equal(namuContent.deriveTitle(`/w/${encodeURIComponent(nfd)}`), "가");
});

test("E13 로직: 비-/w/ 경로는 view 시작 없음 — 유령 제목 차단 [I1]", () => {
  assert.equal(namuContent.deriveTitle("/"), null);
  assert.equal(namuContent.deriveTitle("/RecentChanges"), null);
  assert.equal(namuContent.deriveTitle("/board/free"), null);
});

test("[H9] 비정상 퍼센트 시퀀스는 null — 폴링 콜백을 죽이지 않는다", () => {
  assert.equal(namuContent.deriveTitle("/w/%E0%A4%A"), null);
});

test("E9 로직: 네임스페이스 문서는 view 세션 시작 불가 [N1]", () => {
  assert.equal(namuContent.viewTitleFor("/w/" + encodeURIComponent("나무위키:대문")), null);
  assert.equal(namuContent.viewTitleFor("/w/" + encodeURIComponent("틀:상자")), null);
  // 콜론이 있어도 고정 목록 밖이면 일반 문서
  assert.equal(
    namuContent.viewTitleFor("/w/" + encodeURIComponent("Re:제로부터 시작하는 이세계 생활")),
    "Re:제로부터 시작하는 이세계 생활");
});

// ---------- links 수집 [J4·H3·I12] ----------

const fakeRoot = (anchors) => ({ querySelectorAll: () => anchors });

test("[I12·H3] pathname 프로퍼티 기준 선별·파생 — 비-/w/·URIError·네임스페이스 제외, 중복 제거", () => {
  const links = namuContent.collectLinks(fakeRoot([
    { pathname: "/w/%EB%AC%B8%EC%84%9C%EA%B0%80" },   // 문서가
    { pathname: "/w/%EB%AC%B8%EC%84%9C%EA%B0%80" },   // 중복
    { pathname: "/board/free" },                      // 비-/w/
    { pathname: "/w/%E0%A4%A" },                      // URIError → skip
    { pathname: "/w/" + encodeURIComponent("틀:상자") },   // 네임스페이스 제외
    { pathname: "/w/B" },
  ]));
  assert.deepEqual(links, ["문서가", "B"]);
});

test("[J4] 상한 40개", () => {
  const anchors = Array.from({ length: 50 }, (_, i) => ({ pathname: `/w/doc${i}` }));
  assert.equal(namuContent.collectLinks(fakeRoot(anchors)).length, 40);
});

test("[J4] 컨테이너 미발견(null root) → null 반환 = 수집 skip 신호 (오염보다 결손)", () => {
  assert.equal(namuContent.collectLinks(null), null);
});

// ---------- 본문 컨테이너 = 섹션 앵커 LCA [J4] ----------

function el(name, children = []) {
  const n = {
    name, children, parentElement: null,
    contains(x) { return x === n || n.children.some((c) => c.contains(x)); },
    querySelectorAll() {
      const out = [];
      (function walk(m) {
        for (const c of m.children) { if (c.isSection) out.push(c); walk(c); }
      })(n);
      return out;
    },
  };
  for (const c of children) c.parentElement = n;
  return n;
}
const section = (id) => Object.assign(el(`a#${id}`), { isSection: true });

test("[J4] 본문 래퍼 = 섹션 앵커 최소 공통 조상 — 사이드바는 밖", () => {
  const s1 = section("s-1");
  const s2 = section("s-2");
  const content = el("content", [s1, el("wrap", [s2])]);
  const sidebar = el("sidebar");
  const doc = el("body", [sidebar, content]);
  assert.equal(namuContent.findContentRoot(doc), content);
});

test("[J4] 섹션 앵커 2개 미만이면 식별 불가 → null (수집 포기)", () => {
  const doc = el("body", [section("s-1")]);
  assert.equal(namuContent.findContentRoot(doc), null);
});
