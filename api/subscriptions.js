const { redisCommand, normalizeEmail, makeSubscriptionId } = require("./_kv");

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error("요청 본문이 너무 큽니다."));
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(new Error("JSON 형식이 올바르지 않습니다."));
      }
    });
    req.on("error", reject);
  });
}

function parseDate(value) {
  const v = String(value || "").trim();
  if (!v) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new Error("종료일은 YYYY-MM-DD 형식이어야 합니다.");
  }
  return v;
}

function makeNowIso() {
  return new Date().toISOString();
}

async function upsertSubscription(body) {
  const type = String(body.type || "").trim().toLowerCase();
  if (type !== "seeker" && type !== "employer") {
    throw new Error("type은 seeker 또는 employer만 가능합니다.");
  }

  const email = normalizeEmail(body.email);
  if (!email) throw new Error("이메일이 필요합니다.");

  const subId = makeSubscriptionId(type, email);
  const key = "weekly:" + subId;
  const now = makeNowIso();

  let existing = null;
  const currentRaw = await redisCommand(["GET", key]);
  if (currentRaw) {
    try {
      existing = JSON.parse(currentRaw);
    } catch (e) {
      existing = null;
    }
  }

  const saved = {
    id: subId,
    type,
    email,
    name: String(body.name || "").trim(),
    endDate: parseDate(body.endDate),
    filters: body.filters && typeof body.filters === "object" ? body.filters : {},
    active: true,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
    stoppedAt: "",
    lastSentAt: existing ? existing.lastSentAt || "" : ""
  };

  await redisCommand(["SET", key, JSON.stringify(saved)]);
  await redisCommand(["SADD", "weekly:subs", subId]);

  return saved;
}

async function stopSubscription(body) {
  const type = String(body.type || "").trim().toLowerCase();
  if (type !== "seeker" && type !== "employer") {
    throw new Error("type은 seeker 또는 employer만 가능합니다.");
  }

  const email = normalizeEmail(body.email);
  if (!email) throw new Error("이메일이 필요합니다.");

  const subId = makeSubscriptionId(type, email);
  const key = "weekly:" + subId;
  const currentRaw = await redisCommand(["GET", key]);
  if (!currentRaw) {
    throw new Error("등록된 구독 정보가 없습니다.");
  }

  const current = JSON.parse(currentRaw);
  current.active = false;
  current.updatedAt = makeNowIso();
  current.stoppedAt = makeNowIso();

  await redisCommand(["SET", key, JSON.stringify(current)]);
  return current;
}

async function listSubscriptions(type) {
  const ids = await redisCommand(["SMEMBERS", "weekly:subs"]);
  const out = [];

  for (const subId of ids || []) {
    if (type && !String(subId).startsWith("sub:" + type + ":")) continue;
    const raw = await redisCommand(["GET", "weekly:" + subId]);
    if (!raw) continue;
    try {
      out.push(JSON.parse(raw));
    } catch (e) {
      // ignore invalid row
    }
  }

  return out;
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === "POST") {
      const body = await readBody(req);
      const action = String(body.action || "upsert").trim().toLowerCase();

      if (action === "upsert") {
        const data = await upsertSubscription(body);
        res.status(200).json({ ok: true, action, data });
        return;
      }

      if (action === "stop") {
        const data = await stopSubscription(body);
        res.status(200).json({ ok: true, action, data });
        return;
      }

      res.status(400).json({ ok: false, message: "action은 upsert 또는 stop만 가능합니다." });
      return;
    }

    if (req.method === "GET") {
      const type = String(req.query.type || "").trim().toLowerCase();
      const data = await listSubscriptions(type);
      res.status(200).json({ ok: true, count: data.length, data });
      return;
    }

    res.status(405).json({ ok: false, message: "GET/POST만 지원합니다." });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message || "구독 처리 중 오류가 발생했습니다." });
  }
};
