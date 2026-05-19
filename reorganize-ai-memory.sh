#!/bin/bash

# =============================================================
# Реорганизация Ai Memory — проект «Разберёмся»
# Запускать из корня репозитория: bash reorganize-ai-memory.sh
# =============================================================

set -e  # остановиться при любой ошибке

echo "📁 Начинаем реорганизацию Ai Memory..."
echo ""

# --- 1. Создаём новые папки ---

mkdir -p "Ai Memory/archive/Memory Bank"
mkdir -p "Ai Memory/archive/Master Modes"
mkdir -p "Ai Memory/notebook-memory"

echo "✓ Папки созданы"

# --- 2. Перемещаем актуальные файлы в корень Ai Memory ---
# Берём из Memory Bank — там последние версии

cp "Ai Memory/Memory Bank/CLAUDE_MASTER.md"           "Ai Memory/CLAUDE_MASTER.md"
cp "Ai Memory/Memory Bank/CODEX_MASTER.md"            "Ai Memory/CODEX_MASTER.md"
cp "Ai Memory/Memory Bank/AI_MEMORY_ARCHITECTURE.md"  "Ai Memory/AI_MEMORY_ARCHITECTURE.md"
cp "Ai Memory/Memory Bank/PROJECT_PROMOTION_STRATEGY.md" "Ai Memory/PROJECT_PROMOTION_STRATEGY.md"

# CLAUDE_PROJECT_MASTER — тоже актуальный, оставляем
cp "Ai Memory/Memory Bank/CLAUDE_PROJECT_MASTER.md"   "Ai Memory/CLAUDE_PROJECT_MASTER.md"

echo "✓ Актуальные файлы скопированы в корень Ai Memory/"

# --- 3. Архивируем старые папки (не удаляем) ---

# Memory Bank → archive
cp -r "Ai Memory/Memory Bank/."   "Ai Memory/archive/Memory Bank/"

# Master Modes → archive
cp -r "Ai Memory/Master Modes/."  "Ai Memory/archive/Master Modes/"

# Старый AI_MEMORY_MASTER.md из корня → archive
if [ -f "Ai Memory/AI_MEMORY_MASTER.md" ]; then
  cp "Ai Memory/AI_MEMORY_MASTER.md" "Ai Memory/archive/AI_MEMORY_MASTER_old.md"
fi

# Старый AI_MEMORY_ARCHITECTURE.md из корня (если был отдельно)
if [ -f "Ai Memory/AI_MEMORY_ARCHITECTURE.md" ] && [ -f "Ai Memory/Memory Bank/AI_MEMORY_ARCHITECTURE.md" ]; then
  echo "  (AI_MEMORY_ARCHITECTURE.md уже обновлён из Memory Bank)"
fi

echo "✓ Старые папки заархивированы в Ai Memory/archive/"

# --- 4. Удаляем старые папки (они уже в archive) ---

rm -rf "Ai Memory/Memory Bank"
rm -rf "Ai Memory/Master Modes"

# Удаляем старый дублирующий AI_MEMORY_MASTER.md если он был
# (мы уже скопировали его в archive выше)
if [ -f "Ai Memory/AI_MEMORY_MASTER.md" ]; then
  rm "Ai Memory/AI_MEMORY_MASTER.md"
fi

echo "✓ Старые папки убраны"

# --- 5. Создаём notebook-memory/README.md ---

cat > "Ai Memory/notebook-memory/README.md" << 'EOF'
# Notebook Memory — живая память блокнота

Эта папка — контур связи между приложением «Разберёмся» и AI-партнёрами проекта.

## Идея

Евгений пишет заметки прямо в «Разберёмся» — идеи, баги, правки, мысли о проекте.
AI (Claude или Codex) читает эту папку и составляет план работ.

Не нужно объяснять AI что делать — достаточно написать заметку в приложении.

## Файлы

- `PROJECT_NOTES.md` — заметки из приложения, которые помечены как проектные
- `TASK_QUEUE.md` — план правок, собранный AI из заметок

## Статус

Контур спроектирован (Этап 1 в AI_MEMORY_ARCHITECTURE.md).
Реализация: нужно создать таблицы в Supabase и подключить Edge Function.

## Как будет работать (после реализации)

1. Пишешь заметку в «Разберёмся»: "хочу починить свайп на айфоне"
2. Нажимаешь ✦ AI → AI видит что это проектная задача
3. Появляется: "Добавить в TODO проекта? [Добавить] [Не надо]"
4. Нажимаешь "Добавить" → заметка летит в project_memory (Supabase)
5. Claude или Codex читают project_memory и знают что делать дальше
EOF

echo "✓ notebook-memory/README.md создан"

# --- 6. Создаём notebook-memory/PROJECT_NOTES.md ---

cat > "Ai Memory/notebook-memory/PROJECT_NOTES.md" << 'EOF'
# Project Notes — заметки из приложения

Последнее обновление: автоматически через Supabase project_memory

> Этот файл будет заполняться автоматически после реализации Этапа 1.
> Пока — ручной лог проектных идей.

## Формат записи

```
[дата] [тип: bug|idea|decision|todo|ux]
Заметка: <текст как написал в приложении>
AI-суть: <что AI понял>
Статус: открыто / в работе / сделано
```

## Записи

<!-- Сюда будут добавляться заметки из приложения -->
EOF

echo "✓ notebook-memory/PROJECT_NOTES.md создан"

# --- 7. Создаём notebook-memory/TASK_QUEUE.md ---

cat > "Ai Memory/notebook-memory/TASK_QUEUE.md" << 'EOF'
# Task Queue — план правок

Последнее обновление: 2026-05-19

> Этот файл собирается AI из PROJECT_NOTES.md и актуального TODO.md.
> После реализации Этапа 1 будет обновляться автоматически.

## Ближайшие задачи (из TODO.md)

### 🔴 Критично — сделать первым
- [ ] Исправить баг `autoLabel` (out of scope) в редакторе заметки
- [ ] Проверить вход по почте и коду на iPhone Safari и через PWA-ярлык

### 🟡 Этап 1 — проектный кластер
- [ ] Создать таблицы в Supabase: `profiles`, `ai_memory`, `note_analysis`, `project_memory`
- [ ] INSERT admin-флага для своего user_id
- [ ] Добавить `action: 'save_to_project'` в Edge Function
- [ ] Показывать кнопку "Запомнить для проекта" только для admin

### 🟢 Следующие этапы
- [ ] Этап 2: микроблок после AI-анализа
- [ ] Этап 3: AI-сводка для документов
- [ ] Этап 4: ai_memory в Supabase (сейчас только локально)
- [ ] Этап 5: восстановление доступа

### 📋 UX
- [ ] Тревожные сценарии — убрать заглушки, сделать реальные
- [ ] Проверить длинные заметки в превью
- [ ] Голосовой ввод на телефоне
EOF

echo "✓ notebook-memory/TASK_QUEUE.md создан"

# --- 8. Создаём archive/README.md ---

cat > "Ai Memory/archive/README.md" << 'EOF'
# Archive

Здесь хранятся старые версии папок Memory Bank и Master Modes.
Не удалять — источник истории решений.

Актуальные файлы находятся в корне `Ai Memory/`.
EOF

echo "✓ archive/README.md создан"

# --- 9. Git commit ---

echo ""
echo "📦 Добавляем в git..."
git add "Ai Memory/"
git commit -m "refactor: реорганизация Ai Memory — плоская структура + notebook-memory"

echo ""
echo "🚀 Пушим на GitHub..."
git push

echo ""
echo "✅ Готово! Новая структура:"
echo ""
echo "Ai Memory/"
echo "├── CLAUDE_MASTER.md"
echo "├── CODEX_MASTER.md"
echo "├── CLAUDE_PROJECT_MASTER.md"
echo "├── AI_MEMORY_ARCHITECTURE.md"
echo "├── PROJECT_PROMOTION_STRATEGY.md"
echo "├── notebook-memory/"
echo "│   ├── README.md"
echo "│   ├── PROJECT_NOTES.md"
echo "│   └── TASK_QUEUE.md"
echo "└── archive/"
echo "    ├── README.md"
echo "    ├── Memory Bank/   (старая)"
echo "    └── Master Modes/  (старая)"
