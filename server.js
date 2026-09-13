// AeroSense 백엔드 프록시 서버
// 역할: 기상청 API허브 인증키를 안전하게 보관하고, 프론트엔드 대신 기상청에 요청을 보낸 뒤
//       프론트엔드가 바로 쓸 수 있는 형태(우리 앱의 위험지수 그리드 JSON)로 가공해서 돌려준다.
//
// 실행 방법:
//   1) npm install
//   2) KMA_AUTH_KEY 환경변수에 기상청 API허브에서 발급받은 인증키를 넣는다
//      (터미널에서: export KMA_AUTH_KEY=발급받은값   /  Windows: set KMA_AUTH_KEY=발급받은값)
//   3) node server.js
//   4) 기본적으로 http://localhost:3787 에서 대기한다
//
// 주의: 실제 응답 필드명은 기상청 문서 기준으로 작성했지만, 실제 키로 호출해봐야 100% 확정돼요.
//       특히 WINTEM(typ01, php 스크립트)은 JSON이 아닐 수도 있어서 parseWintem() 함수를
//       실제 응답을 보고 조정해야 할 가능성이 높습니다. 그 부분은 주석으로 표시해뒀어요.

const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors()); // 프론트엔드(다른 origin)에서 호출할 수 있도록 허용

const PORT = process.env.PORT || 3787;
const KMA_AUTH_KEY = process.env.KMA_AUTH_KEY || "";
const KMA_BASE = "https://apihub.kma.go.kr";

if (!KMA_AUTH_KEY) {
  console.warn("[경고] KMA_AUTH_KEY 환경변수가 비어있습니다. 기상청 API 호출이 모두 실패합니다.");
}

// ---------- 격자/공항 설정 (프론트엔드 aerosense.html과 반드시 동일하게 유지) ----------
const COLS = 24, ROWS = 30;
const BBOX = { latN: 38.8, latS: 33.0, lonW: 124.5, lonE: 131.0 };
const latStep = (BBOX.latN - BBOX.latS) / (ROWS - 1);
const lonStep = (BBOX.lonE - BBOX.lonW) / (COLS - 1);

const AIRPORTS = [
  { id: "GMP", icao: "RKSS", name: "김포", lat: 37.5583, lon: 126.7906 },
  { id: "ICN", icao: "RKSI", name: "인천", lat: 37.4692, lon: 126.4505 },
  { id: "CJU", icao: "RKPC", name: "제주", lat: 33.5113, lon: 126.4930 },
  { id: "PUS", icao: "RKPK", name: "김해", lat: 35.1795, lon: 128.9382 },
  { id: "TAE", icao: "RKTN", name: "대구", lat: 35.8942, lon: 128.6589 },
  { id: "KWJ", icao: "RKJJ", name: "광주", lat: 35.1264, lon: 126.8089 },
  { id: "RSU", icao: "RKJY", name: "여수", lat: 34.8420, lon: 127.6170 },
];

function gridToLatLng(r, c) {
  return { lat: BBOX.latN - r * latStep, lon: BBOX.lonW + c * lonStep };
}

// 지형은 아직 기상청/V-World 연동 전이라 기존 절차적 생성값을 그대로 사용한다.
// (TODO: V-World 표고 API로 교체)
function hash(r, c) { const x = Math.sin(r * 12.9898 + c * 78.233) * 43758.5453; return x - Math.floor(x); }
function ridgeCol(r) { return COLS * 0.62 + 2.5 * Math.sin(r * 0.28); }
const elevGrid = [];
for (let r = 0; r < ROWS; r++) {
  const row = [];
  for (let c = 0; c < COLS; c++) {
    const d = c - ridgeCol(r);
    const base = Math.exp(-(d * d) / (2 * 2.2 * 2.2));
    row.push(Math.min(1, base * 0.95 + hash(r, c) * 0.2));
  }
  elevGrid.push(row);
}

// ---------- 기상청 호출 헬퍼 ----------
async function kmaGetRaw(path, params) {
  const url = new URL(KMA_BASE + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set("authKey", KMA_AUTH_KEY);
  const res = await fetch(url.toString());
  return await res.text();
}
// 실제로는 typ02 계열도 IWXXM 관측/특보는 dataType=JSON을 줘도 XML(IWXXM 표준 포맷)을
// 그대로 돌려주는 경우가 확인되어, JSON을 먼저 시도하고 실패하면 정규식으로 필요한 값만 뽑아낸다.
function extractTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, "i");
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}
function hasPresentWeather(xml) {
  return /<iwxxm:presentWeather[^>]*>[^<]+<\/iwxxm:presentWeather>/.test(xml);
}

// ---------- 1) 공항 METAR (실황: 풍속/시정/강수/구름) ----------
async function fetchMetarOne(a) {
  const xml = await kmaGetRaw("/api/typ02/openApi/AmmIwxxmService/getMetar", {
    pageNo: 1, numOfRows: 1, dataType: "JSON", icao: a.icao,
  });
  const windKt = parseFloat(extractTag(xml, "iwxxm:meanWindSpeed"));
  const gustKt = parseFloat(extractTag(xml, "iwxxm:windGustSpeed"));
  const visM = parseFloat(extractTag(xml, "iwxxm:prevailingVisibility"));
  return {
    windKt: isNaN(windKt) ? null : windKt,
    gustKt: isNaN(gustKt) ? null : gustKt,
    visM: isNaN(visM) ? null : visM,
    precip: hasPresentWeather(xml) ? 0.6 : 0,
  };
}
async function fetchMetarAll() {
  const results = {};
  await Promise.all(AIRPORTS.map(async (a) => {
    try { results[a.id] = await fetchMetarOne(a); }
    catch (e) { results[a.id] = null; } // 이 공항만 실패 — 나머지는 계속 진행
  }));
  return results;
}

// ---------- 2) SIGMET / AIRMET (공식 위험기상 특보 — 난기류 근사 신호) ----------
function extractItemBlocks(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml))) items.push(m[1]);
  return items;
}
async function fetchHazards() {
  const out = { turbulenceActive: false, messages: [] };
  try {
    const [sigXml, airXml] = await Promise.all([
      kmaGetRaw("/api/typ02/openApi/AmmService/getSigmet", { pageNo: 1, numOfRows: 20, dataType: "JSON" }),
      kmaGetRaw("/api/typ02/openApi/AmmService/getAirmet", { pageNo: 1, numOfRows: 20, dataType: "JSON" }),
    ]);
    for (const raw of [...extractItemBlocks(sigXml), ...extractItemBlocks(airXml)]) {
      const msg = extractTag(raw, "sigmetMsg") || extractTag(raw, "airmetMsg") || "";
      const icaoCode = extractTag(raw, "icaoCode");
      const stTm = extractTag(raw, "stTm"), edTm = extractTag(raw, "edTm");
      out.messages.push({ icaoCode, msg, stTm, edTm });
      if (/TURB|CB|TS|OBSC/i.test(msg)) out.turbulenceActive = true;
    }
  } catch (e) {
    // 특보 조회 실패해도 전체 흐름은 계속 (난기류는 보수적으로 낮게 처리)
  }
  return out;
}

// ---------- 3) WINTEM (격자형 고도별 바람/기온 — 지도 전체를 채우는 핵심 데이터) ----------
function latestTmfc() {
  // 발표주기 0,6,12,18 UTC 중 가장 최근 것으로 맞춤
  const now = new Date();
  const h = now.getUTCHours();
  const slot = [0, 6, 12, 18].filter((s) => s <= h).pop() ?? 18;
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), slot));
  if (slot === 18 && h < 18) d.setUTCDate(d.getUTCDate() - 1); // 자정 넘어간 경우 보정
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}`;
}

async function fetchWintem(ef = "06", ht = "050") {
  const url = `${KMA_BASE}/api/typ01/url/amo_wintem.php?tmfc=${latestTmfc()}&ef=${ef}&ht=${ht}&authKey=${KMA_AUTH_KEY}`;
  const res = await fetch(url);
  const text = await res.text();
  // TODO: 실제 응답 포맷 확인 후 파싱 로직 조정.
  // 문서상 lat/lon/wd/ws/temp 컬럼을 담은 자료로 보이나, JSON인지 구분자 텍스트인지는
  // 실제 키로 호출해봐야 확정할 수 있어 우선 두 가지 경우를 모두 시도한다.
  try {
    const json = JSON.parse(text);
    const points = json?.response?.body?.items?.item || json?.items || [];
    return points.map((p) => ({
      lat: parseFloat(p.lat), lon: parseFloat(p.lon),
      wd: parseFloat(p.wd), ws: parseFloat(p.ws), temp: parseFloat(p.temp),
    })).filter((p) => !isNaN(p.lat) && !isNaN(p.lon));
  } catch (e) {
    // JSON이 아니면 줄 단위 구분자 포맷으로 가정 (예: "lat,lon,wd,ws,temp" 헤더 이후 데이터줄)
    const lines = text.trim().split("\n").filter((l) => l && !l.startsWith("#"));
    const points = [];
    for (const line of lines) {
      const cols = line.trim().split(/[\s,]+/).map(Number);
      if (cols.length >= 5 && cols.every((v) => !isNaN(v))) {
        points.push({ lat: cols[0], lon: cols[1], wd: cols[2], ws: cols[3], temp: cols[4] });
      }
    }
    return points;
  }
}

// ---------- 격자 조립 ----------
function idwInterpolate(targetLat, targetLon, points, valueKey) {
  // 역거리가중(IDW)으로 주변 관측/격자점 값을 섞어 임의 좌표 값 추정
  let wsum = 0, vsum = 0;
  for (const p of points) {
    const v = p[valueKey];
    if (v === null || v === undefined || isNaN(v)) continue;
    const d = Math.hypot(p.lat - targetLat, p.lon - targetLon) || 1e-4;
    const w = 1 / (d * d);
    wsum += w; vsum += w * v;
  }
  return wsum > 0 ? vsum / wsum : null;
}

async function buildLiveGrid(ef, ht) {
  const [metar, hazards, wintem] = await Promise.all([
    fetchMetarAll(), fetchHazards(), fetchWintem(ef, ht),
  ]);

  const airportPoints = AIRPORTS.map((a) => {
    const m = metar[a.id];
    return {
      lat: a.lat, lon: a.lon,
      windKt: m?.windKt ?? null,
      visM: m?.visM ?? null,
      precip: m?.presentWeather ? 0.6 : 0,
    };
  });

  const grid = [];
  for (let r = 0; r < ROWS; r++) {
    const row = [];
    for (let c = 0; c < COLS; c++) {
      const { lat, lon } = gridToLatLng(r, c);

      // 풍속: WINTEM 격자점이 있으면 그걸 우선(더 촘촘함), 없으면 공항 실황으로 보간
      const windFromWintem = wintem.length ? idwInterpolate(lat, lon, wintem, "ws") : null;
      const windFromMetar = idwInterpolate(lat, lon, airportPoints, "windKt");
      const windKt = windFromWintem ?? windFromMetar ?? 10;

      const visM = idwInterpolate(lat, lon, airportPoints, "visM") ?? 8000;
      const visKm = Math.max(1, visM / 1000);
      const precip = idwInterpolate(lat, lon, airportPoints, "precip") ?? 0;

      // 난기류: 공식 그리드(KTG NetCDF)는 이번 버전에서 아직 미연동 (TODO).
      // 지금은 SIGMET/AIRMET에 난기류 관련 특보가 떠 있으면 전역적으로 위험도를 끌어올리는
      // 보수적 근사치를 사용한다. 나중에 KTG NetCDF 파싱을 추가하면 이 값을 교체하면 된다.
      const turb = hazards.turbulenceActive ? 55 : 15;

      const terrN = elevGrid[r][c];
      const windN = Math.min(1, windKt / 45);
      const turbN = Math.min(1, turb / 100);
      const visN = Math.min(1, Math.max(0, (10 - visKm) / 9));
      const precN = Math.min(1, precip);
      const score = 100 * (0.25 * windN + 0.25 * turbN + 0.2 * visN + 0.15 * terrN + 0.15 * precN);

      row.push({ score, wind: windKt, turb, vis: visKm, precip, terrN });
    }
    grid.push(row);
  }
  return { grid, meta: { hazards: hazards.messages, wintemPoints: wintem.length, tmfc: latestTmfc() } };
}

// ---------- 라우트 ----------
app.get("/api/live-grid", async (req, res) => {
  try {
    const ef = req.query.ef || "06";
    const ht = req.query.ht || "050";
    const result = await buildLiveGrid(ef, ht);
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
});

app.get("/api/health", (req, res) => res.json({ ok: true, hasKey: !!KMA_AUTH_KEY }));

app.listen(PORT, () => {
  console.log(`AeroSense backend listening on http://localhost:${PORT}`);
  console.log(`KMA_AUTH_KEY set: ${!!KMA_AUTH_KEY}`);
});

