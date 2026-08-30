#!/usr/bin/env python3
"""Respaldo de PostgreSQL a Cloudflare R2 con rotación.

Variables de entorno:
  DATABASE_URL          conexión al Postgres (interna del proyecto)
  R2_ACCOUNT_ID         cuenta Cloudflare R2
  R2_ACCESS_KEY_ID      credencial S3 de R2
  R2_SECRET_ACCESS_KEY  credencial S3 de R2
  R2_BUCKET_NAME        bucket destino
  BACKUP_PREFIX         nombre del proyecto (ej. 'service-desk') → carpeta en R2
  RETENTION_DAYS        días a conservar (default 30)

Corre como Cron Job en Railway: hace pg_dump, sube a R2 y termina.
Restaurar:  pg_restore --no-owner --no-acl -d <DATABASE_URL> archivo.dump
"""
import os, sys, subprocess, datetime
import boto3

def env(name, default=None, required=False):
    v = os.environ.get(name, default)
    if required and not v:
        print(f"FALTA la variable {name}", flush=True); sys.exit(1)
    return v

DB      = env("DATABASE_URL", required=True)
PREFIX  = env("BACKUP_PREFIX", "db")
RET     = int(env("RETENTION_DAYS", "30"))
ACCT    = env("R2_ACCOUNT_ID", required=True)
BUCKET  = env("R2_BUCKET_NAME", required=True)

s3 = boto3.client(
    "s3",
    endpoint_url=f"https://{ACCT}.r2.cloudflarestorage.com",
    aws_access_key_id=env("R2_ACCESS_KEY_ID", required=True),
    aws_secret_access_key=env("R2_SECRET_ACCESS_KEY", required=True),
    region_name="auto",
)

ts  = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d_%H%M")
key = f"db-backups/{PREFIX}/{ts}.dump"

print(f"[{ts}] pg_dump de '{PREFIX}'…", flush=True)
# Formato custom (-Fc): comprimido y restaurable con pg_restore.
proc = subprocess.run(
    ["pg_dump", "--no-owner", "--no-acl", "-Fc", DB],
    capture_output=True,
)
if proc.returncode != 0:
    print("pg_dump ERROR:\n" + proc.stderr.decode("utf-8", "replace")[:800], flush=True)
    sys.exit(1)

data = proc.stdout
print(f"  dump: {len(data)/1024:.0f} KB", flush=True)

s3.put_object(Bucket=BUCKET, Key=key, Body=data)
print(f"  ✅ subido → {BUCKET}/{key}", flush=True)

# Rotación: borrar respaldos más viejos que RET días.
cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=RET)
deleted = 0
token = None
while True:
    kw = {"Bucket": BUCKET, "Prefix": f"db-backups/{PREFIX}/"}
    if token:
        kw["ContinuationToken"] = token
    resp = s3.list_objects_v2(**kw)
    for o in resp.get("Contents", []):
        if o["LastModified"] < cutoff:
            s3.delete_object(Bucket=BUCKET, Key=o["Key"])
            deleted += 1
    if resp.get("IsTruncated"):
        token = resp.get("NextContinuationToken")
    else:
        break
print(f"  rotación: {deleted} respaldos viejos borrados (retención {RET}d)", flush=True)
print("BACKUP OK", flush=True)
