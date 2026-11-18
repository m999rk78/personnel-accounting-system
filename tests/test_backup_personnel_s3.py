"""Unit tests only: synthetic credentials, archives and Docker/S3 command responses.

No database, Docker daemon, network connection or existing config is accessed.
These checks do not replace a real PostgreSQL dump/download/restore verification.
"""

from contextlib import ExitStack, redirect_stdout
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("personnel_s3_backup", ROOT / "scripts/backup-personnel-s3.py")
backup = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = backup
SPEC.loader.exec_module(backup)

ACCESS_KEY = "unit-test-access-key"
SECRET_KEY = "unit-test-secret-do-not-log"
DATABASE_PASSWORD = "unit-test-database-password"
CERTIFICATE = "unit-test-certificate"
ARCHIVE = b"synthetic PostgreSQL archive unit fixture\n" * 128


def settings(**overrides):
    return {**backup.DEFAULTS, "AWS_ACCESS_KEY_ID": ACCESS_KEY,
            "AWS_SECRET_ACCESS_KEY": SECRET_KEY, **overrides}


def source_environment(**overrides):
    return {"PGHOST": backup.DEFAULTS["EXPECTED_PGHOST"], "PGDATABASE": "personnel",
            "PGUSER": "personnel", "PGPASSWORD": DATABASE_PASSWORD, "PGPORT": "5432",
            "DATABASE_SSL": "verify-full", "DATABASE_CA_CERT": CERTIFICATE, **overrides}


class TemporaryFiles(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="personnel-backup-unit-")
        # macOS /var is a symlink: use its canonical path before testing path guards.
        self.root = Path(self.temporary.name).resolve()
        self.addCleanup(self.temporary.cleanup)

    def config(self, content=None, **overrides):
        path = self.root / "backup.env"
        path.write_text(content if content is not None else "".join(
            f"{key}={value}\n" for key, value in {
                "AWS_ACCESS_KEY_ID": ACCESS_KEY, "AWS_SECRET_ACCESS_KEY": SECRET_KEY,
                **overrides,
            }.items()), encoding="utf-8")
        path.chmod(0o600)
        return path

    def directories(self):
        result = []
        for name in ("state", "work", "run"):
            directory = self.root / name
            directory.mkdir(mode=0o700)
            result.append(directory)
        return result


class ConfigTests(TemporaryFiles):
    def test_config_is_literal_and_does_not_execute_shell_or_expand_environment(self):
        marker = self.root / "must-not-exist"
        literal = f"$(touch {marker});`touch {marker}`;$HOME"
        configuration = backup.load_config(self.config(AWS_SECRET_ACCESS_KEY=literal))
        self.assertEqual(configuration["AWS_SECRET_ACCESS_KEY"], literal)
        self.assertFalse(marker.exists())
        self.assertEqual(configuration["S3_PREFIX"], backup.DEFAULTS["S3_PREFIX"])

    def test_config_rejects_group_or_other_access(self):
        path = self.config()
        for mode in (0o640, 0o644, 0o606):
            with self.subTest(mode=oct(mode)):
                path.chmod(mode)
                with self.assertRaisesRegex(backup.BackupError, "mode 0600 or 0400"):
                    backup.load_config(path)

    def test_read_only_private_config_is_accepted(self):
        path = self.config()
        path.chmod(0o400)
        self.assertEqual(backup.load_config(path)["AWS_ACCESS_KEY_ID"], ACCESS_KEY)

    def test_symlinked_config_is_rejected(self):
        path = self.config()
        link = self.root / "linked.env"
        link.symlink_to(path)
        with self.assertRaisesRegex(backup.BackupError, "non-symlink"):
            backup.load_config(link)

    def test_config_owned_by_another_user_is_rejected(self):
        path = self.config()
        with patch.object(backup.os, "geteuid", return_value=os.geteuid() + 1):
            with self.assertRaisesRegex(backup.BackupError, "owned"):
                backup.load_config(path)

    def test_malformed_or_unexpected_keys_fail_without_echoing_values(self):
        valid = f"AWS_ACCESS_KEY_ID={ACCESS_KEY}\nAWS_SECRET_ACCESS_KEY={SECRET_KEY}\n"
        for addition in (f"AWS_SECRET_ACCESS_KEY={DATABASE_PASSWORD}\n",
                         f"UNKNOWN_SECRET={DATABASE_PASSWORD}\n",
                         f"broken {DATABASE_PASSWORD}\n",
                         f"S3_PREFIX='unclosed-{DATABASE_PASSWORD}\n",
                         "S3_PREFIX=bad\x00value\n"):
            with self.subTest(addition=addition.split("=", 1)[0]):
                with self.assertRaises(backup.BackupError) as raised:
                    backup.load_config(self.config(valid + addition))
                self.assertNotIn(DATABASE_PASSWORD, str(raised.exception))
                self.assertNotIn(SECRET_KEY, str(raised.exception))

    def test_insecure_endpoints_and_unsafe_targets_are_rejected(self):
        invalid = {
            "S3_ENDPOINT_URL": ["http://storage.example", "https://key:secret@storage.example",
                                "https://storage.example/bucket", "https://storage.example?key=secret",
                                "https://storage.example#secret", "https://storage.example:bad"],
            "S3_BUCKET": ["", "bucket/other", "bucket.with.dots", "Bucket", "--option"],
            "S3_PREFIX": ["", "/absolute", "../other", "production/../other", "production//other"],
            "POSTGRES_IMAGE": ["postgres:18", "untrusted/postgres@sha256:" + "a" * 64],
            "STATE_DIRECTORY": ["/", "/tmp", "relative/path", "/tmp/../elsewhere", "/tmp/a,b"],
            "MIN_FREE_BYTES": ["-1", "0", "not-a-number"],
            "COMMAND_TIMEOUT_SECONDS": ["0", "-1", "7201"],
            "RESTORE_CPUS": ["0", "nan", "inf", "9"],
            "RESTORE_MEMORY": ["0m", "--privileged", "1g --network host"],
            "RETENTION_ENABLED": ["yes", "1", "delete-everything"],
            "MAX_BACKUP_AGE_HOURS": ["0", "169", "nan"],
        }
        for key, values in invalid.items():
            for value in values:
                with self.subTest(key=key, value=value):
                    with self.assertRaises(backup.BackupError):
                        backup.load_config(self.config(**{key: value}))

    def test_check_config_does_not_touch_docker_network_or_work_directories(self):
        destination = self.root / "should-not-be-created"
        config = self.config(STATE_DIRECTORY=destination, WORK_DIRECTORY=destination / "work",
                             RUN_DIRECTORY=destination / "run")
        output = io.StringIO()
        previous_umask = os.umask(0o077)
        try:
            with patch.object(backup.subprocess, "run", side_effect=AssertionError("No subprocess allowed")), redirect_stdout(output):
                self.assertEqual(backup.main(["--config", str(config), "--check-config"]), 0)
        finally:
            os.umask(previous_umask)
        self.assertFalse(destination.exists())
        self.assertEqual(json.loads(output.getvalue())["stage"], "config_valid")
        self.assertNotIn(ACCESS_KEY, output.getvalue())
        self.assertNotIn(SECRET_KEY, output.getvalue())

    def test_explicit_ca_bundle_must_be_regular_and_not_writable_by_other_users(self):
        ca = self.root / "storage-ca.pem"
        ca.write_text("unit-test-certificate", encoding="utf-8")
        ca.chmod(0o644)
        configuration = backup.load_config(self.config(S3_CA_BUNDLE=ca))
        self.assertEqual(configuration["S3_CA_BUNDLE"], str(ca))
        secrets = self.root / "aws-secrets"
        secrets.mkdir(mode=0o700)
        operation = backup.Backup(configuration)
        operation.configure_aws(secrets)
        self.assertEqual(operation.aws_environment["AWS_CA_BUNDLE"], str(ca))
        ca.chmod(0o666)
        with self.assertRaisesRegex(backup.BackupError, "trusted regular file"):
            backup.load_config(self.config(S3_CA_BUNDLE=ca))
        ca.chmod(0o644)
        link = self.root / "linked-ca.pem"
        link.symlink_to(ca)
        with self.assertRaisesRegex(backup.BackupError, "trusted regular file"):
            backup.load_config(self.config(S3_CA_BUNDLE=link))


class PrivateFilesTests(TemporaryFiles):
    def test_private_directory_does_not_repair_or_follow_unsafe_existing_paths(self):
        existing = self.root / "public-directory"
        existing.mkdir(mode=0o755)
        with self.assertRaisesRegex(backup.BackupError, "mode 0700"):
            backup.private_directory(existing)
        self.assertEqual(stat.S_IMODE(existing.stat().st_mode), 0o755)
        link = self.root / "linked-directory"
        link.symlink_to(existing, target_is_directory=True)
        with self.assertRaisesRegex(backup.BackupError, "symbolic link"):
            backup.private_directory(link / "child")
        self.assertFalse((existing / "child").exists())

    def test_private_write_neither_overwrites_file_nor_follows_symlink(self):
        private = self.root / "private"
        backup.write_private(private, SECRET_KEY)
        self.assertEqual(stat.S_IMODE(private.stat().st_mode), 0o600)
        with self.assertRaises(FileExistsError):
            backup.write_private(private, "overwritten")
        link = self.root / "linked"
        link.symlink_to(private)
        with self.assertRaises(OSError):
            backup.write_private(link, "overwritten")
        self.assertEqual(private.read_text(), SECRET_KEY)

    def test_lock_prevents_concurrent_jobs_and_releases_after_failure(self):
        with backup.exclusive_lock(self.root):
            with self.assertRaisesRegex(backup.BackupError, "already running"):
                with backup.exclusive_lock(self.root):
                    self.fail("Second job entered the critical section")
        with self.assertRaisesRegex(RuntimeError, "simulated failure"):
            with backup.exclusive_lock(self.root):
                raise RuntimeError("simulated failure")
        with backup.exclusive_lock(self.root):
            pass

    def test_public_lock_file_is_rejected(self):
        lock = self.root / "backup.lock"
        lock.touch(mode=0o644)
        with self.assertRaisesRegex(backup.BackupError, "Unsafe backup lock"):
            with backup.exclusive_lock(self.root):
                self.fail("Unsafe lock accepted")


class SourceAndCommandsTests(TemporaryFiles):
    def test_source_guards_refuse_ambiguous_wrong_or_unhealthy_production_container(self):
        operation = backup.Backup(settings())
        name = operation.settings["APP_CONTAINER_PREFIX"] + "current"
        def inspect(environment=None, health="healthy", names=None):
            document = [{"State": {"Health": {"Status": health}},
                         "Config": {"Env": [f"{key}={value}" for key, value in (environment or source_environment()).items()]},
                         "Image": "sha256:unit-test-app"}]
            return patch.object(operation, "run", side_effect=[names if names is not None else name, json.dumps(document)])
        with inspect():
            result = operation.inspect_source()
            self.assertEqual(result[0], name)
            self.assertEqual(result[1]["PGPASSWORD"], DATABASE_PASSWORD)
        invalid_environments = [source_environment(PGHOST="unrelated.example"),
                                source_environment(PGDATABASE="other"), source_environment(PGUSER="root"),
                                source_environment(DATABASE_URL="postgres://secret@other/database"),
                                source_environment(DATABASE_SSL="require"), source_environment(DATABASE_CA_CERT=""),
                                source_environment(PGPASSWORD=""), source_environment(PGPORT="5432;exec")]
        for environment in invalid_environments:
            with self.subTest(environment_keys=list(environment)), inspect(environment):
                with self.assertRaises(backup.BackupError) as raised:
                    operation.inspect_source()
                self.assertNotIn(DATABASE_PASSWORD, str(raised.exception))
        for health, names in [("starting", name), ("healthy", ""), ("healthy", name + "\n" + name + "-next")]:
            with self.subTest(health=health, names=names), inspect(health=health, names=names):
                with self.assertRaises(backup.BackupError):
                    operation.inspect_source()

    def test_subprocess_errors_and_repr_do_not_expose_secrets_or_inherit_ambient_environment(self):
        operation = backup.Backup(settings())
        for failure in (SimpleNamespace(returncode=1, stdout=SECRET_KEY, stderr=DATABASE_PASSWORD),
                        subprocess.TimeoutExpired(["cmd", SECRET_KEY], 1, output=DATABASE_PASSWORD),
                        OSError(SECRET_KEY)):
            with self.subTest(failure_type=type(failure).__name__):
                effect = {"side_effect": failure} if isinstance(failure, Exception) else {"return_value": failure}
                with patch.object(backup.subprocess, "run", **effect) as run:
                    with self.assertRaises(backup.BackupError) as raised:
                        operation.run(["command", SECRET_KEY], "unit operation")
                self.assertNotIn(SECRET_KEY, str(raised.exception))
                self.assertNotIn(DATABASE_PASSWORD, str(raised.exception))
                self.assertEqual(run.call_args.kwargs["env"], {"PATH": backup.SAFE_PATH, "LANG": "C.UTF-8"})
                self.assertTrue(run.call_args.kwargs["capture_output"])
                self.assertNotIn("shell", run.call_args.kwargs)
        self.assertNotIn(SECRET_KEY, repr(operation))

    def test_aws_configuration_uses_only_explicit_credentials(self):
        operation = backup.Backup(settings())
        with patch.dict(os.environ, {"AWS_PROFILE": "unrelated-profile", "AWS_SESSION_TOKEN": "unrelated-token",
                                    "AWS_ENDPOINT_URL": "https://unrelated.example"}):
            operation.configure_aws(self.root)
        self.assertNotIn("AWS_PROFILE", operation.aws_environment)
        self.assertNotIn("AWS_SESSION_TOKEN", operation.aws_environment)
        self.assertNotIn("AWS_ENDPOINT_URL", operation.aws_environment)
        self.assertEqual(operation.aws_environment["AWS_EC2_METADATA_DISABLED"], "true")
        self.assertEqual(operation.aws_environment["AWS_SHARED_CREDENTIALS_FILE"], "/dev/null")
        config = Path(operation.aws_environment["AWS_CONFIG_FILE"])
        self.assertEqual(stat.S_IMODE(config.stat().st_mode), 0o600)
        self.assertNotIn(SECRET_KEY, config.read_text())

    def test_cleanup_only_removes_registered_resources_and_preserves_volume_on_container_failure(self):
        operation = backup.Backup(settings())
        name, volume = "personnel-s3-backup-unit-verify", "personnel-s3-backup-unit-data"
        operation.containers.add(name)
        operation.volumes.add(volume)
        commands = []
        def run(arguments, _label, **_options):
            commands.append(arguments)
            if arguments[1:3] == ["container", "ls"]:
                return name + "\n"
            if arguments[1:3] == ["volume", "ls"]:
                return volume + "\n"
            return ""
        with patch.object(operation, "run", side_effect=run):
            operation.cleanup()
        self.assertIn(["docker", "rm", "--force", "--volumes", name], commands)
        self.assertIn(["docker", "volume", "rm", volume], commands)
        self.assertEqual(operation.containers | operation.volumes, set())
        self.assertFalse(any("prune" in command for command in commands))
        operation.containers.add(name)
        operation.volumes.add(volume)
        with patch.object(operation, "run", side_effect=backup.BackupError("Docker unavailable")) as run:
            with self.assertRaisesRegex(backup.BackupError, "cleanup failed"):
                operation.cleanup()
        self.assertEqual(operation.volumes, {volume})
        self.assertFalse(any(call.args[0][1:3] == ["volume", "rm"] for call in run.call_args_list))

    def test_restore_uses_network_isolation_no_published_ports_and_transactional_fail_fast_flags(self):
        operation = backup.Backup(settings())
        commands = []
        def run(arguments, label, **options):
            commands.append((arguments, options))
            if arguments[1:3] == ["volume", "inspect"]:
                return "/unit-test-docker-root/volume"
            sql = options.get("input_text", "")
            if "to_regclass" in sql:
                return json.dumps(backup.REQUIRED_TABLES)
            if "information_schema.tables" in sql:
                return "SELECT 'unit-test-table-counts';"
            if sql:
                return json.dumps({"schema": "public", "rows": 12}) + "\n" + json.dumps({"schema": "drizzle", "rows": 3})
            return ""
        with patch.object(operation, "run", side_effect=run), patch.object(operation, "cleanup") as cleanup, \
                patch.object(backup.shutil, "disk_usage", return_value=SimpleNamespace(free=10**12)):
            verified = operation.verify_restore(self.root, "downloaded.dump")
        self.assertEqual(verified["public_row_count"], 12)
        self.assertTrue(verified["required_tables_present"])
        cleanup.assert_called_once()
        docker_run = next(command for command, _ in commands if command[:2] == ["docker", "run"])
        self.assertEqual(docker_run[docker_run.index("--network") + 1], "none")
        self.assertEqual(docker_run[docker_run.index("--pull=never")], "--pull=never")
        self.assertNotIn("-p", docker_run)
        self.assertNotIn("--publish", docker_run)
        restore = next(command for command, _ in commands if "pg_restore" in command)
        for flag in ("--exit-on-error", "--single-transaction", "--no-owner", "--no-privileges"):
            self.assertIn(flag, restore)
        self.assertEqual(restore[-1], "/backup/downloaded.dump")
        self.assertNotIn("--clean", restore)
        self.assertFalse(any(DATABASE_PASSWORD in " ".join(command) for command, _ in commands))

    def test_restore_missing_migration_history_is_not_marked_verified(self):
        operation = backup.Backup(settings())
        def run(arguments, _label, **options):
            if arguments[1:3] == ["volume", "inspect"]:
                return "/unit-test-docker-root/volume"
            if "to_regclass" in options.get("input_text", ""):
                return json.dumps([table for table in backup.REQUIRED_TABLES if not table.startswith("drizzle.")])
            return ""
        with patch.object(operation, "run", side_effect=run), \
                patch.object(backup.shutil, "disk_usage", return_value=SimpleNamespace(free=10**12)):
            with self.assertRaisesRegex(backup.BackupError, "migration history"):
                operation.verify_restore(self.root, "downloaded.dump")


class ImageAvailabilityTests(unittest.TestCase):
    def setUp(self):
        self.operation = backup.Backup(settings())
        self.inspect = ["docker", "image", "inspect", self.operation.image, "--format", "{{.Id}}"]
        self.daemon = ["docker", "info", "--format", "{{.ServerVersion}}"]
        self.pull = ["docker", "pull", self.operation.image]

    def missing(self):
        return backup.BackupError("checking pinned PostgreSQL image failed (exit 1)", returncode=1)

    def test_present_image_does_not_pull_or_change_the_pin(self):
        with patch.object(self.operation, "run", return_value="sha256:unit-test-image") as run:
            self.operation.ensure_image()
        self.assertEqual([call.args[0] for call in run.call_args_list], [self.inspect])

    def test_missing_image_pulls_only_same_official_digest_then_reinspects(self):
        output = io.StringIO()
        with patch.object(self.operation, "run", side_effect=[self.missing(), "28.5.1", "downloaded", "sha256:unit-test-image"]) as run, \
                redirect_stdout(output):
            self.operation.ensure_image()
        self.assertEqual([call.args[0] for call in run.call_args_list],
                         [self.inspect, self.daemon, self.pull, self.inspect])
        self.assertEqual(run.call_args_list[2].kwargs["timeout"], 300)
        self.assertRegex(self.pull[2], r"^postgres@sha256:[a-f0-9]{64}$")
        self.assertNotIn(SECRET_KEY, output.getvalue())

    def test_daemon_failure_prevents_pull(self):
        with patch.object(self.operation, "run", side_effect=[self.missing(), backup.BackupError("Docker daemon unavailable")]) as run:
            with self.assertRaisesRegex(backup.BackupError, "daemon unavailable"):
                self.operation.ensure_image()
        self.assertEqual([call.args[0] for call in run.call_args_list], [self.inspect, self.daemon])

    def test_inspect_timeout_or_unexpected_error_does_not_trigger_pull(self):
        for failure in (backup.BackupError("Image inspection timed out"),
                        backup.BackupError("Cannot execute image inspection"),
                        backup.BackupError("Unexpected inspection failure", returncode=2)):
            with self.subTest(failure=str(failure)), patch.object(self.operation, "run", side_effect=failure) as run:
                with self.assertRaises(backup.BackupError):
                    self.operation.ensure_image()
            self.assertEqual([call.args[0] for call in run.call_args_list], [self.inspect])

    def test_network_or_reinspection_failure_is_not_reported_as_image_restored(self):
        for replies in ([self.missing(), "28.5.1", backup.BackupError("Image download failed", returncode=1)],
                        [self.missing(), "28.5.1", "downloaded", self.missing()]):
            output = io.StringIO()
            with self.subTest(commands=len(replies)), patch.object(self.operation, "run", side_effect=replies) as run, \
                    redirect_stdout(output):
                with self.assertRaises(backup.BackupError):
                    self.operation.ensure_image()
            self.assertEqual([call.args[0] for call in run.call_args_list],
                             [self.inspect, self.daemon, self.pull, self.inspect][:len(replies)])
            self.assertNotIn("postgres_image_restore_completed", output.getvalue())

    def test_mutated_configuration_cannot_pull_an_unpinned_or_unofficial_image(self):
        for image in ("postgres:18", "postgres:latest", "untrusted/postgres@sha256:" + "a" * 64):
            with self.subTest(image=image):
                operation = backup.Backup(settings(POSTGRES_IMAGE=image))
                with patch.object(operation, "run", side_effect=AssertionError("Unsafe image must not reach Docker")):
                    with self.assertRaises(backup.BackupError):
                        operation.ensure_image()


class FakeExternalServicesBackup(backup.Backup):
    """Exercise execute's real ordering/hash/status logic; fake every external service."""
    def __init__(self, configuration, failure=None):
        super().__init__(configuration)
        self.failure = failure
        self.objects = {}
        self.operations = []
        self.client_calls = []
        self.secret_files = []

    def run(self, arguments, label, **options):
        if arguments[:2] == ["docker", "info"]:
            if arguments[-1] == "{{.ServerVersion}}":
                if self.failure == "image-daemon":
                    raise backup.BackupError("Docker daemon unavailable")
                return "28.5.1"
            return "/unit-test-docker-root"
        if arguments[:2] == ["docker", "pull"]:
            if arguments[2] != self.image:
                raise AssertionError("A different image was pulled")
            if self.failure == "image-network":
                raise backup.BackupError("Pinned image download failed", returncode=1)
            return "downloaded"
        if arguments[:3] != ["docker", "image", "inspect"]:
            raise AssertionError(f"Unexpected external command in unit test: {label}")
        if self.failure in ("image-network", "image-daemon"):
            raise backup.BackupError("Pinned image is absent", returncode=1)
        return "sha256:unit-test-client"

    def inspect_source(self):
        return self.settings["APP_CONTAINER_PREFIX"] + "current", source_environment(), "sha256:unit-test-app"

    def client(self, suffix, arguments, **options):
        self.client_calls.append((suffix, arguments, options))
        if suffix == "version":
            return "pg_dump (PostgreSQL) 17.1" if self.failure == "client-version" else "pg_dump (PostgreSQL) 18.1"
        if suffix == "target":
            return json.dumps({"database": "unrelated" if self.failure == "target" else "personnel",
                               "user": "personnel", "version": 180001, "database_bytes": 10_000_000})
        if suffix != "dump":
            raise AssertionError("Unexpected PostgreSQL unit-test command")
        self.secret_files.append(Path(options["environment_file"]))
        environment = self.secret_files[-1].read_text()
        if "PGSSLMODE=verify-full" not in environment or "default_transaction_read_only=on" not in environment:
            raise AssertionError("Source dump is not explicitly read-only with verified TLS")
        self.operations.append("dump")
        if self.failure == "dump":
            raise backup.BackupError("Synthetic dump failure")
        directory = Path(options["mounts"][0].split("src=", 1)[1].split(",dst=", 1)[0])
        (directory / "personnel.dump").write_bytes(ARCHIVE)
        return ""

    def upload(self, source, key):
        self.operations.append("upload:" + source.name)
        if self.failure == "upload":
            raise backup.BackupError("Synthetic upload failure")
        self.objects[key] = source.read_bytes()

    def download(self, key, destination):
        self.operations.append("download:" + destination.name)
        content = self.objects[key]
        if self.failure == "download-hash" and destination.name == "downloaded.dump":
            content = b"X" + content[1:]  # Same length: the SHA check must catch this.
        if self.failure == "manifest-hash" and destination.name == "downloaded-manifest.json":
            content = b"X" + content[1:]
        destination.write_bytes(content)

    def verify_restore(self, directory, filename):
        self.operations.append("restore:" + filename)
        if (directory / filename).read_bytes() != ARCHIVE:
            raise AssertionError("Restore did not receive the downloaded archive")
        if self.failure == "restore":
            raise backup.BackupError("Synthetic restore failure")
        return {"all_table_count": 12, "public_table_count": 11, "public_row_count": 42,
                "required_tables_present": True}


class RetentionTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2030, 5, 20, 12, 0, tzinfo=timezone.utc)
        self.prefix = backup.DEFAULTS["S3_PREFIX"]
        self.operation = backup.Backup(settings(RETENTION_ENABLED="true"))
        self.operation.verified_backup_id = self.operation.run_id

    def version(self, *, run_age=timedelta(days=31), modified_age=timedelta(days=31),
                filename="personnel.dump", version_id="old-version", key=None):
        run_id = (self.now - run_age).strftime("%Y%m%dT%H%M%SZ") + "-" + "a" * 32
        return {"Key": key if key is not None else f"{self.prefix}/{run_id}/{filename}",
                "VersionId": version_id, "LastModified": (self.now - modified_age).isoformat()}

    def listing(self, versions=(), markers=()):
        return {"Versions": list(versions), "DeleteMarkers": list(markers), "IsTruncated": False}

    def test_both_object_version_and_run_id_must_be_strictly_older_than_thirty_days(self):
        old = self.version(version_id="eligible")
        boundary_run = self.version(run_age=timedelta(days=30), version_id="run-exactly-30")
        boundary_modified = self.version(modified_age=timedelta(days=30), version_id="modified-exactly-30")
        recent_run = self.version(run_age=timedelta(days=1), version_id="recent-run")
        recent_replacement = self.version(modified_age=timedelta(hours=1), version_id="recent-replacement")
        newer_marker = self.version(filename="manifest.json", modified_age=timedelta(hours=1), version_id="recent-marker")
        old_marker = self.version(filename="manifest.json", version_id="eligible-marker")
        result = backup.retention_candidates(self.listing([old, boundary_run, boundary_modified, recent_run, recent_replacement],
                                                          [old_marker, newer_marker]), self.prefix, now=self.now)
        self.assertEqual({(row["Key"], row["VersionId"]) for row in result},
                         {(old["Key"], "eligible"), (old_marker["Key"], "eligible-marker")})

    def test_foreign_prefixes_checks_and_unrecognized_files_are_never_candidates(self):
        old = self.version()
        owned_directory = old["Key"].rsplit("/", 1)[0]
        ignored = [self.version(key="other-system/production/file"),
                   self.version(key=f"{self.prefix}/_checks/probe.txt"),
                   self.version(key=f"{self.prefix}/../other-system/personnel.dump"),
                   self.version(key=f"{self.prefix}-other/" + old["Key"].split(self.prefix + "/", 1)[1]),
                   self.version(key=owned_directory + "/private-note.txt"),
                   self.version(key=owned_directory + "/nested/personnel.dump"),
                   self.version(key=f"{self.prefix}/not-a-run-id/personnel.dump")]
        markers = [{**item, "VersionId": "marker-" + str(index)} for index, item in enumerate(ignored)]
        self.assertEqual(backup.retention_candidates(self.listing(ignored, markers), self.prefix, now=self.now), [])

    def test_disabled_retention_never_lists_or_deletes(self):
        operation = backup.Backup(settings(RETENTION_ENABLED="false"))
        with patch.object(operation, "aws", side_effect=AssertionError("Disabled retention reached S3")), redirect_stdout(io.StringIO()):
            operation.run_retention(now=self.now)

    def test_delete_requires_verification_of_this_run_and_exact_bucket_prefix(self):
        unsafe = [settings(RETENTION_ENABLED="true"),
                  settings(RETENTION_ENABLED="true", S3_BUCKET="unrelated-bucket"),
                  settings(RETENTION_ENABLED="true", S3_PREFIX="unrelated/production")]
        for index, configuration in enumerate(unsafe):
            with self.subTest(case=index):
                operation = backup.Backup(configuration)
                operation.verified_backup_id = "a-different-run" if index == 0 else operation.run_id
                with patch.object(operation, "aws", side_effect=AssertionError("Unsafe retention reached S3")):
                    with self.assertRaises(backup.BackupError):
                        operation.run_retention(now=self.now)

    def test_listing_keeps_aws_cli_automatic_pagination_and_deletes_only_explicit_versions(self):
        old = self.version()
        marker = self.version(filename="manifest.json", version_id="old-marker")
        commands = []
        def aws(arguments, _label):
            commands.append(arguments)
            if arguments[:2] == ["s3api", "list-object-versions"]:
                return json.dumps(self.listing([old], [marker]))
            if arguments[:2] == ["s3api", "head-object"]:
                return json.dumps({"LastModified": self.now.isoformat()})
            self.assertEqual(arguments[:2], ["s3api", "delete-object"])
            self.assertIn("--version-id", arguments)
            return json.dumps({"VersionId": arguments[arguments.index("--version-id") + 1]})
        with patch.object(self.operation, "aws", side_effect=aws), redirect_stdout(io.StringIO()):
            self.operation.run_retention(now=self.now)
        self.assertEqual(len(commands), 4)
        listing = commands[0]
        self.assertEqual(listing[listing.index("--prefix") + 1], self.prefix + "/")
        self.assertEqual(listing[listing.index("--output") + 1], "json")
        for forbidden in ("--no-paginate", "--max-items", "--starting-token", "--query"):
            self.assertNotIn(forbidden, listing)
        self.assertEqual(commands[1], ["s3api", "head-object", "--bucket", self.operation.settings["S3_BUCKET"],
                                      "--key", f"{self.prefix}/{self.operation.run_id}/manifest.json", "--output", "json"])
        deleted = {(command[command.index("--key") + 1], command[command.index("--version-id") + 1])
                   for command in commands[2:]}
        self.assertEqual(deleted, {(old["Key"], old["VersionId"]), (marker["Key"], marker["VersionId"])})

    def test_mutable_null_versions_and_pagination_markers_prevent_partial_cleanup(self):
        null_version = self.version(version_id="null")
        old_version = self.version(version_id="immutable-version")
        with self.assertRaises(backup.BackupError):
            backup.retention_candidates(self.listing([old_version, null_version]), self.prefix, now=self.now)
        with patch.object(self.operation, "aws", return_value=json.dumps(self.listing([old_version, null_version]))) as aws, \
                redirect_stdout(io.StringIO()):
            with self.assertRaises(backup.BackupError):
                self.operation.run_retention(now=self.now)
        self.assertEqual(len(aws.call_args_list), 1, "An eligible mutable version must prevent all deletions")
        fresh_null = self.version(version_id="null", modified_age=timedelta(hours=1))
        foreign_null = self.version(version_id="null", key="another-system/backup.dump")
        self.assertEqual(backup.retention_candidates(self.listing([fresh_null, foreign_null]), self.prefix, now=self.now), [])
        for marker in ("NextToken", "NextKeyMarker", "NextVersionIdMarker"):
            with self.subTest(marker=marker):
                with self.assertRaises(backup.BackupError):
                    backup.retention_candidates({**self.listing([old_version]), marker: "next-page"}, self.prefix, now=self.now)
        with self.assertRaises(backup.BackupError):
            backup.retention_candidates({**self.listing([old_version]), "CommonPrefixes": [{"Prefix": "omitted/"}]},
                                        self.prefix, now=self.now)

    def test_dry_run_requires_no_verified_copy_but_performs_no_delete(self):
        operation = backup.Backup(settings(RETENTION_ENABLED="true"))
        with patch.object(operation, "aws", return_value=json.dumps(self.listing([self.version()]))) as aws, \
                redirect_stdout(io.StringIO()):
            operation.run_retention(dry_run=True, now=self.now)
        self.assertEqual(len(aws.call_args_list), 1)
        self.assertEqual(aws.call_args.args[0][:2], ["s3api", "list-object-versions"])

    def test_current_verified_run_is_protected_even_if_clock_jump_makes_it_look_old(self):
        old = self.version()
        self.operation.run_id = old["Key"].split(self.prefix + "/", 1)[1].split("/", 1)[0]
        self.operation.verified_backup_id = self.operation.run_id
        with patch.object(self.operation, "aws", return_value=json.dumps(self.listing([old]))) as aws, redirect_stdout(io.StringIO()):
            summary = self.operation.run_retention(now=self.now)
        self.assertEqual(len(aws.call_args_list), 1)
        self.assertEqual(summary["deleted_versions"], 0)

    def test_malformed_or_truncated_listing_is_fully_validated_before_any_deletion(self):
        old = self.version()
        malformed_records = [{}, {**old, "VersionId": ""}, {**old, "LastModified": "not-a-timestamp"},
                             {**old, "LastModified": "2030-04-01T12:00:00"},
                             {**old, "VersionId": "invalid\nidentifier"},
                             {**old, "VersionId": "new", "LastModified": (self.now + timedelta(minutes=6)).isoformat()},
                             {**old, "Key": f"{self.prefix}/20301399T120000Z-" + "a" * 32 + "/personnel.dump"}]
        listings = [[], {"Versions": "not-an-array"}, {**self.listing([old]), "IsTruncated": True},
                    {**self.listing([old]), "Name": "unrelated-bucket"},
                    {**self.listing([old]), "Prefix": "other-system/"}, self.listing([old, old]),
                    *[self.listing([old, bad]) for bad in malformed_records]]
        for document in listings:
            with self.subTest(document_type=type(document).__name__), \
                    patch.object(self.operation, "aws", return_value=json.dumps(document)) as aws, redirect_stdout(io.StringIO()):
                with self.assertRaises(backup.BackupError):
                    self.operation.run_retention(now=self.now)
                self.assertEqual(len(aws.call_args_list), 1, "No delete may precede full listing validation")

    def test_s3_errors_or_wrong_delete_version_are_failure_not_success(self):
        responses = [{"Errors": [{"Code": "AccessDenied", "Message": SECRET_KEY}]},
                     {"Error": {"Code": "AccessDenied", "Message": SECRET_KEY}},
                     {"VersionId": "old-version", "Errors": []},
                     {"VersionId": "old-version", "Unexpected": SECRET_KEY},
                     {"VersionId": "another-version"}, {}]
        for response in responses:
            output = io.StringIO()
            with self.subTest(response_keys=list(response)), \
                    patch.object(self.operation, "aws", side_effect=[json.dumps(self.listing([self.version()])),
                                                                     json.dumps({"LastModified": self.now.isoformat()}), json.dumps(response)]) as aws, \
                    redirect_stdout(output):
                with self.assertRaises(backup.BackupError) as raised:
                    self.operation.run_retention(now=self.now)
            self.assertEqual(aws.call_args.args[0][:2], ["s3api", "delete-object"])
            self.assertNotIn(SECRET_KEY, str(raised.exception))
            self.assertNotIn(SECRET_KEY, output.getvalue())

    def test_s3_time_check_accepts_recent_manifest_and_exact_five_minute_boundary(self):
        for offset in (timedelta(0), timedelta(seconds=-300), timedelta(seconds=300)):
            with self.subTest(offset=offset), patch.object(self.operation, "aws", side_effect=[
                    json.dumps(self.listing([self.version()])),
                    json.dumps({"LastModified": (self.now + offset).isoformat()}),
                    json.dumps({"VersionId": "old-version"}),
            ]) as aws, redirect_stdout(io.StringIO()):
                summary = self.operation.run_retention(now=self.now)
            self.assertEqual(summary["deleted_versions"], 1)
            self.assertEqual([call.args[0][1] for call in aws.call_args_list],
                             ["list-object-versions", "head-object", "delete-object"])

    def test_clock_jump_or_invalid_missing_manifest_time_prevents_all_deletion(self):
        invalid = [{"LastModified": (self.now - timedelta(seconds=301)).isoformat()},
                   {"LastModified": (self.now + timedelta(seconds=301)).isoformat()},
                   {"LastModified": (self.now - timedelta(days=40)).isoformat()},
                   {"LastModified": "2030-05-20T12:00:00"}, {"LastModified": SECRET_KEY}, {}, []]
        for metadata in invalid:
            output = io.StringIO()
            with self.subTest(metadata_type=type(metadata).__name__), patch.object(self.operation, "aws", side_effect=[
                    json.dumps(self.listing([self.version()])), json.dumps(metadata),
            ]) as aws, redirect_stdout(output):
                with self.assertRaises(backup.BackupError) as raised:
                    self.operation.run_retention(now=self.now)
            self.assertEqual([call.args[0][1] for call in aws.call_args_list], ["list-object-versions", "head-object"])
            self.assertNotIn(SECRET_KEY, output.getvalue())
            self.assertNotIn(SECRET_KEY, str(raised.exception))
        with patch.object(self.operation, "aws", side_effect=[json.dumps(self.listing([self.version()])),
                                                              backup.BackupError("Manifest metadata unavailable")]) as aws, \
                redirect_stdout(io.StringIO()):
            with self.assertRaises(backup.BackupError):
                self.operation.run_retention(now=self.now)
        self.assertEqual([call.args[0][1] for call in aws.call_args_list], ["list-object-versions", "head-object"])

    def test_no_expired_versions_does_not_request_manifest_metadata(self):
        with patch.object(self.operation, "aws", return_value=json.dumps(self.listing())) as aws, redirect_stdout(io.StringIO()):
            summary = self.operation.run_retention(now=self.now)
        self.assertEqual(summary["deleted_versions"], 0)
        self.assertEqual([call.args[0][1] for call in aws.call_args_list], ["list-object-versions"])


class WorkflowTests(TemporaryFiles):
    def execute(self, operation, directories):
        output = io.StringIO()
        with patch.object(backup.shutil, "disk_usage", return_value=SimpleNamespace(free=10**12)), redirect_stdout(output):
            operation.execute(*directories)
        return output.getvalue()

    def test_success_requires_download_hash_restore_then_verified_manifest(self):
        directories = self.directories()
        operation = FakeExternalServicesBackup(settings())
        output = self.execute(operation, directories)
        self.assertEqual(operation.operations, ["dump", "upload:personnel.dump", "download:downloaded.dump",
                                               "restore:downloaded.dump", "upload:manifest.json",
                                               "download:downloaded-manifest.json"])
        state, work, run = directories
        result = json.loads((state / "last-success.json").read_text())
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["sha256"], hashlib.sha256(ARCHIVE).hexdigest())
        manifest = json.loads(operation.objects[result["manifest_key"]])
        self.assertEqual(manifest["archive"]["key"], result["dump_key"])
        self.assertTrue(manifest["verification"]["s3_download_sha256"])
        self.assertTrue(manifest["verification"]["isolated_restore"])
        dump_call = next(call for call in operation.client_calls if call[0] == "dump")
        self.assertIn("--format=custom", dump_call[1])
        self.assertFalse(any(argument.startswith("--schema") for argument in dump_call[1]))
        self.assertEqual(dump_call[2]["network"], "container:" + settings()["APP_CONTAINER_PREFIX"] + "current")
        for secret in (ACCESS_KEY, SECRET_KEY, DATABASE_PASSWORD, CERTIFICATE):
            self.assertNotIn(secret, output)
            self.assertNotIn(secret, json.dumps(manifest))
            self.assertNotIn(secret, json.dumps(result))
        self.assertEqual(list(work.iterdir()), [])
        self.assertEqual(list(run.iterdir()), [])
        self.assertTrue(all(not path.exists() for path in operation.secret_files))

    def test_failed_steps_preserve_previous_success_and_remove_local_secrets(self):
        directories = self.directories()
        state, work, run = directories
        previous = {"status": "success", "backup_id": "previous-good-copy"}
        for failure in ("image-network", "image-daemon", "client-version", "target", "dump", "upload", "download-hash", "restore", "manifest-hash"):
            with self.subTest(failure=failure):
                backup.write_status(state, "last-success.json", previous)
                operation = FakeExternalServicesBackup(settings(), failure=failure)
                with self.assertRaises(backup.BackupError):
                    self.execute(operation, directories)
                self.assertEqual(json.loads((state / "last-success.json").read_text()), previous)
                self.assertEqual(list(work.iterdir()), [])
                self.assertEqual(list(run.iterdir()), [])
                self.assertTrue(all(not path.exists() for path in operation.secret_files))
                if failure != "manifest-hash":
                    self.assertFalse(any(key.endswith("manifest.json") for key in operation.objects))
                if failure == "download-hash":
                    self.assertFalse(any(stage.startswith("restore:") for stage in operation.operations))
                if failure in ("image-network", "image-daemon", "target", "client-version"):
                    self.assertNotIn("dump", operation.operations)
                    self.assertEqual(operation.objects, {})
                if failure in ("image-network", "image-daemon"):
                    self.assertEqual(operation.client_calls, [])

    def test_low_disk_space_prevents_upload_and_preserves_old_success(self):
        directories = self.directories()
        state, work, run = directories
        operation = FakeExternalServicesBackup(settings())
        with patch.object(backup.shutil, "disk_usage", return_value=SimpleNamespace(free=0)), redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(backup.BackupError, "disk space"):
                operation.execute(*directories)
        self.assertEqual(operation.objects, {})
        self.assertFalse((state / "last-success.json").exists())
        self.assertEqual(list(work.iterdir()), [])
        self.assertEqual(list(run.iterdir()), [])

    def test_failed_backup_never_reaches_retention_even_when_enabled(self):
        directories = self.directories()
        for failure in ("dump", "upload", "download-hash", "restore", "manifest-hash"):
            with self.subTest(failure=failure):
                operation = FakeExternalServicesBackup(settings(RETENTION_ENABLED="true"), failure=failure)
                with patch.object(operation, "run_retention") as retention:
                    with self.assertRaises(backup.BackupError):
                        self.execute(operation, directories)
                    retention.assert_not_called()


class MainStatusTests(TemporaryFiles):
    def main_context(self, directories, operation):
        context = ExitStack()
        configuration = settings(**dict(zip(("STATE_DIRECTORY", "WORK_DIRECTORY", "RUN_DIRECTORY"),
                                            map(str, directories))))
        context.enter_context(patch.object(backup, "load_config", return_value=configuration))
        real_uid = os.geteuid()
        identity_checks = iter([0])
        context.enter_context(patch.object(backup.os, "geteuid", side_effect=lambda: next(identity_checks, real_uid)))
        # Directory/ownership validation has its own real-filesystem tests above.
        context.enter_context(patch.object(backup, "private_directory", side_effect=Path))
        context.enter_context(patch.object(backup.shutil, "which", return_value="/unit-test/tool"))
        context.enter_context(patch.object(backup.shutil, "disk_usage", return_value=SimpleNamespace(free=10**12)))
        context.enter_context(patch.object(backup, "Backup", return_value=operation))
        previous_umask = os.umask(0o077)
        context.callback(os.umask, previous_umask)
        return context

    def test_failed_attempt_is_written_while_locked_and_does_not_replace_previous_success(self):
        directories = self.directories()
        state = directories[0]
        previous = {"status": "success", "backup_id": "previous-good-copy"}
        backup.write_status(state, "last-success.json", previous)
        operation = FakeExternalServicesBackup(settings())
        original_write_status = backup.write_status
        locked_failures = []
        def record(directory, name, value):
            if value.get("status") == "failed":
                with self.assertRaisesRegex(backup.BackupError, "already running"):
                    with backup.exclusive_lock(directory):
                        self.fail("Failure status was written after releasing the lock")
                locked_failures.append(value)
            original_write_status(directory, name, value)
        output = io.StringIO()
        with self.main_context(directories, operation), \
                patch.object(operation, "execute", side_effect=RuntimeError(SECRET_KEY)), \
                patch.object(backup, "write_status", side_effect=record), redirect_stdout(output):
            self.assertEqual(backup.main(["--config", "/not-read/unit-config"]), 1)
        self.assertEqual(len(locked_failures), 1)
        self.assertEqual(json.loads((state / "last-attempt.json").read_text())["status"], "failed")
        self.assertEqual(json.loads((state / "last-success.json").read_text()), previous)
        self.assertNotIn(SECRET_KEY, output.getvalue())
        self.assertNotIn(SECRET_KEY, (state / "last-attempt.json").read_text())
        with backup.exclusive_lock(state):
            pass

    def test_second_job_does_not_overwrite_the_running_jobs_status(self):
        directories = self.directories()
        state = directories[0]
        existing = {"status": "running", "backup_id": "first-job"}
        backup.write_status(state, "last-attempt.json", existing)
        operation = FakeExternalServicesBackup(settings())
        with backup.exclusive_lock(state), self.main_context(directories, operation), \
                patch.object(operation, "execute") as execute, redirect_stdout(io.StringIO()):
            self.assertEqual(backup.main(["--config", "/not-read/unit-config"]), 1)
            execute.assert_not_called()
        self.assertEqual(json.loads((state / "last-attempt.json").read_text()), existing)

    def test_retention_failure_preserves_new_verified_copy_but_marks_attempt_failed(self):
        directories = self.directories()
        state = directories[0]
        operation = FakeExternalServicesBackup(settings(RETENTION_ENABLED="true"))
        old_time = datetime.now(timezone.utc) - timedelta(days=31)
        old_id = old_time.strftime("%Y%m%dT%H%M%SZ") + "-" + "b" * 32
        old = {"Key": f"{backup.DEFAULTS['S3_PREFIX']}/{old_id}/personnel.dump", "VersionId": "old-version",
               "LastModified": old_time.isoformat()}
        commands = []
        def aws(arguments, _label):
            commands.append(arguments)
            self.assertTrue(any(key.endswith("manifest.json") for key in operation.objects))
            self.assertEqual(json.loads((state / "last-success.json").read_text())["backup_id"], operation.run_id)
            if arguments[:2] == ["s3api", "list-object-versions"]:
                return json.dumps({"Versions": [old], "DeleteMarkers": []})
            if arguments[:2] == ["s3api", "head-object"]:
                return json.dumps({"LastModified": datetime.now(timezone.utc).isoformat()})
            self.assertEqual(arguments[:2], ["s3api", "delete-object"])
            return json.dumps({"Errors": [{"Code": "AccessDenied", "Message": SECRET_KEY}]})
        output = io.StringIO()
        with self.main_context(directories, operation), patch.object(operation, "aws", side_effect=aws), redirect_stdout(output):
            self.assertEqual(backup.main(["--config", "/not-read/unit-config"]), 1)
        self.assertEqual(len(commands), 3)
        success = json.loads((state / "last-success.json").read_text())
        attempt = json.loads((state / "last-attempt.json").read_text())
        self.assertEqual(success["status"], "success")
        self.assertEqual(success["backup_id"], operation.run_id)
        self.assertEqual(attempt["status"], "failed")
        self.assertEqual(attempt["backup_id"], operation.run_id)
        self.assertEqual(attempt["phase"], "retention")
        self.assertNotIn(SECRET_KEY, output.getvalue())


class BackupStatusTests(TemporaryFiles):
    def setUp(self):
        super().setUp()
        self.now = datetime(2030, 5, 20, 12, 0, tzinfo=timezone.utc)
        self.state = self.root / "state"
        self.state.mkdir(mode=0o700)
        self.configuration = settings(STATE_DIRECTORY=str(self.state), MAX_BACKUP_AGE_HOURS="8")

    def records(self, age=timedelta(hours=1), attempt_status="success", now=None):
        now = now or self.now
        timestamp = (now - age).isoformat()
        success = {"status": "success", "completed_at_utc": timestamp,
                   "backup_id": "unit-test-verified", "bucket": "unit-test-bucket",
                   "manifest_key": "unit-test/manifest.json", "dump_key": "unit-test/personnel.dump",
                   "bytes": 1024, "sha256": "a" * 64}
        attempt = {**success, "status": attempt_status}
        if attempt_status == "running":
            attempt.pop("completed_at_utc")
            attempt["started_at_utc"] = (now - timedelta(minutes=5)).isoformat()
        elif attempt_status == "failed":
            attempt["completed_at_utc"] = (now - timedelta(minutes=5)).isoformat()
            attempt["error"] = SECRET_KEY
        backup.write_status(self.state, "last-success.json", success)
        backup.write_status(self.state, "last-attempt.json", attempt)
        return success, attempt

    def test_fresh_success_and_exact_eight_hour_boundary_are_healthy(self):
        for age in (timedelta(0), timedelta(hours=1), timedelta(hours=8)):
            with self.subTest(age=age):
                self.records(age=age)
                report, code = backup.backup_status(self.configuration, now=self.now)
                self.assertEqual(code, 0)
                self.assertEqual(report["status"], "healthy")
                self.assertAlmostEqual(report["age_hours"], age.total_seconds() / 3600, places=4)

    def test_old_success_is_stale_even_when_last_attempt_succeeded(self):
        self.records(age=timedelta(hours=8, seconds=1))
        report, code = backup.backup_status(self.configuration, now=self.now)
        self.assertNotEqual(code, 0)
        self.assertEqual(report["status"], "stale")

    def test_daily_schedule_uses_a_thirty_six_hour_default_freshness_window(self):
        configuration = settings(STATE_DIRECTORY=str(self.state))
        self.assertEqual(configuration["MAX_BACKUP_AGE_HOURS"], "36")
        for age, expected in ((timedelta(hours=24), "healthy"), (timedelta(hours=36), "healthy"),
                              (timedelta(hours=36, seconds=1), "stale")):
            with self.subTest(age=age):
                self.records(age=age)
                report, code = backup.backup_status(configuration, now=self.now)
                self.assertEqual(report["status"], expected)
                self.assertEqual(code == 0, expected == "healthy")

    def test_failed_or_running_attempt_is_not_masked_by_fresh_success(self):
        for attempt_status in ("failed", "running"):
            with self.subTest(attempt_status=attempt_status):
                self.records(attempt_status=attempt_status)
                report, code = backup.backup_status(self.configuration, now=self.now)
                self.assertNotEqual(code, 0)
                self.assertEqual(report["status"], attempt_status)
                self.assertEqual(report["last_attempt_status"], attempt_status)
                self.assertNotIn(SECRET_KEY, json.dumps(report))

    def test_future_timestamps_outside_clock_tolerance_are_rejected(self):
        self.records(age=timedelta(minutes=-6))
        report, code = backup.backup_status(self.configuration, now=self.now)
        self.assertNotEqual(code, 0)
        self.assertEqual(report["status"], "future")
        success, attempt = self.records()
        attempt["completed_at_utc"] = (self.now + timedelta(minutes=6)).isoformat()
        backup.write_status(self.state, "last-attempt.json", attempt)
        report, code = backup.backup_status(self.configuration, now=self.now)
        self.assertNotEqual(code, 0)
        self.assertEqual(report["status"], "future")

    def test_either_missing_state_file_is_not_healthy(self):
        for missing in ("last-success.json", "last-attempt.json"):
            with self.subTest(missing=missing):
                self.records()
                (self.state / missing).unlink()
                report, code = backup.backup_status(self.configuration, now=self.now)
                self.assertNotEqual(code, 0)
                self.assertEqual(report["status"], "missing")

    def test_malformed_json_timestamps_and_statuses_fail_without_exposing_contents(self):
        for malformed in (SECRET_KEY, "[]", json.dumps({"status": "success", "completed_at_utc": SECRET_KEY}),
                          json.dumps({"status": "success", "completed_at_utc": "2030-05-20T11:00:00"}),
                          json.dumps({"status": "unexpected", "completed_at_utc": self.now.isoformat()})):
            with self.subTest(malformed_type=malformed[:1]):
                self.records()
                (self.state / "last-success.json").write_text(malformed, encoding="utf-8")
                report, code = backup.backup_status(self.configuration, now=self.now)
                self.assertNotEqual(code, 0)
                self.assertEqual(report["status"], "invalid")
                self.assertNotIn(SECRET_KEY, json.dumps(report))

    def test_status_refuses_public_or_symlinked_state_file(self):
        self.records()
        success = self.state / "last-success.json"
        success.chmod(0o644)
        report, code = backup.backup_status(self.configuration, now=self.now)
        self.assertNotEqual(code, 0)
        self.assertEqual(report["status"], "invalid")
        success.chmod(0o600)
        elsewhere = self.root / "outside.json"
        success.rename(elsewhere)
        success.symlink_to(elsewhere)
        report, code = backup.backup_status(self.configuration, now=self.now)
        self.assertNotEqual(code, 0)
        self.assertEqual(report["status"], "invalid")

    def test_cli_status_is_read_only_and_uses_no_external_commands(self):
        self.records(now=datetime.now(timezone.utc))
        path = self.config(STATE_DIRECTORY=self.state)
        before = {item.name: (item.read_bytes(), item.stat().st_mtime_ns) for item in self.state.iterdir()}
        output = io.StringIO()
        previous_umask = os.umask(0o077)
        try:
            with patch.object(backup.subprocess, "run", side_effect=AssertionError("No subprocess allowed")), \
                    patch.object(backup, "private_directory", side_effect=AssertionError("No directory writes allowed")), \
                    patch.object(backup, "write_status", side_effect=AssertionError("No status writes allowed")), \
                    patch.object(backup, "Backup", side_effect=AssertionError("No backup execution allowed")), \
                    redirect_stdout(output):
                self.assertEqual(backup.main(["--config", str(path), "--status"]), 0)
        finally:
            os.umask(previous_umask)
        self.assertEqual(before, {item.name: (item.read_bytes(), item.stat().st_mtime_ns) for item in self.state.iterdir()})
        report = json.loads(output.getvalue())
        self.assertEqual(report["status"], "healthy")
        self.assertNotIn(SECRET_KEY, output.getvalue())


if __name__ == "__main__":
    unittest.main(verbosity=2)
