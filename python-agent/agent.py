import argparse
import asyncio
import ast
import inspect
import json
import os
import re
from pathlib import Path
from typing import Any

from openai import APIConnectionError, APIStatusError, RateLimitError
from pydantic import BaseModel

from browser_use import Agent, ChatOpenAI
from browser_use.browser.profile import BrowserProfile
from browser_use.browser.session import BrowserSession
from browser_use.llm.exceptions import ModelProviderError, ModelRateLimitError
from browser_use.llm.messages import BaseMessage
from browser_use.llm.openai.serializer import OpenAIMessageSerializer
from browser_use.llm.views import ChatInvokeCompletion
from dotenv import load_dotenv

from reporting import (
    analyze_task_report,
    render_pdf_report,
    summarize_history,
)

PROJECT_ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS_ROOT = PROJECT_ROOT / "artifacts"
DEFAULT_ZEROG_BASE_URL = "https://router-api-testnet.integratenetwork.work/v1"
BROWSER_USE_ACTION_SCHEMA_HINT = (
    "Use one concise browser action at a time. Do not use screenshot or PDF tools; call done when the "
    "page is positioned for final evidence capture."
)
ACTIVE_USER_TASK = ""
ACTIVE_INITIAL_URL = ""
RESULT_PAGE_NAVIGATION_SEEN = False
QWEN_ACTION_PROMPT = (
    "You control a browser. Choose exactly one next action from the current page state.\n"
    "Return ONLY this compact JSON, with no markdown:\n"
    '{"evaluation":"short","memory":"short","next_goal":"short",'
    '"action":{"name":"click|input|send_keys|navigate|scroll|wait|find_text|extract|done",'
    '"params":{}}}\n'
    "Params are: click {index}; input {index,text,clear}; send_keys {keys}; navigate {url}; "
    "scroll {down,pages}; wait {seconds}; find_text {text}; "
    "extract {query}; done {text,success}.\n"
    "Use visible element indexes when clicking or typing. Never use the browser-wide search tool for site "
    "search. For site search, type into that site's visible search field and include send_keys Enter in the "
    "same step to submit. Do not leave the starting website unless the "
    "user explicitly asks to. If the requested evidence is visible, use done. For screenshot tasks, position "
    "the page then use done; another process captures final evidence screenshots. On a search results page, use done "
    "for screenshot tasks. Do not send Enter unless you just typed into an input in the same step. Do not wait "
    "unless the page has no usable content."
)
MAX_QWEN_CONTEXT_CHARS = 1200


def parse_scalar(value: str) -> str | int | float | bool:
    normalized = value.strip().strip("'\"")
    lowered = normalized.lower()

    if lowered in {"null", "none"}:
        return None

    if lowered in {"true", "yes", "1"}:
        return True

    if lowered in {"false", "no", "0"}:
        return False

    if re.fullmatch(r"-?\d+", normalized):
        return int(normalized)

    if re.fullmatch(r"-?\d+\.\d+", normalized):
        return float(normalized)

    return normalized


def parse_dict_text(value: str) -> dict[str, Any] | None:
    cleaned = value.strip()
    if not cleaned.startswith("{") or not cleaned.endswith("}"):
        return None

    cleaned = re.sub(r"\btrue\b", "True", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\bfalse\b", "False", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\bnull\b", "None", cleaned, flags=re.IGNORECASE)

    try:
        parsed = ast.literal_eval(cleaned)
    except (SyntaxError, ValueError):
        return None

    return parsed if isinstance(parsed, dict) else None


def parse_key_value_text(value: str) -> dict[str, Any]:
    params: dict[str, Any] = {}

    for part in value.split(","):
        if ":" in part:
            key, raw = part.split(":", 1)
        elif "=" in part:
            key, raw = part.split("=", 1)
        else:
            continue

        key = key.strip().strip("'\"")
        if key:
            params[key] = parse_scalar(raw)

    return params


def strip_labeled_value(value: Any, label: str) -> Any:
    if not isinstance(value, str):
        return value

    pattern = rf"^\s*{re.escape(label)}\s*[:=]\s*"
    return re.sub(pattern, "", value, flags=re.IGNORECASE).strip()


def coerce_index_value(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        if "index" in value and not isinstance(value["index"], int):
            value["index"] = parse_scalar(str(value["index"]))
        return value

    if isinstance(value, int):
        return {"index": value}

    if isinstance(value, str):
        parsed_dict = parse_dict_text(value)
        if parsed_dict is not None:
            return parsed_dict

        parsed = parse_key_value_text(value)
        if parsed:
            return parsed

        scalar = parse_scalar(value)
        if isinstance(scalar, int):
            return {"index": scalar}

    return {"index": value}


def coerce_text_value(value: Any, field_name: str = "text") -> dict[str, Any]:
    if isinstance(value, dict):
        return value

    return {field_name: str(value)}


def coerce_object_value(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value

    if isinstance(value, str):
        parsed_dict = parse_dict_text(value)
        if parsed_dict is not None:
            return parsed_dict

        parsed_fields = parse_key_value_text(value)
        if parsed_fields:
            return parsed_fields

    return {}


def normalize_tab_params(value: Any) -> dict[str, Any]:
    params = coerce_object_value(value)
    if not params:
        params = {"tab_id": str(value)}

    if "tab_id" in params:
        params["tab_id"] = strip_labeled_value(params["tab_id"], "tab_id")

    return params


def normalize_action_item(item: Any) -> Any:
    if not isinstance(item, dict):
        return item

    if "input" in item:
        value = item["input"]
        params = value if isinstance(value, dict) else coerce_index_value(value)

        for key in ("index", "text", "clear"):
            if key in item:
                params[key] = item[key]

        return {"input": params}

    if "click" in item:
        params = coerce_index_value(item["click"])
        if not isinstance(params.get("index"), int):
            return {"wait": {"seconds": 1}}
        return {"click": params}

    if "navigate" in item:
        value = item["navigate"]
        params = value if isinstance(value, dict) else {"url": strip_labeled_value(value, "url")}

        if "new_tab" in item:
            params["new_tab"] = item["new_tab"]

        if not str(params.get("url", "")).strip():
            return {"wait": {"seconds": 1}}

        return {"navigate": params}

    if "search" in item:
        value = item["search"]
        params = value if isinstance(value, dict) else coerce_object_value(value)
        if not params:
            params = {"query": value}

        if "query" in params:
            params["query"] = strip_labeled_value(params["query"], "query")

        return {"search": params}

    if "wait" in item:
        params = coerce_object_value(item["wait"])
        if "seconds" in item:
            params["seconds"] = item["seconds"]
        params = {"seconds": params["seconds"]} if "seconds" in params else {}
        if not params:
            params = {"seconds": 3}
        return {"wait": params}

    if "scroll" in item:
        params = coerce_object_value(item["scroll"])
        down = params.get("down", True)
        if not isinstance(down, bool):
            parsed_down = parse_scalar(str(down))
            if isinstance(parsed_down, bool):
                down = parsed_down
            elif isinstance(parsed_down, (int, float)):
                params.setdefault("pages", max(1, int(round(abs(parsed_down)))))
                down = parsed_down >= 0
            else:
                down = str(down).strip().lower() not in {"up", "false", "no", "0"}
        params["down"] = down
        if "pages" in params and not isinstance(params["pages"], int):
            parsed_pages = parse_scalar(str(params["pages"]))
            params["pages"] = max(1, int(round(abs(parsed_pages)))) if isinstance(parsed_pages, (int, float)) else 1
        return {"scroll": params}

    if "done" in item:
        value = item["done"]
        params = value if isinstance(value, dict) else {"text": str(value)}

        if "success" in item:
            params["success"] = item["success"]

        return {"done": params}

    for action_name, field_name in {
        "find_text": "text",
        "send_keys": "keys",
        "search_page": "pattern",
        "extract": "query",
    }.items():
        if action_name in item:
            value = item[action_name]
            params = coerce_object_value(value) if isinstance(value, str) else {}
            if params:
                return {action_name: params}

            return {action_name: coerce_text_value(value, field_name)}

    if "find_elements" in item:
        value = item["find_elements"]
        if isinstance(value, int):
            return {"click": {"index": value}}

        params = coerce_object_value(value)
        for key in ("selector", "attributes", "max_results", "include_text"):
            if key in item:
                params[key] = item[key]

        return {"find_elements": params}

    if "evaluate" in item:
        value = item["evaluate"]
        if isinstance(value, str):
            return {"evaluate": {"code": value}}

        return {"wait": {"seconds": 1}}

    for action_name in ("save_as_pdf", "screenshot"):
        if action_name in item:
            return {action_name: coerce_object_value(item[action_name])}

    for action_name in ("switch", "close"):
        if action_name in item:
            return {action_name: normalize_tab_params(item[action_name])}

    return item


def browser_use_action_from_simple(action: Any) -> dict[str, Any]:
    actions = browser_use_actions_from_simple(action)
    return actions[0] if actions else {"wait": {"seconds": 1}}


def browser_use_actions_from_simple(action: Any) -> list[dict[str, Any]]:
    if not isinstance(action, dict):
        return [{"wait": {"seconds": 1}}]

    name = action.get("name") or action.get("action") or action.get("type")
    params = action.get("params", {})

    if not isinstance(name, str):
        return [normalize_action_item(action)]

    name = name.strip().lower()
    if isinstance(params, list) and name == "input" and len(params) >= 2:
        params = {
            "index": params[0],
            "text": params[1],
            "clear": bool(params[2]) if len(params) >= 3 else True,
        }
    elif isinstance(params, list):
        first_param = params[0] if params else ""
        list_param_fields = {
            "find_text": "text",
            "send_keys": "keys",
            "navigate": "url",
            "extract": "query",
        }
        if name in list_param_fields:
            params = {list_param_fields[name]: first_param}
        else:
            params = {}
    elif not isinstance(params, dict):
        params = coerce_object_value(params)

    if "|" in name:
        repaired_actions = []
        input_index = params.get("input", params.get("index"))
        text = params.get("text")
        has_input_intent = "input" in name
        if has_input_intent and input_index is not None and text:
            repaired_actions.append(
                normalize_action_item(
                    {
                        "input": {
                            "index": input_index,
                            "text": text,
                            "clear": params.get("clear", True),
                        }
                    }
                )
            )

        keys = params.get("send_keys") or params.get("keys")
        if "send_keys" in name and not keys and repaired_actions:
            keys = "Enter"
        if keys and repaired_actions:
            repaired_actions.append(normalize_action_item({"send_keys": {"keys": keys}}))

        click_index = params.get("click")
        if click_index is not None and len(repaired_actions) < 2:
            repaired_actions.append(normalize_action_item({"click": click_index}))

        if "find_text" in name and text and not repaired_actions:
            repaired_actions.append(normalize_action_item({"find_text": {"text": text}}))

        navigate_url = params.get("navigate") or params.get("url")
        if "navigate" in name and navigate_url and not repaired_actions:
            repaired_actions.append(normalize_action_item({"navigate": {"url": navigate_url}}))

        scroll_value = params.get("scroll")
        if "scroll" in name and scroll_value is not None and not repaired_actions:
            repaired_actions.append(normalize_action_item({"scroll": scroll_value}))

        if repaired_actions:
            return repaired_actions[:2]

    if name in {"done", "finish", "complete"}:
        return [
            {
                "done": {
                    "text": str(params.get("text") or params.get("message") or "Task completed."),
                    "success": bool(params.get("success", True)),
                }
            }
        ]

    if name == "input":
        actions = [normalize_action_item({"input": params})]
        if "search" in ACTIVE_USER_TASK.lower() and params.get("text"):
            actions.append(normalize_action_item({"send_keys": {"keys": "Enter"}}))
        return actions[:2]

    if name in {"click", "send_keys", "navigate", "wait", "scroll", "extract"}:
        return [normalize_action_item({name: params})]

    if name == "find_text":
        return [normalize_action_item({"find_text": params})]

    return [{"wait": {"seconds": 1}}]


def extract_json_object(text: str) -> dict[str, Any] | None:
    cleaned = text.strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
    cleaned = re.sub(r"\s*```$", "", cleaned)

    try:
        parsed = json.loads(cleaned)
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        pass

    repaired = re.sub(r"([{,]\s*)([A-Za-z_][\w-]*)\"(\s*:)", r'\1"\2"\3', cleaned)
    repaired = re.sub(r"([{,]\s*)([A-Za-z_][\w-]*)(\s*:)", r'\1"\2"\3', repaired)
    try:
        parsed = json.loads(repaired)
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        pass

    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None

    candidate = cleaned[start : end + 1]
    try:
        parsed = json.loads(candidate)
    except json.JSONDecodeError:
        repaired_candidate = re.sub(r"([{,]\s*)([A-Za-z_][\w-]*)\"(\s*:)", r'\1"\2"\3', candidate)
        repaired_candidate = re.sub(r"([{,]\s*)([A-Za-z_][\w-]*)(\s*:)", r'\1"\2"\3', repaired_candidate)
        try:
            parsed = json.loads(repaired_candidate)
        except json.JSONDecodeError:
            return None

    return parsed if isinstance(parsed, dict) else None


def should_complete_visible_results(action: Any, context: str) -> bool:
    global RESULT_PAGE_NAVIGATION_SEEN

    if not isinstance(action, dict):
        return False

    task = ACTIVE_USER_TASK.lower()
    context_lower = context.lower()
    if not any(word in task for word in ("screenshot", "proof", "capture")):
        return False

    name = str(action.get("name") or action.get("action") or action.get("type") or "").lower()
    params = action.get("params", {})
    params_text = json.dumps(params, default=str).lower() if isinstance(params, (dict, list)) else str(params).lower()
    action_mentions_results = "youtube.com/results" in params_text or "search_query=" in params_text
    context_mentions_results = "youtube.com/results" in context_lower or "search_query=" in context_lower

    if action_mentions_results and not RESULT_PAGE_NAVIGATION_SEEN and not context_mentions_results:
        RESULT_PAGE_NAVIGATION_SEEN = True
        return False

    if context_mentions_results or RESULT_PAGE_NAVIGATION_SEEN:
        return any(token in name for token in ("navigate", "find_text", "extract", "done")) or action_mentions_results

    return False


def agent_output_from_simple_qwen(parsed: dict[str, Any], context: str = "") -> dict[str, Any] | None:
    done = parsed.get("done")
    if isinstance(done, dict):
        return {
            "evaluation_previous_goal": str(
                parsed.get("evaluation") or parsed.get("evaluation_previous_goal") or "Observed current browser state."
            ),
            "memory": str(parsed.get("memory") or ""),
            "next_goal": str(parsed.get("next_goal") or parsed.get("goal") or ""),
            "action": [
                {
                    "done": {
                        "text": str(done.get("text") or done.get("message") or "Task completed."),
                        "success": bool(done.get("success", True)),
                    }
                }
            ],
        }

    action = parsed.get("action")
    if action is None:
        return None

    if should_complete_visible_results(action, context):
        action = {
            "name": "done",
            "params": {
                "text": "The requested search results are visible for the evidence screenshot.",
                "success": True,
            },
        }

    return {
        "evaluation_previous_goal": str(
            parsed.get("evaluation") or parsed.get("evaluation_previous_goal") or "Observed current browser state."
        ),
        "memory": str(parsed.get("memory") or ""),
        "next_goal": str(parsed.get("next_goal") or parsed.get("goal") or ""),
        "action": browser_use_actions_from_simple(action),
    }


def normalize_agent_output_json(text: str, context: str = "") -> dict[str, Any] | None:
    parsed = extract_json_object(text)
    if not parsed:
        return None

    simple_output = agent_output_from_simple_qwen(parsed, context)
    if simple_output is not None:
        return simple_output

    actions = parsed.get("action")
    if isinstance(actions, list):
        wants_final_capture = any(
            isinstance(action, dict)
            and any(key in action for key in ("take_screenshot", "screenshot", "save_as_pdf"))
            for action in actions
        )
        if wants_final_capture:
            parsed["action"] = [
                {
                    "done": {
                        "text": "Task completed; final evidence screenshots will capture the visible evidence page.",
                        "success": True,
                    }
                }
            ]
            return parsed

        status_text = " ".join(
            str(parsed.get(key, ""))
            for key in ("evaluation_previous_goal", "memory", "next_goal")
        ).lower()
        has_done = any(isinstance(action, dict) and "done" in action for action in actions)
        says_complete = (
            ("success" in status_text or "successfully" in status_text)
            and "screenshot" in status_text
            and any(word in status_text for word in ("taken", "captured", "complete", "completed"))
        )

        if says_complete and not has_done:
            parsed["action"] = [
                {
                    "done": {
                        "text": "Task completed; the browser is positioned on the evidence page for final capture.",
                        "success": True,
                    }
                }
            ]
            return parsed

        parsed["action"] = [normalize_action_item(action) for action in actions]

    return parsed


def content_to_text(content: Any) -> str:
    if isinstance(content, str):
        return content

    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict):
                if item.get("type") == "text":
                    parts.append(str(item.get("text", "")))
                elif "text" in item:
                    parts.append(str(item["text"]))
            else:
                parts.append(str(item))
        return "\n".join(part for part in parts if part)

    return str(content)


def compact_browser_context(openai_messages: list[dict[str, Any]]) -> str:
    chunks = []

    browser_messages = [message for message in openai_messages if message.get("role") != "system"]
    for message in browser_messages[-2:]:
        role = message.get("role", "message")
        text = content_to_text(message.get("content", ""))
        if not text.strip():
            continue

        chunks.append(f"[{role}]\n{text}")

    context = "\n\n".join(chunks)
    if len(context) > MAX_QWEN_CONTEXT_CHARS:
        context = context[-MAX_QWEN_CONTEXT_CHARS:]

    return context


def completion_hint(browser_context: str) -> str:
    task = ACTIVE_USER_TASK.lower()
    context = browser_context.lower()

    if not any(word in task for word in ("screenshot", "proof", "capture")):
        return ""

    if "youtube.com/results" in context or "search_query=" in context:
        return (
            "\n\nImportant: the browser is already on a YouTube results page for this screenshot task. "
            "If the requested results are visible, choose action name done now."
        )

    return ""


class BrowserUseCompatibleChatOpenAI(ChatOpenAI):
    async def ainvoke(
        self,
        messages: list[BaseMessage],
        output_format: type[BaseModel] | None = None,
        **kwargs: Any,
    ) -> ChatInvokeCompletion[Any]:
        if output_format is None:
            return await super().ainvoke(messages, output_format=None, **kwargs)

        original_messages = OpenAIMessageSerializer.serialize_messages(messages)
        browser_context = compact_browser_context(original_messages)
        openai_messages = [
            {"role": "system", "content": QWEN_ACTION_PROMPT},
            {
                "role": "user",
                "content": (
                    f"Starting website: {ACTIVE_INITIAL_URL}\n"
                    f"Task: {ACTIVE_USER_TASK}\n\n"
                    "Page state:\n"
                    f"{browser_context}"
                    f"{completion_hint(browser_context)}"
                ),
            },
        ]

        try:
            model_params: dict[str, Any] = {}

            if self.temperature is not None:
                model_params["temperature"] = self.temperature

            if self.frequency_penalty is not None:
                model_params["frequency_penalty"] = self.frequency_penalty

            if self.max_completion_tokens is not None:
                model_params["max_completion_tokens"] = self.max_completion_tokens

            if self.top_p is not None:
                model_params["top_p"] = self.top_p

            if self.seed is not None:
                model_params["seed"] = self.seed

            if self.service_tier is not None:
                model_params["service_tier"] = self.service_tier

            if self.reasoning_models and any(
                str(model).lower() in str(self.model).lower() for model in self.reasoning_models
            ):
                model_params["reasoning_effort"] = self.reasoning_effort
                model_params.pop("temperature", None)
                model_params.pop("frequency_penalty", None)

            model_params["max_completion_tokens"] = min(int(model_params.get("max_completion_tokens") or 96), 96)
            response = await self.get_client().chat.completions.create(
                model=self.model,
                messages=openai_messages,
                **model_params,
            )

            choice = response.choices[0] if response.choices else None
            if choice is None or choice.message.content is None:
                raise ModelProviderError(
                    message="Invalid OpenAI chat completion response: missing content",
                    status_code=502,
                    model=self.name,
                )

            usage = self._get_usage(response)
            content = choice.message.content
            print(f"INFO|qwen_action_raw={content[:240].replace(chr(10), ' ')}", flush=True)

            normalized = normalize_agent_output_json(content, browser_context)
            if normalized is None:
                parsed = output_format.model_validate_json(content)
            else:
                parsed = output_format.model_validate(normalized)

            return ChatInvokeCompletion(
                completion=parsed,
                usage=usage,
                stop_reason=choice.finish_reason,
            )
        except ModelProviderError:
            raise
        except RateLimitError as error:
            raise ModelRateLimitError(message=error.message, model=self.name) from error
        except APIConnectionError as error:
            raise ModelProviderError(message=str(error), model=self.name) from error
        except APIStatusError as error:
            raise ModelProviderError(message=error.message, status_code=error.status_code, model=self.name) from error
        except Exception as error:
            raise ModelProviderError(message=str(error), model=self.name) from error


def fail(message: str, exit_code: int = 1) -> None:
    print(f"ERROR|{message}", flush=True)
    raise SystemExit(exit_code)


async def maybe_await(value):
    if inspect.isawaitable(value):
        return await value
    return value


def info(key: str, value: Any) -> None:
    if isinstance(value, (dict, list)):
        rendered = json.dumps(value, ensure_ascii=True)
    else:
        rendered = str(value)

    print(f"INFO|{key}={rendered}", flush=True)


def project_relative(path: Path) -> str:
    return path.resolve().relative_to(PROJECT_ROOT).as_posix()


def sanitize_request_id(value: str) -> str:
    sanitized = re.sub(r"[^A-Za-z0-9_.-]+", "-", value.strip())
    return sanitized[:120] or "manual"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a browser-use task and generate a tester PDF report.")
    parser.add_argument("url")
    parser.add_argument("task")
    parser.add_argument("--request-id", default=os.getenv("REQUEST_ID", "manual"))
    return parser.parse_args()


async def capture_screenshot(browser_session: BrowserSession, screenshot_path: Path) -> str:
    await maybe_await(browser_session.take_screenshot(path=str(screenshot_path), full_page=False))

    if not screenshot_path.exists():
        fail(f"Screenshot was not written: {screenshot_path}")

    return project_relative(screenshot_path)


async def capture_final_screenshot(browser_session: BrowserSession, screenshot_path: Path) -> tuple[str, str]:
    """Capture the final page controlled by browser-use, not a freshly opened URL."""
    screenshot = await capture_screenshot(browser_session, screenshot_path)

    try:
        final_url = await maybe_await(browser_session.get_current_page_url())
    except Exception:
        final_url = "unknown"

    return final_url, screenshot


def summarize_agent_failure(history) -> str:
    errors = [error for error in history.errors() if error]
    if errors:
        return errors[-1]

    if history.is_done() is False:
        return "Agent stopped before marking the task as done"

    success = history.is_successful()
    if success is False:
        return "Agent completed but judged the task unsuccessful"

    return "Agent did not produce a successful completion"


def env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default

    return value.strip().lower() in {"1", "true", "yes", "on"}


async def main() -> None:
    args = parse_args()
    url = args.url
    task = args.task
    initial_url = url
    request_id = sanitize_request_id(args.request_id)
    artifact_dir = ARTIFACTS_ROOT / request_id
    artifact_dir.mkdir(parents=True, exist_ok=True)
    screenshots: list[str] = []

    global ACTIVE_USER_TASK, ACTIVE_INITIAL_URL, RESULT_PAGE_NAVIGATION_SEEN
    ACTIVE_USER_TASK = task
    ACTIVE_INITIAL_URL = initial_url
    RESULT_PAGE_NAVIGATION_SEEN = False

    load_dotenv(PROJECT_ROOT / ".env")
    info("artifactDir", project_relative(artifact_dir))

    api_key = os.getenv("ZEROG_API_KEY")
    model = os.getenv("ZEROG_MODEL")
    base_url = os.getenv("ZEROG_BASE_URL", DEFAULT_ZEROG_BASE_URL)

    if not api_key:
        fail("Missing ZEROG_API_KEY in environment or .env")

    if not model:
        fail("Missing ZEROG_MODEL in environment or .env")

    llm = BrowserUseCompatibleChatOpenAI(
        api_key=api_key,
        base_url=base_url,
        model=model,
        temperature=0,
        frequency_penalty=None,
        max_completion_tokens=None,
        timeout=180,
        max_retries=1,
        add_schema_to_system_prompt=False,
        dont_force_structured_output=True,
    )

    browser_task = (
        f"Start at this URL: {initial_url}\n"
        f"Complete this WebOps task: {task}\n"
        "Stay on the submitted website unless the user explicitly asks you to leave it.\n"
        "For search tasks on a site, interact with that site's visible search UI like a user would.\n"
        "When finished, leave the browser visually positioned on the best evidence page for screenshots.\n"
        "Do not use save_as_pdf or screenshot tools; the orchestrator captures evidence screenshots automatically after done."
    )

    browser_profile = BrowserProfile(
        headless=env_bool("BROWSER_HEADLESS", False),
        keep_alive=True,
        viewport={"width": 1440, "height": 1000},
        window_size={"width": 1440, "height": 1000},
    )
    browser_session = BrowserSession(browser_profile=browser_profile)
    agent = Agent(
        task=browser_task,
        llm=llm,
        browser_session=browser_session,
        initial_actions=[{"navigate": {"url": initial_url, "new_tab": False}}],
        use_vision=False,
        use_thinking=False,
        max_failures=3,
        max_actions_per_step=2,
        llm_timeout=180,
        use_judge=False,
        extend_system_message=BROWSER_USE_ACTION_SCHEMA_HINT,
    )

    try:
        step_counter = 0

        async def capture_step(_agent: Agent) -> None:
            nonlocal step_counter
            step_counter += 1
            screenshot_path = artifact_dir / f"step-{step_counter:02d}.png"
            try:
                screenshots.append(await capture_screenshot(browser_session, screenshot_path))
            except Exception as error:
                info("screenshotWarning", f"{screenshot_path.name}: {error}")

        history = await agent.run(max_steps=20, on_step_end=capture_step)
        is_successful = history.is_successful()

        if history.is_done() is not True or is_successful is False:
            fail(summarize_agent_failure(history))

        final_url, final_screenshot = await capture_final_screenshot(browser_session, artifact_dir / "01-final.png")
        if final_screenshot in screenshots:
            screenshots.remove(final_screenshot)
        screenshots.append(final_screenshot)

        history_summary = summarize_history(history)
        report = await analyze_task_report(
            api_key=api_key,
            base_url=base_url,
            model=model,
            original_url=initial_url,
            task=task,
            final_url=final_url,
            history_summary=history_summary,
            screenshots=screenshots,
        )
        report_path = render_pdf_report(
            report_path=artifact_dir / "report.pdf",
            artifact_dir=artifact_dir,
            original_url=initial_url,
            task=task,
            final_url=final_url,
            report=report,
            screenshots=screenshots,
            request_id=request_id,
        )
        info("finalUrl", final_url)
        info("screenshots", screenshots)
        info("reportPath", project_relative(report_path))
    except Exception as error:
        fail(str(error))
    finally:
        await maybe_await(browser_session.stop())

    print(f"SUCCESS|{project_relative(artifact_dir / 'report.pdf')}", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
