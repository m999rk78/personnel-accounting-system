import contextlib
from datetime import datetime, timedelta, timezone
import importlib.util
import io
import json
import os
from pathlib import Path
import smtplib
import ssl
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import MagicMock, patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("personnel_backup_notify", ROOT / "scripts/personnel-backup-notify.py")
notify = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(notify)
NOW = datetime(2026, 11, 16, 7, 0, tzinfo=timezone.utc)


class NotifyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="personnel-notify-test-")
        self.addCleanup(self.tmp.cleanup)
        # Resolve macOS /var -> /private/var; production paths cannot contain aliases.
        self.root = Path(self.tmp.name).resolve()
        self.backup = self.root / "backup"
        self.backup.mkdir(mode=0o700)
        self.state = self.root / "notify"
        self.config = {
            **notify.DEFAULTS,
            "ALERT_TO": "owner@example.test",
            "MAIL_FROM": "Personnel Accounting <backup@example.test>",
            "YANDEX_POSTBOX_API_KEY_ID": "test-mail-user",
            "YANDEX_POSTBOX_API_KEY_SECRET": "test-mail-secret-do-not-log",
            "STATE_DIRECTORY": str(self.backup),
            "NOTIFY_STATE_DIRECTORY": str(self.state),
        }
        self.config_path = self.root / "notify.env"
        self.write_config()
        self.timer = patch.object(notify, "timer_state", return_value=None)
        self.timer_mock = self.timer.start()
        self.addCleanup(self.timer.stop)
        self.service = patch.object(notify, "service_state", return_value=None)
        self.service_mock = self.service.start()
        self.addCleanup(self.service.stop)
        self.success()

    def write_config(self, **overrides):
        values = {**self.config, **overrides}
        self.config_path.write_text("".join(key + "=" + value + "\n" for key, value in values.items()))
        self.config_path.chmod(0o600)

    def status(self, name, value):
        target = self.backup / name
        target.write_text(json.dumps(value))
        target.chmod(0o600)

    def success(self, age_hours=1):
        timestamp = (NOW - timedelta(hours=age_hours)).isoformat()
        self.status("last-success.json", {"status": "success", "completed_at_utc": timestamp})
        self.status("last-attempt.json", {"status": "success", "phase": "complete", "completed_at_utc": timestamp})

    def set_failure(self, phase="backup"):
        self.status("last-attempt.json", {"status": "failed", "phase": phase, "completed_at_utc": NOW.isoformat(),
                                         "error": "secret-token and employee-private-data must never be sent"})

    def run_check(self, now=NOW):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            notify.check_and_notify(self.config, now)
        return output.getvalue()

    def test_private_config_and_exact_single_recipient(self):
        config = notify.parse_config(self.config_path)
        self.assertEqual(config["ALERT_TO"], "owner@example.test")
        for recipient in ["a@example.test,b@example.test", "Name <a@example.test>", "invalid", "a@example.test\nBcc: other@example.test"]:
            with self.subTest(recipient=recipient):
                self.write_config(ALERT_TO=recipient)
                with self.assertRaises(notify.NotifyError):
                    notify.parse_config(self.config_path)

    def test_config_rejects_unknown_keys_intervals_and_other_provider(self):
        for overrides in [dict(MAIL_PROVIDER="other"), dict(MAX_BACKUP_AGE_HOURS="0"),
                          dict(REMINDER_HOURS="0"), dict(RUNNING_GRACE_HOURS="-1"),
                          dict(BACKUP_TIMER="another.service"), dict(NOTIFY_STATE_DIRECTORY=str(self.backup)),
                          dict(MAIL_FROM="one@example.test, two@example.test")]:
            self.write_config(**overrides)
            with self.subTest(overrides=overrides), self.assertRaises(notify.NotifyError):
                notify.parse_config(self.config_path)
        self.write_config()
        with self.config_path.open("a") as out:
            out.write("INVENTED_KEY=private-value\n")
        with self.assertRaises(notify.NotifyError) as raised:
            notify.parse_config(self.config_path)
        self.assertNotIn("private-value", str(raised.exception))

    def test_config_rejects_public_or_symlink_file(self):
        self.config_path.chmod(0o644)
        with self.assertRaises(notify.NotifyError):
            notify.parse_config(self.config_path)
        self.config_path.chmod(0o600)
        link = self.root / "link.env"
        link.symlink_to(self.config_path)
        with self.assertRaises((notify.NotifyError, OSError)):
            notify.parse_config(link)

    def test_config_is_literal_without_shell_expansion(self):
        marker = self.root / "must-not-exist"
        self.write_config(YANDEX_POSTBOX_API_KEY_SECRET=f"$(touch {marker})")
        config = notify.parse_config(self.config_path)
        self.assertEqual(config["YANDEX_POSTBOX_API_KEY_SECRET"], f"$(touch {marker})")
        self.assertFalse(marker.exists())

    def test_daily_freshness_boundary_and_success(self):
        self.success(36)
        self.assertEqual(notify.inspect_backup(self.config, NOW)["issues"], [])
        report = notify.inspect_backup(self.config, NOW + timedelta(seconds=1))
        self.assertEqual(report["issues"], ["backup_stale"])

    def test_failed_retention_preserves_visible_good_copy_and_has_distinct_category(self):
        self.set_failure("retention")
        report = notify.inspect_backup(self.config, NOW)
        self.assertEqual(report["issues"], ["retention_failed"])
        self.assertEqual(report["last_success_at_utc"], (NOW - timedelta(hours=1)).isoformat())
        subject, body = notify.mail_content(self.config, "alert", report, NOW)
        self.assertIn("очистку", body)
        self.assertNotIn("secret-token", subject + body)
        self.assertNotIn("employee-private-data", body)

    def test_first_failure_without_success_is_reported(self):
        (self.backup / "last-success.json").unlink()
        self.set_failure()
        report = notify.inspect_backup(self.config, NOW)
        self.assertEqual(report["issues"], ["backup_failed", "backup_missing"])
        self.assertIsNone(report["last_success_at_utc"])

    def test_running_grace_and_stalled_job(self):
        self.status("last-attempt.json", {"status": "running", "phase": "retention", "started_at_utc": NOW.isoformat()})
        self.assertEqual(notify.inspect_backup(self.config, NOW + timedelta(hours=1))["issues"], [])
        self.assertEqual(notify.inspect_backup(self.config, NOW + timedelta(hours=1, seconds=1))["issues"], ["backup_stalled"])

    def test_future_timestamps_and_corrupt_status_do_not_enter_email(self):
        self.status("last-success.json", {"status": "success", "completed_at_utc": (NOW + timedelta(minutes=6)).isoformat()})
        self.assertIn("status_invalid", notify.inspect_backup(self.config, NOW)["issues"])
        (self.backup / "last-success.json").write_text("malformed with secret-data")
        report = notify.inspect_backup(self.config, NOW)
        _, body = notify.mail_content(self.config, "alert", report, NOW)
        self.assertIn("status_invalid", report["issues"])
        self.assertNotIn("secret-data", body)

    def test_public_status_and_symlinked_status_are_reported_invalid(self):
        file = self.backup / "last-success.json"
        file.chmod(0o644)
        self.assertIn("status_invalid", notify.inspect_backup(self.config, NOW)["issues"])
        file.unlink()
        file.symlink_to(self.config_path)
        report = notify.inspect_backup(self.config, NOW)
        self.assertIn("status_invalid", report["issues"])
        self.assertNotIn(self.config["YANDEX_POSTBOX_API_KEY_SECRET"], json.dumps(report))

    def test_disabled_or_unavailable_timer_is_reported_even_with_fresh_copy(self):
        for issue in ["timer_disabled", "timer_unavailable"]:
            self.timer_mock.return_value = issue
            self.assertEqual(notify.inspect_backup(self.config, NOW)["issues"], [issue])

    def test_systemd_failure_before_status_write_is_reported_with_fresh_success_files(self):
        self.service_mock.return_value = "backup_failed"
        self.assertEqual(notify.inspect_backup(self.config, NOW)["issues"], ["backup_failed"])
        self.status("last-attempt.json", {"status": "running", "started_at_utc": NOW.isoformat()})
        self.assertEqual(notify.inspect_backup(self.config, NOW)["issues"], ["backup_failed"], "A timed-out service cannot be hidden by running grace")
        self.service_mock.return_value = "service_missing"
        self.assertIn("service_missing", notify.inspect_backup(self.config, NOW)["issues"])

    def test_failed_systemd_retention_is_one_clear_category(self):
        self.set_failure("retention")
        self.service_mock.return_value = "backup_failed"
        self.assertEqual(notify.inspect_backup(self.config, NOW)["issues"], ["retention_failed"])

    def test_service_inspection_distinguishes_pre_runner_failure_and_normal_running(self):
        self.service.stop()
        with patch.object(notify.subprocess, "run") as run:
            cases = [
                ("LoadState=loaded\nActiveState=inactive\nResult=success\nExecMainStatus=0\n", None),
                ("LoadState=loaded\nActiveState=failed\nResult=exit-code\nExecMainStatus=203\n", "backup_failed"),
                ("LoadState=loaded\nActiveState=failed\nResult=timeout\nExecMainStatus=0\n", "backup_failed"),
                ("LoadState=loaded\nActiveState=activating\nResult=success\nExecMainStatus=0\n", None),
                ("LoadState=not-found\n", "service_missing"),
            ]
            for stdout, expected in cases:
                run.return_value = subprocess.CompletedProcess([], 0, stdout, "")
                self.assertEqual(notify.service_state(self.config), expected)
            self.assertIn("personnel-s3-backup.service", run.call_args.args[0])
            self.assertNotIn("YANDEX_POSTBOX_API_KEY_SECRET", run.call_args.kwargs["env"])
            run.side_effect = subprocess.TimeoutExpired("systemctl", 10)
            self.assertEqual(notify.service_state(self.config), "service_unavailable")

    def test_systemctl_checks_loaded_enabled_active_with_bounded_nonsecret_environment(self):
        self.timer.stop()
        with patch.object(notify.subprocess, "run") as run:
            run.return_value = subprocess.CompletedProcess([], 0, "LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n", "")
            self.assertIsNone(notify.timer_state(self.config))
            self.assertEqual(run.call_args.kwargs["timeout"], 10)
            self.assertNotIn("YANDEX_POSTBOX_API_KEY_SECRET", run.call_args.kwargs["env"])
            for value in ["LoadState=not-found\n", "LoadState=loaded\nActiveState=inactive\nUnitFileState=enabled\n", "LoadState=loaded\nActiveState=active\nUnitFileState=disabled\n"]:
                run.return_value = subprocess.CompletedProcess([], 0, value, "")
                self.assertIsNotNone(notify.timer_state(self.config))
            run.side_effect = subprocess.TimeoutExpired("systemctl", 10)
            self.assertEqual(notify.timer_state(self.config), "timer_unavailable")

    def test_success_does_not_send_email_or_create_notification_record(self):
        with patch.object(notify, "send_email") as send:
            log = self.run_check()
        send.assert_not_called()
        self.assertIn("backup_monitor_healthy", log)
        self.assertFalse((self.state / "last-notification.json").exists())

    def test_failure_is_deduplicated_and_reminded_after_24_hours(self):
        self.set_failure()
        with patch.object(notify, "send_email") as send:
            self.run_check()
            self.run_check(NOW + timedelta(hours=1))
            self.run_check(NOW + timedelta(hours=24))
        self.assertEqual(send.call_count, 2)
        saved = self.state / "last-notification.json"
        self.assertEqual(stat.S_IMODE(saved.stat().st_mode), 0o600)
        self.assertNotIn(self.config["ALERT_TO"], saved.read_text())
        self.assertNotIn("secret-token", saved.read_text())

    def test_changed_issue_sends_immediately(self):
        self.set_failure()
        with patch.object(notify, "send_email") as send:
            self.run_check()
            self.timer_mock.return_value = "timer_disabled"
            self.run_check(NOW + timedelta(minutes=5))
        self.assertEqual(send.call_count, 2)

    def test_smtp_failure_does_not_mark_alert_delivered_and_next_check_retries(self):
        self.set_failure()
        with patch.object(notify, "send_email", side_effect=notify.NotifyError("Notification SMTP delivery failed")):
            with self.assertRaises(notify.NotifyError):
                self.run_check()
        self.assertFalse((self.state / "last-notification.json").exists())
        with patch.object(notify, "send_email") as send:
            self.run_check(NOW + timedelta(minutes=1))
        send.assert_called_once()

    def test_corrupt_notification_history_does_not_block_future_alerts(self):
        self.set_failure()
        notify.private_directory(self.state)
        history = self.state / "last-notification.json"
        history.write_text("bad JSON with private details")
        history.chmod(0o600)
        with patch.object(notify, "send_email") as send:
            log = self.run_check()
        send.assert_called_once()
        self.assertNotIn("private details", log)
        self.assertEqual(json.loads(history.read_text())["issue_key"], "backup_failed")

    def test_unsafe_history_link_is_replaced_without_touching_target_or_suppressing_alert(self):
        self.set_failure()
        notify.private_directory(self.state)
        before = self.config_path.read_bytes()
        history = self.state / "last-notification.json"
        history.symlink_to(self.config_path)
        with patch.object(notify, "send_email") as send:
            self.run_check()
        send.assert_called_once()
        self.assertFalse(history.is_symlink())
        self.assertEqual(self.config_path.read_bytes(), before)

    def test_recovery_sent_once_only_after_reported_failure_and_completed_retry(self):
        self.set_failure()
        with patch.object(notify, "send_email") as send:
            self.run_check()
            self.status("last-attempt.json", {"status": "running", "started_at_utc": NOW.isoformat()})
            self.run_check(NOW + timedelta(minutes=5))
            self.assertEqual(send.call_count, 1, "A retry in progress does not prove recovery")
            self.success()
            self.run_check(NOW + timedelta(minutes=6))
            self.run_check(NOW + timedelta(minutes=7))
        self.assertEqual([call.args[1] for call in send.call_args_list], ["alert", "recovery"])

    def test_lock_prevents_simultaneous_duplicate_sends(self):
        directory = notify.private_directory(self.state)
        with notify.notification_lock(directory):
            with self.assertRaises(notify.AlreadyRunning):
                with notify.notification_lock(directory):
                    self.fail("Second lock should not be acquired")

    def test_smtp_uses_verified_tls_direct_postbox_credentials_and_explicit_recipient(self):
        smtp = MagicMock()
        smtp.__enter__.return_value = smtp
        smtp.send_message.return_value = {}
        report = {"issues": ["backup_failed"], "last_success_at_utc": NOW.isoformat()}
        with patch.object(notify.smtplib, "SMTP_SSL", return_value=smtp) as connect:
            notify.send_email(self.config, "alert", report, NOW)
        self.assertEqual(connect.call_args.args, ("postbox.cloud.yandex.net", 465))
        context = connect.call_args.kwargs["context"]
        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        smtp.login.assert_called_once_with("test-mail-user", "test-mail-secret-do-not-log")
        message = smtp.send_message.call_args.args[0]
        self.assertEqual(smtp.send_message.call_args.kwargs["to_addrs"], ["owner@example.test"])
        self.assertIn("16.11.2026 10:00 МСК", message.get_content())
        self.assertNotIn("test-mail-secret", message.as_string())

    def test_smtp_error_output_is_sanitized(self):
        with patch.object(notify.smtplib, "SMTP_SSL", side_effect=smtplib.SMTPAuthenticationError(535, b"private-secret")):
            with self.assertRaises(notify.NotifyError) as raised:
                notify.send_email(self.config, "test", {}, NOW)
        self.assertNotIn("private-secret", str(raised.exception))

    def test_cli_config_check_does_not_send_or_write_or_execute_commands(self):
        with patch.object(notify, "send_email") as send, patch.object(notify.subprocess, "run") as run, contextlib.redirect_stdout(io.StringIO()) as output:
            result = notify.main(["--config", str(self.config_path), "--check-config"])
        self.assertEqual(result, 0)
        send.assert_not_called()
        run.assert_not_called()
        self.assertFalse(self.state.exists())
        self.assertNotIn(self.config["YANDEX_POSTBOX_API_KEY_SECRET"], output.getvalue())

    def test_cli_test_sends_one_explicit_test_without_touching_alert_history(self):
        with patch.object(notify, "send_email") as send, patch.object(notify, "inspect_backup") as inspect, contextlib.redirect_stdout(io.StringIO()):
            result = notify.main(["--config", str(self.config_path), "--test"])
        self.assertEqual(result, 0)
        send.assert_called_once()
        self.assertEqual(send.call_args.args[1], "test")
        inspect.assert_not_called()
        self.assertFalse(self.state.exists())
        subject, body = notify.mail_content(self.config, "test", {}, NOW)
        self.assertIn("Проверка", subject)
        self.assertIn("тестовое письмо", body)

    def test_cli_unexpected_error_does_not_log_sensitive_exception(self):
        self.set_failure()
        with patch.object(notify, "check_and_notify", side_effect=RuntimeError("RAW SECRET")), contextlib.redirect_stdout(io.StringIO()) as output:
            result = notify.main(["--config", str(self.config_path), "--check"])
        self.assertEqual(result, 1)
        self.assertNotIn("RAW SECRET", output.getvalue())


if __name__ == "__main__":
    unittest.main()
