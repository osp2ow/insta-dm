// 발송 진단 (GitHub Actions에서 수동 실행). 공개 로그라 아이디는 가려서 출력
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { execSync } = require("child_process");
initializeApp({ projectId: "insta---dm" });
const db = getFirestore();
const mask = (s) => (s ? String(s).slice(0, 2) + "***" : "?");
const ago = (d) => Math.round((Date.now() - d) / 3600000) + "h";

(async () => {
  const since = Date.now() - 14 * 864e5;
  const cs = (await db.collection("comments").orderBy("createdAt", "desc").limit(1000).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const ds = (await db.collection("dms").orderBy("createdAt", "desc").limit(3000).get()).docs.map((d) => d.data());
  const ps = (await db.collection("people").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const recentC = cs.filter((c) => c.createdAt?.toMillis() > since && c.matched);
  console.log("== 최근 14일 키워드 댓글:", recentC.length);
  const byAct = {};
  recentC.forEach((c) => (byAct[c.action] = (byAct[c.action] || 0) + 1));
  console.log("댓글 결과:", JSON.stringify(byAct));

  // 댓글별로 악보가 실제로 나갔는지 (같은 사람 + 같은 게시물 delivery가 댓글 이후에 있는지)
  const deliveries = ds.filter((d) => d.type === "delivery" && d.status === "sent");
  const asks = ds.filter((d) => d.type === "follow_ask");
  let delivered = 0, asked = 0, nothing = 0, idMismatch = 0;
  const peopleById = Object.fromEntries(ps.map((p) => [p.id, p]));
  const samples = [];
  for (const c of recentC.filter((c) => c.action === "dm_sent")) {
    const t = c.createdAt.toMillis();
    const igsid = c.igsid || "";
    const got = deliveries.find((d) => d.mediaId === c.mediaId && (d.igsid === igsid || d.username === c.username) && d.createdAt?.toMillis() >= t);
    if (got) { delivered++; continue; }
    if (asks.find((d) => d.mediaId === c.mediaId && (d.igsid === igsid || d.username === c.username) && d.createdAt?.toMillis() >= t)) { asked++; continue; }
    nothing++;
    if (igsid && c.fromId && igsid !== c.fromId) idMismatch++;
    if (samples.length < 25) samples.push({ ago: ago(t), user: mask(c.username), igsidEqFrom: igsid === c.fromId, hasPerson: !!peopleById[igsid], pendingHere: !!peopleById[igsid]?.pending?.[c.mediaId], usedButton: c.usedButton });
  }
  console.log(`DM 보낸 댓글 중 → 악보 전달: ${delivered}, 팔로우 요청에서 멈춤: ${asked}, 아무 반응 없음(버튼 미탭?): ${nothing}, igsid≠fromId: ${idMismatch}`);
  console.log("미전달 샘플:", JSON.stringify(samples, null, 0));

  // 서버 로그: 대기 요청 없이 들어온 DM (= 버튼을 눌렀는데 짝을 못 찾은 경우)
  try {
    const raw = execSync(
      `gcloud logging read 'resource.labels.service_name="igwebhook" AND jsonPayload.message="대기 중인 요청 없는 DM" AND timestamp>="${new Date(since).toISOString()}"' --project=insta---dm --limit=500 --format=json`,
      { maxBuffer: 50e6 }
    ).toString();
    const logs = JSON.parse(raw || "[]");
    console.log("== 짝 없는 DM(버튼/답장했는데 대기 요청을 못 찾음):", logs.length);
    const tally = { hasPersonDoc: 0, noPersonDoc: 0, payloadGet: 0, payloadFollow: 0, text: 0 };
    const orphanIds = new Set();
    for (const l of logs) {
      const p = l.jsonPayload || {};
      orphanIds.add(p.igsid);
      peopleById[p.igsid] ? tally.hasPersonDoc++ : tally.noPersonDoc++;
      if (String(p.payload || "").startsWith("GET_SCORE")) tally.payloadGet++;
      else if (String(p.payload || "").startsWith("CHECK_FOLLOW")) tally.payloadFollow++;
      else tally.text++;
    }
    console.log("내역:", JSON.stringify(tally), "서로 다른 사람:", orphanIds.size);
    console.log("== 짝 없는 DM 보낸 사람별 상태");
    for (const l of logs.slice(0, 8)) {
      const id = l.jsonPayload?.igsid; const pp = peopleById[id] || {};
      const t = Date.parse(l.timestamp);
      const mine = ds.filter((d) => d.igsid === id).sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
      const myC = cs.filter((c) => c.igsid === id);
      const hhmm = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(5, 19);
      console.log("  시각(KST) 답장:", hhmm(t), "| 댓글:", myC.map((c) => hhmm(c.createdAt.toMillis()) + "(웹훅받은시각)").join(","), "| 첫DM:", mine.filter((d) => d.type === "opening").map((d) => hhmm(d.createdAt.toMillis())).join(","));
      console.log(JSON.stringify({ ago: ago(t), text: String(l.jsonPayload?.text || "").slice(0, 12), comments: myC.map((c) => ago(c.createdAt.toMillis()) + ":" + String(c.mediaId).slice(-5)).join(","), dms: mine.map((d) => d.type[0] + (d.status === "sent" ? "" : "!") + "@" + ago(d.createdAt.toMillis())).join(","), pendingNow: Object.keys(pp.pending || {}).map((k) => k.slice(-5)).join(","), following: pp.isFollowing }));
    }
    console.log("샘플:", JSON.stringify(logs.slice(0, 15).map((l) => ({ ago: ago(Date.parse(l.timestamp)), payload: l.jsonPayload?.payload, text: String(l.jsonPayload?.text || "").slice(0, 15), hasPerson: !!peopleById[l.jsonPayload?.igsid] }))));
    // 짝 못 찾은 사람의 igsid가 people에 없을 때, 같은 사람의 다른 id가 있는지 (username으로 비교는 토큰 필요 → 개수만)
  } catch (e) {
    console.log("로그 조회 실패:", e.message.slice(0, 300));
  }
  // 에러 로그
  try {
    const raw = execSync(
      `gcloud logging read 'resource.labels.service_name="igwebhook" AND severity>=WARNING AND timestamp>="${new Date(since).toISOString()}"' --project=insta---dm --limit=300 --format=json`,
      { maxBuffer: 50e6 }
    ).toString();
    const logs = JSON.parse(raw || "[]");
    const t = {};
    logs.forEach((l) => { const k = (l.jsonPayload?.message || l.textPayload || "").slice(0, 60) + " | " + String(l.jsonPayload?.error?.message || l.jsonPayload?.error || "").slice(0, 80); t[k] = (t[k] || 0) + 1; });
    console.log("== 경고/오류 로그:", logs.length, JSON.stringify(t, null, 1));
  } catch (e) {
    console.log("오류 로그 조회 실패:", e.message.slice(0, 300));
  }
})();
