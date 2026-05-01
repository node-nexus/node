import asyncio
import inspect
import os
import sys
from pathlib import Path

from browser_use import Agent, ChatOpenAI
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


async def try_browser_use_screenshot(agent: Agent, proof_path: Path) -> bool:
    """Best-effort screenshot across browser-use versions."""
    candidates = [
        getattr(agent, "browser_session", None),
        getattr(agent, "browser", None),
    ]

    for candidate in candidates:
        if candidate is None:
            continue

        for method_name in ("take_screenshot", "screenshot"):
            method = getattr(candidate, method_name, None)
            if method is None:
                continue

            try:
                await maybe_await(method(path=str(proof_path)))
                return proof_path.exists()
            except TypeError:
                try:
                    await maybe_await(method(str(proof_path)))
                    return proof_path.exists()
                except Exception:
                    continue
            except Exception:
                continue

        for page_attr in ("current_page", "page"):
            page = getattr(candidate, page_attr, None)
            if callable(page):
                try:
                    page = await maybe_await(page())
                except Exception:
                    page = None

            screenshot = getattr(page, "screenshot", None)
            if screenshot is None:
                continue

            try:
                await maybe_await(screenshot(path=str(proof_path), full_page=True))
                return proof_path.exists()
            except Exception:
                continue

    return False


async def fallback_playwright_screenshot(url: str, proof_path: Path) -> None:
    from playwright.async_api import async_playwright

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        page = await browser.new_page(viewport={"width": 1440, "height": 1000})
        await page.goto(url, wait_until="networkidle", timeout=45_000)
        await page.screenshot(path=str(proof_path), full_page=True)
        await browser.close()


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

    agent = Agent(task=browser_task, llm=llm)

    try:
        await agent.run()

        if not await try_browser_use_screenshot(agent, PROOF_PATH):
            await fallback_playwright_screenshot(url, PROOF_PATH)
    except Exception as error:
        fail(str(error))

    print("SUCCESS|./final_proof.png", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
