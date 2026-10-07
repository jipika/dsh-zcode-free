/** 网关离线验证：mock 上游，不发真请求。覆盖 system 重写规则 + token 围栏 + SSE 透传 + JWT 脱敏。 */
import assert from "node:assert/strict";
import { startGateway, rewriteSystemBody, systemToBlocks, loadIdentityBlocks } from "./lib/gateway.js";

const identity = loadIdentityBlocks(new URL("./assets/zcode-system.json", import.meta.url).pathname);
const results = [];
const t = async (label, fn) => { try { await fn(); results.push(["PASS", label]); } catch (e) { results.push(["FAIL", `${label}::${e.message}`]); } };

await t("loadIdentityBlocks：42 字符前缀 + ≥1300 stable", () => {
  assert.equal(identity[0].text, "You are ZCode, an interactive coding agent");
  assert.ok(identity[1].text.length >= 1300);
});

await t("systemToBlocks：string/数组/块混合统一", () => {
  assert.deepEqual(systemToBlocks("hi"), [{ type: "text", text: "hi" }]);
  assert.equal(systemToBlocks([{ type: "text", text: "a" }, "b"]).length, 2);
  assert.deepEqual(systemToBlocks(null), []);
});

await t("rewriteSystemBody：官方两块最前 + 原 system 跟后", () => {
  const { body } = rewriteSystemBody(JSON.stringify({ model: "m", system: [{ type: "text", text: "DSH harness rules" }], messages: [] }), identity);
  assert.equal(body.system.length, 3);
  assert.equal(body.system[0].text, identity[0].text);
  assert.equal(body.system[1].text, identity[1].text);
  assert.equal(body.system[2].text, "DSH harness rules");
});

await t("rewriteSystemBody：原 system 为 string 也转块跟后", () => {
  const { body } = rewriteSystemBody(JSON.stringify({ system: "plain" }), identity);
  assert.equal(body.system[2].text, "plain");
});

await t("rewriteSystemBody：无 system 时只有官方两块", () => {
  const { body } = rewriteSystemBody(JSON.stringify({ messages: [] }), identity);
  assert.deepEqual(body.system.map((b) => b.text), [identity[0].text, identity[1].text]);
});

await t("rewriteSystemBody：已带官方身份则幂等不重复插", () => {
  const once = rewriteSystemBody(JSON.stringify({ system: [{ type: "text", text: "x" }] }), identity).body;
  const twice = rewriteSystemBody(JSON.stringify({ system: once.system }), identity).body;
  // 第二次：system[0] 已是官方串（在字符串层面检测）→ 不再前插
  assert.equal(twice.system.length, once.system.length);
});

await t("rewriteSystemBody：坏 JSON → error", () => {
  assert.deepEqual(rewriteSystemBody("not json", identity), { error: "bad-json" });
});

// ── 网关端到端（mock 上游：SSE 透传 + 围栏 + JWT 注入） ──
let mockCalled = 0, mockAuth = null, mockBody = null;
const mockUpstream = async (url, init) => {
  mockCalled++;
  mockAuth = init.headers.authorization;
  mockBody = JSON.parse(init.body);
  const sse = `event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`;
  return { status: 200, headers: new Headers({ "content-type": "text/event-stream" }), body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } }), text: async () => sse };
};

const gw = await startGateway({
  identityBlocks: identity,
  appVersion: "3.14.4",
  jwtGetter: async () => "TEST.JWT.TOKEN",
  fetchImpl: mockUpstream,
});

await t("无 token → 403（防本机其它进程白嫖）", async () => {
  const res = await fetch(`${gw.url}/v1/messages`, { method: "POST", body: "{}" });
  assert.equal(res.status, 403);
  assert.equal(mockCalled, 0);
});
await t("错误 token → 403", async () => {
  const res = await fetch(`${gw.url}/v1/messages`, { method: "POST", headers: { "x-gw-token": "bad" }, body: "{}" });
  assert.equal(res.status, 403);
});
await t("GET → 404", async () => {
  const res = await fetch(`${gw.url}/v1/messages`, { headers: { "x-gw-token": gw.token } });
  assert.equal(res.status, 404);
});
await t("SDK 形态路径（/v1/v1/messages?beta=true）→ 放行（query 剥除回归）", async () => {
  // Anthropic SDK 拼 {baseURL}/v1/messages?beta=true；曾因 query 串 endsWith 失配 → 404
  const res = await fetch(`${gw.url}/v1/v1/messages?beta=true`, {
    method: "POST", headers: { "x-gw-token": gw.token, "content-type": "application/json" },
    body: JSON.stringify({ stream: true }),
  });
  assert.equal(res.status, 200);
  await res.text();
});
await t("正确 token → 透传 SSE，官方块最前、JWT 进授权头", async () => {
  const res = await fetch(`${gw.url}/v1/messages`, {
    method: "POST",
    headers: { "x-gw-token": gw.token, "content-type": "application/json" },
    body: JSON.stringify({ model: "GLM-5.3-Flash", system: [{ type: "text", text: "DSH rules" }], stream: true }),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /message_start/);
  assert.equal(mockAuth, "Bearer TEST.JWT.TOKEN");
  assert.equal(mockBody.system.length, 3);
  assert.equal(mockBody.system[0].text, identity[0].text);
  // 关键脱敏：响应是 mock 的，但真实链路响应不含 JWT —— 这里断言 mock 上游收到的 body 不含 JWT
  assert.ok(!JSON.stringify(mockBody).includes("TEST.JWT.TOKEN"), "JWT 不得混进 body");
});
await t("SSE content-type 原样透传", async () => {
  const res = await fetch(`${gw.url}/v1/messages`, {
    method: "POST", headers: { "x-gw-token": gw.token, "content-type": "application/json" },
    body: JSON.stringify({ stream: true }),
  });
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
});

await gw.close();
console.log(results.map(([s, m]) => `${s === "PASS" ? "✓" : "✗"} ${m}`).join("\n"));
const failed = results.filter(([s]) => s === "FAIL").length;
console.log(`\n合计 ${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
