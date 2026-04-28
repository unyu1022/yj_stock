import json
import os
import atexit
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parent.parent
DEFAULT_ENV_PATH = ROOT_DIR / "telegram-bridge.env"
DEFAULT_STATE_PATH = ROOT_DIR / ".telegram-bridge-state.json"
DEFAULT_LOCK_PATH = ROOT_DIR / ".telegram-bridge.lock"
DEFAULT_WORKSPACE_PATH = ROOT_DIR
MAX_TELEGRAM_MESSAGE_LENGTH = 3500
ACTIVE_RUN_LOCK = threading.Lock()


def load_simple_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def get_config() -> dict[str, str]:
    file_values = load_simple_env(DEFAULT_ENV_PATH)
    token = os.environ.get("TELEGRAM_BOT_TOKEN") or file_values.get("TELEGRAM_BOT_TOKEN", "")
    chat_id = os.environ.get("TELEGRAM_ALLOWED_CHAT_ID") or file_values.get("TELEGRAM_ALLOWED_CHAT_ID", "")
    poll_timeout = os.environ.get("TELEGRAM_POLL_TIMEOUT") or file_values.get("TELEGRAM_POLL_TIMEOUT", "25")
    codex_timeout = os.environ.get("CODEX_RUN_TIMEOUT_SECONDS") or file_values.get("CODEX_RUN_TIMEOUT_SECONDS", "900")
    codex_workspace = os.environ.get("CODEX_WORKSPACE") or file_values.get("CODEX_WORKSPACE", str(DEFAULT_WORKSPACE_PATH))
    codex_command = os.environ.get("CODEX_COMMAND") or file_values.get("CODEX_COMMAND", "")
    codex_sandbox = os.environ.get("CODEX_SANDBOX") or file_values.get("CODEX_SANDBOX", "workspace-write")
    git_command = os.environ.get("GIT_COMMAND") or file_values.get("GIT_COMMAND", "")
    git_user_name = os.environ.get("GIT_USER_NAME") or file_values.get("GIT_USER_NAME", "unyu1022")
    git_user_email = os.environ.get("GIT_USER_EMAIL") or file_values.get("GIT_USER_EMAIL", "kyj921022@gmail.com")

    if not token:
        raise RuntimeError(
            f"TELEGRAM_BOT_TOKEN is missing. Set it in env or {DEFAULT_ENV_PATH.name}."
        )
    if not chat_id:
        raise RuntimeError(
            f"TELEGRAM_ALLOWED_CHAT_ID is missing. Set it in env or {DEFAULT_ENV_PATH.name}."
        )

    return {
        "token": token,
        "chat_id": chat_id,
        "poll_timeout": poll_timeout,
        "codex_timeout": codex_timeout,
        "codex_workspace": codex_workspace,
        "codex_command": codex_command,
        "codex_sandbox": codex_sandbox,
        "git_command": git_command,
        "git_user_name": git_user_name,
        "git_user_email": git_user_email,
    }


def load_state() -> dict[str, int]:
    if not DEFAULT_STATE_PATH.exists():
        return {"last_update_id": 0}
    try:
        return json.loads(DEFAULT_STATE_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"last_update_id": 0}


def save_state(state: dict[str, int]) -> None:
    DEFAULT_STATE_PATH.write_text(
        json.dumps(state, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def process_is_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def acquire_lock_or_exit() -> None:
    if DEFAULT_LOCK_PATH.exists():
        try:
            existing_pid = int(DEFAULT_LOCK_PATH.read_text(encoding="utf-8").strip())
        except ValueError:
            existing_pid = 0

        if existing_pid and existing_pid != os.getpid() and process_is_alive(existing_pid):
            raise RuntimeError(
                f"Another telegram bridge is already running with PID {existing_pid}. "
                "Stop it before starting a new one."
            )

    DEFAULT_LOCK_PATH.write_text(str(os.getpid()), encoding="utf-8")
    atexit.register(release_lock)


def release_lock() -> None:
    if DEFAULT_LOCK_PATH.exists():
        try:
            current = DEFAULT_LOCK_PATH.read_text(encoding="utf-8").strip()
        except OSError:
            return
        if current == str(os.getpid()):
            DEFAULT_LOCK_PATH.unlink(missing_ok=True)


def api_get(token: str, method: str, params: dict[str, str | int]) -> dict:
    query = urllib.parse.urlencode(params)
    url = f"https://api.telegram.org/bot{token}/{method}?{query}"
    with urllib.request.urlopen(url, timeout=45) as response:
        return json.loads(response.read().decode("utf-8"))


def api_post(token: str, method: str, payload: dict[str, str | int]) -> dict:
    url = f"https://api.telegram.org/bot{token}/{method}"
    data = urllib.parse.urlencode(payload).encode("utf-8")
    request = urllib.request.Request(url, data=data, method="POST")
    with urllib.request.urlopen(request, timeout=45) as response:
        return json.loads(response.read().decode("utf-8"))


def send_message(token: str, chat_id: str, text: str) -> None:
    if len(text) > MAX_TELEGRAM_MESSAGE_LENGTH:
        text = text[: MAX_TELEGRAM_MESSAGE_LENGTH - 120] + "\n\n[truncated]"
    api_post(
        token,
        "sendMessage",
        {
            "chat_id": chat_id,
            "text": text,
        },
    )


def build_help_text() -> str:
    return "\n".join(
        [
            "사용 가능한 명령:",
            "/start - 연결 확인",
            "/ping - 봇 응답 확인",
            "/run <내용> - Codex CLI로 작업 실행",
            "/runraw <내용> - Codex 최종 답변만 그대로 전송",
            "/push <커밋 메시지> - 브리지가 직접 git add/commit/push 실행",
            "/gitstatus - 현재 Git 상태 확인",
            ". <내용> - /runraw 와 동일",
            "/ <내용> - /runraw 와 동일",
            "일반 메시지 - /runraw 와 동일",
            "/status - 현재 실행 상태 확인",
            "/help - 도움말",
        ]
    )


def resolve_codex_command(config: dict[str, str]) -> str | None:
    configured = config.get("codex_command", "").strip()
    candidates: list[str] = []

    if configured:
        candidates.append(configured)

    candidates.extend(
        [
            shutil.which("codex.cmd") or "",
            shutil.which("codex") or "",
            str(Path.home() / "AppData" / "Roaming" / "npm" / "codex.cmd"),
            str(Path.home() / "AppData" / "Roaming" / "npm" / "codex.ps1"),
        ]
    )

    windows_app_dir = Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "WindowsApps"
    if windows_app_dir.exists():
        candidates.append(str(windows_app_dir / "codex.exe"))

    for candidate in candidates:
        if not candidate:
            continue
        if candidate.lower().endswith(".ps1"):
            if Path(candidate).exists():
                return candidate
            continue
        if Path(candidate).exists():
            return candidate
        resolved = shutil.which(candidate)
        if resolved:
            return resolved

    return None


def resolve_git_command(config: dict[str, str]) -> str | None:
    configured = config.get("git_command", "").strip()
    candidates: list[str] = []

    if configured:
        candidates.append(configured)

    candidates.extend(
        [
            shutil.which("git.exe") or "",
            shutil.which("git") or "",
            r"C:\Program Files\Git\cmd\git.exe",
            r"C:\Program Files\Git\bin\git.exe",
        ]
    )

    for candidate in candidates:
        if not candidate:
            continue
        if Path(candidate).exists():
            return candidate
        resolved = shutil.which(candidate)
        if resolved:
            return resolved

    return None


def is_codex_run_active() -> bool:
    locked = ACTIVE_RUN_LOCK.acquire(blocking=False)
    if locked:
        ACTIVE_RUN_LOCK.release()
        return False
    return True


def format_codex_summary(payload: str, final_message: str, event_count: int) -> str:
    cleaned = final_message.strip() if final_message else "최종 메시지를 받지 못했습니다."
    return "\n".join(
        [
            "Codex 실행 완료",
            f"요청: {payload}",
            f"이벤트 수: {event_count}",
            "",
            cleaned,
        ]
    )


def is_acknowledgement_only(text: str) -> bool:
    normalized = " ".join(text.strip().split()).lower()
    if not normalized:
        return True

    markers = [
        "understood.",
        "i'll ",
        "i will ",
        "avoid interactive prompts",
        "non-interactive",
        "powershell-friendly",
        "work only inside the current workspace",
        "keep commands",
    ]
    marker_hits = sum(1 for marker in markers if marker in normalized)
    if marker_hits < 2:
        return False

    if len(normalized) < 320:
        return True

    return False


def build_codex_prompt(payload: str, retry: bool = False) -> str:
    base_prompt = (
        "아래 작업을 지금 바로 수행하고, 최종 답변만 한국어로 작성하세요.\n"
        "작업 폴더 안의 파일을 읽거나 명령을 실행해 실제 결과를 확인한 뒤 답하세요.\n"
        "Git 명령이 필요하면 `C:\\Program Files\\Git\\cmd\\git.exe` 절대경로를 우선 사용하세요.\n"
        "지시를 이해했다는 말, 앞으로 하겠다는 말, 작업 계획은 금지합니다.\n"
        "영어로 답하지 마세요.\n"
        "최종 답변은 바로 결과부터 시작하세요.\n"
        "분석 요청이면 분석 결과를, 수정 요청이면 수정 결과를 적으세요.\n"
        "Cloudflare 직접 배포는 시도하지 마세요. `wrangler deploy`, `deploy_cloudflare.cmd`, `npx wrangler deploy`를 실행하지 마세요.\n"
        "배포가 필요한 경우에도 Codex가 직접 commit/push 하지 마세요. 코드 수정까지만 수행하면 Telegram 브리지가 직접 GitHub origin/main 에 commit/push 합니다.\n"
        "실제로 불가능한 경우에만 짧게 이유를 적으세요.\n\n"
        f"작업:\n{payload}\n"
    )

    if not retry:
        return base_prompt

    return (
        "이전 응답은 잘못되었습니다. 확인 문구나 계획이 아니라 실제 결과를 내야 합니다.\n"
        "이번에는 반드시 작업을 수행한 뒤 최종 결과만 한국어로 답하세요.\n"
        "영어 문장, Understood, I'll 같은 표현은 금지합니다.\n\n"
        + base_prompt
    )


def execute_codex_command(
    workspace: Path,
    codex_command: str,
    sandbox_mode: str,
    prompt: str,
    output_file: Path,
    timeout_seconds: int,
) -> tuple[subprocess.CompletedProcess[str] | None, str | None]:
    if codex_command.lower().endswith(".ps1"):
        command = [
            "powershell",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            codex_command,
            "exec",
            "--json",
            "--full-auto",
            "--sandbox",
            sandbox_mode,
            "--skip-git-repo-check",
            "--output-last-message",
            str(output_file),
            "--cd",
            str(workspace),
            "-",
        ]
    else:
        command = [
            codex_command,
            "exec",
            "--json",
            "--full-auto",
            "--sandbox",
            sandbox_mode,
            "--skip-git-repo-check",
            "--output-last-message",
            str(output_file),
            "--cd",
            str(workspace),
            "-",
        ]

    try:
        completed = subprocess.run(
            command,
            cwd=workspace,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=timeout_seconds,
            input=prompt,
        )
        return completed, None
    except FileNotFoundError:
        return None, "codex 실행 파일을 찾지 못했습니다. telegram-bridge.env 의 CODEX_COMMAND를 확인하세요."
    except subprocess.TimeoutExpired:
        return None, f"Codex 실행이 {timeout_seconds}초 제한을 초과해 중단되었습니다."
    except Exception as exc:
        return None, f"Codex 실행 중 예외가 발생했습니다: {type(exc).__name__}: {exc}"


def parse_codex_result(completed: subprocess.CompletedProcess[str], output_file: Path) -> tuple[str, int, str]:
    final_message = ""
    event_count = 0
    stdout_text = completed.stdout.strip()
    stderr_text = completed.stderr.strip()

    if output_file.exists():
        try:
            final_message = output_file.read_text(encoding="utf-8").strip() or final_message
        except Exception:
            pass

    if stdout_text:
        for line in stdout_text.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                final_message = line
                continue

            event_count += 1
            item = event.get("item", {})
            if event.get("type") == "item.completed" and item.get("type") == "agent_message":
                final_message = item.get("text", final_message)

    return final_message, event_count, stderr_text


def run_git_command(
    workspace: Path,
    git_command: str,
    args: list[str],
    timeout_seconds: int = 120,
) -> subprocess.CompletedProcess[str]:
    command = [git_command, *args]
    return subprocess.run(
        command,
        cwd=workspace,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=timeout_seconds,
    )


def build_bridge_commit_message(payload: str) -> str:
    normalized = " ".join(payload.strip().split())
    if not normalized:
        return "Update from Telegram bridge"

    if len(normalized) > 80:
        normalized = normalized[:77].rstrip() + "..."
    return f"Telegram bridge: {normalized}"


def publish_git_changes(config: dict[str, str], commit_message: str) -> tuple[bool, str]:
    workspace = Path(config["codex_workspace"]).resolve()
    git_command = resolve_git_command(config)
    if not git_command:
        return False, "git 실행 파일을 찾지 못했습니다."

    if not commit_message:
        commit_message = "Update from Telegram bridge"

    config_name = run_git_command(workspace, git_command, ["config", "user.name", config["git_user_name"]])
    config_email = run_git_command(workspace, git_command, ["config", "user.email", config["git_user_email"]])
    if config_name.returncode != 0 or config_email.returncode != 0:
        return False, "git 사용자 정보 설정에 실패했습니다."

    add_result = run_git_command(workspace, git_command, ["add", "-A"])
    if add_result.returncode != 0:
        return False, f"git add 실패:\n{add_result.stderr.strip() or add_result.stdout.strip()}"

    status_result = run_git_command(workspace, git_command, ["status", "--short"])
    if status_result.returncode != 0:
        return False, f"git status 실패:\n{status_result.stderr.strip() or status_result.stdout.strip()}"

    if not status_result.stdout.strip():
        return True, "커밋할 변경 사항이 없습니다."

    commit_result = run_git_command(workspace, git_command, ["commit", "-m", commit_message], timeout_seconds=180)
    if commit_result.returncode != 0:
        return False, f"git commit 실패:\n{commit_result.stderr.strip() or commit_result.stdout.strip()}"

    push_result = run_git_command(workspace, git_command, ["push", "origin", "main"], timeout_seconds=300)
    if push_result.returncode != 0:
        details = push_result.stderr.strip() or push_result.stdout.strip()
        return False, f"git push 실패:\n{details}"

    head_result = run_git_command(workspace, git_command, ["rev-parse", "--short", "HEAD"])
    head_sha = head_result.stdout.strip() if head_result.returncode == 0 else "(unknown)"
    return True, f"git push 완료\n커밋: {head_sha}\nCloudflare Git 자동 배포가 이어서 실행됩니다."


def handle_git_status(token: str, allowed_chat_id: str, config: dict[str, str]) -> None:
    workspace = Path(config["codex_workspace"]).resolve()
    git_command = resolve_git_command(config)
    if not git_command:
        send_message(token, allowed_chat_id, "git 실행 파일을 찾지 못했습니다.")
        return

    try:
        completed = run_git_command(workspace, git_command, ["status", "--short", "--branch"])
    except Exception as exc:
        send_message(token, allowed_chat_id, f"git status 실행 실패: {type(exc).__name__}: {exc}")
        return

    if completed.returncode != 0:
        send_message(token, allowed_chat_id, f"git status 실패:\n{completed.stderr.strip() or completed.stdout.strip()}")
        return

    output = completed.stdout.strip() or "변경 사항이 없습니다."
    send_message(token, allowed_chat_id, f"Git 상태\n경로: {git_command}\n\n{output}")


def handle_git_push(token: str, allowed_chat_id: str, commit_message: str, config: dict[str, str]) -> None:
    workspace = Path(config["codex_workspace"]).resolve()
    git_command = resolve_git_command(config)
    if not git_command:
        send_message(token, allowed_chat_id, "git 실행 파일을 찾지 못했습니다.")
        return

    if not commit_message:
        commit_message = "Update from Telegram bridge"

    send_message(
        token,
        allowed_chat_id,
        "\n".join(
            [
                "Git push 시작",
                f"git 경로: {git_command}",
                f"작업 폴더: {workspace}",
                f"커밋 메시지: {commit_message}",
            ]
        ),
    )

    try:
        ok, message = publish_git_changes(config, commit_message)
        send_message(token, allowed_chat_id, message)
    except Exception as exc:
        send_message(token, allowed_chat_id, f"git push 처리 중 예외 발생: {type(exc).__name__}: {exc}")


def run_codex_task(token: str, allowed_chat_id: str, payload: str, config: dict[str, str], raw_only: bool = False) -> None:
    workspace = Path(config["codex_workspace"]).resolve()
    timeout_seconds = int(config["codex_timeout"])
    sandbox_mode = config["codex_sandbox"]
    output_file = workspace / ".telegram-codex-last-message.txt"
    codex_command = resolve_codex_command(config)

    if not codex_command:
        send_message(
            token,
            allowed_chat_id,
            "codex 실행 파일을 찾지 못했습니다. telegram-bridge.env 에 CODEX_COMMAND를 직접 지정하세요.",
        )
        return

    output_file.unlink(missing_ok=True)

    send_message(
        token,
        allowed_chat_id,
        "\n".join(
            [
                "Codex 실행 시작",
                f"실행 파일: {codex_command}",
                f"작업 폴더: {workspace}",
                f"샌드박스: {sandbox_mode}",
                f"제한 시간: {timeout_seconds}초",
            ]
        ),
    )

    attempt_results: list[tuple[subprocess.CompletedProcess[str] | None, str, int, str]] = []

    for retry in (False, True):
        output_file.unlink(missing_ok=True)
        completed, launch_error = execute_codex_command(
            workspace=workspace,
            codex_command=codex_command,
            sandbox_mode=sandbox_mode,
            prompt=build_codex_prompt(payload, retry=retry),
            output_file=output_file,
            timeout_seconds=timeout_seconds,
        )
        if launch_error:
            send_message(token, allowed_chat_id, launch_error)
            return

        assert completed is not None
        final_message, event_count, stderr_text = parse_codex_result(completed, output_file)
        attempt_results.append((completed, final_message, event_count, stderr_text))

        if completed.returncode == 0 and not is_acknowledgement_only(final_message):
            response_text = final_message.strip() if raw_only else format_codex_summary(payload, final_message, event_count)
            try:
                ok, publish_message = publish_git_changes(config, build_bridge_commit_message(payload))
            except Exception as exc:
                ok = False
                publish_message = f"git push 처리 중 예외 발생: {type(exc).__name__}: {exc}"
            if publish_message and publish_message != "커밋할 변경 사항이 없습니다.":
                response_text = "\n\n".join([response_text or "", "브리지 Git 처리", publish_message]).strip()
            send_message(token, allowed_chat_id, response_text or "최종 메시지를 받지 못했습니다.")
            return

    completed, final_message, event_count, stderr_text = attempt_results[-1]
    assert completed is not None

    failure_lines = [
        "Codex 실행 실패",
        f"요청: {payload}",
        f"exit code: {completed.returncode}",
    ]
    if final_message:
        failure_lines.extend(["", final_message])
    if completed.returncode == 0 and is_acknowledgement_only(final_message):
        failure_lines.extend(
            [
                "",
                "실패 원인: Codex가 작업 결과 대신 확인 문구만 두 번 반환했습니다.",
            ]
        )
    if stderr_text:
        failure_lines.extend(["", "stderr:", stderr_text])
    send_message(token, allowed_chat_id, "\n".join(failure_lines))


def handle_text_message(token: str, allowed_chat_id: str, text: str, config: dict[str, str]) -> None:
    normalized = text.strip()
    if not normalized:
        send_message(token, allowed_chat_id, "빈 메시지는 처리하지 않습니다.")
        return

    if normalized.startswith("/start"):
        send_message(
            token,
            allowed_chat_id,
            "텔레그램 브리지가 연결되었습니다.\n" + build_help_text(),
        )
        return

    if normalized.startswith("/help"):
        send_message(token, allowed_chat_id, build_help_text())
        return

    if normalized.startswith("/ping"):
        send_message(token, allowed_chat_id, "pong")
        return

    if normalized.startswith("/status"):
        resolved = resolve_codex_command(config)
        busy_text = "실행 중인 Codex 작업이 있습니다." if is_codex_run_active() else "현재 실행 중인 작업이 없습니다."
        path_text = resolved if resolved else "찾지 못함"
        status_text = "\n".join(
            [
                busy_text,
                f"Codex 경로: {path_text}",
                f"Codex 샌드박스: {config['codex_sandbox']}",
            ]
        )
        send_message(token, allowed_chat_id, status_text)
        return

    if normalized.startswith("/gitstatus"):
        handle_git_status(token, allowed_chat_id, config)
        return

    if normalized.startswith("/push"):
        commit_message = normalized[5:].strip()
        handle_git_push(token, allowed_chat_id, commit_message, config)
        return

    if normalized.startswith("/runraw"):
        payload = normalized[7:].strip()
        if not payload:
            send_message(token, allowed_chat_id, "형식: /runraw <작업 내용>")
            return

        if not ACTIVE_RUN_LOCK.acquire(blocking=False):
            send_message(token, allowed_chat_id, "이미 실행 중인 Codex 작업이 있습니다. 완료 후 다시 시도하세요.")
            return
        try:
            run_codex_task(token, allowed_chat_id, payload, config, raw_only=True)
        finally:
            ACTIVE_RUN_LOCK.release()
        return

    if normalized.startswith("/run"):
        payload = normalized[4:].strip()
        if not payload:
            send_message(token, allowed_chat_id, "형식: /run <작업 내용>")
            return

        if not ACTIVE_RUN_LOCK.acquire(blocking=False):
            send_message(token, allowed_chat_id, "이미 실행 중인 Codex 작업이 있습니다. 완료 후 다시 시도하세요.")
            return
        try:
            run_codex_task(token, allowed_chat_id, payload, config)
        finally:
            ACTIVE_RUN_LOCK.release()
        return

    implicit_raw_payload = ""
    if normalized.startswith(". "):
        implicit_raw_payload = normalized[2:].strip()
    elif normalized.startswith("/ "):
        implicit_raw_payload = normalized[2:].strip()
    elif not normalized.startswith("/"):
        implicit_raw_payload = normalized

    if implicit_raw_payload:
        if not ACTIVE_RUN_LOCK.acquire(blocking=False):
            send_message(token, allowed_chat_id, "이미 실행 중인 Codex 작업이 있습니다. 완료 후 다시 시도하세요.")
            return
        try:
            run_codex_task(token, allowed_chat_id, implicit_raw_payload, config, raw_only=True)
        finally:
            ACTIVE_RUN_LOCK.release()
        return

    send_message(
        token,
        allowed_chat_id,
        "알 수 없는 명령입니다.\n/help 를 입력해 사용 가능한 명령을 확인하세요.",
    )


def process_update(token: str, allowed_chat_id: str, update: dict, config: dict[str, str]) -> None:
    message = update.get("message")
    if not message:
        return

    chat = message.get("chat", {})
    chat_id = str(chat.get("id", ""))
    if chat_id != allowed_chat_id:
        return

    text = message.get("text", "")
    handle_text_message(token, allowed_chat_id, text, config)


def run_loop() -> None:
    acquire_lock_or_exit()
    config = get_config()
    token = config["token"]
    allowed_chat_id = config["chat_id"]
    timeout = int(config["poll_timeout"])
    state = load_state()

    print(f"Telegram bridge started. Allowed chat_id={allowed_chat_id}")
    print(f"Env file: {DEFAULT_ENV_PATH}")
    print(f"State file: {DEFAULT_STATE_PATH}")

    while True:
        try:
            response = api_get(
                token,
                "getUpdates",
                {
                    "offset": state["last_update_id"] + 1,
                    "timeout": timeout,
                    "allowed_updates": json.dumps(["message"]),
                },
            )
            if not response.get("ok"):
                raise RuntimeError(f"Telegram API error: {response}")

            for update in response.get("result", []):
                update_id = int(update["update_id"])
                process_update(token, allowed_chat_id, update, config)
                state["last_update_id"] = update_id
                save_state(state)
        except KeyboardInterrupt:
            print("Stopping Telegram bridge.")
            return
        except Exception as exc:
            print(f"[telegram-bridge] {type(exc).__name__}: {exc}", file=sys.stderr)
            time.sleep(5)


if __name__ == "__main__":
    run_loop()
