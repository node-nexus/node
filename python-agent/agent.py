import asyncio
import inspect
import os
import sys
from pathlib import Path

from browser_use import Agent, ChatOpenAI
from browser_use.browser.profile import BrowserProfile
from browser_use.browser.session import BrowserSession
from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parents[1]
PROOF_PATH = PROJECT_ROOT / "final_proof.png"
ZEROG_BASE_URL = "https://router-api.0g.ai/v1"


def fail(message: str, exit_code: int = 1) -> None:
    print(f"ERROR|{message}", flush=True)
    raise SystemExit(exit_code)


async def maybe_await(value):
    if inspect.isawaitable(value):
        return await value
    return value


async def capture_final_screenshot(browser_session: BrowserSession, proof_path: Path) -> str:
    """Capture the final page controlled by browser-use, not a freshly opened URL."""
    await maybe_await(browser_session.take_screenshot(path=str(proof_path), full_page=True))

    if not proof_path.exists():
        fail("Browser task completed, but final screenshot was not written")

    try:
        return await maybe_await(browser_session.get_current_page_url())
    except Exception:
        return "unknown"


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
    if len(sys.argv) < 3:
        fail("Usage: python-agent/agent.py <url> <task>")

    url = sys.argv[1]
    task = sys.argv[2]

    load_dotenv(PROJECT_ROOT / ".env")

    api_key = os.getenv("ZEROG_API_KEY")
    model = os.getenv("ZEROG_MODEL")

    if not api_key:
        fail("Missing ZEROG_API_KEY in environment or .env")

    if not model:
        fail("Missing ZEROG_MODEL in environment or .env")

    llm = ChatOpenAI(
        api_key=api_key,
        base_url=ZEROG_BASE_URL,
        model=model,
        temperature=0,
    )

    browser_task = (
        f"Start at this URL: {url}\n"
        f"Complete this WebOps task: {task}\n"
        "When finished, leave the browser on the best evidence page for a proof screenshot."
    )

    browser_profile = BrowserProfile(
        headless=env_bool("BROWSER_HEADLESS", False),
        keep_alive=True,
        viewport={"width": 1440, "height": 1000},
        window_size={"width": 1440, "height": 1000},
    )
    browser_session = BrowserSession(browser_profile=browser_profile)
    agent = Agent(task=browser_task, llm=llm, browser_session=browser_session)

    try:
        history = await agent.run()
        is_successful = history.is_successful()

        if history.is_done() is not True or is_successful is False:
            fail(summarize_agent_failure(history))

        final_url = await capture_final_screenshot(browser_session, PROOF_PATH)
        print(f"INFO|final_url={final_url}", flush=True)
    except Exception as error:
        fail(str(error))
    finally:
        await maybe_await(browser_session.stop())

    print("SUCCESS|./final_proof.png", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
