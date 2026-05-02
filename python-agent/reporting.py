import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from openai import AsyncOpenAI
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import Image, Paragraph, SimpleDocTemplate, Spacer


REPORT_SCHEMA_HINT = {
    "title": "Short report title",
    "status": "pass|fail|complete|inconclusive",
    "summary": "Plain-language result summary",
    "steps_performed": ["Step 1", "Step 2"],
    "observations": ["Observation 1"],
    "limitations": ["Limitation or note"],
}


def _truncate(value: Any, max_length: int = 4000) -> str:
    text = str(value or "")
    return text if len(text) <= max_length else f"{text[:max_length]}..."


def _safe_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []

    return [str(item) for item in value if str(item).strip()]


def _parse_report_json(content: str) -> dict[str, Any]:
    cleaned = content.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.removeprefix("```json").removeprefix("```").strip()
        cleaned = cleaned.removesuffix("```").strip()

    try:
        parsed = json.loads(cleaned)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start != -1 and end > start:
        try:
            parsed = json.loads(cleaned[start : end + 1])
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass

    return {
        "title": "Browser Task Tester Report",
        "status": "complete",
        "summary": cleaned or "Qwen returned an empty report summary.",
        "steps_performed": [],
        "observations": [cleaned] if cleaned else [],
        "limitations": ["The report text could not be parsed as JSON, so it was included verbatim."],
    }


def summarize_history(history: Any) -> dict[str, Any]:
    return {
        "is_done": history.is_done(),
        "is_successful": history.is_successful(),
        "final_result": history.final_result(),
        "urls": history.urls()[-10:],
        "action_names": history.action_names()[-20:],
        "actions": history.model_actions()[-20:],
        "extracted_content": history.extracted_content()[-10:],
        "errors": [error for error in history.errors() if error][-5:],
        "duration_seconds": history.total_duration_seconds(),
        "steps": history.number_of_steps(),
    }


async def analyze_task_report(
    *,
    api_key: str,
    base_url: str,
    model: str,
    original_url: str,
    task: str,
    final_url: str,
    history_summary: dict[str, Any],
    screenshots: list[str],
) -> dict[str, Any]:
    client = AsyncOpenAI(api_key=api_key, base_url=base_url)
    prompt = {
        "original_url": original_url,
        "task": task,
        "final_url": final_url,
        "history_summary": history_summary,
        "screenshot_paths": screenshots,
        "required_schema": REPORT_SCHEMA_HINT,
    }

    response = await client.chat.completions.create(
        model=model,
        temperature=0,
        messages=[
            {
                "role": "system",
                "content": (
                    "You are a careful human QA tester writing an evidence report for a completed "
                    "browser automation task. Return only JSON matching the requested schema. Be "
                    "specific, factual, and mention limitations when evidence is incomplete."
                ),
            },
            {
                "role": "user",
                "content": json.dumps(prompt, ensure_ascii=True, default=str),
            },
        ],
    )

    choice = response.choices[0] if response.choices else None
    content = choice.message.content if choice and choice.message else ""
    report = _parse_report_json(content or "")
    report["qwen_raw_report"] = content or ""
    return report


def _paragraph(story: list[Any], styles: dict[str, Any], title: str, value: Any) -> None:
    story.append(Paragraph(title, styles["Heading2"]))
    if isinstance(value, list):
        if not value:
            story.append(Paragraph("None recorded.", styles["BodyText"]))
        for item in value:
            story.append(Paragraph(f"- {_truncate(item, 1200)}", styles["BodyText"]))
    else:
        story.append(Paragraph(_truncate(value, 2000) or "None recorded.", styles["BodyText"]))
    story.append(Spacer(1, 0.15 * inch))


def _image_for_pdf(path: Path, max_width: float, max_height: float) -> Image | None:
    if not path.exists():
        return None

    image = Image(str(path))
    width = image.imageWidth
    height = image.imageHeight
    if width <= 0 or height <= 0:
        return None

    scale = min(max_width / width, max_height / height, 1)
    image.drawWidth = width * scale
    image.drawHeight = height * scale
    return image


def render_pdf_report(
    *,
    report_path: Path,
    artifact_dir: Path,
    original_url: str,
    task: str,
    final_url: str,
    report: dict[str, Any],
    screenshots: list[str],
    request_id: str,
) -> Path:
    report_path.parent.mkdir(parents=True, exist_ok=True)
    styles = getSampleStyleSheet()
    styles["Title"].textColor = colors.HexColor("#1f2937")
    styles["Heading2"].textColor = colors.HexColor("#374151")

    doc = SimpleDocTemplate(
        str(report_path),
        pagesize=letter,
        rightMargin=0.65 * inch,
        leftMargin=0.65 * inch,
        topMargin=0.65 * inch,
        bottomMargin=0.65 * inch,
    )

    title = str(report.get("title") or "Browser Task Tester Report")
    story: list[Any] = [
        Paragraph(title, styles["Title"]),
        Spacer(1, 0.2 * inch),
        Paragraph(f"Request ID: {request_id}", styles["BodyText"]),
        Paragraph(f"Generated: {datetime.now(timezone.utc).isoformat()}", styles["BodyText"]),
        Paragraph(f"Environment: Python browser-use with Qwen via 0G router", styles["BodyText"]),
        Spacer(1, 0.25 * inch),
    ]

    _paragraph(story, styles, "Task Requested", task)
    _paragraph(story, styles, "Original URL", original_url)
    _paragraph(story, styles, "Final URL", final_url)
    _paragraph(story, styles, "Completion Status", report.get("status", "complete"))
    _paragraph(story, styles, "Result Summary", report.get("summary"))
    _paragraph(story, styles, "Observations", _safe_list(report.get("observations")))
    _paragraph(story, styles, "Steps Performed", _safe_list(report.get("steps_performed")))
    _paragraph(story, styles, "Evidence / Screenshots", screenshots)

    max_width = letter[0] - 1.3 * inch
    max_height = 3.2 * inch
    for screenshot in screenshots:
        screenshot_path = (artifact_dir / Path(screenshot).name).resolve()
        image = _image_for_pdf(screenshot_path, max_width, max_height)
        if image is None:
            continue
        story.append(Paragraph(Path(screenshot).name, styles["BodyText"]))
        story.append(image)
        story.append(Spacer(1, 0.2 * inch))

    _paragraph(story, styles, "Notes / Limitations", _safe_list(report.get("limitations")))

    doc.build(story)
    return report_path
