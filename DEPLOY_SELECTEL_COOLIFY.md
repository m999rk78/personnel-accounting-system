# Selectel + Coolify

Целевой production-контур не зависит от Yandex Cloud:

```text
GitHub → Coolify (Mark's Team) → отдельный сервер Selectel
                                    ↓ приватная сеть
                             Managed PostgreSQL 18
```

Все ресурсы создаются в отдельном проекте Selectel **Personnel Accounting**.
Ресурсы проекта миграции `welding-journal` использовать или изменять нельзя.

## Рекомендуемая конфигурация

- отдельная приватная сеть и подсеть для приложения и базы;
- сервер приложения: Ubuntu LTS, 2 vCPU, 4 ГБ RAM, SSD 40 ГБ;
- Managed PostgreSQL 18: одна нода, база `personnel`, пользователь `personnel`;
- полная резервная копия раз в неделю и ежедневные инкрементальные копии,
  хранение 7 дней;
- прямой публичный IP только у сервера приложения;
- PostgreSQL доступен только из приватной подсети;
- Coolify подключается к серверу отдельным SSH-ключом проекта;
- приложение разворачивается из `Dockerfile`, без локального PostgreSQL из
  `docker-compose.yml` и без постоянного тома приложения.

## Переменные Coolify

Значения пароля, сертификата, webhook и почтового ключа хранятся как secrets.

```dotenv
NODE_ENV=production
HOST=0.0.0.0
PORT=8080
PGHOST=<приватный FQDN Selectel PostgreSQL>
PGPORT=<порт из строки подключения Selectel>
PGUSER=personnel
PGPASSWORD=<secret>
PGDATABASE=personnel
DATABASE_SSL=verify-full
DATABASE_CA_CERT=<корневой сертификат Selectel с \n вместо переносов строк>
DATABASE_POOL_SIZE=5
APP_ORIGIN=https://uchet-personala.ru
PUBLIC_APP_ORIGIN=https://uchet-personala.ru
BITRIX24_SYNC_ENABLED=false
```

Проверка состояния контейнера: `GET /api/health`. Она возвращает `200`, только
когда приложение может выполнить запрос к PostgreSQL. При запуске контейнер под
advisory lock применяет миграции из `drizzle-postgres`, затем запускает сервер.

## Порядок запуска

1. Создать новые сеть, сервер и PostgreSQL 18 в проекте `Personnel Accounting`.
2. В Coolify выбрать только `Mark's Team` и добавить новый сервер отдельным
   SSH-ключом.
3. Создать новое приложение из репозитория и выбрать сборку из `Dockerfile`.
4. Добавить переменные, но оставить синхронизацию Bitrix24 выключенной.
5. Первый деплой выполнить на временном домене Coolify.
6. Проверить `/api/health`, вход, справочники, отчёты и табели.
7. Переключить `uchet-personala.ru` только после проверки временного адреса.
8. Включать Bitrix24 и загружать рабочие данные отдельным решением после запуска.

Локальный `docker-compose.yml` нужен только для разработки и проверки. Он
использует отдельный PostgreSQL 18 и не участвует в production-развёртывании.

## Созданный контур

- сервер `personnel-accounting-app`: прямой публичный IP `161.104.62.72`,
  приватный IP `192.168.0.2`;
- Managed PostgreSQL `personnel-accounting-db`: приватный IP `192.168.0.85`;
- сервер и PostgreSQL находятся в приватной сети
  `personnel-accounting-db-network`;
- Coolify использует сервер `personnel-accounting-app` в `Mark's Team`;
- прежний плавающий IP `176.53.230.111` можно удалить только после успешного
  тестового развёртывания через прямой IP.
