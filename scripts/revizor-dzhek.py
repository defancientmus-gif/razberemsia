#!/usr/bin/env python3
"""Кому сегодня уже писал Джек (дозор задач). Ревизор этим хозяевам про то же дело не пишет.

Раздел ролей из аудита штата 06.11: повторный пинок хозяину по висящему делу ведёт Джек,
ревизор разбирает застревания между окнами. Читает Домик/log/дозор-задач.jsonl, только чтение.
"""
import json
import sys
from datetime import date
from pathlib import Path

LOG = Path.home() / "Documents/Домик/log/дозор-задач.jsonl"
day = sys.argv[1] if len(sys.argv) > 1 else date.today().isoformat()

owners = set()
if LOG.exists():
    for line in LOG.read_text(encoding="utf-8").splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if not str(row.get("когда", "")).startswith(day):
            continue
        for key in ("живых_окон", "письмом"):
            owners.update(row.get(key) or [])

if owners:
    print(f"Джек {day} уже писал: " + ", ".join(sorted(owners)))
else:
    print(f"Джек {day} никому не писал (или журнала нет)")
