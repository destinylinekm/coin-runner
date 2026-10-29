// api/leaderboard.js
// Vercel Serverless Function  →  เรียกใช้ที่ /api/leaderboard
//   GET  : ดึงอันดับ Top 10
//   POST : ส่งคะแนนใหม่  { name, coins, meters, seconds }
//
// ฐานข้อมูล: Redis (เพิ่มได้ฟรีผ่าน Vercel → Storage → Marketplace → Upstash)
// ตัวแปรสภาพแวดล้อมที่รองรับ (Vercel ใส่ให้อัตโนมัติเมื่อเชื่อมฐานข้อมูล):
//   KV_REST_API_URL  + KV_REST_API_TOKEN              (REST, จาก Vercel Marketplace)
//   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (REST, จาก Upstash โดยตรง)
//   REDIS_URL  (เช่น rediss://default:...@host:6379 — ใช้ผ่านแพ็กเกจ ioredis)

const LEADERBOARD_KEY = "coinrunner:leaderboard";
const TOP_N = 10;

// ---- กติกาตรวจความสมเหตุสมผลของคะแนน (กันโกงแบบพื้นฐาน) ----
// ต้องสอดคล้องกับค่าในเกม (index.html)
const POINTS_PER_COIN = 10;
const MAX_METERS_PER_SEC = 12; // เกมวิ่งคงที่ 9 ม./วิ (SPEED 360 ÷ 40) เผื่อไว้
const MAX_COINS_PER_SEC = 6;   // ในเกมจริงเฉลี่ยไม่เกิน ~5 ชิ้น/วิ แม้เก็บครบทุกแถว
const MIN_SECONDS = 3;
const MAX_SECONDS = 60 * 60; // 1 ชั่วโมง
const RATE_LIMIT_PER_MIN = 12; // ส่งคะแนนได้กี่ครั้งต่อนาทีต่อ IP

const NAME_RE = /^[\p{L}\p{M}\p{N} _.\-]+$/u;

function cleanName(raw) {
  if (typeof raw !== "string") return null;
  const name = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  if (name.length < 1 || [...name].length > 16) return null;
  if (!NAME_RE.test(name)) return null;
  return name;
}

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : NaN;
}

function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff) return xff.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

function parseTop(flat) {
  // รูปแบบที่ได้จาก zrange withScores: [member, score, member, score, ...]
  const out = [];
  for (let i = 0; i < flat.length; i += 2) {
    out.push({ name: String(flat[i]), score: Number(flat[i + 1]) });
  }
  return out;
}

async function getTop(redis) {
  const flat = await redis.zrange(LEADERBOARD_KEY, 0, TOP_N - 1, {
    rev: true,
    withScores: true,
  });
  return parseTop(flat || []);
}

// สร้าง handler จาก "redis" ที่ส่งเข้ามา → ทดสอบด้วยฐานข้อมูลจำลองได้ง่าย
export function createHandler(getRedis) {
  return async function handler(req, res) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");

    let redis;
    try {
      redis = await getRedis();
    } catch (e) {
      console.error("Redis config error:", e);
    }
    if (!redis) {
      res.statusCode = 503;
      res.end(
        JSON.stringify({
          error: "not_configured",
          message:
            "ยังไม่ได้เชื่อมต่อฐานข้อมูล (Upstash Redis) — ดูขั้นตอนใน README.md",
        })
      );
      return;
    }

    try {
      if (req.method === "GET") {
        res.setHeader("Cache-Control", "public, s-maxage=5, stale-while-revalidate=30");
        res.statusCode = 200;
        res.end(JSON.stringify({ top: await getTop(redis) }));
        return;
      }

      if (req.method === "POST") {
        res.setHeader("Cache-Control", "no-store");

        // 1) จำกัดจำนวนครั้งต่อ IP
        const rlKey = `coinrunner:rl:${clientIp(req)}`;
        const hits = await redis.incr(rlKey);
        if (hits === 1) await redis.expire(rlKey, 60);
        if (hits > RATE_LIMIT_PER_MIN) {
          res.statusCode = 429;
          res.end(JSON.stringify({ error: "rate_limited", message: "ส่งคะแนนถี่เกินไป ลองใหม่อีกสักครู่" }));
          return;
        }

        // 2) อ่านและตรวจข้อมูล
        let body = req.body;
        if (typeof body === "string") {
          try { body = JSON.parse(body); } catch { body = null; }
        }
        if (!body || typeof body !== "object") {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "bad_body", message: "ข้อมูลไม่ถูกต้อง" }));
          return;
        }

        const name = cleanName(body.name);
        const coins = toInt(body.coins);
        const meters = toInt(body.meters);
        const seconds = Number(body.seconds);

        if (!name) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "bad_name", message: "ชื่อต้องยาว 1–16 ตัวอักษร (ตัวอักษร ตัวเลข เว้นวรรค _ . -)" }));
          return;
        }
        if (!(coins >= 0) || !(meters >= 0) || !Number.isFinite(seconds)) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "bad_numbers", message: "ตัวเลขคะแนนไม่ถูกต้อง" }));
          return;
        }
        if (
          seconds < MIN_SECONDS ||
          seconds > MAX_SECONDS ||
          meters > seconds * MAX_METERS_PER_SEC + 20 ||
          coins > seconds * MAX_COINS_PER_SEC + 5
        ) {
          res.statusCode = 422;
          res.end(JSON.stringify({ error: "implausible", message: "คะแนนดูผิดปกติ จึงไม่ถูกบันทึก" }));
          return;
        }

        // 3) เซิร์ฟเวอร์คำนวณคะแนนเอง (ไม่เชื่อค่า score จากเบราว์เซอร์)
        const score = coins * POINTS_PER_COIN + meters;

        // gt:true = อัปเดตเฉพาะเมื่อคะแนนใหม่สูงกว่าคะแนนเดิมของชื่อนั้น
        await redis.zadd(LEADERBOARD_KEY, { gt: true }, { score, member: name });

        const best = Number(await redis.zscore(LEADERBOARD_KEY, name));
        const revRank = await redis.zrevrank(LEADERBOARD_KEY, name);

        res.statusCode = 200;
        res.end(
          JSON.stringify({
            ok: true,
            score,
            best,
            rank: typeof revRank === "number" ? revRank + 1 : null,
            top: await getTop(redis),
          })
        );
        return;
      }

      res.setHeader("Allow", "GET, POST");
      res.statusCode = 405;
      res.end(JSON.stringify({ error: "method_not_allowed" }));
    } catch (e) {
      console.error("Leaderboard error:", e);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "server_error", message: "เซิร์ฟเวอร์ขัดข้อง ลองใหม่อีกครั้ง" }));
    }
  };
}

// ---- ใช้งานจริงบน Vercel ----
// ---- หาค่าเชื่อมต่อ Redis จากตัวแปรสภาพแวดล้อม ----
// แบบที่ 1 (REST): KV_REST_API_URL + KV_REST_API_TOKEN, UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
//                  รวมถึงกรณีตั้ง prefix เอง เช่น STORAGE_REST_API_URL + STORAGE_REST_API_TOKEN
export function findRedisEnv(env = process.env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return { url, token };
  for (const key of Object.keys(env)) {
    const m = key.match(/^(.*REST(?:_API)?_)URL$/);
    if (m && env[key]) {
      const tk = env[`${m[1]}TOKEN`]; // ไม่จับ *_READ_ONLY_TOKEN เพราะชื่อไม่ตรงรูปแบบ
      if (tk) return { url: env[key], token: tk };
    }
  }
  return null;
}

// แบบที่ 2 (TCP): REDIS_URL เช่น rediss://default:รหัส@host:6379 (Vercel Marketplace บางแบบให้มาแค่ตัวนี้)
export function findRedisUrl(env = process.env) {
  const isRedisUrl = (v) => typeof v === "string" && /^rediss?:\/\//i.test(v);
  if (isRedisUrl(env.REDIS_URL)) return env.REDIS_URL;
  if (isRedisUrl(env.KV_URL)) return env.KV_URL;
  for (const key of Object.keys(env)) {
    if (/URL$/.test(key) && isRedisUrl(env[key])) return env[key];
  }
  return null;
}

// ตัวแปลงให้ ioredis ใช้ชุดคำสั่งเดียวกับที่ handler เรียก
export function ioredisAdapter(c) {
  return {
    incr: (k) => c.incr(k),
    expire: (k, s) => c.expire(k, s),
    zadd: (k, opts, { score, member }) =>
      opts && opts.gt ? c.zadd(k, "GT", score, member) : c.zadd(k, score, member),
    zscore: (k, m) => c.zscore(k, m),
    zrevrank: (k, m) => c.zrevrank(k, m),
    zrange: (k, a, b) => c.zrevrange(k, a, b, "WITHSCORES"), // เรียงจากคะแนนสูงไปต่ำ → [ชื่อ, คะแนน, ...]
  };
}

let cached;
async function getRealRedis() {
  if (cached) return cached;

  const rest = findRedisEnv();
  if (rest) {
    const { Redis } = await import("@upstash/redis");
    // ปิดการแปลงค่าอัตโนมัติ เพื่อให้ชื่อผู้เล่นที่เป็นตัวเลข/คำว่า true ไม่ถูกแปลงชนิด
    cached = new Redis({ url: rest.url, token: rest.token, automaticDeserialization: false });
    return cached;
  }

  const tcpUrl = findRedisUrl();
  if (tcpUrl) {
    const mod = await import("ioredis");
    const IORedis = mod.default?.default || mod.default || mod;
    const client = new IORedis(tcpUrl, { maxRetriesPerRequest: 2, connectTimeout: 5000 });
    client.on("error", (e) => console.error("Redis connection error:", e && e.message));
    cached = ioredisAdapter(client);
    return cached;
  }

  // เขียนเฉพาะ "ชื่อ" ตัวแปรที่คล้ายกันลง Logs ของ Vercel (ไม่เขียนค่า) เพื่อช่วยไล่หาสาเหตุ
  const similar = Object.keys(process.env).filter((k) => /REDIS|KV_|UPSTASH/i.test(k));
  console.error("ไม่พบตัวแปรเชื่อม Redis. ตัวแปรที่ชื่อใกล้เคียง:", similar.join(", ") || "(ไม่มีเลย)");
  return null;
}

export default createHandler(getRealRedis);
