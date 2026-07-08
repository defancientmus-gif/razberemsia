#!/usr/bin/env bash
# deploy.sh — быстрый деплой фронта
# Использование: ./deploy.sh "описание правки"
# Делает: bump sw cache → обновить SNAPSHOT → git add → commit → push

set -e

MSG="${1:-"update frontend"}"
SW="sw.js"
SNAPSHOT="texts/SNAPSHOT.md"

# 1. Поднять CACHE в sw.js
CURRENT=$(grep -o "rz-v[0-9]*" "$SW" | head -1)
NUM=$(echo "$CURRENT" | grep -o "[0-9]*$")
NEXT="rz-v$((NUM + 1))"
sed -i '' "s/${CURRENT}/${NEXT}/" "$SW"
echo "✓ CACHE: $CURRENT → $NEXT"

# 2. Проверить синтаксис JS перед деплоем
NODE_BIN=$(which node 2>/dev/null || echo "/opt/homebrew/bin/node")
if [ -x "$NODE_BIN" ]; then
  echo "Проверяю синтаксис js/app.js..."
  "$NODE_BIN" --check js/app.js || { echo "❌ Синтаксическая ошибка в js/app.js! Деплой отменён."; exit 1; }
  echo "✓ Синтаксис OK"
else
  echo "⚠️  Node.js не найден — пропускаю проверку синтаксиса"
fi

# 3. Обновить строку "Последний деплой" в SNAPSHOT.md
# Ограничено первыми 15 строками (шапка файла) — иначе sed цепляет любое упоминание
# этой фразы в историческом тексте ниже (уже наступали на эти грабли).
if [ -f "$SNAPSHOT" ]; then
  DEPLOY_LINE="- **Последний деплой:** $(date '+%Y-%m-%d %H:%M') · $NEXT · $MSG"
  sed -i '' "1,15 s/- \*\*Последний деплой:\*\*.*/$(echo "$DEPLOY_LINE" | sed 's/[\/&]/\\&/g')/" "$SNAPSHOT"
  echo "✓ SNAPSHOT обновлён"
fi

# 4. Добавить изменённые фронтовые файлы
git add "$SW"
if [ -f "$SNAPSHOT" ]; then
  git add "$SNAPSHOT"
fi
for F in index.html js/app.js manifest.json; do
  if git diff --name-only -- "$F" 2>/dev/null | grep -q .; then
    git add "$F"
  fi
done

echo "✓ Staged:"
git diff --cached --name-only

# 5. Commit
git commit -m "$MSG"

# 6. Push
git push origin HEAD:main
echo ""
echo "✓ Задеплоено: $NEXT — $MSG"
echo "  https://defancientmus-gif.github.io/razberemsia/"
