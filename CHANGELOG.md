# Changelog

Все заметные изменения этого проекта фиксируются здесь.

Формат основан на [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/).
Версии следуют [Semantic Versioning](https://semver.org/lang/ru/).

Источник версии — поле `version` в `package.json`. Команда `/version` и лог запуска читают его напрямую.

## [0.2.0] - 2026-10-19

### Added

- Журнал версий `CHANGELOG.md` и SemVer в `package.json`
- `src/version.js` — единая версия для бота и консоли
- Команда `/version` в Telegram
- Подробный `README.md`

## [0.1.0] - 2026-10-19

### Added

- Telegram-бот на Telegraf для paper-счёта Alpaca
- Команды `/start`, `/account`, `/positions`, `/quote`, `/buy`, `/sell`
- Рыночные day-ордера только после кнопки «Подтвердить»
- Доступ только для `TELEGRAM_ALLOWED_USER_ID`
- Тонкий HTTP-клиент Alpaca без SDK, URL paper зашит в код
