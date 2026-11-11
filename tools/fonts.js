// 기타 타브: 저장된 DM용 페이지 이미지와 poppler 렌더를 임시 브랜치로 올려 비교
const { initializeApp } = require("firebase-admin/app");
const { getStorage } = require("firebase-admin/storage");
const { execSync } = require("child_process");
const fs = require("fs");
initializeApp({ projectId: "insta---dm", storageBucket: "insta---dm.firebasestorage.app" });
(async () => {
  execSync("sudo apt-get install -y -qq poppler-utils >/dev/null 2>&1");
  fs.mkdirSync("out", { recursive: true });
  const b = getStorage().bucket();
  const [files] = await b.getFiles({ prefix: "scores/An7IUM0j0x9oXtIdzQjI/" });
  console.log(files.map((x) => x.name + " " + x.metadata.size));
  for (const x of files) await x.download({ destination: "out/" + x.name.split("/").pop() });
  execSync(`pdftoppm -r 100 -png -f 1 -l 1 out/score.pdf out/poppler`);
  console.log(execSync("head -c 1500 out/score.pdf | strings | head -30").toString());
})();
