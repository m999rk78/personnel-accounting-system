# Учёт персонала

Веб-приложение для ведения ежедневной расстановки сотрудников по проектам,
управления справочниками и разграничения доступа между офисом и прорабами.

## Стек

- React 19 и vinext
- AG Grid
- Node.js 22
- PostgreSQL 17
- Drizzle Kit для миграций
- Docker

## Локальный запуск с PostgreSQL

1. Скопируйте пример окружения:

   ```bash
   cp .env.example .env.local
   ```

2. Запустите PostgreSQL:

   ```bash
   docker compose up -d postgres
   ```

3. Установите зависимости и примените миграции:

   ```bash
   npm install
   npm run db:migrate
   ```

4. Запустите приложение:

   ```bash
   npm run dev
   ```

Приложение будет доступно на `http://localhost:3000`.

Для проверки production-контейнера выполните:

```bash
docker compose up --build
```

## Переменные окружения

- `DATABASE_URL` — строка подключения PostgreSQL. Вместо неё можно задать
  стандартные `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`.
- `APP_ORIGIN` — публичный адрес приложения для проверки браузерных POST-запросов;
  несколько адресов можно перечислить через запятую или точку с запятой.
- `DATABASE_SSL` — `disable`, `require` или `verify-full`.
- `DATABASE_CA_CERT` — CA-сертификат с `\n` вместо переносов строк; обязателен для `verify-full`.
- `DATABASE_POOL_SIZE` — размер пула, для Serverless Containers рекомендуется `5`.
- `DATABASE_RUNTIME_BOOTSTRAP` — включите `true` только для локального запуска без
  заранее применённых миграций. В production схема изменяется командой миграции,
  поэтому тяжёлая проверка и восстановление таблиц не выполняются при каждом
  холодном старте контейнера.
- `MAIL_PROVIDER` — почтовый адаптер: `yandex-postbox` (рекомендуется в Yandex Cloud) или `resend`.
- `MAIL_FROM` — подтверждённый адрес отправителя, например `no-reply@uchet-personala.ru`.
- `PUBLIC_APP_ORIGIN` — публичный адрес приложения без завершающего `/`; используется в ссылках-приглашениях.
- `RESEND_API_KEY` — нужен только при `MAIL_PROVIDER=resend`.

Секреты нельзя добавлять в Git. Для production храните их в Yandex Lockbox.

## Авторизация

На пустой базе страница `/login` предложит создать первого администратора.
После этого офисный пользователь приглашает остальных через раздел
**Общие настройки → Пользователи системы и права**. Приглашение действует 72
часа. Если почтовый сервис не настроен, ссылка приглашения показывается
администратору в интерфейсе.

## Команды

- `npm run dev` — локальная разработка.
- `npm run build` — production-сборка.
- `npm start` — запуск standalone-сборки.
- `npm run lint` — проверка кода.
- `npm test` — сборка и тесты.
- `npm run db:generate` — создать миграцию после изменения схемы.
- `npm run db:migrate` — применить миграции к `DATABASE_URL`.
- `npm run db:migrate-postgres` — безопасно применить миграции к production PostgreSQL
  после проверки имени базы и пользователя.
- `npm run db:import-sqlite` — один раз перенести текущие локальные данные D1/SQLite в пустой PostgreSQL.

## Развёртывание

Пошаговая инструкция находится в [DEPLOY_YANDEX_CLOUD.md](./DEPLOY_YANDEX_CLOUD.md).
