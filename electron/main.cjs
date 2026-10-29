"use strict";
/*
  寒霜破甲工具 · Electron 主进程

  本构建已移除全部内置提示词与 V1–V5 版本：保留卸载 / 装回原始记忆 / 技能管理等
  清理与维护能力。渲染进程通过 preload 暴露的 window.hs 调用下面的 IPC。
*/

const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage } = require("electron");
const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// 应用名由构建变体决定（scripts/build.mjs 写入 variant.json）
let APP_NAME = "寒霜破甲工具";
let VARIANT = "free";
try {
  const v = require("../variant.json");
  if (v && v.appName) APP_NAME = v.appName;
  if (v && v.variant) VARIANT = v.variant;
} catch {
  /* 开发环境缺文件时用默认值 */
}
const UNINSTALL_TIMEOUT = 120000;
const INSTALL_TIMEOUT = 600000;
/** Seep 工作台首次部署要装 Python 依赖 + 解压离线包，给足 30 分钟。 */
const SEEP_TIMEOUT = 1800000;

let win = null;
let tray = null;
let quitting = false;
let child = null; // 当前运行的 powershell
let childTimer = null;
let childLabel = "";

// ---------- 路径 ----------

/**
   脚本目录：打包后在 resources/；开发时 main.cjs 位于 <工具目录>/electron/，
   所以先试上一级，再在上一级的同级目录里找带 install.ps1 的那一层
   （项目目录名可能带中文或空格，不能写死）。
*/
const INSTALL_SCRIPTS = [
  "install.ps1",
  "install-zcode.ps1",
  "install-cursor.ps1",
  "install-claude.ps1",
  "install-workbuddy.ps1",
  "install-dsh.ps1",
  "install-opencode.ps1",
];

function hasScripts(dir) {
  try {
    return INSTALL_SCRIPTS.every((f) => fs.existsSync(path.join(dir, f)));
  } catch {
    return false;
  }
}

function toolDir() {
  if (app.isPackaged) return process.resourcesPath;
  const parent = path.join(__dirname, "..");
  if (hasScripts(parent)) return path.resolve(parent);
  try {
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(parent, entry.name);
      if (hasScripts(dir)) return path.resolve(dir);
    }
  } catch {
    /* 落到兜底 */
  }
  return path.resolve(parent);
}

function homeDir() {
  return os.homedir();
}

/**
   Codex 的配置目录（home）。不能写死 ~/.codex：
     * 用户可能把 CODEX_HOME 指到别的盘（C 盘紧张时的常见做法，Codex 官方支持）
     * 也可能直接把 .codex 放在某个盘的根目录（迁移过数据目录的机器）
   探测顺序：CODEX_HOME 环境变量 → ~/.codex → 各盘根目录下的 .codex → 兜底 ~/.codex。
   写操作（如首次写状态文件）落在最后那个兜底路径上，不影响读取判断。
   结果缓存，避免每次调用都扫一遍盘。
*/
let cachedCodexHome = null;
function codexHome() {
  if (cachedCodexHome) return cachedCodexHome;
  const envHome = process.env.CODEX_HOME;
  const def = path.join(homeDir(), ".codex");
  if (envHome) {
    try { if (fs.existsSync(envHome)) { cachedCodexHome = envHome; return cachedCodexHome; } } catch { /* 忽略 */ }
  }
  try { if (fs.existsSync(def)) { cachedCodexHome = def; return cachedCodexHome; } } catch { /* 忽略 */ }
  for (let c = 67; c <= 90; c++) {   // C: 到 Z:
    const p = String.fromCharCode(c) + ":\\" + ".codex";
    try { if (fs.existsSync(p)) { cachedCodexHome = p; return cachedCodexHome; } } catch { /* 盘不存在 */ }
  }
  cachedCodexHome = def;
  return cachedCodexHome;
}

function statePath() {
  return path.join(codexHome(), "fj_desktop_state.json");
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

// ---------- 任务定义（与 Python 版一致） ----------

const SCRIPTS = {
  codex: "install.ps1",
  zcode: "install-zcode.ps1",
  cursor: "install-cursor.ps1",
  opencode: "install-opencode.ps1",
  claude: "install-claude.ps1",
  workbuddy: "install-workbuddy.ps1",
  // WorkBuddy 国内版：同一个脚本，靠 -ConfigDir 指到 ~/.workbuddy 区分
  "workbuddy-cn": "install-workbuddy.ps1",
  dsh: "install-dsh.ps1",
  doubao: "install-doubao.ps1",
};

const TARGET_IDS = Object.keys(SCRIPTS);


function p(...parts) {
  return path.join(toolDir(), ...parts);
}

// ---------- 随包分发的 Seep 逆向工作台 ----------

/** 工具链目录名：electron-builder 的 extraResources 把它整个落到 resources/seep-kit/。 */
const SEEP_KIT = "seep-kit";
/** 工作台技能库（apkseep / softseep / ida-reverse / 授权流审计），相对工具目录。 */
const SEEP_SKILLS = SEEP_KIT + "/Tool/skill";
/** 用户自己填提示词的目录，随包分发到 resources/memory/。 */
const MEMORY_DIR = "memory";

function seepScript(name) {
  return p(SEEP_KIT, "setup", name);
}

/**
   记忆文件 = memory/ 下第一个非空、非 README 的 .md。
   返回 null 表示还没填，界面据此报错，避免把空提示词写进用户记忆档案。
*/
function memoryPrompt() {
  const dir = p(MEMORY_DIR);
  let names = [];
  try {
    names = fs
      .readdirSync(dir)
      .filter((n) => n.toLowerCase().endsWith(".md") && n.toLowerCase() !== "readme.md")
      .sort();
  } catch {
    return null;
  }
  for (const name of names) {
    try {
      const full = path.join(dir, name);
      const text = fs.readFileSync(full, "utf8");
      const chars = text.trim().length;
      if (chars > 0) return { path: full, name, chars };
    } catch {
      /* 读不了就试下一个 */
    }
  }
  return null;
}

/** Seep 工作台是否已部署到 ~/.pi/agent（install-pi.ps1 会往 mcp.json 里写 seep 条目）。 */
function seepState() {
  const kitFile = p(SEEP_KIT, "VERSION");
  let version = "";
  try {
    version = fs.readFileSync(kitFile, "utf8").trim();
  } catch {
    /* 随包文件缺失时留空 */
  }
  let installed = false;
  try {
    const mcp = path.join(homeDir(), ".pi", "agent", "mcp.json");
    installed = fs.existsSync(mcp) && fs.readFileSync(mcp, "utf8").includes('"seep"');
  } catch {
    /* 没装过 */
  }
  return {
    kit: fs.existsSync(seepScript("install.ps1")),
    installed,
    version,
  };
}

/**
   各目标的安装参数。提示词统一取 memory/ 里用户自己填的那一份；
   技能库统一用随包的 Seep 工作台技能（cursor / doubao 没有技能库，只注入提示词）。
*/
function installArgs(targetId, promptFile) {
  const script = SCRIPTS[targetId];
  if (!script) throw new Error("未知目标: " + targetId);
  const file = p(script);
  const skills = SEEP_SKILLS;
  switch (targetId) {
    case "codex":
      // 额外写一份 <CodexHome>\AGENTS.md：config.toml 会被 Codex 自己重写，AGENTS.md 不会丢
      return [
        "-File", file,
        "-SourcePrompt", promptFile,
        "-SkillsSource", skills,
        "-InjectAgents",
        "-AgentsKnown", promptFile,
      ];
    case "zcode":
      return [
        "-File", file,
        "-PatchSystemPrompt",
        "-SourcePrompt", promptFile,
        "-MemorySourcePrompt", promptFile,
        "-SkillsSource", skills,
      ];
    case "claude":
      return [
        "-File", file,
        "-SourcePrompt", promptFile,
        "-SkillsSource", skills,
        "-KnownPrompts", promptFile,
      ];
    case "opencode":
      // 全局规则写 ~/.config/opencode/AGENTS.md，技能落 ~/.config/opencode/skills
      return [
        "-File", file,
        "-SourcePrompt", promptFile,
        "-SkillsSource", skills,
        "-KnownPrompts", promptFile,
      ];
    case "workbuddy":
      return ["-File", file, "-SourcePrompt", promptFile, "-SkillsSource", skills];
    case "workbuddy-cn":
      // 国内版数据目录固定 ~/.workbuddy，自动探测会先命中 .workbuddy-ai
      return [
        "-File", file,
        "-SourcePrompt", promptFile,
        "-SkillsSource", skills,
        "-ConfigDir", path.join(homeDir(), ".workbuddy"),
      ];
    case "dsh":
      return ["-File", file, "-SourcePrompt", promptFile, "-SkillsSource", skills];
    default:
      return ["-File", file, "-SourcePrompt", promptFile];
  }
}



function uninstallArgs(targetId) {
  const args = ["-File", p(SCRIPTS[targetId]), "-Uninstall"];
  // 国内版必须显式指定数据目录，否则卸载会走自动探测跑到国际版上去
  if (targetId === "workbuddy-cn") args.push("-ConfigDir", path.join(homeDir(), ".workbuddy"));
  return args;
}

/**
   装回原始记忆（install-workbuddy.ps1 -RestoreMemory）：把云记忆档案与 MEMORY.md 还原成
   安装前的原文，并删掉注入状态文件、让守护停止重注入；技能库和记忆开关都不动。
   与卸载共用同一段还原逻辑，所以数据目录的指定方式必须和 uninstallArgs 保持一致。
*/
function restoreMemoryArgs(targetId) {
  const args = ["-File", p(SCRIPTS[targetId]), "-RestoreMemory"];
  // 本构建不再随包分发提示词：脚本在卸载/还原模式下跳过提示词解析（提示词缺失时按
  // 「内容比对不上就保留用户记忆」安全降级），这里不再传 -SourcePrompt。
  if (targetId === "workbuddy-cn") args.push("-ConfigDir", path.join(homeDir(), ".workbuddy"));
  return args;
}

/**
   提示词残留兜底清扫（scripts/clear-injected-prompts.ps1，由 extraResources 打进
   resources/scripts/）。按 -Targets 限定到当前目标，避免卸载一个目标时把别的目标的
   提示词也一起清掉。
*/
function clearPromptsArgs(targetId) {
  // 清理脚本的 workbuddy 分支按 Home 目录扫，已经同时覆盖 .workbuddy-ai 与 .workbuddy，
  // 所以国内版映射到同一个 target，不需要单独的清理分支。
  const t = targetId === "workbuddy-cn" ? "workbuddy" : targetId;
  return ["-File", p("scripts", "clear-injected-prompts.ps1"), "-Apply", "-Targets", t];
}

// ---------- 运行 powershell ----------

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/**
   中文 Windows 上 PowerShell 子进程按系统代码页（GBK/936）写标准输出，
   直接按 UTF-8 解会整段乱码（用户看到的「?????」日志就是这么来的）。
   这里先按 UTF-8 严格解码；只要有一个非法字节就退回 GBK —— 两种来源都能读。
*/
function decodeConsoleOutput(buf) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder("gbk").decode(buf);
    } catch {
      return buf.toString("utf8");
    }
  }
}

function killChild() {
  if (!child) return;
  const pid = child.pid;
  child = null;
  try {
    // /T 连带子进程一起杀，否则 powershell 退出后残留的安装进程仍会写文件
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => {});
  } catch {
    /* ignore */
  }
}

function runPowerShell(args, label, timeoutMs) {
  return new Promise((resolve) => {
    if (child) {
      killChild();
    }
    if (childTimer) clearTimeout(childTimer);

    let out = "";
    // 累计原始字节再整段解码：多字节中文字符可能被 chunk 边界切开，逐块解码会碎成乱码
    let rawOut = Buffer.alloc(0);
    let sentChars = 0;
    let timedOut = false;
    childLabel = label;
    send("tool:status", { label, state: "running" });

    const onOutput = (buf) => {
      rawOut = Buffer.concat([rawOut, buf]);
      const text = decodeConsoleOutput(rawOut);
      const delta = text.slice(sentChars);
      sentChars = text.length;
      if (rawOut.length > 4 * 1024 * 1024) {
        // 超长输出：丢掉已经发过的前缀，免得内存一直涨
        rawOut = rawOut.subarray(rawOut.length - 1024 * 1024);
        sentChars = decodeConsoleOutput(rawOut).length;
      }
      if (!delta) return;
      out = (out + delta).slice(-60000);
      send("tool:log", { label, text: delta });
    };

    const ps = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...args],
      { cwd: toolDir(), windowsHide: true },
    );
    child = ps;

    ps.stdout.on("data", onOutput);
    ps.stderr.on("data", onOutput);

    childTimer = setTimeout(() => {
      timedOut = true;
      send("tool:log", { label, text: "\n[超时] 已强制终止\n" });
      killChild();
    }, timeoutMs);

    ps.on("error", (err) => {
      if (childTimer) clearTimeout(childTimer);
      child = null;
      resolve({ ok: false, code: -1, out, timedOut, error: String(err && err.message) });
    });

    ps.on("close", (code) => {
      if (childTimer) clearTimeout(childTimer);
      child = null;
      resolve({ ok: !timedOut && code === 0, code: code == null ? -1 : code, out, timedOut });
    });
  });
}

// ---------- 已安装状态 ----------


function loadState() {
  const st = readJson(statePath(), {});
  return {
    installed: st.installed || {},
  };
}

function saveState(patch) {
  const st = loadState();
  const next = { ...st, ...patch };
  writeJson(statePath(), next);
  return next;
}

function installedSnapshot() {
  // 提示词版本探测已随提示词一并移除，已安装标记只认安装时写下的状态记录。
  return loadState();
}

// ---------- skills ----------

function skillsDir() {
  return path.join(codexHome(),"skills");
}

function configToml() {
  return path.join(codexHome(),"config.toml");
}

/** 解析 [[skills.config]] 块，返回被禁用的 skill 目录名集合。 */
function readDisabledSkills() {
  const disabled = new Set();
  let text = "";
  try {
    text = fs.readFileSync(configToml(), "utf8");
  } catch {
    return disabled;
  }
  const blocks = text.split(/^\[\[skills\.config\]\]\s*$/m);
  for (const blk of blocks.slice(1)) {
    const mp = blk.match(/^\s*path\s*=\s*"([^"]+)"/m);
    if (!mp) continue;
    const me = blk.match(/^\s*enabled\s*=\s*(true|false)/m);
    const enabled = me ? me[1] === "true" : true;
    if (enabled) continue;
    const parts = mp[1].replace(/\\/g, "/").split("/");
    const name = parts[parts.length - 2];
    if (name) disabled.add(name);
  }
  return disabled;
}

function writeDisabledSkills(disabled) {
  const cp = configToml();
  let text;
  try {
    text = fs.readFileSync(cp, "utf8");
  } catch {
    return { ok: false, error: "找不到 config.toml" };
  }
  text = text.replace(/^\[\[skills\.config\]\]\s*$[\s\S]*?(?=^\[\[|$)/gm, "");
  text = text.replace(/\s+$/, "") + "\n";
  for (const name of [...disabled].sort()) {
    const sk = path.join(skillsDir(), name, "SKILL.md").replace(/\\/g, "/");
    text += `\n[[skills.config]]\npath = "${sk}"\nenabled = false\n`;
  }
  try {
    fs.writeFileSync(cp, text, "utf8");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message) };
  }
}

function listSkills() {
  const dir = skillsDir();
  const disabled = readDisabledSkills();
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, "SKILL.md")))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
  return names.map((name) => {
    let desc = "";
    try {
      const head = fs.readFileSync(path.join(dir, name, "SKILL.md"), "utf8").slice(0, 600);
      const m = head.match(/description:\s*(.+)/);
      if (m) desc = m[1].trim().slice(0, 120);
    } catch {
      /* ignore */
    }
    return { name, desc, enabled: !disabled.has(name) };
  });
}


// ---------- 持久化配置守护 (Config Guard) ----------
//
// 问题：install*.ps1 的注入是一次性的。Codex 自身会重写 config.toml（丢掉
// model_instructions_file），cockpit tools 换账号时也会覆写 config.toml，
// 导致破甲提示词静默失效。旧版有 fj_tool 守护线程做自动重注入，但本构建已
// 移除 fj_tool，所以这里在 Electron 主进程内重建一个等效的守护。
//
// 策略：app ready 后每 5 秒轮询一次已安装目标的注入点，发现注入丢失就补回。
// 用轮询而非 FileSystemWatcher：Windows 上 FSW 对网络盘/OneDrive 同步目录
// 误报率高，且 config.toml 被 Codex 原子重写时 FSW 可能丢事件。

const GUARD_INTERVAL_MS = 5000;
let guardTimer = null;
let guardLog = []; // 最近 50 条守护日志，供 IPC 读取

function guardPush(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  guardLog.push(line);
  if (guardLog.length > 50) guardLog = guardLog.slice(-50);
  console.log("[guard]", line);
}

/** 读取 managed-prompts/install-state.json（Codex 目标的注入状态）。 */
function readCodexInstallState() {
  const ch = codexHome();
  const stateFile = path.join(ch, "managed-prompts", "install-state.json");
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

/** UTF-8 无 BOM 写文件（原子写：先写 .tmp 再 Move）。 */
function writeUtf8Atomic(filePath, text) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + ".hs-tmp";
  fs.writeFileSync(tmp, text, "utf8");
  try { fs.renameSync(tmp, filePath); }
  catch {
    // rename 失败（跨卷/占用）→ 直接写
    fs.writeFileSync(filePath, text, "utf8");
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function readUtf8Safe(filePath) {
  try { return fs.readFileSync(filePath, "utf8"); } catch { return null; }
}

// ---- Codex 守护：config.toml + AGENTS.md ----

function guardCodex() {
  const st = readCodexInstallState();
  if (!st || !st.targetPrompt) return;

  const configPath = path.join(codexHome(), "config.toml");
  const agentsPath = path.join(codexHome(), "AGENTS.md");
  const promptPath = st.targetPrompt;

  // 提示词文件不存在 = 被用户/清理工具删了，没法补
  if (!fs.existsSync(promptPath)) return;

  // 1. 守护 config.toml 的 model_instructions_file 行
  const cfgText = readUtf8Safe(configPath);
  if (cfgText !== null) {
    const expected = 'model_instructions_file = "' + promptPath.replace(/\\/g, "/").replace(/"/g, '\\"') + '"';
    const lineRe = /^\s*model_instructions_file\s*=\s*.*$/m;
    const m = cfgText.match(lineRe);
    if (!m) {
      // 行被 Codex/cockpit 删了 → 补到文件开头
      const newText = expected + "\n" + cfgText;
      writeUtf8Atomic(configPath, newText);
      guardPush("Codex config.toml: model_instructions_file 被覆写，已补回");
    } else if (m[0].trim() !== expected.trim()) {
      // 行还在但路径变了（CODEX_HOME 迁移等）→ 替换
      const newText = cfgText.replace(lineRe, expected);
      writeUtf8Atomic(configPath, newText);
      guardPush("Codex config.toml: model_instructions_file 路径漂移，已修正");
    }
  }

  // 2. 守护 AGENTS.md 的注入块
  const agentsText = readUtf8Safe(agentsPath);
  if (agentsText !== null) {
    const beginRe = /<!--\s*寒霜破甲[^\r\n]*注入开始[^\r\n]*-->/;
    if (!beginRe.test(agentsText)) {
      // 注入块丢了（被 Codex 重写 / 用户编辑时误删）→ 重新注入
      const promptText = readUtf8Safe(promptPath);
      if (promptText) {
        const body = promptText.trimEnd();
        const block =
          "<!-- 寒霜破甲注入开始 · " + path.basename(promptPath) + " -->\n" +
          body + "\n" +
          "<!-- 寒霜破甲注入结束 -->\n";
        // 只追加到末尾，不动用户自己的内容
        const newText = agentsText.trimEnd() + "\n\n" + block;
        writeUtf8Atomic(agentsPath, newText);
        guardPush("Codex AGENTS.md: 注入块丢失，已重新追加");
      }
    }
  } else if (st.agentsBackup || fs.existsSync(agentsPath) === false) {
    // AGENTS.md 不存在了但之前注入过 → 重建
    const promptText = readUtf8Safe(promptPath);
    if (promptText) {
      const body = promptText.trimEnd();
      const block =
        "<!-- 寒霜破甲注入开始 · " + path.basename(promptPath) + " -->\n" +
        body + "\n" +
        "<!-- 寒霜破甲注入结束 -->\n";
      writeUtf8Atomic(agentsPath, block);
      guardPush("Codex AGENTS.md: 文件缺失，已重建");
    }
  }
}

// ---- DSH 守护：AGENTS.md ----

function guardDsh() {
  const dshDir = path.join(homeDir(), ".dsh");
  const managedDir = path.join(dshDir, "managed-prompts");
  const stateFile = path.join(managedDir, "install-state.json");
  const st = readJson(stateFile, null);
  if (!st) return;

  // DSH 的 state 文件有 prompt 字段（仅文件名），构造完整路径
  let promptPath = null;
  if (st.prompt) {
    promptPath = path.join(managedDir, st.prompt);
  }
  // 兜底：从 managed-prompts 目录找 .md 文件
  if (!promptPath || !fs.existsSync(promptPath)) {
    try {
      const files = fs.readdirSync(managedDir).filter(n => n.endsWith(".md") && !n.endsWith(".bak"));
      if (files.length > 0) promptPath = path.join(managedDir, files[0]);
    } catch {}
  }
  if (!promptPath || !fs.existsSync(promptPath)) return;

  const agentsPath = path.join(dshDir, "AGENTS.md");
  const agentsText = readUtf8Safe(agentsPath);
  if (agentsText !== null) {
    // DSH 用 HANSHUANG-INJECT 标记，也兼容寒霜破甲注入开始
    const beginRe = /<!--\s*(?:HANSHUANG-INJECT:BEGIN|寒霜破甲[^\r\n]*注入开始)[^\r\n]*-->/;
    if (!beginRe.test(agentsText)) {
      const promptText = readUtf8Safe(promptPath);
      if (promptText) {
        const body = promptText.trimEnd();
        const block =
          "<!-- HANSHUANG-INJECT:BEGIN prompt=" + path.basename(promptPath) + " -->\n" +
          body + "\n" +
          "<!-- HANSHUANG-INJECT:END -->\n";
        const newText = agentsText.trimEnd() + "\n\n" + block;
        writeUtf8Atomic(agentsPath, newText);
        guardPush("DSH AGENTS.md: 注入块丢失，已重新追加");
      }
    }
  }
}

// ---- Claude 守护：CLAUDE.md ----

function guardClaude() {
  const claudeDir = path.join(homeDir(), ".claude");
  const managedDir = path.join(claudeDir, "managed-prompts");
  const stateFile = path.join(managedDir, "install-state.json");
  const st = readJson(stateFile, null);
  if (!st) return;

  // Claude 的 state 文件没有 targetPrompt 字段，从 managed-prompts 目录找提示词文件
  let promptPath = null;
  try {
    const files = fs.readdirSync(managedDir).filter(n => n.endsWith(".md") && n !== "CLAUDE.md.bak");
    if (files.length > 0) promptPath = path.join(managedDir, files[0]);
  } catch {}
  if (!promptPath || !fs.existsSync(promptPath)) return;

  const claudeMd = path.join(claudeDir, "CLAUDE.md");
  const text = readUtf8Safe(claudeMd);
  if (text !== null) {
    // Claude 用 HANSHUANG-INJECT:BEGIN 标记，也兼容寒霜破甲注入开始
    const beginRe = /<!--\s*(?:HANSHUANG-INJECT:BEGIN|寒霜破甲[^\r\n]*注入开始)[^\r\n]*-->/;
    if (!beginRe.test(text)) {
      const promptText = readUtf8Safe(promptPath);
      if (promptText) {
        const body = promptText.trimEnd();
        // 使用 Claude 的标记格式
        const block =
          "<!-- HANSHUANG-INJECT:BEGIN prompt=" + path.basename(promptPath) + " -->\n" +
          body + "\n" +
          "<!-- HANSHUANG-INJECT:END -->\n";
        const newText = text.trimEnd() + "\n\n" + block;
        writeUtf8Atomic(claudeMd, newText);
        guardPush("Claude CLAUDE.md: 注入块丢失，已重新追加");
      }
    }
  }
}

// ---- WorkBuddy 守护：云记忆档案 + MEMORY.md + app-config.json + 只读锁 ----
//
// WorkBuddy 的注入链路最复杂，失效方式也最多：
//   1. 云端同步覆写 *_memory.md → Memory Block 段丢失 / version 降回正常值
//   2. WorkBuddy 更新或重启 → app-config.json 的 generateMemoryEnabled 被重置为 false
//   3. 只读锁被程序解除 → 下次云同步直接覆盖
//   4. 换账号 → 新 uid 的 *_memory.md 出现，但没被注入
//   5. MEMORY.md 被用户/程序改写 → 兜底记忆丢失
// 守护需全部覆盖。

const WB_MEM_VERSION = 999999;

/** 发现配置目录下所有 *_memory.md 档案（包括安装后新出现的）。 */
function wbFindArchives(configDir) {
  const memDir = path.join(configDir, "memory");
  try {
    return fs.readdirSync(memDir)
      .filter(n => n.endsWith("_memory.md") && !n.includes(".bak"))
      .map(n => path.join(memDir, n));
  } catch {
    return [];
  }
}

/** 从档案文件解析 RAW_JSON 块。 */
function wbParseRawJson(archText) {
  const m = archText.match(/<!--\s*RAW_JSON_START\r?\n([\s\S]*?)\r?\nRAW_JSON_END\s*-->/);
  if (!m) return null;
  try { return JSON.parse(m[1].trim()); } catch { return null; }
}

/** 从档案提取 Memory Block 段正文。 */
function wbGetMemoryBlockBody(text) {
  if (!text) return "";
  let m = text.match(/## Memory Block[ \t]*\r?\n\r?\n([\s\S]*?)\r?\n\r?\n---\r?\n\r?\n<!--\s*RAW_JSON_START/);
  if (m) return m[1];
  m = text.match(/## Memory Block[ \t]*\r?\n\r?\n([\s\S]*?)\r?\n\r?\n---/);
  if (m) return m[1];
  return "";
}

/** 从档案提取 uid（优先从 RAW_JSON，其次从文件名）。 */
function wbGetUid(archPath, archText) {
  const raw = wbParseRawJson(archText);
  if (raw && raw.uid) return raw.uid;
  return path.basename(archPath).replace(/_memory\.md$/, "");
}

/** 构造完整的档案内容（与 install-workbuddy.ps1 格式完全一致）。 */
function wbBuildArchive(uid, promptText) {
  const now = new Date().toISOString().replace(/\.\d+Z$/, ".000Z");
  const raw = {
    uid: uid,
    memoryBlock: promptText,
    updatedAt: now,
    version: WB_MEM_VERSION,
  };
  return (
    "# User Memory Profile\n" +
    "> Last updated: " + now + "\n" +
    "> Version: " + WB_MEM_VERSION + "\n\n" +
    "## Memory Block\n\n" +
    promptText.trimEnd() + "\n\n" +
    "---\n\n" +
    "<!-- RAW_JSON_START\n" +
    JSON.stringify(raw, null, 2) + "\n" +
    "RAW_JSON_END -->\n"
  );
}

/** 检查并修复单个记忆档案。返回 true 表示做了修复。 */
function wbGuardArchive(archPath, promptText, cfgLabel) {
  let archText = readUtf8Safe(archPath);
  if (archText === null) return false;

  const expectedBody = promptText.trim();
  const currentBody = wbGetMemoryBlockBody(archText).trim();
  const raw = wbParseRawJson(archText);
  const rawVersion = raw ? raw.version : null;
  const rawBlock = raw ? String(raw.memoryBlock || "").trim() : null;

  let needsRebuild = false;
  let reasons = [];

  // 检查 1: Memory Block 段内容是否与提示词一致
  if (currentBody !== expectedBody) {
    needsRebuild = true;
    reasons.push("MemoryBlock 内容不一致");
  }

  // 检查 2: RAW_JSON 的 version 是否还是 999999
  if (rawVersion !== WB_MEM_VERSION) {
    needsRebuild = true;
    reasons.push("version=" + rawVersion + "(应为" + WB_MEM_VERSION + ")");
  }

  // 检查 3: RAW_JSON 的 memoryBlock 是否与提示词一致
  if (rawBlock !== null && rawBlock !== expectedBody) {
    needsRebuild = true;
    reasons.push("RAW_JSON.memoryBlock 不一致");
  }

  // 检查 4: RAW_JSON 块本身是否存在
  if (!raw) {
    needsRebuild = true;
    reasons.push("RAW_JSON 缺失");
  }

  if (!needsRebuild) {
    // 内容 OK，只检查只读锁
    try {
      const stat = fs.statSync(archPath);
      // Windows: 检查只读位 (0o400 中的 owner-write 位)
      if ((stat.mode & 0o200) !== 0) {
        // 不是只读 → 设只读
        try { fs.chmodSync(archPath, 0o444); } catch {}
      }
    } catch {}
    return false;
  }

  // 需要重建档案
  const uid = wbGetUid(archPath, archText);
  const newContent = wbBuildArchive(uid, promptText);

  try {
    // 先解除只读（如果有的话）
    try { fs.chmodSync(archPath, 0o666); } catch {}
    writeUtf8Atomic(archPath, newContent);
    // 重新设只读（防云回写）
    try { fs.chmodSync(archPath, 0o444); } catch {}
    guardPush("WorkBuddy " + cfgLabel + ": " + path.basename(archPath) + " 已重建 (" + reasons.join(", ") + ")");
    return true;
  } catch (e) {
    guardPush("WorkBuddy " + cfgLabel + ": " + path.basename(archPath) + " 重建失败: " + String(e.message));
    return false;
  }
}

/** 检查并修复 app-config.json 的记忆开关。 */
function wbGuardAppConfig(cfgFile, cfgLabel) {
  const text = readUtf8Safe(cfgFile);
  if (text === null) return;
  let cfg;
  try { cfg = JSON.parse(text); } catch { return; }
  if (!cfg || typeof cfg !== "object") return;

  let changed = false;
  if (cfg.generateMemoryEnabled !== true) {
    cfg.generateMemoryEnabled = true;
    changed = true;
  }
  if (cfg.localMemoryEnabled !== true) {
    cfg.localMemoryEnabled = true;
    changed = true;
  }

  if (changed) {
    try {
      writeUtf8Atomic(cfgFile, JSON.stringify(cfg, null, 2) + "\n");
      guardPush("WorkBuddy " + cfgLabel + ": app-config.json 记忆开关已重置为 true");
    } catch (e) {
      guardPush("WorkBuddy " + cfgLabel + ": app-config.json 重置失败: " + String(e.message));
    }
  }
}

/** 检查并修复 MEMORY.md。
 *  策略：安装状态下（state 文件存在），MEMORY.md 必须与提示词一致。
 *  WorkBuddy 可能在运行时改写 MEMORY.md（写入 AI 笔记等），导致破甲失效。
 *  只要内容不匹配就恢复，安装前原始备份已由 install-workbuddy.ps1 存到 .bak-inject。
 */
function wbGuardMemoryFile(memFile, promptText, cfgLabel, stateExists) {
  const text = readUtf8Safe(memFile);
  if (text === null) return;
  const expected = promptText.trim();
  const current = text.trim();

  if (current === expected) return;

  // 没有 state 文件 = 没安装过，不碰用户的 MEMORY.md
  if (!stateExists) return;

  // 有 state 文件 = 已安装，MEMORY.md 被覆写了 → 恢复
  // 但如果内容不含寒霜标记且 .bak-inject 不存在 → 可能是用户自己写的，保守跳过
  const hasMarker = text.includes("寒霜") || text.includes("HANSHUANG");
  const hasBackup = fs.existsSync(memFile + ".bak-inject");
  const isEmpty = current.length === 0;

  if (!hasMarker && !hasBackup && !isEmpty) {
    // 可能是用户自己的 MEMORY.md，且没有安装前备份 → 不碰
    return;
  }

  try {
    writeUtf8Atomic(memFile, promptText.trimEnd() + "\n");
    guardPush("WorkBuddy " + cfgLabel + ": MEMORY.md 已恢复（内容被覆写）");
  } catch (e) {
    guardPush("WorkBuddy " + cfgLabel + ": MEMORY.md 恢复失败: " + String(e.message));
  }
}

/** WorkBuddy 守护主函数。 */
function guardWorkbuddy() {
  // 查找所有可能的配置目录
  const cfgDirs = [];
  const home = homeDir();

  // 1. 当前用户的标准目录
  for (const name of [".workbuddy", ".workbuddy-ai"]) {
    const dir = path.join(home, name);
    if (fs.existsSync(dir)) cfgDirs.push({ dir, label: name });
  }

  // 2. 其他用户目录（管理员运行时 $env:USERPROFILE 可能不是真实用户）
  const usersRoot = path.join(home.charAt(0) + ":\\", "Users");
  try {
    for (const u of fs.readdirSync(usersRoot)) {
      for (const name of [".workbuddy", ".workbuddy-ai"]) {
        const dir = path.join(usersRoot, u, name);
        if (fs.existsSync(dir) && !cfgDirs.some(c => c.dir === dir)) {
          cfgDirs.push({ dir, label: name + "(" + u + ")" });
        }
      }
    }
  } catch {}

  for (const { dir: cfgDir, label: cfgLabel } of cfgDirs) {
    // 读状态文件 —— state 文件不存在 = 未安装或已卸载，守护绝不碰任何文件。
    // 这是最关键的安全门：卸载/装回原始记忆会删 state 文件，守护必须尊重这个信号。
    // 没有 state 就注入 = 用户点了卸载却卸不掉，5 秒后破甲又回来了。
    const stateFile = path.join(cfgDir, ".hanshuang-state.json");
    const st = readJson(stateFile, null);
    if (!st) continue;  // ★ 核心安全门：无 state = 不注入

    // 找提示词源文件
    let promptText = null;
    let promptName = null;

    // 优先：state 记录的 prompt 文件名 → resources/memory/<prompt>
    if (st.prompt) {
      const promptPath = p(MEMORY_DIR, st.prompt);
      const text = readUtf8Safe(promptPath);
      if (text) {
        promptText = text;
        promptName = st.prompt;
      }
    }

    // 兜底 1：state 存在但 prompt 字段缺失 → 从 resources/memory/ 找第一个非空 .md
    // （只在 state 存在时才走这个兜底，不会在未安装时触发）
    if (!promptText) {
      try {
        const files = fs.readdirSync(p(MEMORY_DIR))
          .filter(n => n.toLowerCase().endsWith(".md") && n.toLowerCase() !== "readme.md")
          .sort();
        for (const name of files) {
          const text = readUtf8Safe(p(MEMORY_DIR, name));
          if (text && text.trim().length > 0) {
            promptText = text;
            promptName = name;
            break;
          }
        }
      } catch {}
    }

    // 兜底 2：提示词源文件也没了 → 从已有档案的 RAW_JSON 提取 memoryBlock
    // （安装过但提示词源被删了的场景，用档案里存的内容补注入）
    if (!promptText && st.archives && Array.isArray(st.archives)) {
      for (const archPath of st.archives) {
        const archText = readUtf8Safe(archPath);
        if (archText) {
          const raw = wbParseRawJson(archText);
          if (raw && raw.memoryBlock) {
            promptText = raw.memoryBlock;
            promptName = "(from archive)";
            break;
          }
        }
      }
    }

    // 三级查找都找不到提示词 → 没法补注入
    if (!promptText) continue;

    // 1. 守护云记忆档案
    // 合并：state 记录的 + 目录下新出现的（换账号后新 uid 的档案）
    const knownArchives = (st && st.archives) ? st.archives : [];
    const allArchives = [...new Set([...knownArchives, ...wbFindArchives(cfgDir)])];

    for (const archPath of allArchives) {
      if (!fs.existsSync(archPath)) continue;
      wbGuardArchive(archPath, promptText, cfgLabel);
    }

    // 2. 守护 MEMORY.md
    const memFile = (st && st.memoryFile) ? st.memoryFile : path.join(cfgDir, "MEMORY.md");
    if (fs.existsSync(memFile)) {
      wbGuardMemoryFile(memFile, promptText, cfgLabel, !!st);
    }

    // 3. 守护 app-config.json 记忆开关
    const cfgFile = (st && st.appConfig) ? st.appConfig : path.join(cfgDir, "app", "app-config.json");
    if (fs.existsSync(cfgFile)) {
      wbGuardAppConfig(cfgFile, cfgLabel);
    }

    // 4. 如果状态文件记录的 archives 列表与实际不一致（新档案出现），
    //    更新状态文件让下次扫描能覆盖到
    if (st && allArchives.length > knownArchives.length) {
      st.archives = allArchives;
      try {
        writeUtf8Atomic(stateFile, JSON.stringify(st, null, 2) + "\n");
      } catch {}
    }
  }
}

// ---- OpenCode 守护：~/.config/opencode/AGENTS.md ----

function guardOpencode() {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(homeDir(), ".config");
  const ocDir = path.join(configHome, "opencode");
  const managedDir = path.join(ocDir, "managed-prompts");
  const stateFile = path.join(managedDir, "install-state.json");
  const st = readJson(stateFile, null);
  if (!st) return;

  // OpenCode 的 state 可能有 targetPrompt 或 prompt（仅文件名），兜底从 managed-prompts 找
  let promptPath = st.targetPrompt || null;
  if (st.prompt && !promptPath) {
    promptPath = path.join(managedDir, st.prompt);
  }
  if (!promptPath || !fs.existsSync(promptPath)) {
    try {
      const files = fs.readdirSync(managedDir).filter(n => n.endsWith(".md") && !n.endsWith(".bak"));
      if (files.length > 0) promptPath = path.join(managedDir, files[0]);
    } catch {}
  }
  if (!promptPath || !fs.existsSync(promptPath)) return;

  const agentsPath = path.join(ocDir, "AGENTS.md");
  const text = readUtf8Safe(agentsPath);
  if (text !== null) {
    const beginRe = /<!--\s*(?:HANSHUANG-INJECT:BEGIN|寒霜破甲[^\r\n]*注入开始)[^\r\n]*-->/;
    if (!beginRe.test(text)) {
      const promptText = readUtf8Safe(promptPath);
      if (promptText) {
        const body = promptText.trimEnd();
        const block =
          "<!-- HANSHUANG-INJECT:BEGIN prompt=" + path.basename(promptPath) + " -->\n" +
          body + "\n" +
          "<!-- HANSHUANG-INJECT:END -->\n";
        const newText = text.trimEnd() + "\n\n" + block;
        writeUtf8Atomic(agentsPath, newText);
        guardPush("OpenCode AGENTS.md: 注入块丢失，已重新追加");
      }
    }
  }
}

/** 守护主循环：轮询所有已安装目标的注入点。 */
function guardTick() {
  try {
    const snap = installedSnapshot();
    const installed = snap.installed || {};
    for (const targetId of Object.keys(installed)) {
      switch (targetId) {
        case "codex": guardCodex(); break;
        case "dsh": guardDsh(); break;
        case "claude": guardClaude(); break;
        case "workbuddy":
        case "workbuddy-cn": guardWorkbuddy(); break;
        case "opencode": guardOpencode(); break;
        // cursor / zcode / doubao：注入点较稳定（AGENTS.md / 配置文件不被 agent 自身覆写），
        // 如有类似问题可按同模式扩展。
      }
    }
  } catch (e) {
    // 守护异常绝不影响主进程
    guardPush("守护异常(已忽略): " + String(e && e.message));
  }
}

function startGuard() {
  if (guardTimer) return;
  guardPush("配置守护已启动 (间隔 " + GUARD_INTERVAL_MS + "ms)");
  // 首次立即跑一次
  setTimeout(guardTick, 2000);
  guardTimer = setInterval(guardTick, GUARD_INTERVAL_MS);
}

function stopGuard() {
  if (guardTimer) {
    clearInterval(guardTimer);
    guardTimer = null;
    guardPush("配置守护已停止");
  }
}

// ---------- IPC ----------

function registerIpc() {
  ipcMain.handle("tool:state", () => ({
    installed: installedSnapshot().installed,
    version: app.getVersion(),
  }));

  /** 记忆文件状态：界面用它显示「已填写 N 字 / 还没填」，安装前也会再查一次。 */
  ipcMain.handle("tool:memory", () => memoryPrompt());

  /**
     安装：把 memory/ 里用户填的提示词注入目标，并同步随包的 Seep 工作台技能库。
     记忆为空时直接失败 —— 宁可报错，也不要把空内容写进用户的 AGENTS.md / 记忆档案。
  */
  ipcMain.handle("tool:install", async (_e, targetId) => {
    const installed = installedSnapshot().installed;
    if (!SCRIPTS[targetId]) {
      return { ok: false, code: -1, timedOut: false, out: `未知的破甲目标：${targetId}`, installed };
    }
    const prompt = memoryPrompt();
    if (!prompt) {
      const dir = p(MEMORY_DIR);
      const text = `记忆文件为空：请先把提示词粘进 ${dir} 下的 .md 文件，再点安装。`;
      send("tool:status", { label: "记忆文件为空", state: "idle" });
      send("tool:log", { label: "安装中止", text: text + "\n" });
      return { ok: false, code: -1, timedOut: false, out: text, error: text, installed };
    }
    const res = await runPowerShell(installArgs(targetId, prompt.path), `安装 ${targetId}`, INSTALL_TIMEOUT);
    if (res.ok) {
      const st = loadState();
      st.installed[targetId] = prompt.name;
      saveState({ installed: st.installed });
    }
    return { ...res, installed: installedSnapshot().installed };
  });

  ipcMain.handle("seep:state", () => seepState());

  /** 部署 Seep 工作台：解压离线依赖 + Python 依赖 + Pi/Claude/DSH 配置 + 自检。 */
  ipcMain.handle("seep:install", async () => {
    const script = seepScript("install.ps1");
    if (!fs.existsSync(script)) {
      const text = `随包缺少 Seep 工作台安装脚本：${script}`;
      return { ok: false, code: -1, timedOut: false, out: text, error: text };
    }
    return runPowerShell(["-File", script, "-NonInteractive"], "部署 Seep 逆向工作台", SEEP_TIMEOUT);
  });

  ipcMain.handle("seep:uninstall", async () => {
    const script = seepScript("uninstall.ps1");
    if (!fs.existsSync(script)) {
      const text = `随包缺少 Seep 工作台卸载脚本：${script}`;
      return { ok: false, code: -1, timedOut: false, out: text, error: text };
    }
    // -Yes 跳过交互确认（主进程没法回话），保留用户自装技能与自己的配置
    return runPowerShell(["-File", script, "-Yes"], "卸载 Seep 逆向工作台", SEEP_TIMEOUT);
  });

  ipcMain.handle("seep:verify", async () => {
    const script = seepScript("verify.ps1");
    if (!fs.existsSync(script)) {
      const text = `随包缺少 Seep 工作台自检脚本：${script}`;
      return { ok: false, code: -1, timedOut: false, out: text, error: text };
    }
    return runPowerShell(["-File", script, "-Detailed"], "Seep 工作台自检", SEEP_TIMEOUT);
  });


  ipcMain.handle("tool:uninstall", async (_e, targetId) => {
    const res = await runPowerShell(uninstallArgs(targetId), `卸载 ${targetId}`, UNINSTALL_TIMEOUT);
    if (res.ok) {
      const st = loadState();
      delete st.installed[targetId];
      saveState({ installed: st.installed });
    }

    // 兜底清扫：**不依赖 install*.ps1 的卸载结果**，无条件执行。
    //
    // install*.ps1 的卸载靠 <Home>\managed-prompts\install-state.json 记录该删哪些提示词。
    // state 一旦不在了（被清理工具删过、用户手工删过、上次卸载删掉了），提示词就留在盘上
    // 没人管 —— 实测本机 5 个提示词 + 几个 .mdc 就是这么残留的。
    //
    // 而且卸载脚本自己也可能失败（文件被占用、权限不足、脚本报错）。早期写法把这一步
    // 放在 `if (res.ok)` 里面，于是「卸载脚本失败 ⇒ 兜底也不跑 ⇒ 提示词原样留着」——
    // 偏偏那正是最需要兜底的时候。「点卸载 = 提示词清干净」是硬要求，所以移到这里。
    //
    // 这一步按注入点和副产物直接扫，只清提示词，用户的 AGENTS.md / CLAUDE.md /
    // config.toml / 自己的备份一律不动（详见脚本头部注释）。
    const sweep = await runPowerShell(
      clearPromptsArgs(targetId),
      `清理 ${targetId} 提示词残留`,
      UNINSTALL_TIMEOUT,
    );
    res.out = (res.out || "") + "\n" + (sweep.out || "");
    if (!sweep.ok) {
      res.ok = false;
      res.error = sweep.error || "提示词残留清理失败";
    }
    return { ...res, installed: installedSnapshot().installed };
  });

  // 装回原始记忆：把该目标的注入内容还原成原版，技能库保留。
  //
  // 这里**不跑** clearPromptsArgs 兜底清扫 —— 那个脚本连技能树一起清（它的职责是卸载后的
  // 零残留），跟「只想换回原版」正好相反。注入内容本身也不需要它兜底：本 handler 与卸载
  // 走同一段还原逻辑，各注入点（AGENTS.md / CLAUDE.md / config.toml / 记忆档案）都在里面处理掉了。
  ipcMain.handle("tool:restoreMemory", async (_e, targetId) => {
    if (!SCRIPTS[targetId]) {
      return {
        ok: false,
        code: -1,
        timedOut: false,
        out: `未知的破甲目标：${targetId}`,
        installed: installedSnapshot().installed,
      };
    }
    const res = await runPowerShell(
      restoreMemoryArgs(targetId),
      `装回 ${targetId} 原始记忆`,
      UNINSTALL_TIMEOUT,
    );
    // 不动 installed 记录：技能库还在，工具仍处于已安装状态 ——
    // 想彻底回到安装前用「卸载」，这个按钮只负责把记忆换回来。
    return { ...res, installed: installedSnapshot().installed };
  });

  ipcMain.handle("tool:restartCodex", async () => {
    const cmd =
      "$ErrorActionPreference = 'SilentlyContinue'; " +
      "$appId = (Get-StartApps | Where-Object { $_.AppID -like 'OpenAI.Codex*' } | Select-Object -First 1 -ExpandProperty AppID); " +
      "$chat = @(Get-Process ChatGPT | Where-Object { $_.Path -like '*OpenAI.Codex*' }); " +
      "$chat | Stop-Process -Force; " +
      "$cx = @(Get-Process codex -ErrorAction SilentlyContinue); " +
      "$cx | Stop-Process -Force; " +
      "Start-Sleep -Milliseconds 1200; " +
      "if (-not $appId) { Write-Output 'no-appid'; exit 0 } " +
      // 直接 Start-Process shell:AppsFolder 拉起；多套一层 explorer.exe -ArgumentList 实测不可靠
      "Start-Process ('shell:AppsFolder\\' + $appId); " +
      // 等应用真起来再回话，避免「命令发出去了但其实没启动」也算成功
      "for ($i = 0; $i -lt 20; $i++) { Start-Sleep -Milliseconds 500; if (@(Get-Process ChatGPT).Count -gt 0) { break } } " +
      "Write-Output ('launched:' + $appId + ' procs:' + @(Get-Process ChatGPT).Count)";
    return new Promise((resolve) => {
      /*
        这里不能带 detached: true。Windows 上 detached 走 DETACHED_PROCESS，
        powershell 失去控制台后会在 ~100ms 内直接退出、命令一行都不执行
        （实测：带 detached 时 stdout 为空、94ms 退出；去掉后 900ms 正常返回），
        表现就是点「重启 Codex」毫无反应。父进程 await close 即可，无需 detach。
      */
      const ps = spawn("powershell.exe", ["-NoProfile", "-Command", cmd], { windowsHide: true });
      let out = "";
      let raw = Buffer.alloc(0);
      const onChunk = (buf) => {
        raw = Buffer.concat([raw, buf]);
        out = decodeConsoleOutput(raw);
      };
      ps.stdout.on("data", onChunk);
      ps.stderr.on("data", onChunk);
      ps.on("close", (code) => {
        const text = out.trim();
        const launched = /^launched:/m.test(text);
        resolve({
          ok: code === 0 && launched,
          code: code == null ? -1 : code,
          out: text,
          // 没找到 AppID 时给一句能看懂的话，而不是把失败也报成「重启指令已发送」
          error: launched ? undefined : text || "未找到 Codex 应用（Get-StartApps 无 OpenAI.Codex* 条目）",
        });
      });
      ps.on("error", (e) => resolve({ ok: false, code: -1, out, error: String(e && e.message) }));
    });
  });

  ipcMain.handle("tool:skills:list", () => listSkills());
  ipcMain.handle("tool:skills:save", (_e, disabled) => writeDisabledSkills(disabled || []));

  /** 守护状态查询：界面可显示「守护运行中 / 已补注入 N 次」。 */
  ipcMain.handle("tool:guard", () => ({
    running: guardTimer !== null,
    interval: GUARD_INTERVAL_MS,
    log: guardLog.slice(-20),
  }));

  ipcMain.handle("tool:openQQ", async (_e, url) => {
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) {
      console.log("[openQQ] 拒绝非 http(s) 链接:", url);
      return { ok: false, error: "invalid url" };
    }
    try {
      await shell.openExternal(url);
      console.log("[openQQ] 已用系统浏览器打开:", url.slice(0, 60) + "…");
      return { ok: true };
    } catch (e) {
      console.log("[openQQ] 打开失败:", String(e && e.message));
      return { ok: false, error: String(e && e.message) };
    }
  });

  ipcMain.handle("tool:quit", () => {
    app.quit();
    return { ok: true };
  });

  ipcMain.handle("tool:win", (_e, action) => {
    if (!win) return { ok: false };
    if (action === "minimize") win.minimize();
    else if (action === "maximize") win.isMaximized() ? win.unmaximize() : win.maximize();
    else if (action === "close") win.close();
    return { ok: true };
  });
}

// ---------- 窗口 ----------

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: "#ffffff",
    title: APP_NAME,
    /*
      用系统原生标题栏。之前用 titleBarStyle:"hidden" 自绘拖拽条，
      在 Windows 上导致窗口拖不动、且只有上下边能缩放；原生边框两个问题都没有。
    */
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  /*
    显示窗口。只挂 ready-to-show 并不可靠：窗口以 show:false 创建时，若
    Chromium 判定窗口被遮挡 / 未激活，首帧可能迟迟不画，ready-to-show 就
    不触发，结果是进程活着但永远没有窗口。这里三重兜底。
  */
  const showOnce = () => {
    if (win && !win.isDestroyed() && !win.isVisible()) win.show();
  };
  win.once("ready-to-show", showOnce);
  win.webContents.once("did-finish-load", showOnce);
  setTimeout(showOnce, 1200);

  // 默认加载构建产物；只有显式 HS_DEV=1 时才连 Vite 开发服务器。
  if (!app.isPackaged && process.env.HS_DEV) {
    win.loadURL("http://localhost:5273");
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  // 关窗只收进托盘（与 Python 版一致）；真正退出走托盘菜单或 app.quit()
  win.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });

  win.on("closed", () => {
    win = null;
  });

  // 开发用：把渲染进程的 console / 未捕获异常转发到终端
  if (process.env.HS_CAPTURE || process.env.HS_DEBUG) {
    win.webContents.on("console-message", (_e, lvl, msg, line, src) => {
      console.log("[renderer:%s] %s (%s:%s)", lvl, msg, src, line);
    });
    win.webContents.on("render-process-gone", (_e, d) => {
      console.log("[renderer gone]", JSON.stringify(d));
    });
    win.webContents.on("did-fail-load", (_e, code, desc) => {
      console.log("[load failed]", code, desc);
    });
  }

  // 开发用：HS_CAPTURE=<dir> 时逐页截图后退出，用于验收版式。
  if (process.env.HS_CAPTURE) {
    win.webContents.once("did-finish-load", () => {
      captureAll(process.env.HS_CAPTURE).catch(() => app.quit());
    });
  }
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function captureAll(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const nav = (i) => `document.querySelectorAll(".settings-nav-scroll .settings-nav-item")[${i}].click()`;
  // 索引跟随 data/targets.ts 的目标顺序；工具组固定排在目标组之后
  const shots = [
    ["codex", null],
    ["zcode", nav(1)],
    ["workbuddy", nav(5)],
    ["dsh", nav(7)],
    ["seep", nav(9)],
    ["skills", nav(10)],
    ["tutorial", nav(11)],
    ["profile", 'document.querySelector(".app-nav-foot .settings-nav-item").click()'],
  ];
  // 截图前确保窗口真正可见并聚焦，否则 Chromium 会冻结 CSS 动画时间线
  try {
    win.show();
    win.focus();
    win.moveTop();
  } catch {
    /* ignore */
  }
  await wait(2000);
  if (process.env.HS_QQTEST) {
    const r = await win.webContents.executeJavaScript(
      'window.hs.openQQ("https://qun.qq.com/universal-share/share?ac=1&authKey=test")',
    );
    console.log("[qqtest] openQQ ->", JSON.stringify(r));
  }
  if (process.env.HS_DOM) {
    console.log(
      "[vis]",
      await win.webContents.executeJavaScript(
        "document.visibilityState + ' hidden=' + document.hidden",
      ),
    );
  }
  if (process.env.HS_DOM) {
    const info = await win.webContents.executeJavaScript(`(() => {
      const r = document.getElementById("root");
      const cs = r ? getComputedStyle(r) : null;
      return JSON.stringify({
        rootChildren: r ? r.children.length : -1,
        rootHTML: r ? r.innerHTML.slice(0, 400) : "",
        rootBox: r ? [r.clientWidth, r.clientHeight] : null,
        bodyBox: [document.body.clientWidth, document.body.clientHeight],
        rootDisplay: cs ? cs.display : null,
        probe: [".app-shell", ".settings-shell-full", ".settings-nav", ".settings-content",
                ".settings-section-title", ".settings-card-heading"].map(sel => {
          const el = document.querySelector(sel);
          if (!el) return sel + " => MISSING";
          const c = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return sel + " rect=" + Math.round(r.width) + "x" + Math.round(r.height) +
                 " disp=" + c.display + " vis=" + c.visibility + " op=" + c.opacity +
                 " color=" + c.color + " bg=" + c.backgroundColor +
                 " anim=" + c.animationName + " fs=" + c.fontSize;
        }),
        cssVars: ["--ds-text-primary","--ds-bg-primary","--text-md","--radius-md","--ds-accent"]
          .map(v => v + "=" + getComputedStyle(document.documentElement).getPropertyValue(v).trim()),
        scripts: [...document.scripts].map(s => s.src),
        sheets: [...document.styleSheets].length,
      });
    })()`);
    console.log("[dom]", info);
  }
  // 先同意免责声明，否则遮罩挡住后面的交互
  await win.webContents.executeJavaScript(
    'document.querySelector(".dialog .btn-primary")?.click(), true',
  );
  await wait(400);

  // 开发用：HS_INSTALLTEST=<targetId> 时在界面上真点一次「安装」，把状态与日志抓回来
  if (process.env.HS_INSTALLTEST) {
    const target = process.env.HS_INSTALLTEST;
    const navIdx = { codex: 0, zcode: 1, cursor: 2, opencode: 3, claude: 4, workbuddy: 5, dsh: 7 }[target];
    if (navIdx !== undefined) {
      await win.webContents.executeJavaScript(
        `document.querySelectorAll(".settings-nav-scroll .settings-nav-item")[${navIdx}].click(), true`,
      );
      await wait(600);
    }
    // HS_PROMPTTEST=<版本名片段>：先选中对应版本，再点安装/卸载
    if (process.env.HS_PROMPTTEST) {
      const picked = await win.webContents.executeJavaScript(`(() => {
        const want = ${JSON.stringify(process.env.HS_PROMPTTEST)};
        const row = [...document.querySelectorAll(".settings-panel .settings-row")].find((r) => r.textContent.includes(want));
        if (row) row.click();
        return !!row;
      })()`);
      console.log("[installtest] 选中版本 " + process.env.HS_PROMPTTEST + " -> " + picked);
      await wait(400);
    }
    await win.webContents.executeJavaScript(`(() => {
      const btns = [...document.querySelectorAll(".app-inline-actions .btn")];
      const btn = ${process.env.HS_UNINSTALLTEST ? 'btns.find((b) => /卸载/.test(b.textContent))' : 'btns.find((b) => /安装/.test(b.textContent) && !/卸载|重启/.test(b.textContent))'};
      if (btn) btn.click();
      return !!btn;
    })()`);

    // HS_CHOICETEST=<名称片段>：V5 双提示词弹框里选中那一份再确认（截图留证）
    if (process.env.HS_CHOICETEST) {
      await wait(700);
      const info = await win.webContents.executeJavaScript(`(() => {
        const rows = [...document.querySelectorAll(".overlay .settings-row")];
        const row = rows.find((r) => r.textContent.includes(${JSON.stringify(process.env.HS_CHOICETEST)}));
        if (row) row.click();
        return JSON.stringify({
          rows: rows.map((r) => r.querySelector(".settings-row-title").textContent.trim()),
          picked: !!row,
        });
      })()`);
      console.log("[choicetest] 弹框选项 " + info);
      const shot = await win.webContents.capturePage();
      fs.writeFileSync(path.join(dir, "v5-choice-dialog.png"), shot.toPNG());
      const confirmed = await win.webContents.executeJavaScript(`(() => {
        const ok = [...document.querySelectorAll(".overlay .app-inline-actions .btn")]
          .find((b) => /^安装/.test(b.textContent.trim()));
        if (ok) ok.click();
        return ok ? ok.textContent.trim() : false;
      })()`);
      console.log("[choicetest] 确认 -> " + confirmed);
    }
    await wait(25000);
    const state = await win.webContents.executeJavaScript(`(() => {
      const descs = [...document.querySelectorAll(".settings-card-description")];
      const badge = document.querySelector(".badge-success, .badge-neutral");
      const pre = document.querySelector(".app-pre");
      const btn = [...document.querySelectorAll(".app-inline-actions .btn")].find((b) => /安装|执行中/.test(b.textContent));
      return JSON.stringify({
        status: descs.length ? descs[descs.length - 1].textContent.trim().slice(0, 200) : "(无)",
        badge: badge ? badge.textContent.trim().slice(0, 40) : "(无)",
        button: btn ? btn.textContent.trim() : "(无)",
        log: pre ? pre.textContent.trim().slice(-500) : "(无日志)",
      });
    })()`);
    console.log("[installtest] " + target + " -> " + state);
  }

  // 开发用：HS_SKILLTEST=1 时点一次「保存」并断言全局提示出现（验收 Skills 保存反馈）
  if (process.env.HS_SKILLTEST) {
    await win.webContents.executeJavaScript(
      'document.querySelectorAll(".settings-nav-scroll .settings-nav-item")[10].click(), true',
    );
    await wait(500);
    const clicked = await win.webContents.executeJavaScript(`(() => {
      const btns = [...document.querySelectorAll(".app-inline-actions .btn")];
      const save = btns.find((b) => b.textContent.trim() === "保存");
      if (!save) return "NO_SAVE_BUTTON";
      save.click();
      return "CLICKED";
    })()`);
    await wait(1200);
    const toast = await win.webContents.executeJavaScript(
      '(() => { const t = document.querySelector(".toast"); return t ? t.textContent.trim() : "NO_TOAST"; })()',
    );
    console.log("[skilltest] 点击=" + clicked + " 提示=" + toast);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(dir, "skills-save-toast.png"), img.toPNG());
  }
  for (const [name, js] of shots) {
    if (js) {
      await win.webContents.executeJavaScript(js + ", true");
      // 页面重（技能列表 / 教程长文）时 450ms 会抓到上一页，留够渲染时间
      await wait(1200);
    }
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(dir, name + ".png"), img.toPNG());
  }
  app.quit();
}

/** 显示窗口；若之前已被销毁则重建。托盘点击、菜单、第二实例都走这里。 */
function showWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function makeTrayIcon() {
  // 与安装包图标同一张图；打包后在 resources/icon.png，开发时在 build/
  const candidates = [
    path.join(process.resourcesPath || "", "icon.png"),
    path.join(__dirname, "..", "build", "icon-256.png"),
  ];
  for (const f of candidates) {
    try {
      if (f && fs.existsSync(f)) {
        const img = nativeImage.createFromPath(f);
        if (!img.isEmpty()) return img;
      }
    } catch {
      /* 落到下面的兜底 */
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">
    <rect width="32" height="32" rx="7" fill="#2E8FE0"/>
    <text x="16" y="23" font-size="20" text-anchor="middle" fill="#ffffff">寒</text>
  </svg>`;
  return nativeImage.createFromDataURL(
    "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64"),
  );
}

function setupTray() {
  try {
    tray = new Tray(makeTrayIcon());
    tray.setToolTip(APP_NAME);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "显示主界面", click: () => showWindow() },
        { type: "separator" },
        { label: "退出", click: () => app.quit() },
      ]),
    );
    tray.on("click", () => showWindow());
  } catch {
    tray = null;
  }
}

// ---------- 生命周期 ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showWindow();
  });

  app.whenReady().then(() => {
    registerIpc();
    createWindow();
    setupTray();
    startGuard();
  });

  app.on("window-all-closed", () => {
    // 托盘常驻：关掉窗口不退出应用
    if (!tray) app.quit();
  });

  app.on("before-quit", () => {
    quitting = true;
    stopGuard();
    killChild();
    if (tray) {
      tray.destroy();
      tray = null;
    }
  });

  app.on("activate", () => showWindow());
}
