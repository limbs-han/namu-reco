// popup.js — §4.7 [J8]: recommendations 전 행을 rank 순으로 표시. 표시·클릭 이상 기능 없음(§0).
(async () => {
  // [UX-A3] 렌더 시점 정화 + [E24-M1] 방금 떠난 문서·열람 중 문서 제외 — sw 경로와 같은 관문.
  // (현재 탭 문서 제외는 없음 — 팝업은 새 탭 의미론, tabs 권한 미보유)
  const rows = await db.txn(["recommendations", "events"], "readonly", async (tx) =>
    presentableRows(await tx.getAll("recommendations"),
      pendingViewTitles(await tx.indexGetAll("events", "processed", IDBKeyRange.only(0)),
                        Date.now())));

  const list = document.getElementById("list");
  const empty = document.getElementById("empty");
  if (!rows.length) {                 // 설치 직후 첫 알람 전 등 — 디버그 영역은 계속 렌더
    empty.hidden = false;
  }
  // [G1·B3] 출처별 섹션 — 사유는 그룹 헤더 1회(reasonText 단일 진실원 [J8]),
  // 행은 문서 글리프+제목 (드롭다운과 시각 언어 통일, 번호 제거)
  for (const g of groupRows(rows)) {
    if (g.header) {
      const h = document.createElement("div");
      h.className = "ghead";
      h.textContent = g.header;
      list.append(h);
    }
    const ul = document.createElement("ul");
    for (const r of g.rows) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      const ih = document.createElement("span");
      ih.innerHTML = DOC_GLYPH;                  // currentColor — 링크색 상속
      const icon = ih.firstChild;
      icon.setAttribute("width", "14");
      icon.setAttribute("height", "14");
      a.append(icon, document.createTextNode(r.title));
      // [J2] chrome.tabs.create는 무권한 API — URL 조립은 반드시 common.js docUrlOf
      a.addEventListener("click", () => chrome.tabs.create({ url: docUrlOf(r.title) }));
      li.append(a);
      ul.append(li);
    }
    list.append(ul);
  }

  // [§7] 디버그 — profile 직독 (dwell 경계 실측용, SW 무경유. 팝업은 확장 origin)
  const prof = await db.txn(["profile"], "readonly", (tx) => tx.getAll("profile"));
  prof.sort((a, b) => (b.dwell_ms_total || 0) - (a.dwell_ms_total || 0));
  const dbg = document.getElementById("debug-rows");
  for (const p of prof) {
    const li = document.createElement("li");
    li.textContent = `${p.title} — ${fmtDwell(p.dwell_ms_total || 0)}` +
      ((p.dwell_ms_total || 0) >= LONG_READ_MS ? " · 오래 읽음" : "");
    dbg.append(li);
  }
})();
