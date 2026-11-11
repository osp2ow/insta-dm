// 기타 악보 PDF에 들어 있는 글꼴 확인 (pdffonts)
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const { execSync } = require("child_process");
const fs = require("fs");
initializeApp({ projectId: "insta---dm", storageBucket: "insta---dm.firebasestorage.app" });
(async () => {
  execSync("sudo apt-get install -y -qq poppler-utils >/dev/null 2>&1");
  const ss = (await getFirestore().collection("scores").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  for (const s of ss) {
    console.log("==", s.id.slice(0, 5), s.title, "|", s.instrument || "", "|", s.filePath || "", "| pages", s.pageCount);
  }
  const gt = ss.filter((s) => /기타|guitar|tab|타브/i.test(`${s.title} ${s.instrument}`) && /\.pdf$/i.test(s.filePath || ""));
  for (const s of gt) {
    const f = `/tmp/${s.id}.pdf`;
    try {
      let bucket = getStorage().bucket();
      if (!(await bucket.file(s.filePath).exists())[0]) bucket = getStorage().bucket("insta---dm.appspot.com");
      await bucket.file(s.filePath).download({ destination: f });
      console.log("\n#####", s.title, fs.statSync(f).size, "bytes");
      console.log(execSync(`pdfinfo ${f} | grep -E "Producer|Creator|Pages"; pdffonts ${f}`).toString());
    } catch (e) { console.log("실패", s.title, e.message); }
  }
})();
