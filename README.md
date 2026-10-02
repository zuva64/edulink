# Развёртывание EduLink в Docker

Комплект содержит приложение, PostgreSQL 17 и Mailpit для тестовой почты. Данные переносятся из SQL-дампа автоматически при первом запуске. Это локальное развёртывание на одном компьютере, с доступом только через 127.0.0.1.

## Состав комплекта

- `app/` — исходные файлы текущей локальной версии, включая Google-вход, привязку аккаунтов и сообщения об ошибках.
- `app/Dockerfile` — сборка приложения на Node.js 22; зависимости устанавливаются по package-lock.json.
- `compose.yaml` — приложение, база и тестовая почта.
- `database/01-edulink.sql` — полный снимок базы, включая пользователей, хеши паролей, Google-привязки, учебные данные, журналы и тесты, которые присутствовали на момент выгрузки.
- `.env` — подготовленные настройки с новым паролем контейнерной базы и текущими Google OAuth credentials.
- `.env.example` — шаблон без секретов.
- `backups/` — место для последующих резервных копий.

Папка содержит персональные данные и секреты. Передавайте весь комплект только администратору системы, не помещайте его в публичный репозиторий. `.gitignore` исключает секреты и дампы, но не защищает от ручной публикации архива. Пароль PostgreSQL в комплекте новый; пароли пользователей EduLink сохранены в виде хешей.

Сессии и незавершённые запросы Google хранятся в памяти процесса и не переносятся. Потребуется повторный вход. История Mailpit из исходной системы не переносится; новый почтовый ящик будет пустым. Истёкшие незавершённые попытки тестирования могут быть завершены приложением после запуска.

## Требования

Windows: Docker Desktop с запущенным движком Linux containers и Docker Compose v2. Linux: Docker Engine и плагин Docker Compose. Нужен интернет для загрузки образов, npm-зависимостей и Google OAuth. Проверьте:

```console
docker version
docker compose version
```

## Первый запуск

Откройте терминал в папке `edulink-docker`, где находится `compose.yaml`. Уже подготовленный `.env` не заменяйте файлом-примером.

```console
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 app db
```

Дождитесь состояния healthy у базы и приложения. При первом запуске PostgreSQL создаст базу и исполнит SQL-дамп. Приложение запустится после готовности PostgreSQL.

- EduLink: http://127.0.0.1:8080/
- Проверка приложения и базы: http://127.0.0.1:8080/health
- Тестовая почта: http://127.0.0.1:8026/

Для входа используйте существующие учётные записи и их текущие пароли. Проверьте группы, расписание, планы и статус Google-привязки. Отправьте письмо восстановления на собственную тестовую запись и проверьте его в Mailpit. Письма не доставляются на реальные внешние ящики.

## Google авторизация

В Google Cloud Console добавьте в Authorized redirect URIs текущего OAuth Web client:

```text
http://127.0.0.1:8080/api/auth/google/callback
```

Client ID и Client Secret уже перенесены в `.env`. Новый callback отличается портом от исходной установки. Открывайте приложение именно через `127.0.0.1:8080`, а не через `localhost`, иначе могут не совпасть cookie и проверка Origin. Используйте обычный Chrome или Edge. Если проект Google находится в режиме Testing, добавьте нужные Google-аккаунты в тестовые пользователи.

Привязка существующей записи: войдите паролем EduLink, нажмите «Привязать Google», повторно введите пароль и выберите Google-аккаунт с тем же email. После возврата проверьте статус. Сообщение об отказе отображается в кабинете. Серверу необходим исходящий HTTPS-доступ к accounts.google.com, oauth2.googleapis.com и www.googleapis.com.

После изменения `.env` примените настройки:

```console
docker compose up -d --force-recreate app
```

## Остановка и обновление

```console
docker compose stop
docker compose start
```

Либо `docker compose down` для удаления контейнеров и сети с сохранением томов. Для обновления исходников сначала сделайте резервную копию, затем замените файлы в `app/` и выполните:

```console
docker compose up -d --build app
```

База хранится в именованном томе `pgdata`, почта — в `maildata`. Не используйте `docker compose down -v`, если данные нужно сохранить: эта команда удаляет тома. Изменение POSTGRES_PASSWORD в `.env` не меняет пароль пользователя уже созданной базы.

## Резервная копия

Команды работают в PowerShell и в обычном Linux shell; бинарный дамп копируется через docker compose cp, без перенаправления вывода оболочки:

```console
docker compose exec -T db pg_dump -U edulink -d edulink -Fc -f /tmp/edulink-backup.dump
docker compose cp db:/tmp/edulink-backup.dump ./backups/edulink-backup.dump
```

Используйте новое имя файла для каждой резервной копии. Храните также compose.yaml, исходники и защищённую копию `.env`.

## Восстановление резервной копии вместо текущих данных

Следующая операция заменяет существующее содержимое базы. Сначала сохраните отдельную копию текущего состояния. Остановите приложение, оставив PostgreSQL работающим:

```console
docker compose stop app
docker compose cp ./backups/edulink-backup.dump db:/tmp/edulink-restore.dump
docker compose exec -T db pg_restore -U edulink -d edulink --clean --if-exists --no-owner --no-acl --single-transaction /tmp/edulink-restore.dump
docker compose start app
```

Для переноса первоначального комплекта на новый компьютер скопируйте папку целиком и выполните первый запуск. SQL-файлы в database автоматически выполняются только при пустом томе PostgreSQL; простая замена SQL-файла не обновляет уже работающую базу.

## Другие порты и доступ по сети

При конфликте портов измените APP_PORT и MAILPIT_PORT в `.env`. При изменении APP_PORT обновите GOOGLE_REDIRECT_URI и настройку callback в Google. PostgreSQL и SMTP доступны только внутри сети Compose.

Для доступа студентов с других устройств потребуется отдельная настройка: доменное имя, HTTPS через reverse proxy, публикация приложения, NODE_ENV=production и HTTPS callback Google. Текущий комплект использует NODE_ENV=development для локального HTTP. Для рабочей системы смените демонстрационные пароли, настройте реальный SMTP и не публикуйте Mailpit. При переходе на реальный SMTP сохраните TLS: исключение без TLS в этом комплекте относится только к сервису `mailpit`.

## Диагностика

- База unhealthy: `docker compose logs --tail=100 db`. Убедитесь, что дамп доступен и первый импорт завершился без ошибок.
- Приложение unhealthy: `docker compose logs --tail=100 app`. Проверьте соединение с db и пароль.
- Google redirect_uri_mismatch: callback в Google должен точно совпадать с GOOGLE_REDIRECT_URI.
- После возврата из Google ошибка: прочитайте сообщение в кабинете и логи app; коды и токены не публикуйте.
- После смены конфигурации выполните `docker compose up -d`, а не только restart.

Docker на машине подготовки не установлен: контейнерная сборка и запуск здесь не проверены. Результаты проверки дампа и исходников приведены в VALIDATION.md.

Официальная документация: https://docs.docker.com/compose/how-tos/startup-order/ и https://docs.docker.com/guides/postgresql/

## added github runner

## test