#!/usr/bin/env bash
# deploy.sh — быстрый деплой фронта
# Использование: ./deploy.sh "описание правки"
# Делает: проверить ветку → синтаксис → щит → bump sw cache → SNAPSHOT → commit → push
# Порядок важен: версия поднимается ТОЛЬКО после зелёного щита. Раньше было наоборот,
# и упавший щит оставлял sw.js с поднятым номером без коммита (аудит штаба 18.09).

set -e

MSG="${1:-"update frontend"}"
SW="sw.js"
SNAPSHOT="texts/SNAPSHOT.md"

# 0. Прод едет только с main. Push идёт в main, а кодер часто сидит на v2-experiment:
# без этой проверки «деплой одной командой» выкатил бы экспериментальную ветку (аудит 18.09).
BRANCH=$(git branch --show-current)
if [ "$BRANCH" != "main" ]; then
  echo "❌ Деплой только с main, сейчас: ${BRANCH:-<detached>}."
  echo "   Нужное из ветки перенеси в main осознанно (merge/cherry-pick), потом деплой."
  exit 1
fi
if [ -f .git/MERGE_HEAD ]; then
  echo "❌ Слияние не закончено (.git/MERGE_HEAD) — сначала доведи его, потом деплой."; exit 1
fi

# 2. Проверить синтаксис JS перед деплоем
NODE_BIN=$(which node 2>/dev/null || echo "/opt/homebrew/bin/node")
if [ -x "$NODE_BIN" ]; then
  echo "Проверяю синтаксис js/app.js..."
  "$NODE_BIN" --check js/app.js || { echo "❌ Синтаксическая ошибка в js/app.js! Деплой отменён."; exit 1; }
  echo "✓ Синтаксис OK"
else
  echo "⚠️  Node.js не найден — пропускаю проверку синтаксиса"
fi

# 2.5. ЩИТ — золотые проверки перед коммитом (щит без вызова — не щит).
# Падаем ДО git add/commit: сломанный путь не уедет в прод.
if [ -x "$NODE_BIN" ]; then
  echo "Гоню золотой щит (golden-paths + smoke-agent-router)..."
  "$NODE_BIN" scripts/golden-paths.mjs || { echo "❌ Золотой щит упал — деплой отменён (см. вывод выше)."; exit 1; }
  "$NODE_BIN" scripts/smoke-agent-router.mjs || { echo "❌ Smoke голосового агента упал — деплой отменён."; exit 1; }
  echo "✓ Щит цел"
else
  echo "❌ Node.js не найден — щит не прогнать, деплой отменён (не пропускаю молча)."; exit 1
fi

# 2.9. Поднять CACHE в sw.js — только теперь, когда щит зелёный.
CURRENT=$(grep -o "rz-v[0-9]*" "$SW" | head -1)
NUM=$(echo "$CURRENT" | grep -o "[0-9]*$")
NEXT="rz-v$((NUM + 1))"
sed -i '' "s/${CURRENT}/${NEXT}/" "$SW"
echo "✓ CACHE: $CURRENT → $NEXT"

# 3. Обновить строку "Последний деплой" в SNAPSHOT.md
# Ограничено первыми 15 строками (шапка файла) — иначе sed цепляет любое упоминание
# этой фразы в историческом тексте ниже (уже наступали на эти грабли).
if [ -f "$SNAPSHOT" ]; then
  # Только первая строка сообщения: многострочное описание рвало sed («unescaped
  # newline inside substitute pattern») и деплой падал уже после подъёма версии.
  MSG_ONE=$(printf '%s' "$MSG" | head -1)
  DEPLOY_LINE="- **Последний деплой:** $(date '+%Y-%m-%d %H:%M') · $NEXT · $MSG_ONE"
  sed -i '' "1,15 s/- \*\*Последний деплой:\*\*.*/$(echo "$DEPLOY_LINE" | sed 's/[\/&]/\\&/g')/" "$SNAPSHOT"
  # Строка SW cache в шапке тоже отставала (показывала v411 при живом v412)
  sed -i '' "1,15 s/- \*\*SW cache:\*\* \`rz-v[0-9]*\`/- **SW cache:** \`$NEXT\`/" "$SNAPSHOT"
  echo "✓ SNAPSHOT обновлён"
fi

# 3.5. Та же версия в NEXT.md — иначе раздел «Текущий runtime» отстаёт и врёт
# соседям и следующему заходу (в аудите отставал на две ступени).
NEXTMD="texts/NEXT.md"
if [ -f "$NEXTMD" ]; then
  sed -i '' "s/- \*\*SW cache:\*\* \`rz-v[0-9]*\`/- **SW cache:** \`$NEXT\`/" "$NEXTMD"
  git add "$NEXTMD"
fi

# 4. Добавить изменённые фронтовые файлы
git add "$SW"
if [ -f "$SNAPSHOT" ]; then
  git add "$SNAPSHOT"
fi
# Щит и smoke — тоже часть деплоя: их правки уезжали мимо коммита, потому что
# в этом списке не было scripts/ (нашёл заходом 27.09).
for F in index.html js/app.js manifest.json cloud.html scripts/golden-paths.mjs scripts/smoke-agent-router.mjs; do
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
