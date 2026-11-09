#!/usr/bin/env python3
"""Аудит после обрывов сети (Женя 09.11 21:22 «После таких разрывов с сетью надо аудиты проводить»).

Только чтение. Смотрит журналы сессий Claude Code за последние N часов:
  · какие окна ловили ошибку API (403 «регион», ECONNRESET, нет ответа);
  · какие после обрыва НЕ сделали ни одного хода — встали (их надо поднять);
  · после чьего обрыва Женя писал «продолжи» — его повтор;
  · чьи запросы срезал хук «Интернета нет» (ошибки API при этом нет, ходов тоже):
    фоновый запуск без единого хода = потерян, в живом окне = пропало одно сообщение;
  · в каких проектах ~/Documents лежит незакоммиченное.
Писем не шлёт — вывод читает тот, кто зовёт (поднять.py, ревизор).

  python3 scripts/аудит-обрывов.py            # за 12 часов
  python3 scripts/аудит-обрывов.py --часов 3
"""
import argparse, glob, json, os, subprocess, sys
from datetime import datetime, timedelta, timezone

MSK = timezone(timedelta(hours=3))
ДОК = os.path.expanduser("~/Documents/")


def текст(d):
    c = (d.get("message") or {}).get("content") if isinstance(d.get("message"), dict) else ""
    if isinstance(c, str):
        return c
    if isinstance(c, list) and c and isinstance(c[0], dict):
        return c[0].get("text", "") or ""
    return ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--часов", type=float, default=12)
    ap.add_argument("--подробно", action="store_true", help="срезанный запрос целиком (700 зн.) и время последнего хода окна")
    a = ap.parse_args()
    с = datetime.now(timezone.utc) - timedelta(hours=a.часов)
    встали, повторы, молчат, срезы, потеряно, обрывов = [], [], [], [], 0, 0
    for f in glob.glob(os.path.expanduser("~/.claude/projects/*/*.jsonl")):
        if os.path.getmtime(f) < с.timestamp():
            continue
        rows = []
        for line in open(f, errors="ignore"):
            try:
                d = json.loads(line)
                t = datetime.fromisoformat(d["timestamp"].replace("Z", "+00:00"))
            except Exception:
                continue
            if t >= с:
                rows.append((t, d))
        cwd = next((d.get("cwd") for _, d in reversed(rows) if d.get("cwd")), f)
        где = cwd.replace(ДОК, "") or cwd
        for i, (t, d) in enumerate(rows):
            if not d.get("isApiErrorMessage"):
                continue
            обрывов += 1
            после = [x for _, x in rows[i + 1:] if x.get("type") == "assistant" and not x.get("isApiErrorMessage")]
            когда = t.astimezone(MSK).strftime("%H:%M")
            if not после:
                встали.append(f"{когда} {где} [{os.path.basename(f)[:8]}] — {текст(d)[:60]}")
            след = next((текст(x) for _, x in rows[i + 1:] if x.get("type") == "user" and isinstance((x.get("message") or {}).get("content"), str)), "")
            if след.strip().lower().startswith("продолж"):
                повторы.append(f"{когда} {где} — Женя написал «{след.strip()[:30]}»")
        # Третий вид (09.11 21:28–21:52, 10.11 00:13): хук «Интернета нет» срезал запрос до отправки.
        # Ошибки API нет. Фоновый запуск остаётся без единого хода — повторять «когда сеть вернётся» некому.
        for i, (t, d) in enumerate(rows):
            c = d.get("content")
            if d.get("type") != "system" or not isinstance(c, str) or "blocked by hook" not in c or "Интернета нет" not in c:
                continue
            что = " ".join(c.split("Original prompt:", 1)[-1].split())[:700 if a.подробно else 90]
            ходы = [y for y, x in rows[i + 1:] if x.get("type") == "assistant"]
            жив = bool(ходы)
            потеряно += 0 if жив else 1
            исход = "окно живо, это сообщение пропало" if жив else "ПОТЕРЯН ЗАПУСК, ходов после нет"
            if a.подробно and жив:
                исход += f" (последний ход {ходы[-1].astimezone(MSK).strftime('%H:%M')})"
            срезы.append(f"{t.astimezone(MSK).strftime('%H:%M')} {где} [{os.path.basename(f)[:8]}] — {исход}: «{что}»")
        # Второй вид остановки (09.11 21:22–21:28): ошибки API нет, но последнее слово в окне —
        # не ассистента (стоп фильтра, «Сеть вернулась… выполни сейчас», оборванный ответ инструмента).
        хв = [(t, d) for t, d in rows if d.get("type") in ("user", "assistant")]
        if хв and not хв[-1][1].get("isApiErrorMessage"):
            t, d = хв[-1]
            тихо = (datetime.now(timezone.utc) - t).total_seconds() / 60
            if d.get("type") == "user" and тихо >= 3:
                s = json.dumps(d.get("message", ""), ensure_ascii=False)
                if "safety classifier" in s:
                    почему = "стоп фильтра безопасности"
                elif "Сеть вернулась" in s:
                    почему = "сеть вернулась, сообщение не подхвачено"
                elif "tool_result" in s:
                    почему = "оборван посреди хода"
                else:
                    почему = "сообщение без ответа"
                молчат.append(f"{t.astimezone(MSK).strftime('%H:%M')} {где} [{os.path.basename(f)[:8]}] — {почему}, тишина {тихо:.0f} мин")
    print(f"Обрывов API за {a.часов:g} ч: {обрывов}")
    print(f"Встали после обрыва (ни одного хода): {len(встали)}")
    for s in встали:
        print("   ·", s)
    print(f"Замолчали без ошибки API (последнее слово не ассистента): {len(молчат)}")
    for s in молчат:
        print("   ·", s)
    print(f"Женя сам писал «продолжи» после обрыва: {len(повторы)}")
    for s in повторы:
        print("   ·", s)
    print(f"Срезано хуком «Интернета нет»: {len(срезы)}, из них потеряно запусков целиком: {потеряно}")
    for s in sorted(срезы):
        print("   ·", s)
    грязь = []
    for p in sorted(glob.glob(ДОК + "*/.git")):
        repo = os.path.dirname(p)
        out = subprocess.run(["git", "-C", repo, "status", "--porcelain"], capture_output=True, text=True).stdout.splitlines()
        out = [o for o in out if "__pycache__" not in o]
        if out:
            лог = subprocess.run(["git", "-C", repo, "log", "-1", "--format=%cr"], capture_output=True, text=True).stdout.strip()
            грязь.append(f"{os.path.basename(repo)}: {len(out)} незакоммич., последний коммит {лог}")
    print(f"Проекты с незакоммиченным: {len(грязь)}")
    for s in грязь:
        print("   ·", s)
    return 1 if встали or повторы or молчат or срезы else 0


if __name__ == "__main__":
    sys.exit(main())
