#!/usr/bin/env node
/** 从本机 DSH app.asar 提取插件运行所需的宿主包到 vendor/（48MB，不进 git）。
 *  用法：ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" scripts/extract-vendor.mjs */
import fs from "node:fs";
import path from "node:path";
const base = "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/";
const out = path.resolve(import.meta.dirname, "..", "vendor");
const seeds = ["@earendil-works/pi-ai", "@deepseek-ai/dsh-llm", "@deepseek-ai/dsh-llm-pi-ai"];
const missing = [];
function cp(f, t) {
  fs.mkdirSync(t, { recursive: true });
  for (const e of fs.readdirSync(f, { withFileTypes: true })) {
    if (e.name === ".bin") continue;
    const a = path.join(f, e.name), b = path.join(t, e.name);
    if (e.isDirectory()) cp(a, b); else if (e.isFile()) fs.copyFileSync(a, b);
  }
}
function copyPkg(name, depth = 0) {
  const to = path.join(out, name);
  if (fs.existsSync(to)) return;
  const from = base + name;
  if (!fs.existsSync(from)) { missing.push(name); return; }
  const st = fs.lstatSync(from);
  cp(st.isSymbolicLink() ? path.resolve(path.dirname(from), fs.readlinkSync(from)) : from, to);
  try {
    const p = JSON.parse(fs.readFileSync(path.join(to, "package.json")));
    for (const d of [...Object.keys(p.dependencies ?? {}), ...Object.keys(p.peerDependencies ?? {}).filter(x => !p.peerDependenciesMeta?.[x]?.optional)]) {
      if (depth < 8) copyPkg(d, depth + 1);
    }
  } catch {}
}
for (const s of seeds) copyPkg(s);
console.log("vendor 就绪，asar 顶层缺失:", missing.length ? missing.join(",") : "无");
