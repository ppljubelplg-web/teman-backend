
const { setGlobalOptions } = require("firebase-functions");
const { onRequest } = require("firebase-functions/https");
const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getDatabase } = require("firebase-admin/database");
const { randomBytes } = require("node:crypto");

setGlobalOptions({ maxInstances: 3 });

const emulatorHost = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const databaseURL = emulatorHost
  ? `http://${emulatorHost}/?ns=demo-teman-game-bkp-default-rtdb`
  : "https://teman-game-bkp-default-rtdb.asia-southeast1.firebasedatabase.app/";

const app = getApps().length
  ? getApps()[0]
 : initializeApp({
    credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)),
    databaseURL
  });

const auth = getAuth(app);
const db = getDatabase(app);

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const fail = (message, status = 400) =>
  Object.assign(new Error(message), { status });

function makeCode() {
  const bytes = randomBytes(8);
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join("");
}

function cors(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

async function userFromRequest(req) {
  const match = String(req.headers.authorization || "").match(/^Bearer (.+)$/i);
  if (!match) throw fail("Token autentikasi tidak ditemukan.", 401);
  try {
    return await auth.verifyIdToken(match[1]);
  } catch {
    throw fail("Token autentikasi tidak valid.", 401);
  }
}

function membersOf(room) {
  return Object.values(room.players || {})
    .filter(p => p?.uid)
    .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
}

function requireMember(room, uid) {
  const player = room?.players?.[uid];
  if (!player) throw fail("Kamu bukan anggota ruang ini.", 403);
  return player;
}

function requireTurn(room, uid) {
  if (room.meta?.state !== "playing") {
    throw fail("Permainan belum dimulai.");
  }
  requireMember(room, uid);
  if (room.game?.turn?.uid !== uid) {
    throw fail("Bukan giliran kamu.", 403);
  }
  if (membersOf(room).findIndex(p => p.uid === uid) >= 6) {
    throw fail("Pengamat tidak dapat menjalankan giliran.", 403);
  }
  return room.game.turn.revision;
}

function initialGame() {
  return {
    turn: { uid: null, revision: 0 },
    dice: { phase: "idle", value: 0, turnRevision: 0 },
    positions: {},
    wheel: null,
    mission: { pending: false, turnRevision: 0, phase: "idle" },
    answers: {},
    scores: {},
    finish: {}
  };
}

async function updateRoom(code, uid, action, payload = {}) {
  const ref = db.ref(`rooms/${code}`);
  const result = await ref.transaction(room => {
    if (!room) return;
    const players = room.players || {};
    const game = room.game || initialGame();
    const member = players[uid];

    if (!member) return;

    const now = Date.now();
    const next = JSON.parse(JSON.stringify(room));

    switch (action) {
      case "ready": {
        if (room.meta.state !== "waiting") return;
        next.players[uid].ready = !member.ready;
        next.players[uid].connected = true;
        break;
      }

      case "start": {
        if (room.meta.hostUid !== uid || room.meta.state !== "waiting") return;
        const roster = membersOf(room);
        if (roster.length < 2 || roster.slice(0, 6).some(p => !p.ready)) return;
        next.meta.state = "playing";
        next.game.turn = { uid: roster[0].uid, revision: 1 };
        next.game.dice = { phase: "idle", value: 0, turnRevision: 1 };
        next.game.mission = { pending: false, turnRevision: 1, phase: "idle" };
        break;
      }

      case "leaveRoom": {
        next.players[uid].connected = false;
        next.players[uid].ready = false;
        break;
      }

      case "roll": {
        const rev = requireTurn(room, uid);
        const value = Number(payload.value);
        if (!Number.isInteger(value) || value < 1 || value > 6) return;
        if (game.dice?.phase !== "idle" ||
            game.dice?.turnRevision !== rev ||
            game.mission?.pending) return;
        next.game.dice = { phase: "rolled", value, turnRevision: rev, by: uid };
        break;
      }

      case "move": {
        const rev = requireTurn(room, uid);
        if (game.dice?.phase !== "rolled" ||
            game.dice.by !== uid ||
            game.dice.turnRevision !== rev) return;

        const index = membersOf(room).findIndex(p => p.uid === uid);
        const old = game.positions?.[uid] ||
          { type: "start", startId: `start-${index}` };
        const oldIndex = old.type === "start" ? index * 9 - 1 : old.trackIndex;
        const trackIndex = (oldIndex + game.dice.value) % 54;
        const challenge = trackIndex % 3 === 0;

        next.game.positions[uid] = { type: "track", trackIndex };
        next.game.dice = { ...game.dice, phase: "moved" };

        if (challenge) {
          next.game.mission = {
            pending: true,
            turnRevision: rev,
            cardType: ["B/S", "PG", "T"][trackIndex % 3],
            phase: "wheel"
          };
        } else {
          advanceTurn(next, room, uid);
        }
        break;
      }

      case "spin": {
        const rev = requireTurn(room, uid);
        const categories = [
          "MENYAPA", "BERBICARA", "BERGABUNG",
          "MENDENGAR", "MERESPONS", "BERANI"
        ];
        if (!game.mission?.pending ||
            game.mission.phase !== "wheel" ||
            game.mission.turnRevision !== rev ||
            !categories.includes(payload.category)) return;

        next.game.wheel = { category: payload.category, turnRevision: rev };
        next.game.mission.phase = "choose";
        break;
      }

      case "selectCard": {
        const rev = requireTurn(room, uid);
        const allowed = { "B/S": "tf", "PG": "mc", T: "challenge" };
        if (!game.mission?.pending ||
            game.mission.phase !== "choose" ||
            !game.wheel?.category ||
            allowed[game.mission.cardType] !== payload.type) return;

        next.game.mission.phase = "card";
        next.game.mission.selectedType = payload.type;
        next.game.mission.category = game.wheel.category;
        next.game.mission.turnRevision = rev;
        break;
      }

      case "answer": {
        const rev = requireTurn(room, uid);
        if (!game.mission?.pending ||
            game.mission.phase !== "card" ||
            !["mc", "tf"].includes(game.mission.selectedType) ||
            game.mission.turnRevision !== rev ||
            typeof payload.correct !== "boolean") return;

        next.game.answers[uid] = {
          turnRevision: rev,
          answer: String(payload.answer ?? ""),
          correct: payload.correct,
          category: game.mission.category,
          updatedAt: now
        };

        if (payload.correct) {
          const score = next.game.scores[uid] ||
            { points: 0, mcDone: false, challengeDone: false };
          if (!score.mcDone) {
            score.points += 1;
            score.mcDone = true;
          }
          next.game.scores[uid] = score;
        }
        break;
      }

      case "challengeSuccess": {
        const rev = requireTurn(room, uid);
        if (!game.mission?.pending ||
            game.mission.phase !== "card" ||
            game.mission.selectedType !== "challenge" ||
            game.mission.turnRevision !== rev) return;

        const score = next.game.scores[uid] ||
          { points: 0, mcDone: false, challengeDone: false };
        if (!score.challengeDone) {
          score.points += 2;
          score.challengeDone = true;
        }
        next.game.scores[uid] = score;
        break;
      }

      case "finish": {
        requireTurn(room, uid);
        if (payload.uid && payload.uid !== uid) return;
        next.game.finish[uid] = true;
        break;
      }

      case "nextTurn":
      case "skip":
      case "finishMission": {
        const rev = requireTurn(room, uid);
        if (action === "finishMission" && !game.mission?.pending) return;
        advanceTurn(next, room, uid);
        if (next.game.turn.revision !== rev + 1) return;
        break;
      }

      default:
        throw fail("Aksi belum didukung.");
    }

    return next;
  }, undefined, false);

  if (!result.committed) {
    throw fail("Perubahan tidak diterima. Periksa giliran dan status permainan.", 409);
  }
  return result.snapshot.val();
}

function advanceTurn(next, room, uid) {
  const roster = membersOf(room).slice(0, 6);
  if (!roster.length) return;

  const current = roster.findIndex(p => p.uid === uid);
  const nextPlayer = roster[(current + 1) % roster.length];

  next.game.turn = {
    uid: nextPlayer.uid,
    revision: (room.game?.turn?.revision || 0) + 1
  };
  next.game.dice = {
    phase: "idle",
    value: 0,
    turnRevision: next.game.turn.revision
  };
  next.game.mission = {
    pending: false,
    turnRevision: next.game.turn.revision,
    phase: "idle"
  };
  next.game.wheel = null;
}

exports.temanHealth = onRequest((req, res) => {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  return res.status(200).json({
    ok: true,
    service: "TEMAN backend",
    message: "Backend aktif",
    database: emulatorHost ? "emulator" : "production"
  });
});

exports.temanApi = onRequest(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Gunakan POST." });
  }

  try {
    const user = await userFromRequest(req);
    const uid = user.uid;
    const body = req.body || {};
    const action = String(body.action || "");
    const name = String(body.name || "Teman").trim().slice(0, 24) || "Teman";
    let code = String(body.code || "").trim().toUpperCase();

    if (action === "createRoom") {
      for (let i = 0; i < 5; i++) {
        code = makeCode();
        const room = {
          meta: {
            hostUid: uid, state: "waiting",
            createdAt: Date.now(), capacity: 15
          },
          players: {
            [uid]: {
              uid, name, ready: false, connected: true,
              joinedAt: Date.now()
            }
          },
          game: initialGame()
        };
        const result = await db.ref(`rooms/${code}`).transaction(
          current => current == null ? room : undefined
        );
        if (result.committed) {
          return res.json({ ok: true, code, room: result.snapshot.val() });
        }
      }
      throw fail("Gagal membuat ruang. Coba lagi.", 503);
    }

    if (!/^[A-HJ-NP-Z2-9]{8}$/.test(code)) {
      throw fail("Kode ruang harus terdiri dari 8 karakter.");
    }

    if (action === "joinRoom") {
      const ref = db.ref(`rooms/${code}`);
      const result = await ref.transaction(room => {
        if (!room?.meta) return;
        const existing = room.players?.[uid];
        const count = Object.keys(room.players || {}).length;
        if (room.meta.state !== "waiting" && !existing) return;
        if (!existing && count >= 15) return;
        return {
          ...room,
          players: {
            ...(room.players || {}),
            [uid]: existing
              ? { ...existing, connected: true }
              : { uid, name, ready: false, connected: true, joinedAt: Date.now() }
          }
        };
      }, undefined, false);

      if (!result.committed) throw fail("Ruang tidak ditemukan, penuh, atau sudah dimulai.", 409);
      return res.json({ ok: true, code, room: result.snapshot.val() });
    }

    const room = await updateRoom(code, uid, action, body);
    return res.json({ ok: true, code, room });
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error("TEMAN API ERROR:", error);
    return res.status(status).json({
      ok: false,
      error: status >= 500 ? "Kesalahan backend. Periksa log Firebase." : error.message
    });
  }
});
