/**
 * 本机账户 JWT 解密（与 dsh-zcode-claim/lib/live.js 同源逻辑，独立复制以避免跨 link: 包
 * import 的解析坑）。凭据全程内存，绝不落盘、不打日志。
 */
import { existsSync, readFileSync } from "node:fs";
import { createHash, createDecipheriv } from "node:crypto";
import { execFileSync } from "node:child_process";
import { homedir, userInfo } from "node:os";

export function decryptEncV1(wrapped, secret) {
  if (typeof wrapped !== "string" || !wrapped.startsWith("enc:v1:")) return null;
  const key = createHash("sha256").update(secret).digest();
  const parts = wrapped.slice(7).split(".");
  if (parts.length !== 3) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[0], "base64url"));
    d.setAuthTag(Buffer.from(parts[1], "base64url"));
    return Buffer.concat([d.update(Buffer.from(parts[2], "base64url")), d.final()]).toString("utf8");
  } catch { return null; }
}

function fallbackSecret() {
  let user = process.env.USER || process.env.LOGNAME || "";
  if (!user) { try { user = userInfo().username; } catch { user = "unknown"; } }
  return `zcode-credential-fallback:${process.platform}:${homedir()}:${user}`;
}

export function resolveAccountJwt(home = homedir()) {
  const p = `${home}/.zcode/v2/credentials.json`;
  if (!existsSync(p)) return { jwt: null, reason: "no-credentials-file" };
  let obj;
  try { const o = JSON.parse(readFileSync(p, "utf8")); obj = o && o.data ? o.data : o; }
  catch (e) { return { jwt: null, reason: `credentials-parse-failed:${e.code || e.name}` }; }
  const wrapped = obj["zcodejwttoken"];
  if (typeof wrapped !== "string") return { jwt: null, reason: "no-zcodejwttoken" };
  const secret = (process.env.ZCODE_CREDENTIAL_SECRET || "").trim() || fallbackSecret();
  const jwt = decryptEncV1(wrapped, secret);
  return jwt ? { jwt, reason: null } : { jwt: null, reason: "jwt-decrypt-failed" };
}

const APP_INFO_PLIST = "/Applications/ZCode.app/Contents/Info.plist";
const APP_VERSION_FALLBACK = "3.14.4";
let cached;
export function detectAppVersion() {
  if (cached !== undefined) return cached;
  let v = null;
  try { v = execFileSync("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", APP_INFO_PLIST], { encoding: "utf8", timeout: 4000 }).trim() || null; }
  catch { try { v = execFileSync("/usr/bin/defaults", ["read", "/Applications/ZCode.app/Contents/Info", "CFBundleShortVersionString"], { encoding: "utf8", timeout: 4000 }).trim() || null; } catch { v = null; } }
  cached = v && /^\d+\.\d+/.test(v) ? v : APP_VERSION_FALLBACK;
  return cached;
}
