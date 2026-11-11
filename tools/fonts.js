// 기타 타브 PDF 1개를 poppler와 pdf.js 두 가지로 그려서 비교 (결과는 actions 아티팩트)
const { initializeApp } = require("firebase-admin/app");
const { getStorage } = require("firebase-admin/storage");
const { execSync } = require("child_process");
const fs = require("fs");
initializeApp({ projectId: "insta---dm", storageBucket: "insta---dm.firebasestorage.app" });
(async () => {
  execSync("sudo apt-get install -y -qq poppler-utils qpdf >/dev/null 2>&1");
  fs.mkdirSync("out", { recursive: true });
  const f = "/tmp/a.pdf";
  await getStorage().bucket().file("scores/An7IUM0j0x9oXtIdzQjI/score.pdf").download({ destination: f });
  execSync(`qpdf --qdf --object-streams=disable ${f} /tmp/q.pdf || true`);
  const q = fs.readFileSync("/tmp/q.pdf", "latin1");
  console.log("Font 언급:", (q.match(/\/(Base)?Font[^\n]{0,80}/g) || []).slice(0, 15));
  console.log("Tf 사용:", (q.match(/[^\n]{0,40} Tf/g) || []).slice(0, 10));
  console.log("Tj 예:", (q.match(/[^\n]{0,60} Tj/g) || []).slice(0, 10));
  execSync(`pdftoppm -r 80 -png -f 1 -l 1 ${f} out/poppler`);
  fs.copyFileSync(f, "out/score.pdf");
})();
