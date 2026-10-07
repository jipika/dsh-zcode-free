/**
 * dsh-zcode-free —— 把 ZCode Start Plan 的免费 GLM-5.3-Flash 注册成 DSH 原生 provider。
 *
 * ## 它是什么
 * 「完美接入」：DSH 自己的 agent loop 直接消费免费额度——模型选择器里出现 GLM-5.3-Flash，
 * 工具调用/流式/思考全部原生，**不是**子代理壳、不 spawn ZCode 客户端、不借 Electron。
 *
 * ## 怎么过的门（全部本机实测，见 README「已验证」）
 * 免费额度上游 `zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages` 的门是 **system 前缀指纹**：
 * `system[0]` 必须逐字节等于官方 42 字符 CLI 前缀、`system[1]` 必须以官方 stable 段开头（≥1300
 * 字符），两者必须相邻且在最前；**之后可以追加任意块**（实测官方两块 + 陌生 DSH 块 → 200）。
 * 所以本插件起一个 loopback 网关做且只做三件事：
 *   ① body.system 前插官方两块（DSH 自己的 system 原样跟在后面，harness 指令完整保留）
 *   ② headers 注入本机解密的账户 JWT（Bearer + x-api-key + app-version + platform）
 *   ③ 上游 SSE 流原样透传（协议 Anthropic 进 Anthropic 出，零转换）
 * pi-ai 原生 `anthropic-messages` 指向网关 → PiAiAdapter → ctx.llm.registerAdapter(["zcode"])。
 *
 * ## 安全
 * 网关只绑 127.0.0.1 + 启动生成一次性 token（pi-ai 请求必须带 x-gw-token，防本机其它进程
 * 白嫖 JWT 打上游）；JWT 只在网关内存里，绝不落盘、绝不回显。
 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const UPSTREAM_ORIGIN = "https://zcode.z.ai";
const UPSTREAM_PATH = "/api/v1/zcode-plan/anthropic/v1/messages";

/** 官方身份两块（资产从 a137460387/zcode2api 的 zcode-system.json 取，与 bluechonk docs/05 块长一致）。 */
export function loadIdentityBlocks(assetPath) {
  const zs = JSON.parse(readFileSync(assetPath, "utf8"));
  const block0 = { type: "text", text: zs.cliPrefix };
  const block1 = { type: "text", text: (zs.stableSections || []).join("\n") };
  if (block0.text.length !== 42) throw new Error(`cliPrefix 长度漂移（${block0.text.length}≠42），身份资产过期`);
  if (block1.text.length < 1300) throw new Error(`stable 段过短（${block1.text.length}<1300），指纹门会拒`);
  return [block0, block1];
}

/** 把上游/请求里形形色色的 system（string | 块数组 | 块）统一成块数组。 */
export function systemToBlocks(system) {
  if (system == null) return [];
  if (typeof system === "string") return [{ type: "text", text: system }];
  if (Array.isArray(system)) {
    return system.map((b) => (typeof b === "string" ? { type: "text", text: b } : b));
  }
  return [system];
}

/** 重写请求体：官方两块在最前、原 system 全部跟后（实测此形态 200，C/D 形态 3012）。 */
export function rewriteSystemBody(rawBody, identityBlocks, officialPrefixText) {
  let body;
  try { body = JSON.parse(rawBody); } catch { return { error: "bad-json" }; }
  if (!body || typeof body !== "object") return { error: "bad-json" };
  // 幂等：无论 system 是 string 还是块数组，只要开头已是官方身份就不重复插
  const prefix = officialPrefixText ?? identityBlocks[0].text;
  const firstText = typeof body.system === "string"
    ? body.system
    : (Array.isArray(body.system) ? (typeof body.system[0] === "string" ? body.system[0] : body.system[0]?.text) : body.system?.text);
  if (typeof firstText === "string" && firstText.startsWith(prefix)) return { body };
  const original = systemToBlocks(body.system);
  body.system = [...identityBlocks, ...original];
  return { body };
}

/**
 * 起 loopback 网关。fetchImpl 可注入（离线测试）；jwtGetter 惰性取 JWT（避免插件加载期解密）。
 * @returns {{port, token, url, close():Promise<void>}}
 */
export async function startGateway({ identityBlocks, jwtGetter, appVersion, platform = process.platform, fetchImpl = globalThis.fetch, host = "127.0.0.1" } = {}) {
  if (!Array.isArray(identityBlocks) || identityBlocks.length < 2) throw new Error("identityBlocks 必须含官方两块");
  const token = randomBytes(24).toString("hex");
  let jwtCache = null;
  const getJwt = async () => { if (!jwtCache) jwtCache = await jwtGetter(); return jwtCache; };

  const server = createServer(async (req, res) => {
    // 一次性 token 围栏：防本机其它进程摸到端口后白嫖 JWT
    if (req.headers["x-gw-token"] !== token) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "forbidden" }));
      return;
    }
    // ⚠ SDK 请求路径自带 /v1/messages 且可能带 query（beta.messages → "/v1/v1/messages?beta=true"），
    // 必须先剥 query 再匹配——曾因 "?beta=true" 导致 endsWith 失配 → 404 not-found（实测踩过）
    if (req.method !== "POST" || !String(req.url || "").split("?")[0].endsWith("/v1/messages")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not-found" }));
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    const { body, error } = rewriteSystemBody(raw, identityBlocks);
    if (error) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error }));
      return;
    }
    const jwt = await getJwt();
    if (!jwt) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "gateway", message: "JWT 不可用（本机 credentials.json 解不出 zcodejwttoken）" } }));
      return;
    }
    let upstream;
    try {
      upstream = await fetchImpl(UPSTREAM_ORIGIN + UPSTREAM_PATH, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${jwt}`,
          "x-api-key": jwt,
          "anthropic-version": "2023-06-01",
          "x-zcode-app-version": appVersion,
          "x-platform": platform,
          "user-agent": `ZCode/${appVersion}`,
          "HTTP-Referer": UPSTREAM_ORIGIN + "/",
          accept: body.stream ? "text/event-stream" : "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "gateway", message: `上游网络失败：${String(e?.message ?? e).slice(0, 120)}` } }));
      return;
    }
    // 透传状态与关键响应头；SSE 用 chunked 原样 pipe
    const headers = { "cache-control": "no-store" };
    const ct = upstream.headers.get("content-type");
    if (ct) headers["content-type"] = ct;
    res.writeHead(upstream.status, headers);
    if (upstream.body) {
      const { Readable } = await import("node:stream");
      Readable.fromWeb(upstream.body).pipe(res);
    } else {
      res.end(await upstream.text());
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve());
  });
  const port = server.address().port;
  return {
    port, token, url: `http://${host}:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
