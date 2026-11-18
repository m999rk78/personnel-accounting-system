#!/usr/bin/env python3
"""Send scoped operational email alerts for Personnel Accounting backups.

Runs independently of the application container. Uses the same Yandex Postbox
SMTP credentials as app/auth.ts, stored in its own root-only literal env file.
No database contents, raw logs or raw status error strings enter email or logs.
"""

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import getaddresses, format_datetime, make_msgid
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import smtplib
import ssl
import stat
import subprocess
import sys
import tempfile
from zoneinfo import ZoneInfo


DEFAULTS = {
    "MAIL_PROVIDER": "yandex-postbox",
    "STATE_DIRECTORY": "/var/lib/personnel-s3-backup",
    "NOTIFY_STATE_DIRECTORY": "/var/lib/personnel-s3-backup-notify",
    "MAX_BACKUP_AGE_HOURS": "36",
    "RUNNING_GRACE_HOURS": "1",
    "REMINDER_HOURS": "24",
    "BACKUP_TIMER": "personnel-s3-backup.timer",
}
REQUIRED = {"ALERT_TO", "MAIL_FROM", "YANDEX_POSTBOX_API_KEY_ID", "YANDEX_POSTBOX_API_KEY_SECRET"}
EMAIL = re.compile(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}")
SAFE_ENV = {"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"}
ISSUE_TEXT = {
    "timer_unavailable": "Не удалось проверить системное расписание резервного копирования.",
    "timer_disabled": "Системное расписание резервного копирования выключено или не активно.",
    "service_unavailable": "Не удалось проверить состояние системного сервиса резервного копирования.",
    "service_missing": "Системный сервис резервного копирования отсутствует или не загружен.",
    "backup_failed": "Последний запуск резервного копирования завершился ошибкой.",
    "retention_failed": "Не удалось завершить очистку резервных копий старше срока хранения. Новая проверенная копия сохранена, если время ниже относится к этому запуску.",
    "backup_stalled": "Запуск резервного копирования или очистки выполняется дольше допустимого времени.",
    "backup_stale": "Проверенная резервная копия старше допустимого интервала.",
    "backup_missing": "Нет подтверждения успешно проверенной резервной копии.",
    "status_invalid": "Файлы состояния резервного копирования недоступны или содержат некорректные данные.",
}


class NotifyError(Exception):
    """Only static, non-sensitive messages may be stored in this exception."""


class AlreadyRunning(NotifyError):
    pass


def emit(stage, **fields):
    print(json.dumps({"time_utc": datetime.now(timezone.utc).isoformat(), "stage": stage, **fields}), flush=True)


def private_read(path, *, json_document=False):
    path = Path(path)
    for ancestor in (path.parent, *path.parent.parents):
        if ancestor.is_symlink():
            raise NotifyError("Refusing a symlinked private path")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, encoding="utf-8") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077 or info.st_size > 65536:
            raise NotifyError("Private files must be small regular files owned by this user with mode 0600 or 0400")
        result = json.load(source) if json_document else source.read()
    if json_document and not isinstance(result, dict):
        raise NotifyError("Invalid private status document")
    return result


def parse_config(path):
    data = private_read(path)
    result = {}
    for number, raw in enumerate(data.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if not separator or key not in DEFAULTS.keys() | REQUIRED or key in result:
            raise NotifyError(f"Invalid notification config key on line {number}")
        if value[:1] in ("'", '"'):
            if len(value) < 2 or value[-1] != value[0]:
                raise NotifyError(f"Unmatched config quotes on line {number}")
            value = value[1:-1]
        if any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise NotifyError(f"Control character in config on line {number}")
        result[key] = value
    config = {**DEFAULTS, **result}
    if any(not config.get(key) or config[key].startswith(("YOUR_", "REPLACE_", "<")) for key in REQUIRED):
        raise NotifyError("Missing notification sender, recipient or credentials")
    if config["MAIL_PROVIDER"] != "yandex-postbox":
        raise NotifyError("Only the configured Yandex Postbox SMTP provider is supported")
    if not EMAIL.fullmatch(config["ALERT_TO"]):
        raise NotifyError("ALERT_TO must contain exactly one email address")
    senders = getaddresses([config["MAIL_FROM"]])
    if len(senders) != 1 or not EMAIL.fullmatch(senders[0][1]):
        raise NotifyError("MAIL_FROM must contain one valid sender")
    for name in ("STATE_DIRECTORY", "NOTIFY_STATE_DIRECTORY"):
        p = Path(config[name])
        if not p.is_absolute() or ".." in p.parts or len(p.parts) < 3:
            raise NotifyError("State paths must be dedicated absolute directories")
    if Path(config["STATE_DIRECTORY"]) == Path(config["NOTIFY_STATE_DIRECTORY"]):
        raise NotifyError("Notification state must use a separate directory")
    for key, lower, upper in (("MAX_BACKUP_AGE_HOURS", 24, 168), ("RUNNING_GRACE_HOURS", 1, 6), ("REMINDER_HOURS", 1, 168)):
        try:
            value = int(config[key])
        except ValueError:
            raise NotifyError("Invalid notification interval") from None
        if not lower <= value <= upper:
            raise NotifyError("Notification interval is outside the supported range")
    if config["BACKUP_TIMER"] != "personnel-s3-backup.timer":
        raise NotifyError("Only the Personnel Accounting backup timer may be monitored")
    return config


def parse_time(value):
    if not isinstance(value, str) or len(value) > 40:
        raise NotifyError("Invalid status timestamp")
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise NotifyError("Invalid status timestamp") from None
    if result.tzinfo is None or result.utcoffset() is None:
        raise NotifyError("Status timestamps must include a timezone")
    return result.astimezone(timezone.utc)


def timer_state(config):
    try:
        process = subprocess.run(["systemctl", "show", config["BACKUP_TIMER"], "--property=ActiveState,UnitFileState,LoadState"],
                                 capture_output=True, text=True, timeout=10, env=SAFE_ENV)
        if process.returncode:
            return "timer_unavailable"
        values = dict(line.split("=", 1) for line in process.stdout.splitlines() if "=" in line)
        if values.get("LoadState") != "loaded":
            return "timer_unavailable"
        if values.get("ActiveState") != "active" or values.get("UnitFileState") != "enabled":
            return "timer_disabled"
        return None
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return "timer_unavailable"


def service_state(config):
    """Catch failures occurring before the Python runner can update its own state."""
    service = config["BACKUP_TIMER"].removesuffix(".timer") + ".service"
    try:
        process = subprocess.run(["systemctl", "show", service, "--property=ActiveState,Result,ExecMainStatus,LoadState"],
                                 capture_output=True, text=True, timeout=10, env=SAFE_ENV)
        if process.returncode:
            return "service_unavailable"
        values = dict(line.split("=", 1) for line in process.stdout.splitlines() if "=" in line)
        if values.get("LoadState") != "loaded":
            return "service_missing"
        if values.get("ActiveState") in ("activating", "active", "reloading"):
            return None
        if values.get("ActiveState") == "failed" or values.get("Result") != "success" or values.get("ExecMainStatus") != "0":
            return "backup_failed"
        return None
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return "service_unavailable"


def inspect_backup(config, now=None):
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None or now.utcoffset() is None:
        raise NotifyError("A timezone-aware monitoring clock is required")
    now = now.astimezone(timezone.utc)
    issues = []
    timer_problem = timer_state(config)
    if timer_problem:
        issues.append(timer_problem)
    service_problem = service_state(config)
    report = {"issues": issues, "last_success_at_utc": None, "last_attempt_at_utc": None, "last_attempt_status": None}
    directory = Path(config["STATE_DIRECTORY"])
    success = None
    attempt = None
    try:
        success = private_read(directory / "last-success.json", json_document=True)
    except FileNotFoundError:
        pass
    except (OSError, ValueError, NotifyError):
        issues.append("status_invalid")
    try:
        attempt = private_read(directory / "last-attempt.json", json_document=True)
        if attempt.get("status") not in ("running", "failed", "success"):
            raise NotifyError("Invalid backup attempt")
        attempt_time = parse_time(attempt.get("started_at_utc" if attempt["status"] == "running" else "completed_at_utc"))
        attempt_age = (now - attempt_time).total_seconds()
        if attempt_age < -300:
            raise NotifyError("Attempt is in the future")
        report["last_attempt_at_utc"] = attempt_time.isoformat()
        report["last_attempt_status"] = attempt["status"]
        if attempt["status"] == "failed":
            issues.append("retention_failed" if attempt.get("phase") == "retention" else "backup_failed")
        elif attempt["status"] == "running" and attempt_age > int(config["RUNNING_GRACE_HOURS"]) * 3600:
            issues.append("backup_stalled")
    except FileNotFoundError:
        issues.append("backup_missing")
    except (OSError, ValueError, NotifyError):
        issues.append("status_invalid")
    if success is None:
        issues.append("backup_missing")
    else:
        try:
            if success.get("status") != "success":
                raise NotifyError("Invalid successful backup status")
            success_time = parse_time(success.get("completed_at_utc"))
            age = (now - success_time).total_seconds()
            if age < -300:
                raise NotifyError("Successful backup is in the future")
            report["last_success_at_utc"] = success_time.isoformat()
            if age > int(config["MAX_BACKUP_AGE_HOURS"]) * 3600:
                issues.append("backup_stale")
        except (ValueError, NotifyError):
            issues.append("status_invalid")
    if service_problem:
        if service_problem == "backup_failed" and attempt and attempt.get("phase") == "retention" and attempt.get("status") in ("running", "failed"):
            service_problem = "retention_failed"
        issues.append(service_problem)
    report["issues"] = sorted(set(issues))
    return report


def display_time(value):
    if value is None:
        return "нет подтверждения"
    return parse_time(value).astimezone(ZoneInfo("Europe/Moscow")).strftime("%d.%m.%Y %H:%M МСК")


def mail_content(config, kind, report, now):
    if kind == "test":
        subject = "[Учёт персонала] Проверка уведомлений о резервных копиях"
        body = "Это тестовое письмо после настройки уведомлений. Ошибка резервного копирования этим письмом не сообщается."
    elif kind == "recovery":
        subject = "[Учёт персонала] Резервное копирование восстановлено"
        body = "Проверка больше не обнаруживает ранее сообщённую проблему: расписание включено, последняя попытка успешна, проверенная копия актуальна."
    else:
        subject = "[Учёт персонала] Ошибка резервного копирования"
        body = "Требуется проверить резервное копирование системы учёта:\n\n" + "\n".join("• " + ISSUE_TEXT[code] for code in report["issues"])
    body += "\n\nВремя проверки: " + now.astimezone(ZoneInfo("Europe/Moscow")).strftime("%d.%m.%Y %H:%M МСК")
    if kind != "test":
        body += "\nПоследняя проверенная копия: " + display_time(report["last_success_at_utc"])
        body += "\nДопустимый возраст копии: " + config["MAX_BACKUP_AGE_HOURS"] + " ч."
    body += "\n\nДиагностика на сервере: journalctl -u personnel-s3-backup.service.\nЭто автоматическое уведомление; оно не содержит рабочие данные или секретные ключи."
    return subject, body


def send_email(config, kind, report, now):
    subject, body = mail_content(config, kind, report, now)
    message = EmailMessage()
    message["From"] = config["MAIL_FROM"]
    message["To"] = config["ALERT_TO"]
    message["Subject"] = subject
    message["Date"] = format_datetime(now)
    sender = getaddresses([config["MAIL_FROM"]])[0][1]
    message["Message-ID"] = make_msgid(domain=sender.rsplit("@", 1)[1])
    message.set_content(body, cte="quoted-printable")
    try:
        with smtplib.SMTP_SSL("postbox.cloud.yandex.net", 465, timeout=20, context=ssl.create_default_context()) as smtp:
            smtp.login(config["YANDEX_POSTBOX_API_KEY_ID"], config["YANDEX_POSTBOX_API_KEY_SECRET"])
            refused = smtp.send_message(message, from_addr=sender, to_addrs=[config["ALERT_TO"]])
            if refused:
                raise NotifyError("Mail provider refused the notification")
    except (OSError, smtplib.SMTPException, ValueError):
        raise NotifyError("Notification SMTP delivery failed; credentials and provider response omitted") from None


def private_directory(path):
    path = Path(path)
    for ancestor in (path, *path.parents):
        if ancestor.is_symlink():
            raise NotifyError("Notification state contains a symlink")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise NotifyError("Notification state directory must be owned by this user with mode 0700")
    return path


@contextmanager
def notification_lock(directory):
    fd = os.open(directory / "notify.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise NotifyError("Unsafe notification lock")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise AlreadyRunning("Another notification check is running") from None
        yield
    finally:
        os.close(fd)


def write_state(directory, record):
    fd, temporary = tempfile.mkstemp(prefix=".notify-", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(record, output)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, directory / "last-notification.json")
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def check_and_notify(config, now=None):
    now = now or datetime.now(timezone.utc)
    directory = private_directory(config["NOTIFY_STATE_DIRECTORY"])
    with notification_lock(directory):
        report = inspect_backup(config, now)
        prior = {}
        try:
            prior = private_read(directory / "last-notification.json", json_document=True)
        except FileNotFoundError:
            pass
        except (OSError, ValueError, NotifyError):
            # The enclosing directory is private and validated. An invalid history
            # must not suppress future alerts; atomic replacement touches only our
            # own state entry (including when the old entry was an unsafe symlink).
            emit("notification_history_reset")
        recipient = hashlib.sha256(config["ALERT_TO"].lower().encode()).hexdigest()
        issue_key = ",".join(report["issues"])
        if issue_key:
            same = prior.get("issue_key") == issue_key and prior.get("recipient_sha256") == recipient
            elapsed = None
            if same:
                try:
                    elapsed = (now - parse_time(prior.get("sent_at_utc"))).total_seconds()
                except NotifyError:
                    same = False
            if same and 0 <= elapsed < int(config["REMINDER_HOURS"]) * 3600:
                emit("notification_suppressed", issues=report["issues"])
                return
            send_email(config, "alert", report, now)
            write_state(directory, {"issue_key": issue_key, "recipient_sha256": recipient, "sent_at_utc": now.isoformat()})
            emit("notification_sent", kind="alert", issues=report["issues"])
        elif prior.get("issue_key") and prior.get("recipient_sha256") == recipient and report["last_attempt_status"] == "running":
            emit("notification_recovery_deferred")
        elif prior.get("issue_key") and prior.get("recipient_sha256") == recipient:
            send_email(config, "recovery", report, now)
            write_state(directory, {"issue_key": "", "recipient_sha256": recipient, "sent_at_utc": now.isoformat()})
            emit("notification_sent", kind="recovery")
        else:
            emit("backup_monitor_healthy")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True, help="Private root-only notification config")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true", help="Check timer and status; send deduplicated alerts/recovery")
    mode.add_argument("--test", action="store_true", help="Send one explicit setup-test email without altering alert state")
    mode.add_argument("--check-config", action="store_true", help="Validate configuration without sending or writing")
    arguments = parser.parse_args(argv)
    os.umask(0o077)
    try:
        config = parse_config(arguments.config)
        if arguments.check_config:
            emit("notification_config_valid")
        elif arguments.test:
            send_email(config, "test", {}, datetime.now(timezone.utc))
            emit("notification_sent", kind="test")
        else:
            check_and_notify(config)
        return 0
    except AlreadyRunning:
        emit("notification_check_already_running")
        return 0
    except Exception as error:
        emit("notification_failed", error=str(error) if isinstance(error, NotifyError) else "Notification check failed; sensitive details omitted")
        return 1


if __name__ == "__main__":
    sys.exit(main())
