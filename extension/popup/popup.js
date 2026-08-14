// popup.js — §4.7 [J8]: recommendations 전 행을 rank 순으로 표시. 표시·클릭 이상 기능 없음(§0).
(async () => {
  const rows = presentableRows(   // [UX-A3] 렌더 시점 정화 — sw 메시지 경로와 같은 관문
    await db.txn(["recommendations"], "readonly", (tx) => tx.getAll("recommendations")));

  const list = document.getElementById("list");
  const empty = document.getElementById("empty");
  if (!rows.length) {                 // 설치 직후 첫 알람 전 등 — 디버그 영역은 계속 렌더
    empty.hidden = false;
  }
  for (const r of rows) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.textContent = r.title;
    // [J2] chrome.tabs.create는 무권한 API — URL 조립은 반드시 common.js docUrlOf
    a.addEventListener("click", () => chrome.tabs.create({ url: docUrlOf(r.title) }));
    const why = document.createElement("span");
    why.className = "why";
    why.textContent = reasonText(r);  // §4.7 [J8] 단일 진실원 — common.js
    li.append(a, why);
    list.append(li);
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
