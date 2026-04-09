const { redisCommand } = require("../_kv");

const JOBS_ENDPOINT = "https://www.work24.go.kr/cm/openApi/call/wk/callOpenApiSvcInfo210L01.do";

function getTagValue(xmlBlock, tags) {
  for (const tag of tags) {
    const regex = new RegExp("<" + tag + ">(.*?)</" + tag + ">", "i");
    const match = xmlBlock.match(regex);
    if (match && match[1]) return decodeXml(match[1]);
  }
  return "";
}

function decodeXml(value) {
  return String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<!\[CDATA\[(.*?)\]\]>/g, "$1");
}

function extractBlocks(xml) {
  const blockTags = ["dhsOpenEmpInfoList", "empInfo", "item", "list", "row"];
  for (const tag of blockTags) {
    const regex = new RegExp("<" + tag + ">([\\s\\S]*?)</" + tag + ">", "gi");
    const matches = Array.from(xml.matchAll(regex)).map((m) => m[1]);
    if (matches.length) return matches;
  }
  return [];
}

function toItems(xml, kind) {
  const blocks = extractBlocks(xml);
  const rows = blocks.slice(0, 7).map((block) => {
    if (kind === "jobs") {
      const title = getTagValue(block, ["jobNm", "wantedTitle", "joSj", "recruitmentTitle"]) || "채용 공고";
      const company = getTagValue(block, ["cmpnyNm", "corpNm", "enterpriseNm"]);
      const region = getTagValue(block, ["region", "workRegion", "workPararBassAdresCn", "workPlace"]);
      return [title, company, region].filter(Boolean).join(" / ");
    }

    const title = getTagValue(block, ["hopeJssfcCmmnCodeSeNm", "hopeJssfcNm", "jobNm", "title"]) || "구직자 정보";
    const career = getTagValue(block, ["career", "careerCndNm", "needCareerNm"]);
    const area = getTagValue(block, ["hopeWkplAddr", "region", "address", "workArea"]);
    return [title, career, area].filter(Boolean).join(" / ");
  });

  return rows.filter(Boolean);
}

async function callWork24(endpoint, params) {
  const url = new URL(endpoint);
  Object.keys(params).forEach((k) => {
    if (params[k]) url.searchParams.set(k, params[k]);
  });

  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/xml,text/xml" }
  });

  if (!response.ok) {
    throw new Error("고용24 API 호출 실패(HTTP " + response.status + ")");
  }

  return response.text();
}

function isExpired(endDate) {
  if (!endDate) return false;
  const now = new Date();
  const end = new Date(endDate + "T23:59:59+09:00");
  return now.getTime() > end.getTime();
}

async function sendEmail(to, subject, html, text) {
  const resendKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.NOTIFY_FROM_EMAIL;
  if (!resendKey || !fromEmail) {
    throw new Error("RESEND_API_KEY 또는 NOTIFY_FROM_EMAIL 환경변수가 설정되지 않았습니다.");
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + resendKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [to],
      subject,
      html,
      text
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error("메일 발송 실패: " + errText);
  }
}

function buildMail(subscription, rows, portalUrl) {
  const title = subscription.type === "seeker"
    ? "[고용24] 구직 담당자 주간 구인정보"
    : "[고용24] 구인 담당자 주간 구직자정보";

  const intro = subscription.name
    ? subscription.name + " 담당자님, 이번 주 조회 결과입니다."
    : "담당자님, 이번 주 조회 결과입니다.";

  const listHtml = rows.length
    ? "<ul>" + rows.map((r) => "<li>" + r.replace(/</g, "&lt;").replace(/>/g, "&gt;") + "</li>").join("") + "</ul>"
    : "<p>이번 주 조회 결과가 없습니다.</p>";

  const listText = rows.length
    ? rows.map((r, idx) => (idx + 1) + ". " + r).join("\n")
    : "이번 주 조회 결과가 없습니다.";

  const html = [
    "<p>" + intro + "</p>",
    listHtml,
    '<p><a href="' + portalUrl + '">고용24 바로가기</a></p>'
  ].join("");

  const text = [
    intro,
    "",
    listText,
    "",
    "고용24 바로가기: " + portalUrl
  ].join("\n");

  return { title, html, text };
}

module.exports = async function handler(req, res) {
  try {
    const isVercelCron = req.headers["x-vercel-cron"] === "1";
    const cronSecret = process.env.CRON_SECRET;
    const authHeader = req.headers.authorization || "";

    if (!isVercelCron && (!cronSecret || authHeader !== "Bearer " + cronSecret)) {
      res.status(401).json({ ok: false, message: "Unauthorized" });
      return;
    }

    const apiKey = process.env.WORK24_API_KEY;
    if (!apiKey) {
      res.status(500).json({ ok: false, message: "WORK24_API_KEY가 설정되지 않았습니다." });
      return;
    }

    const seekerEndpoint = process.env.WORK24_SEEKER_API_URL || "";
    const ids = await redisCommand(["SMEMBERS", "weekly:subs"]);
    let sent = 0;
    let stopped = 0;
    const errors = [];

    for (const subId of ids || []) {
      const key = "weekly:" + subId;
      const raw = await redisCommand(["GET", key]);
      if (!raw) continue;

      let sub;
      try {
        sub = JSON.parse(raw);
      } catch (e) {
        continue;
      }

      if (!sub.active) continue;

      if (isExpired(sub.endDate)) {
        sub.active = false;
        sub.stoppedAt = new Date().toISOString();
        sub.updatedAt = new Date().toISOString();
        await redisCommand(["SET", key, JSON.stringify(sub)]);
        stopped += 1;
        continue;
      }

      try {
        let rows = [];
        let portalUrl = "https://www.work24.go.kr";

        if (sub.type === "seeker") {
          const keyword = [sub.filters && sub.filters.wishJob, sub.filters && sub.filters.wishArea, sub.filters && sub.filters.wishPay].filter(Boolean).join(" ");
          const xml = await callWork24(JOBS_ENDPOINT, {
            authKey: apiKey,
            returnType: "XML",
            callTp: "L",
            startPage: "1",
            display: "7"
          });
          rows = toItems(xml, "jobs");
          portalUrl = "https://www.work24.go.kr/cm/main.do#search=" + encodeURIComponent(keyword || "채용정보");
        } else {
          if (!seekerEndpoint) {
            rows = ["WORK24_SEEKER_API_URL이 설정되지 않아 구직자 목록 API 조회를 생략했습니다."];
            portalUrl = "https://www.work24.go.kr";
          } else {
            const keyword = [sub.filters && sub.filters.jobTitle, sub.filters && sub.filters.workPlace].filter(Boolean).join(" ");
            const xml = await callWork24(seekerEndpoint, {
              authKey: apiKey,
              returnType: "XML",
              callTp: "L",
              startPage: "1",
              display: "7"
            });
            rows = toItems(xml, "seekers");
            portalUrl = "https://www.work24.go.kr/cm/main.do#search=" + encodeURIComponent(keyword || "구직자정보");
          }
        }

        const mail = buildMail(sub, rows, portalUrl);
        await sendEmail(sub.email, mail.title, mail.html, mail.text);

        sub.lastSentAt = new Date().toISOString();
        sub.updatedAt = new Date().toISOString();
        await redisCommand(["SET", key, JSON.stringify(sub)]);
        sent += 1;
      } catch (error) {
        errors.push({ id: subId, email: sub.email, message: error.message });
      }
    }

    res.status(200).json({
      ok: true,
      sent,
      stopped,
      errors
    });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message || "주간 발송 중 오류가 발생했습니다." });
  }
};
