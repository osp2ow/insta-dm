// 최근 3시간 댓글 처리 결과 (공개 로그라 아이디는 가림)
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
initializeApp({ projectId: "insta---dm" });
const db = getFirestore();
const mask = (s) => (s ? String(s).slice(0, 3) + "***" : "?");
(async () => {
  const since = Date.now() - 3 * 3600e3;
  const cs = (await db.collection("comments").orderBy("createdAt", "desc").limit(200).get()).docs
    .map((d) => d.data()).filter((c) => c.createdAt?.toMillis() > since);
  const posts = {};
  for (const c of cs) {
    if (c.mediaId && !posts[c.mediaId]) {
      const p = await db.doc(`posts/${c.mediaId}`).get();
      posts[c.mediaId] = p.exists ? p.data() : null;
    }
    const p = posts[c.mediaId];
    console.log(JSON.stringify({
      min: Math.round((Date.now() - c.createdAt.toMillis()) / 60000), who: mask(c.username), text: c.text,
      action: c.action, matched: c.matched, media: String(c.mediaId).slice(-5),
      postKeywords: p ? p.keywords : null, postOn: p ? p.configured && p.enabled !== false : null,
    }));
  }
  console.log("총", cs.length);
})();
