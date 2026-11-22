#!/usr/bin/env python3
"""Convert a saved BYU Learning Suite assignments page to a MyPlan JSON import.

This tool is intentionally offline: it reads a saved HTML file and never logs in,
opens a browser, or makes network requests. It parses only the static
studentAssignmentsData object embedded in the saved page.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path
from typing import Any


class LiteralReader:
    """Read object/array/string/number/boolean/null JavaScript literals only."""

    def __init__(self, source: str):
        self.source = source
        self.pos = 0

    def fail(self, message: str) -> ValueError:
        return ValueError(f"Unsupported embedded data near character {self.pos}: {message}")

    def skip_space(self) -> None:
        while self.pos < len(self.source):
            if self.source[self.pos].isspace():
                self.pos += 1
            elif self.source.startswith("//", self.pos):
                end = self.source.find("\n", self.pos + 2)
                self.pos = len(self.source) if end < 0 else end + 1
            elif self.source.startswith("/*", self.pos):
                end = self.source.find("*/", self.pos + 2)
                if end < 0:
                    raise self.fail("unterminated comment")
                self.pos = end + 2
            else:
                break

    def string(self) -> str:
        quote = self.source[self.pos]
        self.pos += 1
        out: list[str] = []
        escapes = {"n": "\n", "r": "\r", "t": "\t", "b": "\b", "f": "\f", "v": "\v", "0": "\0"}
        while self.pos < len(self.source):
            char = self.source[self.pos]
            self.pos += 1
            if char == quote:
                return "".join(out)
            if char in "\r\n":
                raise self.fail("newline inside string")
            if char != "\\":
                out.append(char)
                continue
            if self.pos >= len(self.source):
                raise self.fail("unterminated escape")
            escape = self.source[self.pos]
            self.pos += 1
            if escape in escapes:
                out.append(escapes[escape])
            elif escape in "\\/'\"":
                out.append(escape)
            elif escape in "uUx":
                digits = 4 if escape in "uU" else 2
                raw = self.source[self.pos:self.pos + digits]
                if len(raw) != digits or not re.fullmatch(r"[\da-fA-F]{%d}" % digits, raw):
                    raise self.fail("invalid character escape")
                out.append(chr(int(raw, 16)))
                self.pos += digits
            elif escape == "\n":
                continue
            elif escape == "\r":
                if self.pos < len(self.source) and self.source[self.pos] == "\n":
                    self.pos += 1
            else:
                out.append(escape)
        raise self.fail("unterminated string")

    def identifier(self) -> str:
        match = re.match(r"[A-Za-z_$][\w$]*", self.source[self.pos:])
        if not match:
            raise self.fail("expected a property name")
        self.pos += len(match.group(0))
        return match.group(0)

    def value(self) -> Any:
        self.skip_space()
        if self.pos >= len(self.source):
            raise self.fail("unexpected end of data")
        char = self.source[self.pos]
        if char == "{":
            return self.object()
        if char == "[":
            return self.array()
        if char in "\"'":
            return self.string()
        number = re.match(r"-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?", self.source[self.pos:])
        if number:
            self.pos += len(number.group(0))
            value = float(number.group(0)) if any(c in number.group(0) for c in ".eE") else int(number.group(0))
            return value if isinstance(value, int) or value == value and abs(value) != float("inf") else None
        word = self.identifier()
        if word == "true":
            return True
        if word == "false":
            return False
        if word in ("null", "undefined", "NaN", "Infinity"):
            return None
        raise self.fail("executable or unsupported value")

    def object(self) -> dict[str, Any]:
        self.pos += 1
        result: dict[str, Any] = {}
        self.skip_space()
        if self.pos < len(self.source) and self.source[self.pos] == "}":
            self.pos += 1
            return result
        while True:
            self.skip_space()
            if self.pos >= len(self.source):
                raise self.fail("unterminated object")
            key = self.string() if self.source[self.pos] in "\"'" else self.identifier()
            self.skip_space()
            if self.pos >= len(self.source) or self.source[self.pos] != ":":
                raise self.fail("expected colon after property name")
            self.pos += 1
            result[key] = self.value()
            self.skip_space()
            if self.pos < len(self.source) and self.source[self.pos] == "}":
                self.pos += 1
                return result
            if self.pos >= len(self.source) or self.source[self.pos] != ",":
                raise self.fail("expected comma or closing brace")
            self.pos += 1
            self.skip_space()
            if self.pos < len(self.source) and self.source[self.pos] == "}":
                self.pos += 1
                return result

    def array(self) -> list[Any]:
        self.pos += 1
        result: list[Any] = []
        self.skip_space()
        if self.pos < len(self.source) and self.source[self.pos] == "]":
            self.pos += 1
            return result
        while True:
            result.append(self.value())
            self.skip_space()
            if self.pos < len(self.source) and self.source[self.pos] == "]":
                self.pos += 1
                return result
            if self.pos >= len(self.source) or self.source[self.pos] != ",":
                raise self.fail("expected comma or closing bracket")
            self.pos += 1
            self.skip_space()
            if self.pos < len(self.source) and self.source[self.pos] == "]":
                self.pos += 1
                return result


class TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.hidden = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in ("script", "style"):
            self.hidden += 1

    def handle_endtag(self, tag: str) -> None:
        if tag in ("script", "style") and self.hidden:
            self.hidden -= 1

    def handle_data(self, data: str) -> None:
        if not self.hidden:
            self.parts.append(data)


def clean_description(value: Any) -> str:
    extractor = TextExtractor()
    extractor.feed(str(value or ""))
    return " ".join(" ".join(extractor.parts).split())[:2000]


def learning_suite_boolean(value: Any) -> bool:
    return value is True or value == 1 or str(value or "").strip().lower() in {"1", "true", "yes", "y"}


def normalize_learning_suite_category_weights(category_folders: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized = [dict(folder) for folder in category_folders]
    regular_total = sum(
        folder["weight_percent"] for folder in normalized
        if not folder["bonus_cap_enabled"] and folder["weight_percent"] > 0
    )
    if regular_total > 0 and abs(regular_total - 100) > 1e-9:
        for folder in normalized:
            if folder["bonus_cap_enabled"]:
                continue
            weight = folder["weight_percent"]
            folder["weight_percent"] = weight * 100 / regular_total if weight > 0 else 0
    return normalized


def to_local_date_time(value: Any) -> tuple[str | None, str | None]:
    if not value or not isinstance(value, str):
        return None, None
    match = re.match(r"^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(?::\d{2})?)?", value.strip())
    if not match:
        return None, None
    try:
        datetime.strptime(match.group(1), "%Y-%m-%d")
    except ValueError:
        return None, None
    return match.group(1), match.group(2)


def parse_payload(page: str) -> dict[str, Any]:
    match = re.search(r"\bconst\s+studentAssignmentsData\s*=\s*", page)
    if not match:
        raise ValueError("Could not find Learning Suite's embedded assignments data in this HTML file.")
    reader = LiteralReader(page[match.end():])
    payload = reader.value()
    if not isinstance(payload, dict):
        raise ValueError("The embedded assignments data was not an object.")
    return payload


def make_backup(data: dict[str, Any], course_name: str, course_id: str, student_id: str | None) -> dict[str, Any]:
    categories = data.get("categories") or []
    assignments = data.get("assignments") or []
    scores = data.get("scores") or []
    if not isinstance(categories, list) or not isinstance(assignments, list) or not isinstance(scores, list):
        raise ValueError("This page's category, assignment, or score data has an unexpected format.")

    score_students = {str(score.get("studentID")) for score in scores if score.get("studentID") is not None}
    if student_id is None and len(score_students) == 1:
        student_id = next(iter(score_students))
    elif student_id is None and len(score_students) > 1:
        raise ValueError("This saved page contains grades for multiple students. Use --student-id with your own Learning Suite student ID.")

    score_by_assignment: dict[str, dict[str, Any]] = {}
    for score in scores:
        if student_id is not None and str(score.get("studentID", "")) != str(student_id):
            continue
        assignment_id = score.get("assignmentID")
        if assignment_id is None:
            continue
        key = str(assignment_id)
        previous = score_by_assignment.get(key)
        if previous is None or str(score.get("modifyTime", "")) >= str(previous.get("modifyTime", "")):
            score_by_assignment[key] = score

    included_assignment_counts: dict[str, int] = {}
    included_assignments_by_category: dict[str, list[dict[str, Any]]] = {}
    for assignment in assignments:
        if not isinstance(assignment, dict) or assignment.get("deleted") or assignment.get("includeScoreInFinalGrade") is False:
            continue
        category_id = str(assignment.get("categoryID") or "")
        included_assignment_counts[category_id] = included_assignment_counts.get(category_id, 0) + 1
        included_assignments_by_category.setdefault(category_id, []).append(assignment)

    course_id = course_id or str(data.get("courseID") or "unknown")
    course_folder_id = f"ls-course-{course_id}"
    folders = [{"id": course_folder_id, "name": course_name, "parent_id": None, "weight_percent": 0, "drop_lowest_count": 0, "bonus_cap_enabled": False}]
    category_by_id: dict[str, dict[str, Any]] = {}
    category_folders: list[dict[str, Any]] = []
    for category in categories:
        if not isinstance(category, dict) or category.get("id") is None or category.get("deleted"):
            continue
        category_id = str(category["id"])
        folder_id = f"ls-category-{category_id}"
        category_by_id[category_id] = category
        included_assignments = included_assignments_by_category.get(category_id) or []
        bonus_cap = bool(included_assignments) and all(
            learning_suite_boolean(assignment.get("extraCredit")) for assignment in included_assignments
        )
        raw_weight = category.get("weight") if category.get("weight") is not None else 0
        try:
            numeric_weight = float(raw_weight)
        except (TypeError, ValueError):
            numeric_weight = 0
        category_folders.append({
            "id": folder_id,
            "name": str(category.get("title") or "Uncategorized"),
            "parent_id": course_folder_id,
            "weight_percent": numeric_weight,
            "drop_lowest_count": category.get("lowScoresToDrop") or 0,
            "bonus_cap_enabled": bonus_cap,
        })
    folders.extend(normalize_learning_suite_category_weights(category_folders))

    tasks: list[dict[str, Any]] = []
    for assignment in assignments:
        if not isinstance(assignment, dict) or assignment.get("deleted"):
            continue
        assignment_id = assignment.get("id")
        title = str(assignment.get("name") or assignment.get("shortName") or "").strip()
        if assignment_id is None or not title:
            continue
        category_id = str(assignment.get("categoryID") or "")
        category = category_by_id.get(category_id)
        if category is None:
            category_id = "uncategorized"
            folder_id = f"ls-category-{category_id}"
            if not any(folder["id"] == folder_id for folder in folders):
                folders.append({"id": folder_id, "name": "Uncategorized", "parent_id": course_folder_id, "weight_percent": 0, "drop_lowest_count": 0, "bonus_cap_enabled": False})
        else:
            folder_id = f"ls-category-{category_id}"

        score = score_by_assignment.get(str(assignment.get("gbAssignmentID") or ""))
        if score is None:
            score = score_by_assignment.get(str(assignment_id))
        points = assignment.get("points")
        earned = score.get("score") if score and score.get("score") is not None else None
        has_grade = earned is not None and not score.get("excuse", False)
        start_date, start_time = to_local_date_time(assignment.get("beginDate"))
        due_date, due_time = to_local_date_time(assignment.get("dueDate"))
        raw_weight = assignment.get("weight")
        try:
            numeric_weight = float(raw_weight) if raw_weight not in (None, "") else None
        except (TypeError, ValueError):
            numeric_weight = None
        category_equal = bool(category and category.get("equalAssignWeight"))
        included = assignment.get("includeScoreInFinalGrade") is not False
        equal_weight_count = included_assignment_counts.get(category_id, 0)
        weight = 0 if not included else 1 if category_equal else numeric_weight
        grade_weight_percent = (
            0 if not included
            else (float(category.get("weight") or 0) / max(1, equal_weight_count)) if category_equal
            else numeric_weight
        )

        tasks.append({
            "id": f"ls-assignment-{assignment_id}",
            "title": title[:200],
            "description": clean_description(assignment.get("description")),
            "folder_id": folder_id,
            "status": "done" if has_grade else "todo",
            "status_label": "",
            "priority": "medium",
            "start_date": start_date,
            "start_time": start_time,
            "due_date": due_date,
            "due_time": due_time,
            "progress": 100 if has_grade else 0,
            "earned_points": earned if has_grade else None,
            "max_points": points,
            "grade": None,
            "weight_override": weight,
            "extra_credit": learning_suite_boolean(assignment.get("extraCredit")),
            "custom_values": {"ls-grade-weight": grade_weight_percent} if grade_weight_percent is not None else {},
            "dependencies": [],
        })

    return {
        "format": "myplan-task-backup", "version": 1,
        "source": {"system": "byu_learning_suite", "course_id": course_id, "course_name": course_name},
        "folders": folders,
        "custom_fields": [{"id": "ls-grade-weight", "name": "Grade Weight %", "field_type": "number", "options": []}],
        "tasks": tasks
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", nargs="?", default="ls.sample.html", help="saved Learning Suite assignments HTML")
    parser.add_argument("--output", help="output MyPlan JSON backup (default: <input>.myplan-import.json)")
    parser.add_argument("--course-name", default="BYU Learning Suite", help="name for the imported top-level course folder")
    parser.add_argument("--student-id", help="your Learning Suite student ID if the file contains multiple students")
    args = parser.parse_args()

    source = Path(args.input)
    target = Path(args.output) if args.output else source.with_suffix(".myplan-import.json")
    try:
        page = source.read_text(encoding="utf-8-sig")
        payload = parse_payload(page)
        course_id_match = re.search(r"\bglobal_courseID\s*=\s*['\"]([^'\"]+)['\"]", page)
        course_id = course_id_match.group(1) if course_id_match else "unknown"
        backup = make_backup(payload, args.course_name, course_id, args.student_id)
        target.write_text(json.dumps(backup, ensure_ascii=False, indent=2), encoding="utf-8")
    except (OSError, UnicodeError, ValueError) as error:
        print(f"Import preparation failed: {error}", file=sys.stderr)
        return 1

    print(f"Prepared {len(backup['tasks'])} task(s) in {len(backup['folders']) - 1} category folder(s).")
    print(f"Saved MyPlan import file: {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
