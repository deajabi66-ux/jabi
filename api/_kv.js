const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

function ensureRedisConfig() {
  if (!REDIS_URL || !REDIS_TOKEN) {
    throw new Error("Vercel KV(Upstash Redis) 환경변수가 설정되지 않았습니다.");
  }
}

function encodePart(v) {
  return encodeURIComponent(String(v));
}

async function redisCommand(parts) {
  ensureRedisConfig();
  const endpoint = REDIS_URL.replace(/\/+$/, "") + "/" + parts.map(encodePart).join("/");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + REDIS_TOKEN
    }
  });

  const payload = await response.json();
  if (!response.ok || payload.error) {
    throw new Error(payload.error || "KV 요청 실패");
  }
  return payload.result;
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function makeSubscriptionId(type, email) {
  return "sub:" + type + ":" + normalizeEmail(email);
}

module.exports = {
  redisCommand,
  normalizeEmail,
  makeSubscriptionId
};
