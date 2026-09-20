# Развёртывание в Yandex Cloud

Production-схема проекта:

```text
GitHub → Docker → Container Registry → Serverless Containers
                                      ↘ Managed PostgreSQL
                                      ↘ Lockbox
```

## 1. Подготовка облака

1. Создайте облако, каталог, сеть и подсети в Yandex Cloud.
2. Установите Yandex Cloud CLI и выполните `yc init`.
3. Создайте сервисный аккаунт для приложения.
4. Выдайте ему права на скачивание Docker-образа и чтение нужных секретов
   Lockbox. При подключении контейнера к пользовательской сети также настройте
   необходимые сетевые права и группы безопасности.

## 2. Managed PostgreSQL

В консоли создайте кластер PostgreSQL, пользователя `personnel` и базу
`personnel`. Для production включите защиту от удаления и резервное копирование.

Рекомендуемый вариант — закрытый кластер без публичного IP в той же облачной
сети, к которой будет подключён Serverless Container. В этом случае задайте:

```text
DATABASE_URL=postgresql://personnel:<PASSWORD>@<MASTER_FQDN>:6432/personnel
DATABASE_SSL=disable
DATABASE_POOL_SIZE=5
```

Если база имеет публичный адрес, используйте TLS:

```text
DATABASE_SSL=verify-full
DATABASE_CA_CERT=<содержимое Yandex Cloud CA.pem>
```

Не записывайте строку подключения и сертификат в Git. Создайте секрет в
Yandex Lockbox и передайте его ключи контейнеру как переменные окружения.

Перед первым запуском примените миграции с компьютера, имеющего сетевой доступ
к базе:

```bash
DATABASE_URL='postgresql://...' DATABASE_SSL=disable npm run db:migrate
```

Для публичного PostgreSQL добавьте `DATABASE_CA_CERT` в окружение команды.

### Перенос текущих локальных данных

После миграций и до первого запуска приложения можно один раз перенести
текущую локальную базу D1/SQLite:

```bash
DATABASE_URL='postgresql://...' DATABASE_SSL=disable npm run db:import-sqlite
```

Команда сама найдёт единственную базу приложения внутри `.wrangler`. Можно
передать путь явно:

```bash
DATABASE_URL='postgresql://...' DATABASE_SSL=disable \
  npm run db:import-sqlite -- /полный/путь/к/database.sqlite
```

По умолчанию импорт разрешён только в полностью пустые таблицы PostgreSQL и
останавливается до записи данных, если база уже использовалась. Это защищает
production-данные от случайного дублирования или перезаписи.

## 3. Container Registry

Создайте реестр и настройте Docker:

```bash
yc container registry create --name personnel-registry
yc container registry configure-docker
```

Сохраните ID реестра из ответа и соберите Linux AMD64-образ:

```bash
docker build --platform linux/amd64 \
  -t cr.yandex/<REGISTRY_ID>/personnel-accounting:<VERSION> .
```

В качестве `<VERSION>` удобно использовать короткий Git-хэш:

```bash
git rev-parse --short HEAD
```

Загрузите образ:

```bash
docker push cr.yandex/<REGISTRY_ID>/personnel-accounting:<VERSION>
```

Не переиспользуйте один и тот же тег для разных production-версий.

## 4. Serverless Container

Создайте контейнер:

```bash
yc serverless container create --name personnel-accounting
```

В консоли откройте контейнер и создайте ревизию со следующими настройками:

- образ `cr.yandex/<REGISTRY_ID>/personnel-accounting:<VERSION>`;
- 1 vCPU и 1 ГБ памяти для первого запуска;
- режим HTTP-сервера;
- тайм-аут не менее 30 секунд;
- сервисный аккаунт приложения;
- облачная сеть Managed PostgreSQL;
- переменные `NODE_ENV=production`, `DATABASE_POOL_SIZE=5`, `PGHOST`,
  `PGPORT=6432`, `PGUSER`, `PGDATABASE=personnel`, `DATABASE_SSL=disable`,
  `APP_ORIGIN=https://<CONTAINER_ID>.containers.yandexcloud.net` (после подключения
  домена перечислите технический и пользовательский адреса через запятую);
- `PGPASSWORD` из Lockbox (ключ `postgresql_password`).

Приложение автоматически слушает порт, переданный платформой в переменной
`PORT`.

Разрешите публичный вызов контейнера:

```bash
yc serverless container allow-unauthenticated-invoke personnel-accounting
```

После этого в карточке контейнера появится технический HTTPS-адрес. Откройте
`/login` и создайте первого администратора.

## 5. Почта

Для отправки приглашений через Yandex Cloud Postbox:

1. Создайте в Cloud Postbox адрес для домена и подтвердите DKIM-записи в Cloud DNS.
2. Выдайте сервисному аккаунту контейнера роль `postbox.sender` в том же каталоге.
3. Передайте контейнеру переменные `MAIL_PROVIDER=yandex-postbox`,
   `MAIL_FROM=no-reply@uchet-personala.ru` и
   `PUBLIC_APP_ORIGIN=https://uchet-personala.ru`.

Приложение получает короткоживущий IAM-токен из metadata service Serverless
Containers, поэтому постоянный почтовый ключ в Lockbox не требуется. Без
почтовой конфигурации ссылка приглашения по-прежнему показывается
администратору. Для Resend используйте `MAIL_PROVIDER=resend`, `MAIL_FROM` и
`RESEND_API_KEY`.

## 6. Собственный домен

Сначала проверьте приложение на техническом домене контейнера. Затем создайте
API Gateway, направьте все маршруты в Serverless Container, выпустите
сертификат в Certificate Manager и подключите домен к API Gateway.

## 7. Обновления

Для каждой версии:

1. Запустите `npm test`.
2. При изменении схемы выполните `npm run db:generate` и закоммитьте миграцию.
3. Примените миграции к production-базе.
4. Соберите образ с новым уникальным тегом и загрузите его в Registry.
5. Создайте новую ревизию Serverless Container с этим образом.
6. Проверьте вход, чтение данных, создание и редактирование записей.

Старую ревизию можно оставить доступной для быстрого отката.
