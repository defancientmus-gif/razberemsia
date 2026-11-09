#!/usr/bin/env python3
"""След окна после обрыва: дошло ли срезанное сообщение до окна потом.

  python3 scripts/след-окна.py <начало id журнала> [слово ...] [--минут 50]

Печатает ходы окна за последние N минут без шума инструментов; строки с искомым
словом помечены. Нужен аудиту обрывов: «окно живо» ещё не значит, что срезанное
сообщение кто-то прочёл.
"""
import argparse
import glob
import json
import os
from datetime import datetime, timedelta, timezone

MSK = timezone(timedelta(hours=3))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("окно")
    ap.add_argument("слова", nargs="*")
    ap.add_argument("--минут", type=float, default=50)
    a = ap.parse_args()
    с = datetime.now(timezone.utc) - timedelta(minutes=a.минут)
    for f in glob.glob(os.path.expanduser("~/.claude/projects/*/" + a.окно + "*.jsonl")):
        print("===", os.path.basename(f)[:8], f.split("/")[-2][-30:])
        for line in open(f, errors="ignore"):
            try:
                d = json.loads(line)
                t = datetime.fromisoformat(d["timestamp"].replace("Z", "+00:00"))
            except Exception:
                continue
            тип = d.get("type")
            if t < с or тип not in ("user", "assistant", "system", "queue-operation"):
                continue
            s = json.dumps(d.get("message") or d.get("content") or "", ensure_ascii=False)
            метки = [w for w in a.слова if w in s]
            if ("tool_use" in s or "tool_result" in s) and not метки:
                continue
            блок = "СРЕЗ" if тип == "system" and "blocked by hook" in s else ""
            if тип == "queue-operation":
                s = str(d.get("operation")) + " " + str(d.get("content"))
            print("  ", t.astimezone(MSK).strftime("%H:%M:%S"), тип[:5], блок, " ".join(метки), "|", " ".join(s.split())[:170])


if __name__ == "__main__":
    main()
