# StockAnaliz

Telegram-бот для paper-торговли через [Alpaca](https://alpaca.markets/). Счёт тестовый: ордера не трогают реальные деньги. Live-URL в клиент не заложен.

Бот ходит в Trading API сам. [Alpaca MCP](https://github.com/alpacahq/alpaca-mcp-server) нужен агенту в Cursor и в работу бота не входит.

Текущая версия: **0.2.0**. Проверка в Telegram: `/version`.

## Возможности

| Команда | Что делает |
| --- | --- |
| `/start` | Справка и номер версии |
| `/account` | Equity, cash, buying power, статус счёта |
| `/positions` | Открытые позиции и нереализованный PnL |
| `/quote AAPL` | Последняя котировка IEX (bid/ask) |
| `/buy AAPL 1` | Рыночная покупка, только после «Подтвердить» |
| `/sell AAPL 1` | Рыночная продажа, только после «Подтвердить» |
| `/version` | Версия запущенного бота |

Правила ордеров:

- формат: `/buy TICKER QTY` или `/sell TICKER QTY`
- тикер — латинские буквы и точка, до 10 символов (`AAPL`, `BRK.B`)
- количество — целое число больше нуля
- тип ордера: `market`, срок: `day`, площадка: paper
- пока ордер не подтверждён, он лежит в памяти процесса
- «Отмена» или новый `/buy`/`/sell` сбрасывает ожидание
- чужие Telegram-аккаунты бот игнорирует

## Архитектура

```text
Telegram  -->  Node-бот (Telegraf)  -->  Alpaca Paper Trading API
Cursor    -->  Alpaca MCP (uvx)     -->  тот же paper-счёт
```

| Файл | Роль |
| --- | --- |
| `src/index.js` | Старт, конфиг, graceful shutdown |
| `src/config.js` | Проверка переменных окружения |
| `src/alpaca.js` | HTTP-клиент paper API |
| `src/bot.js` | Команды Telegram |
| `src/version.js` | Версия из `package.json` |

Зависимость одна: `telegraf`. Запросы к Alpaca идут через встроенный `fetch`.

Базовые URL:

- торговля: `https://paper-api.alpaca.markets`
- котировки: `https://data.alpaca.markets` (лента `iex`)

## Требования

- Windows 11, Node.js 22+
- Paper-ключи Alpaca: [app.alpaca.markets](https://app.alpaca.markets)
- Telegram-бот от [@BotFather](https://t.me/BotFather)
- Свой числовой Telegram id (например, через [@userinfobot](https://t.me/userinfobot))

Для MCP в Cursor дополнительно:

- Python 3.10+
- `uv` / `uvx` (ставится в `%USERPROFILE%\.local\bin`)

## Установка

```powershell
cd C:\Projects\StockAnaliz
npm install
copy .env.example .env
```

Открой `.env` и заполни значения локально. В чат и в git ключи не класть.

```env
ALPACA_API_KEY=...
ALPACA_SECRET_KEY=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_USER_ID=123456789
```

`TELEGRAM_ALLOWED_USER_ID` — целое положительное число, не username.

### Alpaca MCP в Cursor

Файл `%USERPROFILE%\.cursor\mcp.json`. Серверы `Playwright` и `comfy-mcp` не трогать, блок `alpaca` добавить рядом:

```json
"alpaca": {
  "command": "C:\\Users\\<user>\\.local\\bin\\uvx.exe",
  "args": ["alpaca-mcp-server"],
  "env": {
    "ALPACA_API_KEY": "your_alpaca_api_key",
    "ALPACA_SECRET_KEY": "your_alpaca_secret_key",
    "ALPACA_PAPER_TRADE": "true"
  }
}
```

Те же paper-ключи, что в `.env`. После правки перезапусти MCP в Cursor. Проверка: спросить агента баланс paper-счёта.

## Запуск

```powershell
npm start
```

В консоли должно появиться `Bot started v0.2.0`. Номер совпадает с `package.json` и с `/version`.

Остановка: `Ctrl+C`. После смены кода бота нужен повторный `npm start`.

## Версии

Схема: **MAJOR.MINOR.PATCH** ([SemVer](https://semver.org/lang/ru/)).

| Часть | Когда поднимать |
| --- | --- |
| MINOR | Новая команда или заметное поведение (`0.2.0` → `0.3.0`) |
| PATCH | Исправление без новой функции (`0.2.0` → `0.2.1`) |
| MAJOR | Ломающее изменение (`1.0.0`) |

Единственный источник версии — `package.json`. `src/version.js` читает его при старте, поэтому отдельно версию нигде не дублировать.

Каждое обновление:

1. Реализовать функцию или фикс.
2. Поднять `version` в `package.json`.
3. Добавить секцию в [CHANGELOG.md](CHANGELOG.md) с датой и списком `Added` / `Changed` / `Fixed`.
4. Перезапустить бота и проверить `/version`.

История уже вышедших версий:

- **0.1.0** — каркас: счёт, позиции, котировка, рыночные ордера с подтверждением
- **0.2.0** — журнал версий, `/version`, этот README

Невыпущенные идеи держать в секции `Unreleased` журнала, в `package.json` их не писать, пока код не влит.

## Безопасность

- `.env` в `.gitignore`, секреты только локально
- бот отвечает только одному Telegram id
- ордер уходит в Alpaca только после кнопки «Подтвердить»
- paper-ключ и live-ключ — разные; live сюда не подключать
- MCP исполняет торговые вызовы из Cursor: paper-режим держать включённым (`ALPACA_PAPER_TRADE=true`)
