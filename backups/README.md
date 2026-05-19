# Backups

Локальные zip-снимки проекта.

Снимки:

- `razberemsia_snapshot_2026-05-18_ai-memory.zip`
- `razberemsia_snapshot_2026-05-18_end-of-day.zip`
- `razberemsia_snapshot_2026-05-18_17-31-ai-tags-memory.zip`
- `razberemsia_snapshot_2026-05-18_17-45-docs-promotion.zip`
- `razberemsia_snapshot_2026-05-19_08-19_ai-memory-js-split.zip`
- `razberemsia_docs_before_cleanup_2026-05-19_08-51.zip`

Первый снимок содержит рабочие файлы проекта без `.git`, без старых zip и без самой папки `backups`.

Назначение: быстрый ручной откат/сравнение текущей версии после первого живого AI-анализа и добавления архитектуры AI Memory.

End-of-day снимок содержит прод `index.html` после интеграции `index1-index4`, `sw.js` `rz-v55`, Supabase function, master/context docs, AI Memory и все `incoming/index*.html` черновики.

`17-31-ai-tags-memory` содержит состояние после `rz-v60`, локальной AI-памяти, кликабельных тегов, пикера раздела и актуализации стратегических документов. Из zip исключены `.git`, `.claude`, старые zip и `files.zip`.

`17-45-docs-promotion` — финальный снимок после обновления markdown/промтов и добавления ветки `promotion/funding`. Из zip исключены `.git`, `.claude`, старые zip и `files.zip`.

`2026-05-19_08-19_ai-memory-js-split` — снимок после добавления облачного поля `ai_memory` и выноса основного runtime из `index.html` в `js/app.js`. Из zip исключены `.git`, `.claude`, старые zip и `files.zip`.

`docs_before_cleanup_2026-05-19_08-51` — страховой снимок документов перед объединением мастер-промтов и памяти в `project-memory/`.

Правило: делать новый zip-снимок после важных рабочих этапов, особенно когда появилась или стабилизировалась важная функция. Это не замена git, а быстрый страховой снимок «точно работало вот тут».
