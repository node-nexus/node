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
DEFAULT_ZEROG_BASE_URL = "https://router-api-testnet.integratenetwork.work/v1"


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


def extract_search_query(task: str) -> str | None:
    lowered = task.lower()
    marker = "search for "
    if marker not in lowered:
        return None

    start = lowered.index(marker) + len(marker)
    tail = task[start:].strip()
    stop_phrases = [
        " and take",
        " and screenshot",
        " then take",
        " then screenshot",
        " and capture",
        " then capture",
    ]
    end = len(tail)
    lowered_tail = tail.lower()

    for phrase in stop_phrases:
        phrase_index = lowered_tail.find(phrase)
        if phrase_index != -1:
            end = min(end, phrase_index)

    query = tail[:end].strip(" .,:;")
    return query or None


async def run_playwright_search_fallback(url: str, task: str, proof_path: Path) -> str | None:
    query = extract_search_query(task)
    if not query:
        return None

    from playwright.async_api import async_playwright

    headless = env_bool("BROWSER_HEADLESS", False)

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=headless)
        page = await browser.new_page(viewport={"width": 1440, "height": 1000})
        await page.goto(url, wait_until="domcontentloaded", timeout=45_000)

        if "wikipedia.org" in page.url:
            search_box = page.locator("input[name='search']").first
            await search_box.fill(query)
            await page.wait_for_timeout(350)
            article_url = f"https://en.wikipedia.org/wiki/{query.replace(' ', '_')}"
            await page.goto(article_url, wait_until="domcontentloaded", timeout=45_000)
            await page.wait_for_load_state("domcontentloaded", timeout=45_000)

            if "Special:Search" in page.url:
                first_article = page.locator(".mw-search-result-heading a").first
                if await first_article.count() > 0:
                    await first_article.click()
                    await page.wait_for_load_state("domcontentloaded", timeout=45_000)
        else:
            selectors = [
                "input[type='search']",
                "input[name='q']",
                "input[name='search']",
                "textarea[name='q']",
            ]
            search_box = None
            for selector in selectors:
                candidate = page.locator(selector).first
                if await candidate.count() > 0:
                    search_box = candidate
                    break

            if search_box is None:
                await browser.close()
                return None

            await search_box.fill(query)
            await page.keyboard.press("Enter")
            await page.wait_for_load_state("domcontentloaded", timeout=45_000)

        await page.screenshot(path=str(proof_path), full_page=False)
        final_url = page.url
        await browser.close()
        return final_url


async def main() -> None:
    if len(sys.argv) < 3:
        fail("Usage: python-agent/agent.py <url> <task>")

    url = sys.argv[1]
    task = sys.argv[2]

    load_dotenv(PROJECT_ROOT / ".env")

    api_key = os.getenv("ZEROG_API_KEY")
    model = os.getenv("ZEROG_MODEL")
    base_url = os.getenv("ZEROG_BASE_URL", DEFAULT_ZEROG_BASE_URL)

    if not api_key:
        fail("Missing ZEROG_API_KEY in environment or .env")

    if not model:
        fail("Missing ZEROG_MODEL in environment or .env")

    llm = ChatOpenAI(
        api_key=api_key,
        base_url=base_url,
        model=model,
        temperature=0,
        frequency_penalty=None,
        max_completion_tokens=None,
        add_schema_to_system_prompt=True,
        dont_force_structured_output=False,
    )

    browser_task = (
        f"Start at this URL: {url}\n"
        f"Complete this WebOps task: {task}\n"
        "When finished, leave the browser on the best evidence page for a proof screenshot."
    )

    if env_bool("PLAYWRIGHT_SEARCH_FALLBACK", True):
        final_url = await run_playwright_search_fallback(url, task, PROOF_PATH)
        if final_url:
            print(f"INFO|execution=playwright-search-fallback", flush=True)
            print(f"INFO|final_url={final_url}", flush=True)
            print("SUCCESS|./final_proof.png", flush=True)
            return

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
        use_vision=False,
        extend_system_message="Always respond with valid JSON matching the provided schema.",
    )

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
