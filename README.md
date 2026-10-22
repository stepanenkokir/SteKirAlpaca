# StockAnaliz

Telegram-бот для paper-торговли через [Alpaca](https://alpaca.markets/). Счёт тестовый: ордера не трогают реальные деньги. Live-URL в клиент не заложен.

Бот ходит в Trading API сам. [Alpaca MCP](https://github.com/alpacahq/alpaca-mcp-server) нужен агенту в Cursor и в работу бота не входит.

Текущая версия: **0.3.1**. Проверка в Telegram: `/version`.

## Возможности

| Команда | Что делает |
| --- | --- |
| `/start` | Справка и номер версии |
| `/account` | Equity, cash, buying power, статус счёта |
| `/positions` | Открытые позиции и нереализованный PnL |
| `/quote AAPL` | Последняя котировка IEX (bid/ask) |
| `/buy AAPL 1` | Рыночная покупка, только после «Подтвердить» |
| `/sell AAPL 1` | Рыночная продажа, только после «Подтвердить» |
| `/scan` | Проверить пробои диапазона открытия сейчас |
| `/plan` | Идеи и позиции текущего дня |
| `/journal` | Сводка журнала за 7 дней |
| `/version` | Версия запущенного бота |

Правила ручных ордеров:

- формат: `/buy TICKER QTY` или `/sell TICKER QTY`
- тикер — латинские буквы и точка, до 10 символов (`AAPL`, `BRK.B`)
- количество — целое число больше нуля
- тип ордера: `market`, срок: `day`, площадка: paper
- пока ордер не подтверждён, он лежит в памяти процесса
- «Отмена» или новый `/buy`/`/sell` сбрасывает ожидание
- чужие Telegram-аккаунты бот игнорирует

## Дневной стол (ORB)

С 09:46 до 11:00 ET бот каждую минуту смотрит список акций на пробой первых 15 минут сессии.

Вход, все условия сразу:

- закрытие минутной свечи выше high диапазона 09:30–09:45
- цена выше VWAP сессии
- относительный объём открытия ≥ `RVOL_MIN` (по умолчанию 1.1)
- ширина диапазона 0.15–`MAX_RANGE_PCT` (по умолчанию 2.5%), уход от high не больше половины ширины
- не больше трёх идей в день и одна на тикер

По завершении окна сканирования (`11:00 ET`) бот записывает причины отсева в `data/journal.jsonl`, а если за сессию не было ни одного сигнала — отправляет в Telegram сводку по фильтрам.

Размер: риск `RISK_FRACTION` от equity (0.5%), нотионал не больше `MAX_POSITION_FRACTION` (25%) и не больше `buying_power`. Стоп — под low диапазона, но не дальше 1.2% от входа. Цель — 2R.

OpenAI только объясняет уже посчитанные цифры и заголовки новостей. Если API молчит, карточка всё равно уходит.

По кнопке «Купить» сначала пишется статус в `data/session.json`, затем на paper уходит лимитный bracket (вход по ask + буфер, стоп и цель на бирже). Если за 2 минуты не исполнился — ордер снимается.

Сопровождение:

- уведомления о частичном fill, входе, стопе и цели
- после 1R стоп переносится в безубыток
- сигнал «Продать», если цена закрылась внутри диапазона, потеряла VWAP или до закрытия сессии 15 минут (время берётся из `next_close`)
- выход: отмена ног bracket, затем закрытие позиции

`AUTO_FLATTEN=true` (по умолчанию) за 5 минут до закрытия сам закрывает позиции плана. Это единственное действие без кнопки: дневной стоп к закрытию сессии снимется, и бумага иначе ушла бы на ночь без защиты.

Объём и VWAP считаются по ленте IEX — это не вся биржа. Карточка и этот README говорят об этом прямо.

Перед живым прогоном:

```powershell
npm test
npm run backtest
```

Бэктест гоняет те же правила по минутным барам IEX за ~90 сессий и печатает частоту сигналов, средний R и вклад фильтров. Это проверка здравого смысла, не доказательство прибыльности.

## Архитектура

```text
Telegram  -->  Node-бот (Telegraf)  -->  Alpaca Paper Trading API
           \                       \->  OpenAI (пояснение карточек)
            \-> планировщик 30с
Cursor    -->  Alpaca MCP (uvx)     -->  тот же paper-счёт
```

| Файл | Роль |
| --- | --- |
| `src/index.js` | Старт, конфиг, graceful shutdown |
| `src/config.js` | Проверка переменных окружения |
| `src/alpaca.js` | HTTP-клиент paper API |
| `src/market.js` | Правила ORB, VWAP, размер, фазы сессии |
| `src/desk.js` | Скан, вход, сопровождение, журнал |
| `src/exits.js` | Отмена bracket-группы и закрытие позиции |
| `src/openai.js` | Пояснение сигнала и выхода |
| `src/store.js` | `data/session.json` и `data/journal.jsonl` |
| `src/scheduler.js` | Тик каждые 30 секунд |
| `src/bot.js` | Команды Telegram |
| `src/version.js` | Версия из `package.json` |
| `scripts/backtest.js` | Историческая проверка правил |

Зависимость одна: `telegraf`. Запросы к Alpaca и OpenAI идут через встроенный `fetch`.

Базовые URL:

- торговля: `https://paper-api.alpaca.markets`
- котировки: `https://data.alpaca.markets` (лента `iex`)

## Требования

- Windows 11, Node.js 22+
- Paper-ключи Alpaca: [app.alpaca.markets](https://app.alpaca.markets)
- Ключ OpenAI
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
OPENAI_API_KEY=...
```

`TELEGRAM_ALLOWED_USER_ID` — целое положительное число, не username.

Необязательные переменные: `OPENAI_MODEL`, `WATCHLIST`, `RISK_FRACTION`, `MAX_POSITION_FRACTION`, `RVOL_MIN`, `MAX_RANGE_PCT`, `ENTRY_BUFFER_PCT`, `AUTO_FLATTEN`.

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

В консоли должно появиться `Bot started v0.3.1`. Номер совпадает с `package.json` и с `/version`.

Остановка: `Ctrl+C`. После смены кода бота нужен повторный `npm start`.

Каталог `data/` создаётся при работе и в git не входит.

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
- **0.3.0** — дневной стол ORB, OpenAI, журнал и бэктест
- **0.3.1** — отчёт об окне сканирования в 11:00 ET, запись фильтров в журнал, калибровка RVOL/ширины диапазона под IEX

Невыпущенные идеи держать в секции `Unreleased` журнала, в `package.json` их не писать, пока код не влит.

## Безопасность

- `.env` в `.gitignore`, секреты только локально
- бот отвечает только одному Telegram id
- ручной ордер уходит в Alpaca только после кнопки «Подтвердить»
- идея дня уходит в bracket только после кнопки «Купить»
- paper-ключ и live-ключ — разные; live сюда не подключать
- MCP исполняет торговые вызовы из Cursor: paper-режим держать включённым (`ALPACA_PAPER_TRADE=true`)
