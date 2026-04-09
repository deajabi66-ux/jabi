const JOBS_ENDPOINT = "https://www.work24.go.kr/cm/openApi/call/wk/callOpenApiSvcInfo210L01.do";

function clean(value, maxLen) {
  return String(value || "").trim().slice(0, maxLen || 80);
}

function parseNumber(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

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

function toJobItems(xml) {
  const blocks = extractBlocks(xml);
  const items = blocks.map((block) => {
    const title = getTagValue(block, ["jobNm", "wantedTitle", "joSj", "recruitmentTitle"]);
    const company = getTagValue(block, ["cmpnyNm", "corpNm", "enterpriseNm"]);
    const region = getTagValue(block, ["region", "workRegion", "workPararBassAdresCn", "workPlace"]);
    const pay = getTagValue(block, ["salary", "wage", "pay", "hopeWage"]);
    const wantedAuthNo = getTagValue(block, ["wantedAuthNo", "joReqstNo", "joNo"]);

    const metaParts = [company, region, pay].filter(Boolean);
    return {
      title: title || "채용 공고",
      meta: metaParts.join(" / "),
      link: wantedAuthNo
        ? "https://www.work24.go.kr/wk/a/b/1200/retriveDtlEmpSrchList.do?wantedAuthNo=" + encodeURIComponent(wantedAuthNo)
        : "https://www.work24.go.kr"
    };
  }).filter((item) => item.title || item.meta);

  return items.slice(0, 10);
}

function toSeekerItems(xml) {
  const blocks = extractBlocks(xml);
  const items = blocks.map((block) => {
    const title = getTagValue(block, ["hopeJssfcCmmnCodeSeNm", "hopeWageTyNm", "hopeJssfcNm", "jobNm", "title"]);
    const career = getTagValue(block, ["career", "careerCndNm", "needCareerNm"]);
    const area = getTagValue(block, ["hopeWkplAddr", "region", "address", "workArea"]);
    const edu = getTagValue(block, ["acdmcrNm", "needEduNm", "education"]);

    const metaParts = [career, area, edu].filter(Boolean);
    return {
      title: title || "구직자 정보",
      meta: metaParts.join(" / "),
      link: "https://www.work24.go.kr"
    };
  }).filter((item) => item.title || item.meta);

  return items.slice(0, 10);
}

async function callWork24(endpoint, params) {
  const url = new URL(endpoint);
  Object.keys(params).forEach((key) => {
    if (params[key] !== undefined && params[key] !== null && params[key] !== "") {
      url.searchParams.set(key, params[key]);
    }
  });

  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/xml,text/xml" }
  });

  if (!response.ok) {
    throw new Error("고용24 API 호출 실패: HTTP " + response.status);
  }

  return response.text();
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, message: "GET 요청만 지원합니다." });
    return;
  }

  const apiKey = process.env.WORK24_API_KEY;
  if (!apiKey) {
    res.status(500).json({ ok: false, message: "서버 환경변수 WORK24_API_KEY가 설정되지 않았습니다." });
    return;
  }

  const mode = clean(req.query.mode || "jobs", 20).toLowerCase();
  const page = parseNumber(req.query.page, 1, 1, 1000);
  const display = parseNumber(req.query.display, 10, 1, 20);

  try {
    if (mode === "jobs") {
      const xml = await callWork24(JOBS_ENDPOINT, {
        authKey: apiKey,
        returnType: "XML",
        callTp: "L",
        startPage: String(page),
        display: String(display)
      });

      const items = toJobItems(xml);
      res.status(200).json({
        ok: true,
        mode: "jobs",
        items
      });
      return;
    }

    if (mode === "seekers") {
      const seekerEndpoint = process.env.WORK24_SEEKER_API_URL;
      if (!seekerEndpoint) {
        res.status(400).json({
          ok: false,
          message: "구직자 조회 API 엔드포인트(WORK24_SEEKER_API_URL)가 설정되지 않았습니다. 고용24에서 승인받은 구직자 조회 URL을 등록해 주세요."
        });
        return;
      }

      const xml = await callWork24(seekerEndpoint, {
        authKey: apiKey,
        returnType: "XML",
        callTp: "L",
        startPage: String(page),
        display: String(display)
      });

      const items = toSeekerItems(xml);
      res.status(200).json({
        ok: true,
        mode: "seekers",
        items
      });
      return;
    }

    res.status(400).json({ ok: false, message: "mode는 jobs 또는 seekers만 지원합니다." });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message || "고용24 연계 조회 중 오류가 발생했습니다." });
  }
};
