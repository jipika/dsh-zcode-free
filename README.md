<div align="center">
  <img src="assets/icon.svg" width="72" alt="dsh-zcode-free icon">
</div>

# dsh-zcode-free

把 ZCode Start Plan 的**免费 GLM-5.3-Flash** 注册成 DSH **原生 provider**——模型选择器里直接选、
DSH 自己的 agent loop 直接消费（工具调用/流式/思考全原生）。不是子代理壳、不 spawn ZCode 客户端、
不 fork Electron、无 API Key。

## 原理（全部本机实测）

免费额度上游 `https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages`（Anthropic 协议）的门是
**system 前缀指纹**：

| system 形态 | 结果 |
|---|---|
| 无 system / 只有适配器自己的 system | `405 3012` |
| 官方块[0] + 官方块[1] + **任意陌生块**（DSH 的 system 跟在后） | `200` ✅ |
| 官方块中间插陌生块 / 陌生块在前 | `405 3012` |

所以本插件起一个 loopback 网关做且只做三件事：
① `body.system` 前插官方身份两块（DSH 的 harness system 原样跟后，指令完整保留）；
② 注入本机解密的账户 JWT（Bearer + x-api-key + app-version + platform）；
③ 上游 SSE 原样透传（Anthropic 进 Anthropic 出，零协议转换）。
pi-ai 原生 `anthropic-messages` 指向网关 → `PiAiAdapter` → `ctx.llm.registerAdapter(["zcode"])`。

官方身份块来自 `a137460387/zcode2api` 的 `zcode-system.json`（`assets/`），块长与 bluechonk
docs/05 记录一致（cliPrefix 42 / stable 2311 / dynamic 4981）。JWT 解密逻辑与 dsh-zcode-claim
同源（`~/.zcode/v2/credentials.json` 的 `zcodejwttoken`，enc:v1）。

## 安全

- 网关只绑 `127.0.0.1` 随机端口，启动生成一次性 token；pi-ai 每个请求带 `x-gw-token`，
  网关校验——防本机其它进程摸到端口后**白嫖你的 JWT** 打上游。
- JWT 只在网关进程内存里，绝不落盘/回显；上游响应不透传任何凭据。
- 网关只接受 `POST */v1/messages`，其余 404。

## 组装（照抄本机已工作样本 dsh-qoder-connect）

宿主包从 `vendor/` 加载（构建期从 app.asar 提取的**宿主同版**包：pi-ai 0.87.1、
dsh-llm-pi-ai 0.2.0-rc.2、dsh-llm + 递归依赖闭包，48MB）。为什么不直接 import asar：
Electron 主进程的 ESM×asar 组合在实测中解析失败（headless 沙箱却成功），vendor 纯文件系统
100% 可靠且零版本漂移。

```js
provider = { ...createProvider({ id, name, auth, models, api: anthropicMessagesApi() }), getModels }
profile  = { provider, displayName, streamIdleTimeoutMs, retryPolicy, configuredMaxTokens, modelErrors, piProvider }
adapter  = new PiAiAdapter({ profiles: () => new Map([[id, profile]]), auth: INERT_AUTH, resolveApiKey: async () => gwToken })
ctx.llm.registerAdapter([id], adapter)
```

⚠ asar 内 ESM 解析不认裸包名/目录导入，vendor 路径必须给完整文件（dist/index.js、lib/index.js）。

## 已验证（真机证据）

- **直连判定实验**（本机 JWT）：官方三块 → 200 + 模型回复 "OK"（usage input 1557/output 17）；
  官方两块+陌生块 → 200；其余形态 → 405 3012。system 指纹规则即上表。
- **网关真流式**（真上游 `stream:true`）：HTTP 200 + `text/event-stream`，49 个 text_delta 分片，
  模型回复「流式接入成功」，无 JWT 泄漏。
- **沙箱真宿主装配**：`apply-enter → apply-done → gateway-up(:port) → provider-registered`，
  provider "zcode" + GLM-5.3-Flash 注册成功（vendor import 路径）。
- **离线单测 12/12**：system 重写规则（官方前插/幂等/string 兼容）、token 围栏（无/错 token→403）、
  SSE 透传、GET→404、JWT 不入 body。

## 已知边界

- **桌面运行实例需完全重启 DSH 才激活**：本插件是新 bundle，且 ESM 模块缓存在宿主进程里
  （disabled 翻转只重跑 apply、不重读模块——claim 插件同款边界）。重启后模型选择器出现
  「ZCode Start Plan（GLM 免费额度）」分组。
- 上游风控口径可能变化：若某天开始 3012，先查 `assets/zcode-system.json` 是否与新版客户端的
  身份块漂移（`loadIdentityBlocks` 有长度哨兵：42/<1300 直接抛错）。
- 免费额度耗尽时上游会拒绝（usage 可在会话里观察）；领取靠配套的 dsh-zcode-claim。
- 长对话 token 消耗即免费卡额度（今日卡 1 亿 token，当日 24:00 作废）。

## 自检

```
node test-gw.mjs   # 12 项：system 重写/幂等/兼容 + token 围栏 + SSE 透传 + JWT 脱敏（mock 上游，零网络）
```

## 安装

```
cd ~/.dsh/profiles/desktop
~/.dsh/bin/pnpm10 add "dsh-zcode-free@link:../../local-plugins/dsh-zcode-free" --ignore-scripts
# 手工把 "dsh-zcode-free" 追加进 package.json 的 dsh.profile.bundles，再 pnpm10 install
# vendor/ 已随源码就位（48MB，宿主同版）；无需 npm 安装任何依赖
```
