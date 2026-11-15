// js/tg-auth.js — вход через телеграм (Mini App).
//
// Зачем: человек открывает «Разберёмся» прямо в телеграме (кнопка меню бота)
// и уже внутри — без почты и кода. Подпись телеграма проверяет сервер
// (Edge Function, действие tg_auth): токен бота в клиент не попадает.
//
// В обычном браузере (не телеграм) здесь ничего не происходит — экран входа
// с почтой остаётся как был. Это важнее всего: не сломать нынешний вход.
//
// Тихо. Если что-то не так — молча возвращаем false, человек войдёт почтой.

(function () {
  'use strict';

  // Адрес держим СВОЙ, строкой, и не берём его из app.js. Причина: этот файл
  // грузится раньше, а адрес там объявлен через const — в «мёртвой зоне» const
  // обращение к нему бросает ReferenceError (проверено на node). Свой адрес
  // снимает ловушку порядка файлов целиком, а не прячет её.
  const АДРЕС = 'https://izvwgyudjbxlixzrgpuv.supabase.co/functions/v1/ai';
  function адресСервера() { return АДРЕС; }

  /** Мы внутри телеграма? Берём сырой initData — только он годится для проверки. */
  function initData() {
    try {
      var tg = window.Telegram && window.Telegram.WebApp;
      if (!tg) return '';
      // initDataUnsafe НЕ годится: его телеграм не подписывает для проверки.
      return typeof tg.initData === 'string' ? tg.initData : '';
    } catch (e) {
      return '';
    }
  }

  function внутриТелеграма() {
    return !!initData();
  }

  /**
   * Меняет подпись телеграма на сессию Supabase.
   * Возвращает true, если человек вошёл. Ничего не бросает наружу.
   */
  async function войтиЧерезТелеграм() {
    var data = initData();
    if (!data || typeof sb === 'undefined' || !sb) return false;

    var ответ;
    try {
      ответ = await fetch(адресСервера(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'tg_auth', payload: { initData: data } })
      });
    } catch (e) {
      console.warn('tg_auth: сервер недоступен', e);
      return false;
    }

    var итог;
    try {
      итог = await ответ.json();
    } catch (e) {
      return false;
    }
    if (!ответ.ok || !итог || !итог.session || !итог.session.access_token) {
      if (итог && итог.reason) console.warn('tg_auth отклонён:', итог.reason);
      return false;
    }

    try {
      var поставлено = await sb.auth.setSession({
        access_token: итог.session.access_token,
        refresh_token: итог.session.refresh_token
      });
      if (поставлено && поставлено.error) {
        console.warn('tg_auth: сессия не встала', поставлено.error.message);
        return false;
      }
      return true;
    } catch (e) {
      console.warn('tg_auth: сессия не встала', e);
      return false;
    }
  }

  // Витрина для app.js: он решает, звать ли вход через телеграм.
  window.rzTgAuth = {
    внутриТелеграма: внутриТелеграма,
    войти: войтиЧерезТелеграм
  };
})();
