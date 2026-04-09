module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, message: "GET만 지원합니다." });
    return;
  }

  const required = [
    "WORK24_API_KEY",
    "RESEND_API_KEY",
    "NOTIFY_FROM_EMAIL"
  ];

  const kvAltA = ["KV_REST_API_URL", "KV_REST_API_TOKEN"];
  const kvAltB = ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"];

  const present = {};
  for (const key of [...required, ...kvAltA, ...kvAltB, "WORK24_SEEKER_API_URL", "CRON_SECRET"]) {
    present[key] = Boolean(process.env[key]);
  }

  const missingRequired = required.filter((k) => !present[k]);
  const hasKvA = kvAltA.every((k) => present[k]);
  const hasKvB = kvAltB.every((k) => present[k]);
  const kvReady = hasKvA || hasKvB;

  res.status(200).json({
    ok: true,
    ready: missingRequired.length === 0 && kvReady,
    requiredMissing: missingRequired,
    kvReady,
    kvMissingHint: kvReady ? [] : ["KV_REST_API_URL + KV_REST_API_TOKEN 또는 UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN 세트 필요"],
    optional: {
      WORK24_SEEKER_API_URL: present.WORK24_SEEKER_API_URL,
      CRON_SECRET: present.CRON_SECRET
    },
    present
  });
};
