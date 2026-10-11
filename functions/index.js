/**
 * 주니퍼 악보 DM 자동 발송 서버 (Firebase Cloud Functions)
 *
 * 흐름
 *   1) 키워드 댓글 → 비공개 답장(DM)으로 [악보 받기] 버튼 발송 + 공개 대댓글
 *   2) 사용자가 버튼을 누르거나 답장 → 팔로우 여부 확인
 *      - 팔로워 전용 게시물인데 미팔로우 → 팔로우 요청 + [팔로우 완료] 버튼
 *      - 조건 충족 → 악보 페이지 링크 발송
 *
 * 함수
 *   igWebhook      Meta 웹훅 수신
 *   admin          관리자 페이지용 API (게시물 목록, 계정 상태, 재구독)
 *   igStatus       브라우저로 여는 상태 점검
 *   refreshToken   매주 액세스 토큰 갱신
 *   dailySnapshot  매일 밤 팔로워 수 기록
 *
 * Firestore
 *   config/settings   문구·기본 키워드 등 전체 설정
 *   posts/{mediaId}   게시물별 설정 + 통계(stats)
 *   scores/{scoreId}  악보 라이브러리 (공개 읽기)
 *   comments/{id}     댓글 수신 기록
 *   dms/{autoId}      DM 발송 기록
 *   people/{igsid}    요청자별 상태(대기 중인 요청, 팔로우 전환)
 *   stats/totals      전체 누적 통계
 *   daily/{yyyy-mm-dd} 날짜별 팔로워 수
 *   system/token      자동 갱신된 액세스 토큰
 */
const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const crypto = require("crypto");

initializeApp();
const db = getFirestore();

setGlobalOptions({ region: "asia-northeast3", maxInstances: 5 });

const IG_VERIFY_TOKEN = defineSecret("IG_VERIFY_TOKEN");
const IG_APP_SECRET = defineSecret("IG_APP_SECRET");
const IG_ACCESS_TOKEN = defineSecret("IG_ACCESS_TOKEN");

const GRAPH = "https://graph.instagram.com/v24.0";
const SITE = "https://insta---dm.web.app";
const OWNER_EMAILS = ["osp2ow@gmail.com"]; // 항상 접속 가능한 기본 관리자

// 관리자 명단 = 기본 관리자 + 설정 화면에서 추가한 이메일(config/admins)
async function isAdminEmail(email) {
  if (!email) return false;
  const e = String(email).toLowerCase();
  if (OWNER_EMAILS.includes(e)) return true;
  const snap = await db.doc("config/admins").get();
  const list = snap.exists ? snap.get("emails") || [] : [];
  return list.map((x) => String(x).toLowerCase()).includes(e);
}

const PAYLOAD_GET = "GET_SCORE";
const PAYLOAD_FOLLOW = "CHECK_FOLLOW";

// ---------- 기본 설정 (관리자 페이지에서 바꾸면 config/settings 값이 우선) ----------

const DEFAULT_SETTINGS = {
  unconfiguredMode: "ignore", // 켜지 않은 게시물: "ignore"(응답 안 함, 기본) | "default"(기본 키워드로 응답)
  defaultKeywords: ["악보"],
  defaultFollowersOnly: false,
  publicReplyEnabled: true,
  publicReplies: [
    "DM으로 악보 보내드렸어요! 🥁",
    "DM 확인해 주세요! 🎸",
    "보내드렸어요! DM함 확인해 주세요 🎶",
    "DM 보냈어요! 즐거운 연습 되세요 🙌",
  ],
  buttonLabel: "악보 받기 🎵",
  followButtonLabel: "팔로우 완료 ✅",
  msgOpening:
    "안녕하세요 {username}님! 🥁\n{title}악보 보내드릴게요.\n\n아래 [악보 받기] 버튼을 눌러 주세요!\n(버튼이 안 보이면 이 메시지에 아무 답장이나 보내 주세요)",
  msgFollowAsk:
    "{username}님, {title}악보는 팔로워 전용이에요 🙏\n@{account} 팔로우 후 아래 [팔로우 완료] 버튼을 눌러 주세요!",
  msgDelivery: "🎵 {title}악보예요!\n\n{link}\n\n연습하다 막히는 부분 있으면 편하게 DM 주세요 🙂",
  msgNoScore: "악보 요청 감사해요! 🥁\n이 영상 악보는 지금 정리 중이에요. 준비되는 대로 보내드릴게요 🙏",
  msgDeletion: "데이터 삭제 요청이 접수됐어요. 처리되면 다시 알려드릴게요 🙏",
  // 악보 보내는 방식
  sendImages: true, // 악보 사진(페이지별) - DM에서 길게 눌러 바로 저장
  sendPdf: true, // PDF 파일 첨부
  sendCard: false, // 악보 페이지로 가는 카드
};

let settingsCache = { at: 0, value: null };
async function getSettings() {
  if (settingsCache.value && Date.now() - settingsCache.at < 30_000) return settingsCache.value;
  const snap = await db.doc("config/settings").get();
  const value = { ...DEFAULT_SETTINGS, ...(snap.exists ? snap.data() : {}) };
  settingsCache = { at: Date.now(), value };
  return value;
}

// ---------- 공통 유틸 ----------

const norm = (s) => String(s || "").replace(/\s/g, "").toLowerCase();

function fill(tpl, vars) {
  return String(tpl || "").replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? vars[k] : ""));
}

function pick(arr) {
  const list = (arr || []).filter(Boolean);
  return list.length ? list[Math.floor(Math.random() * list.length)] : "";
}

async function getAccessToken() {
  const snap = await db.doc("system/token").get();
  if (snap.exists && snap.get("value")) return snap.get("value");
  return IG_ACCESS_TOKEN.value();
}

let accountCache = null;
async function getAccount(token) {
  if (accountCache) return accountCache;
  const r = await graphGet("/me?fields=user_id,username", token);
  if (r.ok) accountCache = r.data;
  return r.data || {};
}

function isValidSignature(req, appSecret) {
  const header = req.get("x-hub-signature-256") || "";
  if (!header.startsWith("sha256=") || !req.rawBody) return false;
  const expected = crypto.createHmac("sha256", appSecret).update(req.rawBody).digest("hex");
  const received = header.slice("sha256=".length);
  if (received.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

async function graphGet(path, token) {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${GRAPH}${path}${sep}access_token=${encodeURIComponent(token)}`);
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

async function graphPost(path, token, body) {
  const res = await fetch(`${GRAPH}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `HTTP ${res.status}`);
    err.detail = data?.error || data;
    throw err;
  }
  return data;
}

function quickReplies(label, payload) {
  return [{ content_type: "text", title: String(label).slice(0, 20), payload }];
}

// 통계: 게시물별 + 전체 누적
async function bump(mediaId, fields) {
  const inc = {};
  for (const [k, v] of Object.entries(fields)) inc[k] = FieldValue.increment(v);
  const jobs = [db.doc("stats/totals").set(inc, { merge: true })];
  if (mediaId) jobs.push(db.doc(`posts/${mediaId}`).set({ stats: inc }, { merge: true }));
  await Promise.all(jobs);
}

async function logDm(data) {
  await db.collection("dms").add({ ...data, createdAt: FieldValue.serverTimestamp() });
}

// 게시물에 적용할 설정 계산
async function resolvePostConfig(mediaId, settings) {
  const snap = mediaId ? await db.doc(`posts/${mediaId}`).get() : null;
  const post = snap && snap.exists ? snap.data() : null;
  if (post && post.configured) {
    return {
      active: post.enabled !== false,
      keywords: (post.keywords && post.keywords.length ? post.keywords : settings.defaultKeywords) || [],
      followersOnly: !!post.followersOnly,
      scoreId: post.scoreId || null,
      source: "post",
    };
  }
  if (settings.unconfiguredMode === "ignore") {
    return { active: false, keywords: [], followersOnly: false, scoreId: null, source: "ignored" };
  }
  return {
    active: true,
    keywords: settings.defaultKeywords || [],
    followersOnly: !!settings.defaultFollowersOnly,
    scoreId: null,
    source: "default",
  };
}

async function getScore(scoreId) {
  if (!scoreId) return null;
  const s = await db.doc(`scores/${scoreId}`).get();
  return s.exists ? { id: s.id, ...s.data() } : null;
}

// ---------- 1단계: 댓글 처리 ----------

async function handleComment(igUserId, value) {
  const commentId = value?.id;
  const text = value?.text || "";
  const fromId = value?.from?.id || "";
  const username = value?.from?.username || "";
  const mediaId = value?.media?.id || "";

  if (!commentId) return;
  if (fromId && fromId === igUserId) return; // 내 계정 댓글(자동 대댓글 포함) 무시

  const settings = await getSettings();
  const cfg = await resolvePostConfig(mediaId, settings);
  const matchedKeyword = cfg.keywords.find((k) => norm(k) && norm(text).includes(norm(k))) || null;

  const ref = db.doc(`comments/${commentId}`);
  try {
    await ref.create({
      mediaId,
      username,
      fromId,
      text,
      matched: !!matchedKeyword,
      keyword: matchedKeyword,
      action: !cfg.active ? "off" : matchedKeyword ? "processing" : "no_keyword",
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (e) {
    if (e.code === 6) return; // 이미 처리한 댓글 (웹훅 재전송)
    throw e;
  }

  await bump(mediaId, { comments: 1, ...(matchedKeyword && cfg.active ? { matched: 1 } : {}) });
  if (!cfg.active || !matchedKeyword) return;

  const token = await getAccessToken();
  const score = await getScore(cfg.scoreId);
  const vars = { username, title: score?.title ? `「${score.title}」 ` : "", account: (await getAccount(token)).username || "" };
  const text1 = fill(settings.msgOpening, vars);

  let sent = null;
  let usedButton = true;
  try {
    sent = await graphPost("/me/messages", token, {
      recipient: { comment_id: commentId },
      message: { text: text1, quick_replies: quickReplies(settings.buttonLabel, PAYLOAD_GET) },
    });
  } catch (e) {
    // 버튼이 거부되면 글자만 다시 시도 (비공개 답장은 성공해야 1회로 계산됨)
    logger.warn("버튼 포함 발송 실패, 글자로 재시도", { commentId, error: e.detail || e.message });
    usedButton = false;
    try {
      sent = await graphPost("/me/messages", token, {
        recipient: { comment_id: commentId },
        message: { text: text1 },
      });
    } catch (e2) {
      await ref.update({ action: "dm_failed", dmError: e2.message });
      await logDm({ igsid: "", username, mediaId, type: "opening", status: "failed", error: e2.message, commentId });
      logger.error("첫 DM 발송 실패", { commentId, error: e2.detail || e2.message });
      return;
    }
  }

  const igsid = sent?.recipient_id || fromId;
  const personRef = db.doc(`people/${igsid}`);
  const existing = await personRef.get();
  await Promise.all([
    ref.update({ action: "dm_sent", igsid, usedButton }),
    logDm({ igsid, username, mediaId, type: "opening", status: "sent", commentId, usedButton }),
    bump(mediaId, { opened: 1 }),
    personRef.set(
      {
        username,
        lastSeenAt: FieldValue.serverTimestamp(),
        ...(existing.exists ? {} : { firstSeenAt: FieldValue.serverTimestamp() }),
        requests: FieldValue.increment(1),
        pending: { [mediaId || "none"]: { commentId, at: Date.now(), asked: false, responded: false } },
      },
      { merge: true }
    ),
  ]);

  if (settings.publicReplyEnabled) {
    const msg = pick(settings.publicReplies);
    if (msg) {
      try {
        await graphPost(`/${commentId}/replies`, token, { message: fill(msg, vars) });
        await ref.update({ publicReply: "sent" });
      } catch (e) {
        await ref.update({ publicReply: "failed", publicReplyError: e.message });
        logger.warn("공개 대댓글 실패", { commentId, error: e.detail || e.message });
      }
    }
  }
  logger.info("댓글 처리 완료", { commentId, username, mediaId, igsid, usedButton });
}

// ---------- 2단계: DM 응답 처리 (버튼 탭 / 답장) ----------

async function sendDm(token, igsid, text, qr) {
  const message = { text };
  if (qr) message.quick_replies = qr;
  return graphPost("/me/messages", token, { recipient: { id: igsid }, message });
}

// 빈 줄이 겹치지 않게 정리
function tidy(text) {
  return String(text || "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function coverUrl(score) {
  return score.coverPath ? `${SITE}/f/${score.id}?cover=1&v=${encodeURIComponent(score.coverVersion || 1)}` : `${SITE}/og/score.png`;
}

function fileUrl(score, query = "") {
  const ext = (score.filePath || "").split(".").pop() || "pdf";
  const name = encodeURIComponent(String(score.title || "score").replace(/[\\/:*?"<>|]/g, "").trim() || "score");
  return `${SITE}/f/${score.id}/${name}.${ext}${query}`;
}

// 설정에 따라 사진·PDF·카드를 보내고, 하나도 못 보내면 링크를 보냄
async function sendScore(token, igsid, score, link, settings) {
  const sent = [];
  const isPdf = /\.pdf$/i.test(score.filePath || "") || String(score.fileType || "").includes("pdf");
  const pages = Math.min(Number(score.pageCount || 0), 10);

  if (settings.sendImages !== false && pages > 0) {
    try {
      const v = encodeURIComponent(score.pagesVersion || 1);
      const attachments = Array.from({ length: pages }, (_, i) => ({
        type: "image",
        payload: { url: `${SITE}/f/${score.id}?page=${i + 1}&v=${v}` },
      }));
      await graphPost("/me/messages", token, { recipient: { id: igsid }, message: { attachments } });
      sent.push("images");
    } catch (e) {
      logger.warn("악보 사진 발송 실패", { igsid, error: e.detail || e.message });
    }
  }
  if (settings.sendPdf !== false && isPdf) {
    try {
      await graphPost("/me/messages", token, {
        recipient: { id: igsid },
        message: { attachment: { type: "file", payload: { url: fileUrl(score, "?raw=1") } } },
      });
      sent.push("pdf");
    } catch (e) {
      logger.warn("PDF 발송 실패", { igsid, error: e.detail || e.message });
    }
  }
  if (settings.sendCard === true || !sent.length) {
    try {
      await sendCard(token, igsid, score, link);
      sent.push("card");
    } catch (e) {
      logger.warn("카드 발송 실패", { igsid, error: e.detail || e.message });
    }
  }
  if (!sent.length) {
    await sendDm(token, igsid, link);
    sent.push("link");
  }
  return sent;
}

async function sendCard(token, igsid, score, link) {
  const sub = [score.instrument, score.artist].filter(Boolean).join(" · ") || "주니퍼 실용음악학원";
  return graphPost("/me/messages", token, {
    recipient: { id: igsid },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: [
            {
              title: `「${score.title}」 악보`.slice(0, 80),
              subtitle: `${sub} · 눌러서 악보 열기`.slice(0, 80),
              image_url: coverUrl(score),
              default_action: { type: "web_url", url: link },
              buttons: [{ type: "web_url", url: link, title: "악보 열기" }],
            },
          ],
        },
      },
    },
  });
}

async function handleMessage(igUserId, m) {
  const igsid = m.sender?.id;
  if (!igsid || igsid === igUserId) return;
  const text = m.message?.text || "";
  const payload = m.message?.quick_reply?.payload || m.postback?.payload || "";

  const settings = await getSettings();
  const token = await getAccessToken();

  if (norm(text).includes("데이터삭제")) {
    const who = await db.doc(`people/${igsid}`).get();
    await db.collection("deletionRequests").add({
      igsid,
      username: who.exists ? who.get("username") || "" : "",
      text,
      createdAt: FieldValue.serverTimestamp(),
    });
    try {
      await sendDm(token, igsid, settings.msgDeletion);
    } catch (e) {
      logger.warn("삭제 접수 안내 실패", { error: e.message });
    }
    return;
  }

  const personRef = db.doc(`people/${igsid}`);
  const personSnap = await personRef.get();
  const person = personSnap.exists ? personSnap.data() : null;
  const pending = person?.pending || {};
  const mediaIds = Object.keys(pending);
  if (!mediaIds.length) {
    logger.info("대기 중인 요청 없는 DM", { igsid, text, payload });
    return;
  }

  // 팔로우 여부 조회 (사용자가 DM으로 응답한 뒤에만 가능)
  const prof = await graphGet(`/${igsid}?fields=username,is_user_follow_business`, token);
  const following = prof.ok ? !!prof.data.is_user_follow_business : null;
  const username = (prof.ok && prof.data.username) || person.username || "";
  if (!prof.ok) logger.warn("팔로우 조회 실패", { igsid, error: prof.data?.error?.message });

  const updates = { lastSeenAt: FieldValue.serverTimestamp(), username };
  if (following !== null) {
    updates.isFollowing = following;
    if (person.initiallyFollowing === undefined || person.initiallyFollowing === null) {
      updates.initiallyFollowing = following;
    }
  }

  // 처음엔 미팔로우였다가 지금 팔로우 → 전환
  const converted =
    following === true && person.initiallyFollowing === false && !person.convertedAt;
  if (converted) {
    updates.convertedAt = FieldValue.serverTimestamp();
    const askedMedia = mediaIds.filter((id) => pending[id]?.asked);
    await bump(null, { converted: 1 });
    for (const id of askedMedia) if (id !== "none") await db.doc(`posts/${id}`).set({ stats: { converted: FieldValue.increment(1) } }, { merge: true });
  }

  const account = (await getAccount(token)).username || "";
  const needFollow = [];
  const deliver = [];

  for (const mediaId of mediaIds) {
    const cfg = await resolvePostConfig(mediaId === "none" ? "" : mediaId, settings);
    const item = pending[mediaId];
    if (!item.responded) {
      item.responded = true;
      await bump(mediaId === "none" ? null : mediaId, { responded: 1 });
    }
    // 조회 실패(null)면 막지 않고 보냄
    if (cfg.followersOnly && following === false) needFollow.push({ mediaId, cfg, item });
    else deliver.push({ mediaId, cfg, item });
  }

  const newPending = { ...pending };

  for (const { mediaId, cfg } of deliver) {
    const score = await getScore(cfg.scoreId);
    const link = score ? `${SITE}/s/${score.id}` : "";
    const vars = { username, account, title: score?.title ? `「${score.title}」 ` : "", link };
    try {
      let via = "text";
      if (score) {
        // 안내 글(링크 없이) → 악보 사진 → PDF 파일 → (선택) 악보 페이지 카드
        const intro = tidy(fill(settings.msgDelivery, { ...vars, link: "" }));
        if (intro) await sendDm(token, igsid, intro);
        const sent = await sendScore(token, igsid, score, link, settings);
        via = sent.join("+") || "none";
      } else {
        await sendDm(token, igsid, fill(settings.msgNoScore, vars));
      }
      await logDm({ igsid, username, mediaId, scoreId: score?.id || null, type: score ? "delivery" : "no_score", status: "sent", following, via });
      await bump(mediaId === "none" ? null : mediaId, { delivered: 1 });
      delete newPending[mediaId];
      updates.deliveredCount = FieldValue.increment(1);
    } catch (e) {
      await logDm({ igsid, username, mediaId, scoreId: score?.id || null, type: "delivery", status: "failed", error: e.message });
      logger.error("악보 발송 실패", { igsid, error: e.detail || e.message });
    }
  }

  if (needFollow.length) {
    const titles = [];
    for (const { cfg } of needFollow) {
      const s = await getScore(cfg.scoreId);
      if (s?.title) titles.push(s.title);
    }
    const vars = { username, account, title: titles.length ? `「${titles.join(", ")}」 ` : "" };
    try {
      await sendDm(token, igsid, fill(settings.msgFollowAsk, vars), quickReplies(settings.followButtonLabel, PAYLOAD_FOLLOW));
      await logDm({ igsid, username, mediaId: needFollow[0].mediaId, type: "follow_ask", status: "sent", following });
    } catch (e) {
      await logDm({ igsid, username, mediaId: needFollow[0].mediaId, type: "follow_ask", status: "failed", error: e.message });
    }
    for (const { mediaId } of needFollow) {
      if (!newPending[mediaId].asked) {
        newPending[mediaId] = { ...newPending[mediaId], asked: true };
        await bump(mediaId === "none" ? null : mediaId, { followAsked: 1 });
      }
    }
  }

  // pending 맵 통째로 교체 (발송 끝난 요청은 빠짐)
  for (const id of Object.keys(newPending)) newPending[id] = { ...newPending[id], responded: true };
  await personRef.update({ ...updates, pending: newPending });
}

// ---------- 웹훅 ----------

exports.igWebhook = onRequest(
  { secrets: [IG_VERIFY_TOKEN, IG_APP_SECRET, IG_ACCESS_TOKEN], timeoutSeconds: 60 },
  async (req, res) => {
    if (req.method === "GET") {
      const mode = req.query["hub.mode"];
      const token = req.query["hub.verify_token"];
      const challenge = req.query["hub.challenge"];
      if (mode === "subscribe" && token === IG_VERIFY_TOKEN.value()) {
        logger.info("웹훅 구독 확인 성공");
        res.status(200).send(challenge);
      } else {
        logger.warn("웹훅 구독 확인 실패 (인증 토큰 불일치)");
        res.sendStatus(403);
      }
      return;
    }
    if (req.method !== "POST") {
      res.sendStatus(405);
      return;
    }
    if (!isValidSignature(req, IG_APP_SECRET.value())) {
      logger.error("서명 불일치: IG_APP_SECRET 값이 Instagram 앱 시크릿 코드와 같은지 확인하세요");
      res.sendStatus(403);
      return;
    }

    const body = req.body || {};
    logger.info("웹훅 수신", { object: body.object, entries: (body.entry || []).length });

    try {
      for (const entry of body.entry || []) {
        const igUserId = String(entry.id || "");
        for (const change of entry.changes || []) {
          if (change.field === "comments" || change.field === "live_comments") {
            await handleComment(igUserId, change.value);
          }
        }
        for (const m of entry.messaging || []) {
          if (m.message?.is_echo) continue;
          if (!m.message && !m.postback) continue; // 읽음·반응 등은 무시
          if (m.message?.is_deleted) continue;
          await handleMessage(igUserId, m);
        }
      }
    } catch (e) {
      logger.error("웹훅 처리 중 오류", { error: e.message, stack: e.stack });
    }
    res.sendStatus(200);
  }
);

// ---------- 관리자 API (관리자 페이지에서 호출) ----------

exports.admin = onCall({ secrets: [IG_ACCESS_TOKEN], timeoutSeconds: 30 }, async (request) => {
  const email = request.auth?.token?.email;
  if (!email || !request.auth?.token?.email_verified || !(await isAdminEmail(email))) {
    throw new HttpsError("permission-denied", "관리자만 사용할 수 있어요.");
  }
  const token = await getAccessToken();
  const action = request.data?.action;

  if (action === "listMedia") {
    const after = request.data?.after ? `&after=${encodeURIComponent(request.data.after)}` : "";
    const r = await graphGet(
      `/me/media?fields=id,caption,media_type,media_product_type,thumbnail_url,media_url,permalink,timestamp,comments_count,like_count&limit=30${after}`,
      token
    );
    if (!r.ok) throw new HttpsError("internal", r.data?.error?.message || "게시물을 불러오지 못했어요.");
    return { items: r.data.data || [], after: r.data.paging?.cursors?.after || null, hasNext: !!r.data.paging?.next };
  }

  if (action === "status") {
    const me = await graphGet("/me?fields=user_id,username,account_type,followers_count,follows_count,media_count,profile_picture_url", token);
    const subs = await graphGet("/me/subscribed_apps", token);
    const tok = await db.doc("system/token").get();
    if (me.ok && me.data.username) {
      await db.doc("public/site").set({ account: me.data.username, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    }
    return {
      account: me.ok ? me.data : { error: me.data?.error?.message },
      subscribedFields: subs.ok ? (subs.data.data || []).flatMap((a) => a.subscribed_fields || []) : [],
      subscribeError: subs.ok ? null : subs.data?.error?.message,
      tokenRefreshedAt: tok.exists ? tok.get("updatedAt")?.toDate?.().toISOString() : null,
      tokenExpiresInDays: tok.exists ? tok.get("expiresInDays") : null,
    };
  }

  if (action === "resubscribe") {
    const r = await fetch(
      `${GRAPH}/me/subscribed_apps?subscribed_fields=comments,messages&access_token=${encodeURIComponent(token)}`,
      { method: "POST" }
    );
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new HttpsError("internal", d?.error?.message || "재구독 실패");
    return d;
  }

  throw new HttpsError("invalid-argument", "알 수 없는 요청이에요.");
});

// ---------- 악보 파일 전달 (/f/{scoreId}, ?dl=1 이면 다운로드) ----------

exports.scoreFile = onRequest({ timeoutSeconds: 60 }, async (req, res) => {
  // /f/{id} 또는 /f/{id}/{파일이름}
  const segs = req.path.split("/").filter(Boolean);
  const id = String((segs[0] === "f" ? segs[1] : segs[0]) || "").replace(/[^A-Za-z0-9]/g, "");
  if (!id) {
    res.status(404).send("악보를 찾을 수 없어요");
    return;
  }
  const snap = await db.doc(`scores/${id}`).get();
  if (!snap.exists || !snap.get("filePath")) {
    res.status(404).send("악보를 찾을 수 없어요");
    return;
  }
  // DM으로 보내는 악보 사진 (페이지별)
  if (req.query.page) {
    const n = parseInt(req.query.page, 10);
    if (!(n >= 1 && n <= Number(snap.get("pageCount") || 0))) {
      res.status(404).send("페이지가 없어요");
      return;
    }
    res.set("Content-Type", "image/jpeg");
    res.set("Cache-Control", "public, max-age=86400");
    getStorage().bucket().file(`scores/${id}/page-${n}.jpg`).createReadStream()
      .on("error", () => { if (!res.headersSent) res.status(404).send("페이지가 없어요"); else res.end(); })
      .pipe(res);
    return;
  }
  // 카드·미리보기용 표지 이미지
  if (req.query.cover === "1") {
    const cp = snap.get("coverPath");
    if (!cp) {
      res.redirect(302, "/og/score.png");
      return;
    }
    res.set("Content-Type", "image/jpeg");
    res.set("Cache-Control", "public, max-age=86400");
    getStorage().bucket().file(cp).createReadStream()
      .on("error", () => { if (!res.headersSent) res.redirect(302, "/og/score.png"); else res.end(); })
      .pipe(res);
    return;
  }
  // 악보 페이지에서 저장했을 때 다운로드 수만 올림
  if (req.query.count === "1") {
    await snap.ref.update({ downloads: FieldValue.increment(1) }).catch(() => {});
    res.status(204).end();
    return;
  }
  const s = snap.data();
  const download = req.query.dl === "1";
  const ext = (s.filePath.split(".").pop() || "pdf").toLowerCase();
  const name = `${String(s.title || "score").replace(/[\\/:*?"<>|]/g, "")}.${ext}`;
  res.set("Content-Type", s.fileType || "application/pdf");
  res.set("Cache-Control", "private, max-age=300");
  res.set(
    "Content-Disposition",
    `${download ? "attachment" : "inline"}; filename="score.${ext}"; filename*=UTF-8''${encodeURIComponent(name)}`
  );
  if (req.query.raw !== "1") {
    snap.ref.update({ [download ? "downloads" : "views"]: FieldValue.increment(1) }).catch(() => {});
  }
  getStorage()
    .bucket()
    .file(s.filePath)
    .createReadStream()
    .on("error", (e) => {
      logger.error("악보 파일 읽기 실패", { id, error: e.message });
      if (!res.headersSent) res.status(500).send("파일을 불러오지 못했어요");
      else res.end();
    })
    .pipe(res);
});

// ---------- 악보 페이지 (/s/{scoreId}): 링크 미리보기용 제목·이미지를 넣어서 전달 ----------

let pageTemplate = { at: 0, html: "" };
const escHtml = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

exports.scorePage = onRequest({ timeoutSeconds: 30 }, async (req, res) => {
  if (!pageTemplate.html || Date.now() - pageTemplate.at > 5 * 60_000) {
    const r = await fetch(`${SITE}/score`);
    if (r.ok) pageTemplate = { at: Date.now(), html: await r.text() };
  }
  if (!pageTemplate.html) {
    res.redirect(302, "/score");
    return;
  }
  const id = (req.path.split("/").filter(Boolean).pop() || "").replace(/[^A-Za-z0-9]/g, "");
  const snap = id ? await db.doc(`scores/${id}`).get() : null;
  const score = snap && snap.exists ? { id: snap.id, ...snap.data() } : null;

  const title = score ? `${score.title} 악보 · 주니퍼 실용음악학원` : "악보 · 주니퍼 실용음악학원";
  const desc = score
    ? `${[score.instrument, score.artist].filter(Boolean).join(" · ")} 악보를 눌러서 보고 저장하세요.`.trim()
    : "주니퍼 실용음악학원 악보";
  const image = score ? coverUrl(score) : `${SITE}/og/score.png`;
  const url = `${SITE}/s/${id}`;
  const meta = [
    `<title>${escHtml(title)}</title>`,
    `<meta name="description" content="${escHtml(desc)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="주니퍼 실용음악학원">`,
    `<meta property="og:title" content="${escHtml(score ? `「${score.title}」 악보` : "악보")}">`,
    `<meta property="og:description" content="${escHtml(desc)}">`,
    `<meta property="og:image" content="${escHtml(image)}">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta property="og:url" content="${escHtml(url)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
  ].join("\n");
  const html = pageTemplate.html.replace(/<title>[\s\S]*?<\/title>/, meta);
  res.set("Content-Type", "text/html; charset=utf-8");
  res.set("Cache-Control", "public, max-age=60, s-maxage=300");
  res.status(score ? 200 : 404).send(html);
});

// ---------- 상태 점검 (브라우저로 열기) ----------

exports.igStatus = onRequest(
  { secrets: [IG_VERIFY_TOKEN, IG_ACCESS_TOKEN], timeoutSeconds: 30 },
  async (req, res) => {
    if (req.query.key !== IG_VERIFY_TOKEN.value()) {
      res.sendStatus(403);
      return;
    }
    const token = await getAccessToken();
    const out = {};
    const me = await graphGet("/me?fields=user_id,username,account_type", token);
    out.account = me.ok ? me.data : { error: me.data?.error?.message || me.data };
    if (req.query.subscribe === "1") {
      const r = await fetch(
        `${GRAPH}/me/subscribed_apps?subscribed_fields=comments,messages&access_token=${encodeURIComponent(token)}`,
        { method: "POST" }
      );
      const d = await r.json().catch(() => ({}));
      out.subscribeResult = r.ok ? d : { error: d?.error?.message || d };
    }
    const subs = await graphGet("/me/subscribed_apps", token);
    out.subscribedApps = subs.ok ? subs.data : { error: subs.data?.error?.message || subs.data };
    const recent = await db.collection("comments").orderBy("createdAt", "desc").limit(5).get();
    out.recentComments = recent.docs.map((d) => {
      const x = d.data();
      return { id: d.id, username: x.username, text: x.text, action: x.action, dmError: x.dmError };
    });
    res.set("Content-Type", "application/json; charset=utf-8");
    res.set("Cache-Control", "no-store");
    res.status(200).send(JSON.stringify(out, null, 2));
  }
);

// ---------- 토큰 자동 갱신 (매주 월요일 새벽 4시) ----------

exports.refreshToken = onSchedule(
  { schedule: "0 4 * * 1", timeZone: "Asia/Seoul", secrets: [IG_ACCESS_TOKEN] },
  async () => {
    const current = await getAccessToken();
    const url = `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(current)}`;
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      logger.error("토큰 갱신 실패", { error: data?.error || res.status });
      return;
    }
    await db.doc("system/token").set({
      value: data.access_token,
      expiresInDays: Math.round((data.expires_in || 0) / 86400),
      updatedAt: FieldValue.serverTimestamp(),
    });
    logger.info("토큰 갱신 완료", { expiresInDays: Math.round((data.expires_in || 0) / 86400) });
  }
);

// ---------- 팔로워 수 기록 (매일 밤 11시 55분) ----------

exports.dailySnapshot = onSchedule(
  { schedule: "55 23 * * *", timeZone: "Asia/Seoul", secrets: [IG_ACCESS_TOKEN] },
  async () => {
    const token = await getAccessToken();
    const me = await graphGet("/me?fields=followers_count,media_count", token);
    if (!me.ok) {
      logger.error("팔로워 수 조회 실패", { error: me.data?.error });
      return;
    }
    const date = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    const totals = await db.doc("stats/totals").get();
    await db.doc(`daily/${date}`).set({
      date,
      followers: me.data.followers_count ?? null,
      media: me.data.media_count ?? null,
      totals: totals.exists ? totals.data() : {},
      at: FieldValue.serverTimestamp(),
    });
  }
);
