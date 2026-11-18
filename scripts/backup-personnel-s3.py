#!/usr/bin/env python3
"""Verified PostgreSQL backups for Personnel Accounting; never restores to production.

Requires Python 3.10+, Docker, AWS CLI v2 and a digest-pinned PostgreSQL 18 image.
A missing image is recovered using that exact digest. Configuration is a private
literal KEY=value file, not shell.
Every successful run downloads and restores its S3 object before publishing a
manifest. Optional retention removes only this system's versions older than 30
days, and only after a new backup has passed every verification step.
"""

import argparse
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit
import uuid


DEFAULTS = {
    "S3_BUCKET": "personnel-accounting-backups",
    "S3_ENDPOINT_URL": "https://s3.ru-6.storage.selcloud.ru",
    "AWS_DEFAULT_REGION": "ru-6",
    "S3_CA_BUNDLE": "",
    "S3_PREFIX": "personnel-accounting/production",
    "APP_CONTAINER_PREFIX": "qmwx1es9ldj6oz0pdrtsgkk6-",
    "EXPECTED_PGHOST": "master.d9725049-e1dd-492c-9a1e-81b4f96aa767.c.dbaas.selcloud.ru",
    "POSTGRES_IMAGE": "postgres@sha256:10a5c69a83035ab5239f5620d708520e8b28f5aa1f2b20143e6024532edadfb5",
    "STATE_DIRECTORY": "/var/lib/personnel-s3-backup",
    "WORK_DIRECTORY": "/var/lib/personnel-s3-backup/work",
    "RUN_DIRECTORY": "/run/personnel-s3-backup",
    "MIN_FREE_BYTES": "1073741824",
    "COMMAND_TIMEOUT_SECONDS": "900",
    "RESTORE_MEMORY": "768m",
    "RESTORE_CPUS": "1",
    "RETENTION_ENABLED": "false",
    "MAX_BACKUP_AGE_HOURS": "36",
}
SECRET_KEYS = {"AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"}
REQUIRED_TABLES = (
    "public.sites", "public.employees", "public.employee_project_assignments",
    "public.placement_entries", "public.timesheet_marks", "public.app_users",
    "public.personnel_reports", "public.personnel_report_rows",
    "public.equipment_entries", "public.equipment_timesheet_marks",
    "drizzle.__drizzle_migrations",
)
SAFE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
RETENTION_DAYS = 30
RETENTION_BUCKET = "personnel-accounting-backups"
RETENTION_PREFIX = "personnel-accounting/production"


class BackupError(Exception):
    """A deliberately non-sensitive error safe to put into the journal."""

    def __init__(self, message, *, returncode=None):
        super().__init__(message)
        self.returncode = returncode


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def event(stage, **values):
    print(json.dumps({"time_utc": utc_now(), "stage": stage, **values}), flush=True)


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_config(path):
    """Parse a private config without expansion, interpolation, or shell execution."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        raise BackupError("Cannot open config as a regular, non-symlink file") from None
    with os.fdopen(fd, encoding="utf-8") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise BackupError("Config must be owned by the running user and have mode 0600 or 0400")
        if info.st_size > 64 * 1024:
            raise BackupError("Config is unexpectedly large")
        values = {}
        for number, raw in enumerate(source, 1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            name, separator, value = line.partition("=")
            name, value = name.strip(), value.strip()
            if not separator or name not in DEFAULTS.keys() | SECRET_KEYS or name in values:
                raise BackupError(f"Invalid or repeated config key on line {number}")
            if value[:1] in {"'", '"'}:
                if len(value) < 2 or value[-1] != value[0]:
                    raise BackupError(f"Unmatched quotes on config line {number}")
                value = value[1:-1]
            if any(ord(character) < 32 or ord(character) == 127 for character in value):
                raise BackupError(f"Control character on config line {number}")
            values[name] = value
    for name in SECRET_KEYS:
        if not values.get(name) or values[name].startswith(("YOUR_", "REPLACE_", "<")):
            raise BackupError(f"Missing {name}")
    settings = {**DEFAULTS, **values}
    endpoint = urlsplit(settings["S3_ENDPOINT_URL"])
    if (endpoint.scheme != "https" or not endpoint.hostname or endpoint.username or endpoint.password
            or endpoint.query or endpoint.fragment or endpoint.path not in ("", "/")):
        raise BackupError("S3_ENDPOINT_URL must be a plain HTTPS endpoint without credentials or a path")
    try:
        endpoint.port
    except ValueError:
        raise BackupError("Invalid endpoint port") from None
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]", settings["S3_BUCKET"]):
        raise BackupError("S3_BUCKET must be a DNS-safe bucket name without dots for virtual-hosted TLS")
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)+", settings["AWS_DEFAULT_REGION"]):
        raise BackupError("AWS_DEFAULT_REGION must be an explicit region such as ru-6")
    if settings["S3_CA_BUNDLE"]:
        ca_path = Path(settings["S3_CA_BUNDLE"])
        try:
            ca_info = ca_path.lstat()
        except OSError:
            raise BackupError("Cannot read S3_CA_BUNDLE") from None
        if (not ca_path.is_absolute() or not stat.S_ISREG(ca_info.st_mode)
                or ca_info.st_uid not in (0, os.geteuid()) or ca_info.st_mode & 0o022):
            raise BackupError("S3_CA_BUNDLE must be a trusted regular file, not writable by group or others")
    if not re.fullmatch(r"[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*", settings["S3_PREFIX"]):
        raise BackupError("S3_PREFIX must be a nonempty relative prefix with safe path components")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]+-", settings["APP_CONTAINER_PREFIX"]):
        raise BackupError("APP_CONTAINER_PREFIX must be a specific container prefix ending in a hyphen")
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9.-]+", settings["EXPECTED_PGHOST"]):
        raise BackupError("EXPECTED_PGHOST must be an explicit database hostname")
    if not re.fullmatch(r"(?:docker\.io/library/)?postgres@sha256:[a-f0-9]{64}", settings["POSTGRES_IMAGE"]):
        raise BackupError("POSTGRES_IMAGE must identify the official PostgreSQL image by SHA256 digest")
    for name in ("STATE_DIRECTORY", "WORK_DIRECTORY", "RUN_DIRECTORY"):
        path_value = Path(settings[name])
        if (not path_value.is_absolute() or ".." in path_value.parts or len(path_value.parts) < 3
                or "," in settings[name] or ":" in settings[name]):
            raise BackupError(f"{name} must be a dedicated absolute directory path")
    for name, minimum, maximum in (("MIN_FREE_BYTES", 104857600, 10**15),
                                   ("COMMAND_TIMEOUT_SECONDS", 60, 7200)):
        try:
            value = int(settings[name])
        except ValueError:
            raise BackupError(f"Invalid {name}") from None
        if not minimum <= value <= maximum:
            raise BackupError(f"{name} is outside its supported range")
    if not re.fullmatch(r"[1-9][0-9]*(?:m|g)", settings["RESTORE_MEMORY"]):
        raise BackupError("RESTORE_MEMORY must be a Docker memory limit such as 768m")
    try:
        cpus = float(settings["RESTORE_CPUS"])
    except ValueError:
        raise BackupError("Invalid RESTORE_CPUS") from None
    if not 0.1 <= cpus <= 8:
        raise BackupError("RESTORE_CPUS must be between 0.1 and 8")
    settings["RETENTION_ENABLED"] = settings["RETENTION_ENABLED"].lower()
    if settings["RETENTION_ENABLED"] not in ("true", "false"):
        raise BackupError("RETENTION_ENABLED must be true or false")
    try:
        maximum_age = int(settings["MAX_BACKUP_AGE_HOURS"])
    except ValueError:
        raise BackupError("Invalid MAX_BACKUP_AGE_HOURS") from None
    if not 1 <= maximum_age <= 168:
        raise BackupError("MAX_BACKUP_AGE_HOURS must be between 1 and 168")
    if settings["RETENTION_ENABLED"] == "true":
        validate_retention_scope(settings)
    return settings


def validate_retention_scope(settings):
    if settings["S3_BUCKET"] != RETENTION_BUCKET or settings["S3_PREFIX"] != RETENTION_PREFIX:
        raise BackupError("Retention is limited to the Personnel Accounting production backup prefix")


def retention_candidates(listing, prefix, now=None):
    """Validate an entire paginated S3 result before planning any version deletion."""
    if prefix != RETENTION_PREFIX:
        raise BackupError("Unexpected retention prefix")
    current = now if now is not None else datetime.now(timezone.utc)
    if not isinstance(current, datetime) or current.tzinfo is None or current.utcoffset() is None:
        raise BackupError("Retention time must include a timezone")
    current = current.astimezone(timezone.utc)
    cutoff = current - timedelta(days=RETENTION_DAYS)
    allowed_fields = {"Versions", "DeleteMarkers", "CommonPrefixes", "IsTruncated", "NextToken",
                      "NextKeyMarker", "NextVersionIdMarker", "Name", "Prefix", "MaxKeys",
                      "KeyMarker", "VersionIdMarker", "EncodingType", "RequestCharged", "ResponseMetadata"}
    if not isinstance(listing, dict) or set(listing) - allowed_fields:
        raise BackupError("Unexpected S3 version-list response")
    if (listing.get("IsTruncated", False) is not False
            or any(listing.get(key) for key in ("NextToken", "NextKeyMarker", "NextVersionIdMarker"))
            or listing.get("CommonPrefixes")):
        raise BackupError("S3 version listing is incomplete; retention stopped")
    if listing.get("Name", RETENTION_BUCKET) != RETENTION_BUCKET or listing.get("Prefix", prefix + "/") != prefix + "/":
        raise BackupError("S3 version-list scope does not match the backup prefix")
    if listing.get("EncodingType") not in (None, ""):
        raise BackupError("Encoded S3 keys are not accepted for retention")
    candidates, seen = [], set()
    pattern = re.compile(re.escape(prefix) + r"/(\d{8}T\d{6}Z)-[0-9a-f]{32}/(?:personnel\.dump|manifest\.json)\Z")
    for kind in ("Versions", "DeleteMarkers"):
        items = listing.get(kind, [])
        if not isinstance(items, list):
            raise BackupError("Invalid S3 version collection")
        for item in items:
            if not isinstance(item, dict):
                raise BackupError("Invalid S3 version record")
            allowed_item_fields = {"Key", "VersionId", "IsLatest", "LastModified", "Owner"}
            if kind == "Versions":
                allowed_item_fields |= {"ETag", "ChecksumAlgorithm", "ChecksumType", "Size", "StorageClass", "RestoreStatus"}
            if set(item) - allowed_item_fields:
                raise BackupError("Unexpected S3 version metadata")
            key, version = item.get("Key"), item.get("VersionId")
            if (not isinstance(key, str) or not key or len(key.encode("utf-8")) > 1024
                    or not isinstance(version, str) or not version or len(version) > 1024
                    or any(ord(character) < 32 or ord(character) == 127 for character in key + version)):
                raise BackupError("S3 version record has an invalid key or version identifier")
            if "IsLatest" in item and not isinstance(item["IsLatest"], bool):
                raise BackupError("Invalid S3 version metadata")
            if (key, version) in seen:
                raise BackupError("Duplicate S3 version in retention listing")
            seen.add((key, version))
            modified = parse_status_time(item.get("LastModified"))
            if modified > current + timedelta(minutes=5):
                raise BackupError("S3 object time is unexpectedly in the future; retention stopped")
            matched = pattern.fullmatch(key)
            if not matched:
                continue
            try:
                run_time = datetime.strptime(matched.group(1), "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
            except ValueError:
                raise BackupError("Invalid timestamp in a backup identifier") from None
            if run_time < cutoff and modified < cutoff:
                # A null version can be replaced in place while versioning is
                # suspended. Deleting it after a listing could then remove fresh
                # contents. Require an immutable version ID for automatic cleanup.
                if version == "null":
                    raise BackupError("An expired unversioned backup requires manual review; retention stopped")
                candidates.append({"Key": key, "VersionId": version})
    return sorted(candidates, key=lambda item: (item["Key"], item["VersionId"]))


def private_directory(path):
    path = Path(path)
    # Reject existing symlink ancestors instead of following them with root rights.
    for ancestor in reversed((path, *path.parents)):
        if ancestor.exists() and ancestor.is_symlink():
            raise BackupError("A backup directory contains a symbolic link")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise BackupError("Backup directories must belong to the running user and have mode 0700")
    return path


def write_private(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as output:
        output.write(data)


def write_status(directory, name, value):
    destination = directory / name
    fd, temporary = tempfile.mkstemp(prefix=".status-", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(value, output, indent=2)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_private_status(path):
    """Read only the runner's small private status files, never following links."""
    for ancestor in (path.parent, *path.parent.parents):
        if ancestor.is_symlink():
            raise BackupError("A status directory contains a symbolic link")
    parent_info = path.parent.stat()
    if (not stat.S_ISDIR(parent_info.st_mode) or parent_info.st_uid != os.geteuid()
            or parent_info.st_mode & 0o077):
        raise BackupError("Unsafe status directory permissions")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, encoding="utf-8") as source:
        info = os.fstat(source.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or info.st_mode & 0o077 or info.st_size > 64 * 1024):
            raise BackupError("Unsafe status file")
        value = json.load(source)
    if not isinstance(value, dict):
        raise BackupError("Invalid status document")
    return value


def parse_status_time(value):
    if not isinstance(value, str) or len(value) > 40:
        raise BackupError("Invalid status timestamp")
    try:
        timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise BackupError("Invalid status timestamp") from None
    if timestamp.tzinfo is None or timestamp.utcoffset() is None:
        raise BackupError("Status timestamps must include a timezone")
    return timestamp.astimezone(timezone.utc)


def backup_status(settings, now=None):
    """Offline monitoring: a successful attempt and a recent verified copy.

    The report deliberately excludes S3 paths, credentials and raw error strings
    from status JSON. Missing, running, failed, malformed or stale state is not
    healthy. Future timestamps beyond five minutes are rejected as clock errors.
    """
    report = {"status": "invalid", "last_success_at_utc": None, "age_hours": None,
              "last_attempt_at_utc": None, "last_attempt_status": None,
              "last_attempt_error": None}
    current = now if now is not None else datetime.now(timezone.utc)
    if current.tzinfo is None or current.utcoffset() is None:
        return report, 1
    current = current.astimezone(timezone.utc)
    directory = Path(settings["STATE_DIRECTORY"])
    try:
        success = read_private_status(directory / "last-success.json")
        attempt = read_private_status(directory / "last-attempt.json")
        if success.get("status") != "success" or attempt.get("status") not in ("success", "failed", "running"):
            raise BackupError("Invalid backup status")
        success_time = parse_status_time(success.get("completed_at_utc"))
        attempt_status = attempt["status"]
        attempt_time = parse_status_time(attempt.get("started_at_utc" if attempt_status == "running" else "completed_at_utc"))
        age_seconds = (current - success_time).total_seconds()
        if age_seconds < -300 or (current - attempt_time).total_seconds() < -300:
            report["status"] = "future"
            return report, 1
        report.update(last_success_at_utc=success_time.isoformat(), age_hours=round(max(0, age_seconds) / 3600, 4),
                      last_attempt_at_utc=attempt_time.isoformat(), last_attempt_status=attempt_status)
        if attempt_status == "failed":
            report.update(status="failed", last_attempt_error="Last backup failed; inspect the protected service journal")
        elif attempt_status == "running":
            report["status"] = "running"
        elif attempt_time < success_time:
            # Covers partial/inconsistent state without declaring it healthy.
            report["status"] = "invalid"
        elif age_seconds > int(settings.get("MAX_BACKUP_AGE_HOURS", DEFAULTS["MAX_BACKUP_AGE_HOURS"])) * 3600:
            report["status"] = "stale"
        else:
            report["status"] = "healthy"
            return report, 0
    except FileNotFoundError:
        report["status"] = "missing"
    except (BackupError, OSError, ValueError, TypeError, OverflowError):
        report["status"] = "invalid"
    return report, 1


@contextmanager
def exclusive_lock(directory):
    fd = os.open(directory / "backup.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise BackupError("Unsafe backup lock file")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise BackupError("Another backup is already running") from None
        yield
    finally:
        os.close(fd)


@dataclass
class Backup:
    settings: dict = field(repr=False)
    containers: set = field(default_factory=set)
    volumes: set = field(default_factory=set)
    process_environment: dict = field(default_factory=lambda: {"PATH": SAFE_PATH, "LANG": "C.UTF-8"}, repr=False)
    aws_environment: dict = field(default_factory=dict, repr=False)
    run_id: str = field(default_factory=lambda: datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex)
    verified_backup_id: str | None = None
    phase: str = "backup"

    @property
    def image(self):
        return self.settings["POSTGRES_IMAGE"]

    @property
    def timeout(self):
        return int(self.settings["COMMAND_TIMEOUT_SECONDS"])

    def run(self, arguments, label, *, timeout=None, environment=None, input_text=None):
        try:
            result = subprocess.run(arguments, input=input_text, text=True, capture_output=True,
                                    timeout=timeout or self.timeout,
                                    env=environment if environment is not None else self.process_environment)
        except subprocess.TimeoutExpired:
            raise BackupError(f"{label} timed out") from None
        except OSError:
            raise BackupError(f"Cannot execute {label}") from None
        if result.returncode:
            # PostgreSQL errors can contain personal data and Docker inspect has secrets.
            # Never relay command output, args, exception reprs, or credentials to logs.
            raise BackupError(f"{label} failed (exit {result.returncode})", returncode=result.returncode)
        return result.stdout

    def ensure_image(self):
        """Recover the exact pinned dependency if an external image prune removed it."""
        if not re.fullmatch(r"(?:docker\.io/library/)?postgres@sha256:[a-f0-9]{64}", self.image):
            raise BackupError("Image recovery requires an official PostgreSQL image pinned by SHA256 digest")
        inspection = ["docker", "image", "inspect", self.image, "--format", "{{.Id}}"]
        try:
            self.run(inspection, "checking pinned PostgreSQL image", timeout=30)
            return
        except BackupError as error:
            # Missing images return exit 1. A timeout, missing CLI, or other error
            # is not a reason to contact a registry. Check the daemon separately
            # before attempting recovery so a stopped daemon fails immediately.
            if error.returncode != 1:
                raise
        self.run(["docker", "info", "--format", "{{.ServerVersion}}"],
                 "checking Docker daemon before image restore", timeout=30)
        event("postgres_image_restore_started", image=self.image)
        self.run(["docker", "pull", self.image], "restoring pinned PostgreSQL image", timeout=300)
        self.run(inspection, "checking pinned PostgreSQL image", timeout=30)
        event("postgres_image_restore_completed", image=self.image)

    def remove_container(self, name):
        exists = self.run(["docker", "container", "ls", "--all", "--filter", f"name=^/{name}$", "--format", "{{.Names}}"],
                          "checking temporary container", timeout=30).splitlines()
        if name in exists:
            self.run(["docker", "rm", "--force", "--volumes", name], "removing temporary container", timeout=60)
        self.containers.discard(name)

    def cleanup(self):
        errors = []
        for name in tuple(self.containers):
            try:
                self.remove_container(name)
            except BackupError as error:
                errors.append(str(error))
        # Keep a volume if its container could not be removed; never force-delete data
        # belonging to a still-running process or remove a non-task resource.
        if not self.containers:
            for name in tuple(self.volumes):
                try:
                    existing = self.run(["docker", "volume", "ls", "--filter", f"name=^{name}$", "--format", "{{.Name}}"],
                                        "checking temporary restore volume", timeout=30).splitlines()
                    if name in existing:
                        self.run(["docker", "volume", "rm", name], "removing restore volume", timeout=60)
                    self.volumes.discard(name)
                except BackupError as error:
                    errors.append(str(error))
        if errors:
            raise BackupError("Temporary restore cleanup failed; inspect personnel-s3-backup resources on the host")

    def client(self, suffix, arguments, *, environment_file=None, mounts=(), network="none"):
        name = f"personnel-s3-backup-{self.run_id.lower()}-{suffix}"
        self.containers.add(name)
        command = ["docker", "run", "--name", name, "--rm", "--pull=never", "--network", network,
                   "--memory", self.settings["RESTORE_MEMORY"], "--cpus", self.settings["RESTORE_CPUS"],
                   "--pids-limit", "128", "--security-opt", "no-new-privileges"]
        if environment_file:
            command += ["--env-file", str(environment_file)]
        for mount in mounts:
            command += ["--mount", mount]
        try:
            return self.run([*command, self.image, *arguments], f"PostgreSQL {suffix}")
        finally:
            self.remove_container(name)

    def inspect_source(self):
        names = self.run(["docker", "ps", "--format", "{{.Names}}"], "listing application containers", timeout=30).splitlines()
        matches = [name for name in names if name.startswith(self.settings["APP_CONTAINER_PREFIX"])]
        if len(matches) != 1:
            raise BackupError("Expected exactly one running Personnel Accounting application; retry after deployment")
        app = matches[0]
        info = json.loads(self.run(["docker", "inspect", app], "inspecting application", timeout=30))[0]
        if info["State"].get("Health", {}).get("Status") != "healthy":
            raise BackupError("The production application is not healthy")
        environment = dict(value.split("=", 1) for value in info["Config"]["Env"] if "=" in value)
        if (environment.get("DATABASE_URL") or environment.get("PGHOST") != self.settings["EXPECTED_PGHOST"]
                or environment.get("PGDATABASE") != "personnel" or environment.get("PGUSER") != "personnel"):
            raise BackupError("Application database target differs from the expected production database")
        if (environment.get("DATABASE_SSL") != "verify-full" or not environment.get("DATABASE_CA_CERT")
                or not environment.get("PGPASSWORD")):
            raise BackupError("Production database credentials or verified TLS certificate are missing")
        if not re.fullmatch(r"[0-9]{1,5}", environment.get("PGPORT", "5432")):
            raise BackupError("Unexpected production PostgreSQL port")
        return app, environment, info.get("Image", "")

    def configure_aws(self, secret_directory):
        aws_config = secret_directory / "aws.config"
        write_private(aws_config, "[default]\nregion = " + self.settings["AWS_DEFAULT_REGION"]
                      + "\ns3 =\n    addressing_style = virtual\n    max_concurrent_requests = 2\n"
                        "    multipart_threshold = 64MB\n    multipart_chunksize = 64MB\n")
        self.aws_environment = {
            **self.process_environment,
            "AWS_ACCESS_KEY_ID": self.settings["AWS_ACCESS_KEY_ID"],
            "AWS_SECRET_ACCESS_KEY": self.settings["AWS_SECRET_ACCESS_KEY"],
            "AWS_DEFAULT_REGION": self.settings["AWS_DEFAULT_REGION"],
            "AWS_CONFIG_FILE": str(aws_config), "AWS_SHARED_CREDENTIALS_FILE": "/dev/null",
            "AWS_EC2_METADATA_DISABLED": "true", "AWS_PAGER": "", "AWS_RETRY_MODE": "standard",
            "AWS_MAX_ATTEMPTS": "4", "AWS_REQUEST_CHECKSUM_CALCULATION": "when_required",
            "AWS_RESPONSE_CHECKSUM_VALIDATION": "when_required",
        }
        if self.settings["S3_CA_BUNDLE"]:
            self.aws_environment["AWS_CA_BUNDLE"] = self.settings["S3_CA_BUNDLE"]

    def aws(self, arguments, label):
        return self.run(["aws", "--no-cli-pager", "--endpoint-url", self.settings["S3_ENDPOINT_URL"],
                         "--region", self.settings["AWS_DEFAULT_REGION"], "--cli-connect-timeout", "15",
                         "--cli-read-timeout", "120", *arguments], label, environment=self.aws_environment)

    def upload(self, source, key):
        self.aws(["s3", "cp", str(source), f"s3://{self.settings['S3_BUCKET']}/{key}",
                  "--only-show-errors", "--no-progress"], "S3 upload")

    def download(self, key, destination):
        self.aws(["s3", "cp", f"s3://{self.settings['S3_BUCKET']}/{key}", str(destination),
                  "--only-show-errors", "--no-progress"], "S3 verification download")

    def run_retention(self, *, dry_run=False, now=None):
        enabled = self.settings.get("RETENTION_ENABLED", DEFAULTS["RETENTION_ENABLED"]) == "true"
        summary = {"enabled": enabled, "dry_run": dry_run, "retention_days": RETENTION_DAYS,
                   "candidate_versions": 0, "deleted_versions": 0}
        if not enabled and not dry_run:
            event("retention_disabled", **summary)
            return summary
        validate_retention_scope(self.settings)
        if not dry_run and self.verified_backup_id != self.run_id:
            raise BackupError("Retention requires a newly verified backup from the current run")
        # AWS CLI combines every page. Do not add --max-items, --no-paginate or
        # a delimiter: they can silently turn a complete inventory into a subset.
        listing = json.loads(self.aws(["s3api", "list-object-versions", "--bucket", self.settings["S3_BUCKET"],
                             "--prefix", self.settings["S3_PREFIX"] + "/", "--output", "json"],
                            "listing all S3 backup versions"))
        current = now if now is not None else datetime.now(timezone.utc)
        candidates = retention_candidates(listing, self.settings["S3_PREFIX"], now=current)
        if not dry_run:
            protected_prefix = f"{self.settings['S3_PREFIX']}/{self.run_id}/"
            candidates = [item for item in candidates if not item["Key"].startswith(protected_prefix)]
        summary["candidate_versions"] = len(candidates)
        if dry_run:
            event("retention_dry_run", **summary)
            return summary
        if candidates:
            # A large forward jump in the host clock could make recent copies
            # appear expired. This manifest was just uploaded and verified, so
            # its S3 timestamp anchors the retention clock before any deletion.
            manifest_key = f"{self.settings['S3_PREFIX']}/{self.run_id}/manifest.json"
            head = json.loads(self.aws(["s3api", "head-object", "--bucket", self.settings["S3_BUCKET"],
                              "--key", manifest_key, "--output", "json"],
                             "verifying S3 time before retention"))
            if not isinstance(head, dict):
                raise BackupError("S3 did not confirm the current verified backup manifest")
            server_time = parse_status_time(head.get("LastModified"))
            if abs((current - server_time).total_seconds()) > 300:
                raise BackupError("Local time differs from the new S3 manifest timestamp; retention stopped")
        event("retention_started", **summary)
        try:
            for candidate in candidates:
                # Explicit VersionId also removes old delete markers permanently.
                # Never issue an unversioned DELETE, which would create a new marker.
                response = json.loads(self.aws(["s3api", "delete-object", "--bucket", self.settings["S3_BUCKET"],
                                     "--key", candidate["Key"], "--version-id", candidate["VersionId"],
                                     "--output", "json"], "deleting expired backup version"))
                if (not isinstance(response, dict)
                        or set(response) - {"VersionId", "DeleteMarker", "RequestCharged", "ResponseMetadata"}
                        or response.get("VersionId") != candidate["VersionId"]
                        or "DeleteMarker" in response and not isinstance(response["DeleteMarker"], bool)):
                    raise BackupError("S3 did not confirm deletion of the requested backup version")
                summary["deleted_versions"] += 1
        except Exception:
            event("retention_failed", **summary)
            raise
        event("retention_completed", **summary)
        return summary

    def verify_restore(self, directory, filename):
        name = f"personnel-s3-backup-{self.run_id.lower()}-verify"
        volume = f"personnel-s3-backup-{self.run_id.lower()}-data"
        self.volumes.add(volume)
        self.run(["docker", "volume", "create", "--label", "purpose=personnel-s3-backup-restore", volume],
                 "creating isolated restore volume", timeout=30)
        volume_path = self.run(["docker", "volume", "inspect", volume, "--format", "{{.Mountpoint}}"],
                               "checking restore storage", timeout=30).strip()
        if not Path(volume_path).is_absolute() or shutil.disk_usage(volume_path).free < int(self.settings["MIN_FREE_BYTES"]):
            raise BackupError("Insufficient local Docker volume space for restore verification")
        self.containers.add(name)
        self.run(["docker", "run", "--detach", "--name", name, "--pull=never", "--network", "none",
                  "--memory", self.settings["RESTORE_MEMORY"], "--cpus", self.settings["RESTORE_CPUS"],
                  "--pids-limit", "128", "--security-opt", "no-new-privileges",
                  "--mount", f"type=volume,src={volume},dst=/var/lib/postgresql",
                  "--mount", f"type=bind,src={directory},dst=/backup,readonly",
                  "--env", "POSTGRES_HOST_AUTH_METHOD=trust", "--env", "POSTGRES_USER=personnel",
                  "--env", "POSTGRES_DB=personnel", self.image], "starting isolated PostgreSQL", timeout=60)
        deadline = time.monotonic() + 90
        while True:
            try:
                self.run(["docker", "exec", name, "sh", "-c",
                          'test "$(cat /proc/1/comm)" = postgres && pg_isready -U personnel -d personnel'],
                         "waiting for isolated PostgreSQL", timeout=10)
                break
            except BackupError:
                if time.monotonic() >= deadline:
                    raise BackupError("Isolated PostgreSQL did not become ready") from None
                time.sleep(1)
        self.run(["docker", "exec", name, "pg_restore", "--no-password", "--exit-on-error",
                  "--single-transaction", "--no-owner", "--no-privileges", "--no-tablespaces",
                  "-U", "personnel", "--dbname=personnel", f"/backup/{filename}"], "isolated archive restore")
        def query(sql):
            return self.run(["docker", "exec", "-i", name, "psql", "-X", "-A", "-t", "--no-password",
                             "--set", "ON_ERROR_STOP=1", "-U", "personnel", "-d", "personnel"],
                            "checking restored database", input_text=sql)
        present = json.loads(query("SELECT json_agg(name) FROM unnest(ARRAY["
                                   + ",".join("'" + value + "'" for value in REQUIRED_TABLES)
                                   + "]) AS name WHERE to_regclass(name) IS NOT NULL;"))
        if set(present or ()) != set(REQUIRED_TABLES):
            raise BackupError("Restored archive is missing required Personnel Accounting tables or migration history")
        count_queries = query("""SELECT format('SELECT json_build_object(''schema'',%L,''rows'',count(*)) FROM %I.%I;',
            table_schema,table_schema,table_name) FROM information_schema.tables
            WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type='BASE TABLE'
            ORDER BY table_schema,table_name;""")
        counts = [json.loads(line) for line in query(count_queries).splitlines() if line.strip()]
        public = [item for item in counts if item["schema"] == "public"]
        if not public or sum(item["rows"] for item in public) == 0:
            raise BackupError("Restored archive has no application data")
        result = {"all_table_count": len(counts), "public_table_count": len(public),
                  "public_row_count": sum(item["rows"] for item in public),
                  "required_tables_present": True}
        self.cleanup()
        return result

    def execute(self, state_directory, work_directory, run_directory):
        started = utc_now()
        with tempfile.TemporaryDirectory(prefix="job-", dir=work_directory) as work, \
                tempfile.TemporaryDirectory(prefix="secrets-", dir=run_directory) as secrets:
            directory, secret_directory = Path(work), Path(secrets)
            self.configure_aws(secret_directory)
            self.ensure_image()
            version = self.client("version", ["pg_dump", "--version"]).strip()
            if not re.match(r"pg_dump \(PostgreSQL\) 18(?:\.|\s|$)", version):
                raise BackupError("The pinned client image is not PostgreSQL 18")
            app, environment, app_image = self.inspect_source()
            ca = secret_directory / "database-ca.pem"
            write_private(ca, environment["DATABASE_CA_CERT"].replace("\\n", "\n"))
            pg_env = {
                "PGHOST": self.settings["EXPECTED_PGHOST"], "PGPORT": environment.get("PGPORT", "5432"),
                "PGDATABASE": "personnel", "PGUSER": "personnel", "PGPASSWORD": environment["PGPASSWORD"],
                "PGSSLMODE": "verify-full", "PGSSLROOTCERT": "/run/secrets/database-ca.pem",
                "PGCONNECT_TIMEOUT": "15", "PGAPPNAME": "personnel-s3-backup",
                "PGOPTIONS": f"-c default_transaction_read_only=on -c statement_timeout={self.timeout * 1000}",
            }
            if any("\n" in value or "\r" in value or "\0" in value for value in pg_env.values()):
                raise BackupError("Unsupported control character in PostgreSQL connection configuration")
            env_file = secret_directory / "database.env"
            write_private(env_file, "".join(f"{key}={value}\n" for key, value in pg_env.items()))
            mount = f"type=bind,src={directory},dst=/backup"
            ca_mount = f"type=bind,src={ca},dst=/run/secrets/database-ca.pem,readonly"
            # Also verify server identity/version before dumping. No writes to source.
            target = json.loads(self.client("target", ["psql", "-X", "-A", "-t", "--no-password",
                    "--set", "ON_ERROR_STOP=1", "-c", "SELECT json_build_object('database',current_database(),"
                    "'user',current_user,'version',current_setting('server_version_num')::int,"
                    "'database_bytes',pg_database_size(current_database()));"],
                    environment_file=env_file, mounts=(ca_mount,), network=f"container:{app}"))
            if (not isinstance(target, dict) or target.get("database") != "personnel"
                    or target.get("user") != "personnel"
                    or not 180000 <= int(target.get("version", 0)) < 190000
                    or not isinstance(target.get("database_bytes"), int) or target["database_bytes"] <= 0):
                raise BackupError("Connected source is not the expected PostgreSQL 18 personnel database")
            docker_root = self.run(["docker", "info", "--format", "{{.DockerRootDir}}"],
                                   "checking Docker storage directory", timeout=30).strip()
            if not Path(docker_root).is_absolute():
                raise BackupError("Docker did not report an absolute local storage directory")
            restore_space = target["database_bytes"] * 2 + int(self.settings["MIN_FREE_BYTES"])
            if shutil.disk_usage(docker_root).free < restore_space:
                raise BackupError("Insufficient Docker disk space for an isolated restore of this database")
            event("dump_started", backup_id=self.run_id)
            dump = directory / "personnel.dump"
            self.client("dump", ["pg_dump", "--no-password", "--format=custom", "--compress=6",
                                 "--lock-wait-timeout=15s", "--file=/backup/personnel.dump"],
                        environment_file=env_file, mounts=(mount, ca_mount), network=f"container:{app}")
            del environment, pg_env
            env_file.unlink()
            ca.unlink()
            if not dump.is_file() or dump.stat().st_size < 1024:
                raise BackupError("PostgreSQL archive is unexpectedly small")
            os.chmod(dump, 0o600)
            size, digest = dump.stat().st_size, sha256_file(dump)
            # pg_restore plus download need more disk; source backup remains read-only.
            if shutil.disk_usage(work_directory).free < int(self.settings["MIN_FREE_BYTES"]) + size * 3:
                raise BackupError("Insufficient local free space to download and verify the backup")
            if shutil.disk_usage(docker_root).free < restore_space + size * 3:
                raise BackupError("Insufficient Docker disk space for archive download and restore verification")
            key_base = f"{self.settings['S3_PREFIX']}/{self.run_id}"
            dump_key = key_base + "/personnel.dump"
            self.upload(dump, dump_key)
            downloaded = directory / "downloaded.dump"
            self.download(dump_key, downloaded)
            if downloaded.stat().st_size != size or sha256_file(downloaded) != digest:
                raise BackupError("The downloaded S3 archive does not match the source SHA256")
            event("s3_archive_verified", backup_id=self.run_id, bytes=size)
            restored = self.verify_restore(directory, downloaded.name)
            manifest = {
                "format": "personnel-postgresql-s3-backup-v1", "status": "verified", "backup_id": self.run_id,
                "started_at_utc": started, "completed_at_utc": utc_now(),
                "source": {"database": "personnel", "postgres_version_num": target["version"],
                           "database_bytes_before_dump": target["database_bytes"],
                           "application_image_id": app_image, "tls": "verify-full"},
                "archive": {"format": "PostgreSQL custom", "bucket": self.settings["S3_BUCKET"],
                            "key": dump_key, "bytes": size, "sha256": digest},
                "client_version": version, "client_image": self.image,
                "verification": {"s3_download_sha256": True, "isolated_restore": True,
                                 "single_transaction": True, "temporary_database_removed": True, **restored},
            }
            manifest_file = directory / "manifest.json"
            write_private(manifest_file, json.dumps(manifest, indent=2) + "\n")
            manifest_key = key_base + "/manifest.json"
            # Presence of this object is the completion marker. Failed jobs may have
            # an unverified dump but never publish a successful restore manifest.
            self.upload(manifest_file, manifest_key)
            downloaded_manifest = directory / "downloaded-manifest.json"
            self.download(manifest_key, downloaded_manifest)
            if sha256_file(downloaded_manifest) != sha256_file(manifest_file):
                raise BackupError("The downloaded S3 manifest does not match")
            success = {"status": "success", "completed_at_utc": utc_now(), "backup_id": self.run_id,
                       "bucket": self.settings["S3_BUCKET"], "manifest_key": manifest_key,
                       "dump_key": dump_key, "bytes": size, "sha256": digest}
            write_status(state_directory, "last-success.json", success)
            self.verified_backup_id = self.run_id
            event("backup_verified", **success)
            if self.settings.get("RETENTION_ENABLED", DEFAULTS["RETENTION_ENABLED"]) == "true":
                self.phase = "retention"
                write_status(state_directory, "last-attempt.json", {"status": "running", "phase": self.phase,
                             "started_at_utc": utc_now(), "backup_id": self.run_id})
            self.run_retention()
            self.phase = "complete"
            completed = {**success, "phase": self.phase, "completed_at_utc": utc_now()}
            write_status(state_directory, "last-attempt.json", completed)
            event("backup_succeeded", **completed)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", required=True, type=Path, help="Private literal KEY=value config (0600)")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check-config", action="store_true", help="Validate config without Docker, network or writes")
    mode.add_argument("--status", action="store_true", help="Read private local status; default maximum backup age is 36 hours")
    mode.add_argument("--retention-dry-run", action="store_true", help="List expired version counts without deleting S3 objects or changing backup status")
    arguments = parser.parse_args(argv)
    os.umask(0o077)
    backup = None

    def failure_record(error):
        message = str(error) if isinstance(error, BackupError) else "Backup failed due to an unexpected local or response-format error"
        record = {"status": "failed", "completed_at_utc": utc_now(), "error": message}
        if backup:
            record["backup_id"] = backup.run_id
            record["phase"] = backup.phase
        return record

    try:
        settings = load_config(arguments.config)
        if arguments.status:
            report, exit_code = backup_status(settings)
            event("backup_status", **report)
            return exit_code
        if arguments.check_config:
            event("config_valid", bucket=settings["S3_BUCKET"], prefix=settings["S3_PREFIX"],
                  endpoint=settings["S3_ENDPOINT_URL"], region=settings["AWS_DEFAULT_REGION"])
            return 0
        if arguments.retention_dry_run:
            if not shutil.which("aws", path=SAFE_PATH):
                raise BackupError("Required executable is not installed: aws")
            backup = Backup(settings)
            with tempfile.TemporaryDirectory(prefix="personnel-retention-check-") as temporary:
                backup.configure_aws(Path(temporary))
                backup.run_retention(dry_run=True)
            return 0
        if os.geteuid() != 0:
            raise BackupError("Run scheduled backups as root on the application host")
        for executable in ("docker", "aws"):
            if not shutil.which(executable, path=SAFE_PATH):
                raise BackupError(f"Required executable is not installed: {executable}")
        state_directory = private_directory(settings["STATE_DIRECTORY"])
        with exclusive_lock(state_directory):
            try:
                work_directory = private_directory(settings["WORK_DIRECTORY"])
                run_directory = private_directory(settings["RUN_DIRECTORY"])
                if shutil.disk_usage(work_directory).free < int(settings["MIN_FREE_BYTES"]):
                    raise BackupError("Insufficient local free disk space for a backup")
                backup = Backup(settings)
                write_status(state_directory, "last-attempt.json", {"status": "running", "started_at_utc": utc_now(),
                             "backup_id": backup.run_id})
                try:
                    backup.execute(state_directory, work_directory, run_directory)
                finally:
                    backup.cleanup()
            except Exception as error:
                # Record failure while still holding the lock; a newly started job
                # must not have its running/success state overwritten by this job.
                try:
                    write_status(state_directory, "last-attempt.json", failure_record(error))
                except OSError:
                    pass
                raise
        return 0
    except Exception as error:
        event("backup_failed", **failure_record(error))
        return 1


if __name__ == "__main__":
    def terminate(_signum, _frame):
        # Let the normal finally blocks stop only this job's temporary containers.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        raise BackupError("Backup interrupted")
    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    sys.exit(main())
