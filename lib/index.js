/**
 * dsh-zcode-free 主入口 —— 把 Start Plan 免费额度注册成 DSH 原生 provider。
 *
 * 组装方式照抄本机已工作样本 dsh-qoder-connect（createProvider + 手搓 profile + PiAiAdapter），
 * 协议换 anthropic-messages（官方端点本就是 Anthropic 协议，网关零转换）。
 * 宿主包（dsh-llm / dsh-llm-pi-ai / pi-ai）从 app.asar 懒加载：link: 插件按 realpath 解析
 * 拿不到 asar 内的宿主包（claim 插件实测），且 asar 内版本与宿主完全一致、零协议漂移。
 * ⚠ asar 内 ESM 解析不认裸包名/目录导入，必须给完整文件路径（dist/index.js、lib/index.js）。
 */
import { pathToFileURL } from "node:url";
import { existsSync, appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadIdentityBlocks, startGateway } from "./gateway.js";
import { resolveAccountJwt, detectAppVersion } from "./jwt.js";

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const ASSET = join(PLUGIN_DIR, "..", "assets", "zcode-system.json");
const MODEL_ASSET = join(PLUGIN_DIR, "..", "assets", "glm-5.3-flash.json");
const DIAG = process.env.ZCODE_FREE_DIAG || (process.env.HOME ? `${process.env.HOME}/.dsh/zcode-free-diag.ndjson` : "/tmp/zcode-free-diag.ndjson");
function diag(event, extra = {}) {
  try { mkdirSync(DIAG.slice(0, DIAG.lastIndexOf("/")), { recursive: true }); appendFileSync(DIAG, JSON.stringify({ at: new Date().toISOString(), event, pid: process.pid, ...extra }) + "\n"); } catch { /* 诊断绝不拖垮插件 */ }
}

export const name = "dsh-zcode-free";
/** 空注入：cordis 顶层 inject 是硬前置，缺服务会卡 pending（claim 插件教训）。 */
export const inject = [];

const DEFAULTS = {
  enabled: true,
  // ⚠ providerId 不能用 "zcode"：dsh-our-free-model 2026-10-07 起吸收的 jet-hub
  // 白嫖包注册了同名 provider（displayName "ZCode (智谱)"），同名会撞
  // DUPLICATE_ADAPTER。错开为 "zcode-free"。
  providerId: "zcode-free",
  providerName: "ZCode Start Plan（GLM 免费额度）",
  /** 模型清单只是「别名 + 可覆盖项」，全部能力数值从 assets/glm-5.3-flash.json 元数据读。 */
  models: [{ id: "GLM-5.3-Flash", name: "GLM-5.3-Flash" }],
  streamIdleTimeoutMs: 300_000,
};

function resolveConfig(config = {}) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  if (process.env.ZCODE_FREE_ENABLED === "0") cfg.enabled = false;
  cfg.enabled = cfg.enabled !== false;
  return cfg;
}

async function loadHostModule(spec) {
  // 首选 vendor/（构建期从 asar 提取的同版宿主包，纯文件系统，ESM import 100% 可靠）；
  // asar 直读作 fallback（Electron 主进程的 ESM-asar 组合在部分宿主上解析失败，实测踩过）。
  const vendor = join(PLUGIN_DIR, "..", "vendor", spec);
  if (existsSync(vendor)) {
    try { return await import(pathToFileURL(vendor).href); }
    catch (e) { diag("vendor-import-fail", { spec, code: e?.code, msg: String(e?.message).slice(0, 90) }); }
  }
  const rp = process.resourcesPath;
  if (rp) {
    try { return await import(pathToFileURL(`${rp}/app.asar/dsh/node_modules/${spec}`).href); }
    catch (e) { diag("asar-import-fail", { spec, code: e?.code, msg: String(e?.message).slice(0, 90) }); }
  }
  return import(spec);
}

const INERT_AUTH = {
  credentials: { async read() {}, async list() { return []; }, async modify() { throw new Error("dsh-zcode-free: no pi-ai credential lifecycle"); }, async delete() {} },
  authContext: { async env() {}, async fileExists() { return false; } },
};
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export async function apply(ctx, rawConfig) {
  diag("apply-enter", { config: rawConfig ?? null });
  const cfg = resolveConfig(rawConfig);
  if (!cfg.enabled) { diag("disabled"); return; }
  if (!existsSync(ASSET)) { diag("no-identity-asset", { asset: ASSET }); return; }

  let identityBlocks;
  try { identityBlocks = loadIdentityBlocks(ASSET); }
  catch (e) { diag("identity-bad", { msg: String(e?.message ?? e).slice(0, 90) }); return; }
  const appVersion = detectAppVersion();

  ctx.inject(["llm"], (lctx) => {
    void (async () => {
      try {
        const [piAi, anthropicApi, piAiAdapter, llmModules] = await Promise.all([
          loadHostModule("@earendil-works/pi-ai/dist/index.js"),
          loadHostModule("@earendil-works/pi-ai/dist/api/anthropic-messages.lazy.js"),
          loadHostModule("@deepseek-ai/dsh-llm-pi-ai/lib/index.js"),
          loadHostModule("@deepseek-ai/dsh-llm/lib/index.js"),
        ]);
        const { createProvider } = piAi;
        const { anthropicMessagesApi } = anthropicApi;
        const { PiAiAdapter } = piAiAdapter;
        // resolveImageAttachmentAccess 在 dsh-llm（不在 dsh-llm-pi-ai）——官方 Config 组装
        // 里它把附件 ref 解析成宿主路径，图片预处理读尺寸必需
        const { resolveRetryPolicy, resolveImageAttachmentAccess } = llmModules;

        const gw = await startGateway({ identityBlocks, appVersion, jwtGetter: async () => resolveAccountJwt().jwt });
        diag("gateway-up", { port: gw.port });

        // 模型元数据资产（照本机 dsh-opencode-go / dsh-qoder-connect 的规范做法：
        // contextWindow=limit.context、maxTokens=limit.output、档位=reasoning_options、
        // 输入=input modalities —— 全部从官方元数据读，不硬编码）。
        let meta;
        try { meta = JSON.parse(readFileSync(MODEL_ASSET, "utf8")); }
        catch (e) { diag("model-meta-bad", { msg: String(e?.message ?? e).slice(0, 90) }); return; }
        const effLevels = (meta.reasoning_options || []).find((o) => o.type === "effort")?.values ?? [];
        // pi-ai 的 thinkingLevelMap：null=过滤，显式值=映射到上游 effort。
        // xhigh/max 两档必须显式出现（值非 undefined）才不会被 getSupportedThinkingLevels 过滤。
        const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
        const thinkingLevelMap = {};
        for (const level of LEVELS) {
          if (effLevels.includes(level)) thinkingLevelMap[level] = level;      // 官方档原样透传
          else if (level === "max" && effLevels.includes("high")) thinkingLevelMap[level] = "high"; // 上限兜底
          else thinkingLevelMap[level] = null;                                  // 非官方档过滤
        }

        const toPiModel = (m) => ({
          id: m.id, name: m.name ?? m.id ?? meta.name,
          api: "anthropic-messages", provider: cfg.providerId,
          // ⚠ 不带 /v1：Anthropic SDK 自己拼 "/v1/messages"（baseUrl 带 /v1 会变成
          //   /v1/v1/messages?beta=true → 网关曾因 query 串失配返回 404，实测踩过）
          baseUrl: gw.url,
          // 输入模态抄元数据 modalities.input，但只开 DSH 管线验证过的（text/image）；
          // video/pdf 官方虽支持，DSH 透传未验证，宁缺勿谎
          input: meta.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
          reasoning: meta.reasoning === true,
          thinkingLevelMap,
          cost: NO_COST,
          // 官方上限（元数据 limit）：context 1M、output 131072。
          // ⚠ maxTokens 别配小：thinking 会从同一 max_tokens 里扣预算（high 档 16384），
          //   配 8192 时答案只剩 ~1k token，长回答必被截断（实测踩过：「已达到输出 token 上限」）
          contextWindow: m.contextWindow ?? meta.limit?.context ?? 131072,
          maxTokens: m.maxTokens ?? meta.limit?.output ?? 32768,
          compat: { maxTokensField: "max_tokens" },
          // 网关围栏 token 随模型走：pi-ai 发请求时带上，网关校验
          headers: { "x-gw-token": gw.token },
        });

        const provider = {
          ...createProvider({
            id: cfg.providerId,
            name: cfg.providerName,
            // ⚠ resolve 必须把 override 的 key 转成 {auth:{apiKey}} 返回——恒返 undefined 会让
            // pi-ai 的 getAuth 得到 undefined → throw "Provider is not configured"（实测踩过）。
            // 链路：PiAiAdapter.resolveApiKey → 网关 token → pi-ai options.apiKey → 这里。
            // 发到网关的是网关 token（非 JWT），JWT 只在网关内存里注入上游请求。
            auth: { apiKey: { name: "ZCode free gateway token", async resolve({ credential }) {
              const key = credential?.key;
              return key ? { auth: { apiKey: key } } : undefined;
            } } },
            models: cfg.models.map(toPiModel),
            api: anthropicMessagesApi(),
          }),
          getModels: () => cfg.models.map(toPiModel),
        };

        const profile = {
          provider: cfg.providerId,
          displayName: cfg.providerName,
          streamIdleTimeoutMs: cfg.streamIdleTimeoutMs,
          retryPolicy: resolveRetryPolicy(undefined, `dsh-zcode-free:${cfg.providerId} retryPolicy`),
          configuredMaxTokens: new Map(),
          modelErrors: new Map(),
          // ⚠ 手搓 profile 绕过官方 zod schema ⇒ schema 的 .default() 不生效，缺字段就是
          // undefined 直落下游。图片三件套缺任何一个都会让 requestImagePolicy.maxPixels
          // 变 undefined → requestImageDimensions 算出 NaN 宽高 → 抛
          // "Image request width must be a positive integer"（实测踩过，第四轮才定位）。
          // 值与 schema 默认 / Qoder REQUEST_IMAGE_BUDGETS 一致：20MB / 4MP / 1MB。
          maxRequestImageBytes: 20 * 1024 * 1024,
          requestImagePixelBudget: 2048 * 2048,
          requestImageMaxBytes: 1024 * 1024,
          piProvider: provider,
        };
        const profiles = new Map([[cfg.providerId, profile]]);

        // resolveImageAccess 也要接（官方 Config 组装里两者成对出现）：它把附件 ref 解析成
        // 宿主绝对路径，图片预处理（读尺寸→算 target 宽高）依赖它；缺它时 ref.width 为
        // undefined → attachments 服务抛 "Image request width must be a positive integer"（实测踩过）。
        // resolveImageAttachmentAccess 从 dsh-llm-pi-ai 导出（官方 Config 组装同款用法）。
        const adapter = new PiAiAdapter({
          profiles: () => profiles,
          auth: INERT_AUTH,
          resolveApiKey: async () => gw.token,
          resolveAttachments: () => ctx.get("attachments"),
          resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, (hostPath) => ctx.get("fs")?.processPathFromHostPath(hostPath), ref),
        });

        lctx.llm.registerAdapter([cfg.providerId], adapter);
        try {
          lctx.llm.registerConfigurableProviders?.([{
            provider: cfg.providerId,
            displayName: cfg.providerName,
            settingsNs: "dsh-zcode-free",
            settingsPath: [],
          }]);
        } catch { /* 老宿主无该方法则跳过 */ }
        diag("provider-registered", { provider: cfg.providerId, models: cfg.models.map((m) => m.id) });
        ctx.effect(() => () => { void gw.close(); }, `${name}: gateway`);
      } catch (e) {
        diag("llm-apply-THREW", { msg: String(e?.message ?? e).slice(0, 160), stack: String(e?.stack ?? "").split("\n").slice(0, 4).join(" | ") });
      }
    })();
  });

  diag("apply-done", { providerId: cfg.providerId, models: cfg.models.map((m) => m.id) });
}
