const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const rootDir = path.resolve(__dirname, "..");
const envPath = path.join(rootDir, "telegram-bridge.env");
const statePath = path.join(rootDir, ".telegram-bridge-state.json");
const lockPath = path.join(rootDir, ".telegram-bridge.lock");
const logPath = path.join(rootDir, "telegram-bridge.log");
const maxTelegramMessageLength = 3500;
let activeRun = false;

function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  try {
    fs.appendFileSync(logPath, `${line}\n`, "utf8");
  } catch {}
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadSimpleEnv(filePath) {
  const values = {};
  if (!fs.existsSync(filePath)) return values;
  const text = fs.readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    values[key] = value;
  }
  return values;
}

function getConfig() {
  const fileValues = loadSimpleEnv(envPath);
  const read = (key, fallback = "") => process.env[key] || fileValues[key] || fallback;
  const token = read("TELEGRAM_BOT_TOKEN");
  const chatId = read("TELEGRAM_ALLOWED_CHAT_ID");
  if (!token) throw new Error(`TELEGRAM_BOT_TOKEN is missing. Set it in ${path.basename(envPath)}.`);
  if (!chatId) throw new Error(`TELEGRAM_ALLOWED_CHAT_ID is missing. Set it in ${path.basename(envPath)}.`);
  return {
    token,
    chatId,
    pollTimeout: Number(read("TELEGRAM_POLL_TIMEOUT", "25")),
    codexTimeout: Number(read("CODEX_RUN_TIMEOUT_SECONDS", "900")),
    codexWorkspace: read("CODEX_WORKSPACE", rootDir),
    codexCommand: read("CODEX_COMMAND"),
    codexSandbox: read("CODEX_SANDBOX", "workspace-write"),
    gitCommand: read("GIT_COMMAND"),
    gitUserName: read("GIT_USER_NAME", "unyu1022"),
    gitUserEmail: read("GIT_USER_EMAIL", "kyj921022@gmail.com"),
  };
}

function loadState() {
  if (!fs.existsSync(statePath)) return { last_update_id: 0 };
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return { last_update_id: 0 };
  }
}

function saveState(state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLockOrExit() {
  if (fs.existsSync(lockPath)) {
    const existingPid = Number(fs.readFileSync(lockPath, "utf8").trim());
    if (existingPid && existingPid !== process.pid && processIsAlive(existingPid)) {
      throw new Error(`다른 Telegram 브리지가 이미 실행 중입니다. PID=${existingPid}`);
    }
  }
  fs.writeFileSync(lockPath, String(process.pid), "utf8");
  process.on("exit", releaseLock);
  process.on("SIGINT", () => {
    releaseLock();
    process.exit(0);
  });
}

function releaseLock() {
  try {
    if (fs.existsSync(lockPath) && fs.readFileSync(lockPath, "utf8").trim() === String(process.pid)) {
      fs.unlinkSync(lockPath);
    }
  } catch {}
}

async function telegramGet(token, method, params) {
  const url = new URL(`https://api.telegram.org/bot${token}/${method}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const response = await fetch(url);
  return response.json();
}

async function telegramPost(token, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
  });
  return response.json();
}

async function sendMessage(token, chatId, text) {
  let message = String(text || "");
  if (message.length > maxTelegramMessageLength) {
    message = `${message.slice(0, maxTelegramMessageLength - 120)}\n\n[truncated]`;
  }
  await telegramPost(token, "sendMessage", { chat_id: chatId, text: message });
  log(`sent message chat_id=${chatId} length=${message.length}`);
}

function buildHelpText() {
  return [
    "사용 가능한 명령:",
    "/start - 연결 확인",
    "/ping - 봇 응답 확인",
    "/run <내용> - Codex 실행 후 요약 전송",
    "/runraw <내용> - Codex 최종 답변만 전송",
    "/push <커밋 메시지> - 브리지가 git add/commit/push 실행",
    "/gitstatus - 현재 Git 상태 확인",
    ". <내용> - /runraw와 동일",
    "/ <내용> - /runraw와 동일",
    "일반 메시지 - /runraw와 동일",
    "/status - 현재 실행 상태 확인",
    "/help - 도움말",
  ].join("\n");
}

function commandExists(filePath) {
  return filePath && fs.existsSync(filePath);
}

function resolveCodexCommand(config) {
  const candidates = [
    config.codexCommand,
    path.join(process.env.APPDATA || "", "npm", "codex.cmd"),
    path.join(process.env.APPDATA || "", "npm", "codex.ps1"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (commandExists(candidate)) return candidate;
  }
  return null;
}

function resolveGitCommand(config) {
  const candidates = [
    config.gitCommand,
    "C:\\Program Files\\Git\\cmd\\git.exe",
    "C:\\Program Files\\Git\\bin\\git.exe",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (commandExists(candidate)) return candidate;
  }
  return null;
}

function buildCodexPrompt(payload, retry = false) {
  const basePrompt = [
    "아래 작업을 지금 바로 수행하고, 최종 답변만 한국어로 작성하세요.",
    "작업 폴더 안의 파일을 읽거나 명령을 실행해 실제 결과를 확인한 뒤 답하세요.",
    "Git 명령이 필요하면 `C:\\Program Files\\Git\\cmd\\git.exe` 절대경로를 우선 사용하세요.",
    "지시를 이해했다는 말, 앞으로 하겠다는 말, 작업 계획은 금지합니다.",
    "영어로 답하지 마세요.",
    "최종 답변은 바로 결과부터 시작하세요.",
    "분석 요청이면 분석 결과를, 수정 요청이면 수정 결과를 적으세요.",
    "Cloudflare 직접 배포는 시도하지 마세요. `wrangler deploy`, `deploy_cloudflare.cmd`, `npx wrangler deploy`를 실행하지 마세요.",
    "배포가 필요한 경우에도 Codex가 직접 commit/push 하지 마세요. 코드 수정까지만 수행하면 Telegram 브리지가 직접 GitHub origin/main 에 commit/push 합니다.",
    "질문이나 의견 요청이면 파일을 수정하지 말고, 현재 코드 기준으로 분석과 제안만 답하세요.",
    "실제로 불가능한 경우에만 짧게 이유를 적으세요.",
    "",
    `작업:\n${payload}`,
  ].join("\n");

  if (!retry) return basePrompt;
  return [
    "이전 답변은 작업 결과가 아니었습니다. 이번에는 확인 문구나 계획이 아니라 실제 결과만 한국어로 답하세요.",
    "",
    basePrompt,
  ].join("\n");
}

function runProcess(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    input: options.input,
    encoding: "utf8",
    timeout: options.timeoutMs,
    // Codex --json can emit a lot of event data. Node's default spawnSync
    // buffer is small enough to kill the child and report status=null.
    maxBuffer: 1024 * 1024 * 100,
    windowsHide: true,
  });
}

function executeCodexCommand(workspace, codexCommand, sandboxMode, prompt, outputFile, timeoutSeconds) {
  const args = [
    "exec",
    "--json",
    "--full-auto",
    "--sandbox",
    sandboxMode,
    "--skip-git-repo-check",
    "--output-last-message",
    outputFile,
    "--cd",
    workspace,
    "-",
  ];

  if (codexCommand.toLowerCase().endsWith(".ps1")) {
    return runProcess(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", codexCommand, ...args],
      { cwd: workspace, input: prompt, timeoutMs: timeoutSeconds * 1000 },
    );
  }

  return runProcess(codexCommand, args, { cwd: workspace, input: prompt, timeoutMs: timeoutSeconds * 1000 });
}

function parseCodexResult(completed, outputFile) {
  let finalMessage = "";
  let eventCount = 0;
  if (fs.existsSync(outputFile)) {
    finalMessage = fs.readFileSync(outputFile, "utf8").trim();
  }
  const stdoutText = (completed.stdout || "").trim();
  for (const line of stdoutText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      eventCount += 1;
      const item = event.item || {};
      if (event.type === "item.completed" && item.type === "agent_message") {
        finalMessage = item.text || finalMessage;
      }
    } catch {
      finalMessage = line.trim();
    }
  }
  return {
    finalMessage,
    eventCount,
    stderrText: (completed.stderr || "").trim(),
    errorText: completed.error ? `${completed.error.name || "Error"}: ${completed.error.message || completed.error}` : "",
    signalText: completed.signal ? String(completed.signal) : "",
  };
}

function formatCodexSummary(payload, finalMessage, eventCount) {
  return [
    "Codex 실행 완료",
    `요청: ${payload}`,
    `이벤트: ${eventCount}`,
    "",
    finalMessage.trim() || "최종 메시지를 받지 못했습니다.",
  ].join("\n");
}

function isAcknowledgementOnly(text) {
  const normalized = text.trim().replace(/\s+/g, " ").toLowerCase();
  if (!normalized) return true;
  const markers = [
    "understood.",
    "i'll ",
    "i will ",
    "avoid interactive prompts",
    "non-interactive",
    "powershell-friendly",
    "work only inside the current workspace",
  ];
  const hits = markers.filter((marker) => normalized.includes(marker)).length;
  return hits >= 2 && normalized.length < 320;
}

function runGitCommand(workspace, gitCommand, args, timeoutSeconds = 120) {
  return runProcess(gitCommand, args, { cwd: workspace, timeoutMs: timeoutSeconds * 1000 });
}

function buildBridgeCommitMessage(payload) {
  let normalized = payload.trim().replace(/\s+/g, " ");
  if (!normalized) return "Update from Telegram bridge";
  if (normalized.length > 80) normalized = `${normalized.slice(0, 77).trim()}...`;
  return `Telegram bridge: ${normalized}`;
}

function publishGitChanges(config, commitMessage) {
  const workspace = path.resolve(config.codexWorkspace);
  const gitCommand = resolveGitCommand(config);
  if (!gitCommand) return { ok: false, message: "git 실행 파일을 찾지 못했습니다." };

  runGitCommand(workspace, gitCommand, ["config", "user.name", config.gitUserName]);
  runGitCommand(workspace, gitCommand, ["config", "user.email", config.gitUserEmail]);

  const addResult = runGitCommand(workspace, gitCommand, ["add", "-A"]);
  if (addResult.status !== 0) return { ok: false, message: `git add 실패:\n${addResult.stderr || addResult.stdout}`.trim() };

  const statusResult = runGitCommand(workspace, gitCommand, ["status", "--short"]);
  if (statusResult.status !== 0) return { ok: false, message: `git status 실패:\n${statusResult.stderr || statusResult.stdout}`.trim() };
  if (!statusResult.stdout.trim()) return { ok: true, message: "커밋할 변경 사항이 없습니다." };

  const commitResult = runGitCommand(workspace, gitCommand, ["commit", "-m", commitMessage || "Update from Telegram bridge"], 180);
  if (commitResult.status !== 0) return { ok: false, message: `git commit 실패:\n${commitResult.stderr || commitResult.stdout}`.trim() };

  const pushResult = runGitCommand(workspace, gitCommand, ["push", "origin", "main"], 300);
  if (pushResult.status !== 0) return { ok: false, message: `git push 실패:\n${pushResult.stderr || pushResult.stdout}`.trim() };

  const headResult = runGitCommand(workspace, gitCommand, ["rev-parse", "--short", "HEAD"]);
  const headSha = headResult.status === 0 ? headResult.stdout.trim() : "(unknown)";
  return { ok: true, message: `git push 완료\n커밋: ${headSha}\nCloudflare Git 자동 배포가 이어서 실행됩니다.` };
}

async function handleGitStatus(token, chatId, config) {
  const workspace = path.resolve(config.codexWorkspace);
  const gitCommand = resolveGitCommand(config);
  if (!gitCommand) return sendMessage(token, chatId, "git 실행 파일을 찾지 못했습니다.");
  const completed = runGitCommand(workspace, gitCommand, ["status", "--short", "--branch"]);
  if (completed.status !== 0) {
    return sendMessage(token, chatId, `git status 실패:\n${completed.stderr || completed.stdout}`.trim());
  }
  await sendMessage(token, chatId, `Git 상태\n경로: ${gitCommand}\n\n${completed.stdout.trim() || "변경 사항이 없습니다."}`);
}

async function handleGitPush(token, chatId, commitMessage, config) {
  await sendMessage(token, chatId, `Git push 시작\n작업 폴더: ${path.resolve(config.codexWorkspace)}\n커밋 메시지: ${commitMessage || "Update from Telegram bridge"}`);
  const result = publishGitChanges(config, commitMessage || "Update from Telegram bridge");
  await sendMessage(token, chatId, result.message);
}

async function runCodexTask(token, chatId, payload, config, rawOnly = false) {
  const workspace = path.resolve(config.codexWorkspace);
  const outputFile = path.join(workspace, ".telegram-codex-last-message.txt");
  const codexCommand = resolveCodexCommand(config);
  if (!codexCommand) {
    await sendMessage(token, chatId, "codex 실행 파일을 찾지 못했습니다. telegram-bridge.env의 CODEX_COMMAND를 확인하세요.");
    return;
  }

  try {
    fs.rmSync(outputFile, { force: true });
  } catch {}

  await sendMessage(token, chatId, [
    "Codex 실행 시작",
    `실행 파일: ${codexCommand}`,
    `작업 폴더: ${workspace}`,
    `샌드박스: ${config.codexSandbox}`,
    `제한 시간: ${config.codexTimeout}초`,
  ].join("\n"));

  const attempts = [];
  for (const retry of [false, true]) {
    try {
      fs.rmSync(outputFile, { force: true });
    } catch {}
    const completed = executeCodexCommand(
      workspace,
      codexCommand,
      config.codexSandbox,
      buildCodexPrompt(payload, retry),
      outputFile,
      config.codexTimeout,
    );
    const parsed = parseCodexResult(completed, outputFile);
    attempts.push({ completed, ...parsed });
    log(
      [
        "codex completed",
        `status=${completed.status}`,
        `signal=${completed.signal || ""}`,
        `error=${completed.error ? completed.error.message : ""}`,
        `stdout=${completed.stdout ? completed.stdout.length : 0}`,
        `stderr=${completed.stderr ? completed.stderr.length : 0}`,
        `events=${parsed.eventCount}`,
      ].join(" "),
    );

    if (completed.status === 0 && !isAcknowledgementOnly(parsed.finalMessage)) {
      let responseText = rawOnly ? parsed.finalMessage.trim() : formatCodexSummary(payload, parsed.finalMessage, parsed.eventCount);
      const publishResult = publishGitChanges(config, buildBridgeCommitMessage(payload));
      if (publishResult.message && publishResult.message !== "커밋할 변경 사항이 없습니다.") {
        responseText = `${responseText}\n\n브리지 Git 처리\n${publishResult.message}`.trim();
      }
      await sendMessage(token, chatId, responseText || "최종 메시지를 받지 못했습니다.");
      return;
    }
  }

  const last = attempts[attempts.length - 1];
  const statusText = last.completed.status === null ? "null" : String(last.completed.status);
  const lines = ["Codex 실행 실패", `요청: ${payload}`, `exit code: ${statusText}`];
  if (last.signalText) lines.push(`signal: ${last.signalText}`);
  if (last.errorText) lines.push(`error: ${last.errorText}`);
  if (last.finalMessage) lines.push("", last.finalMessage);
  if (last.stderrText) lines.push("", "stderr:", last.stderrText);
  await sendMessage(token, chatId, lines.join("\n"));
}

async function handleTextMessage(token, chatId, text, config) {
  const normalized = String(text || "").trim();
  if (!normalized) return sendMessage(token, chatId, "빈 메시지는 처리하지 않습니다.");

  if (normalized.startsWith("/start")) return sendMessage(token, chatId, `Telegram 브리지가 연결되었습니다.\n${buildHelpText()}`);
  if (normalized.startsWith("/help")) return sendMessage(token, chatId, buildHelpText());
  if (normalized.startsWith("/ping")) return sendMessage(token, chatId, "pong");
  if (normalized.startsWith("/status")) {
    const resolved = resolveCodexCommand(config) || "찾지 못함";
    const busyText = activeRun ? "현재 실행 중인 Codex 작업이 있습니다." : "현재 실행 중인 작업이 없습니다.";
    return sendMessage(token, chatId, `${busyText}\nCodex 경로: ${resolved}\nCodex 샌드박스: ${config.codexSandbox}`);
  }
  if (normalized.startsWith("/gitstatus")) return handleGitStatus(token, chatId, config);
  if (normalized.startsWith("/push")) return handleGitPush(token, chatId, normalized.slice(5).trim(), config);

  let payload = "";
  let rawOnly = false;
  if (normalized.startsWith("/runraw")) {
    payload = normalized.slice(7).trim();
    rawOnly = true;
  } else if (normalized.startsWith("/run")) {
    payload = normalized.slice(4).trim();
  } else if (normalized.startsWith(". ")) {
    payload = normalized.slice(2).trim();
    rawOnly = true;
  } else if (normalized.startsWith("/ ")) {
    payload = normalized.slice(2).trim();
    rawOnly = true;
  } else if (!normalized.startsWith("/")) {
    payload = normalized;
    rawOnly = true;
  }

  if (payload) {
    if (activeRun) return sendMessage(token, chatId, "이미 실행 중인 Codex 작업이 있습니다. 완료 후 다시 시도하세요.");
    activeRun = true;
    try {
      await runCodexTask(token, chatId, payload, config, rawOnly);
    } finally {
      activeRun = false;
    }
    return;
  }

  await sendMessage(token, chatId, "알 수 없는 명령입니다.\n/help 를 입력해 사용 가능한 명령을 확인하세요.");
}

async function processUpdate(token, chatId, update, config) {
  const message = update.message;
  if (!message) return;
  if (String(message.chat?.id || "") !== chatId) return;
  log(`received update_id=${update.update_id} text=${JSON.stringify(String(message.text || "").slice(0, 120))}`);
  await handleTextMessage(token, chatId, message.text || "", config);
}

async function runLoop() {
  acquireLockOrExit();
  const config = getConfig();
  const state = loadState();
  log(`Telegram bridge started. Allowed chat_id=${config.chatId}`);
  log(`Env file: ${envPath}`);
  log(`State file: ${statePath}`);
  log(`Workspace: ${config.codexWorkspace}`);

  while (true) {
    try {
      const response = await telegramGet(config.token, "getUpdates", {
        offset: Number(state.last_update_id || 0) + 1,
        timeout: config.pollTimeout,
        allowed_updates: JSON.stringify(["message"]),
      });
      if (!response.ok) throw new Error(`Telegram API error: ${JSON.stringify(response)}`);
      for (const update of response.result || []) {
        await processUpdate(config.token, config.chatId, update, config);
        state.last_update_id = Number(update.update_id);
        saveState(state);
      }
    } catch (error) {
      log(`[telegram-bridge] ${error.name || "Error"}: ${error.message || error}`);
      await sleep(5000);
    }
  }
}

runLoop().catch((error) => {
  log(`[telegram-bridge] ${error.name || "Error"}: ${error.message || error}`);
  process.exit(1);
});
