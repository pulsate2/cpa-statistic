#!/usr/bin/env python3
"""Deploy cpa-statistics Worker + assets + secrets via nimeio path proxy (no wrangler network)."""
from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROXY = os.environ.get("NIMEIO_PROXY", "http://tyfd.kdns.fr/nimeio/").rstrip("/") + "/"
TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", "")
ACCOUNT = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "ceef02e63c625bc88a01acbe89103cc1")
SCRIPT = os.environ.get("WORKER_NAME", "cpa-statistics")
DB_ID = os.environ.get("D1_DATABASE_ID", "0a86d28f-e55b-4ee0-b093-01d9d2d0e7a2")


def api(method: str, url: str, data: bytes | None = None, headers: dict | None = None, timeout: int = 300):
    if url.startswith("https://") or url.startswith("http://"):
        full = PROXY + url
    else:
        full = PROXY + "https://api.cloudflare.com" + url
    hdrs = {"Authorization": f"Bearer {TOKEN}", "User-Agent": "cpa-statistics-deploy/1.0"}
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(full, data=data, method=method, headers=hdrs)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read()
            return resp.status, body
    except urllib.error.HTTPError as e:
        body = e.read()
        return e.code, body


def api_json(method: str, url: str, payload=None, timeout: int = 300):
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"
    status, body = api(method, url, data=data, headers=headers, timeout=timeout)
    try:
        parsed = json.loads(body.decode() or "null")
    except Exception:
        parsed = {"raw": body[:500].decode(errors="replace")}
    return status, parsed


def load_dev_vars(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def bundle_worker() -> Path:
    """Bundle worker with wrangler/esbuild offline."""
    out_dir = ROOT / ".deploy-bundle"
    out_dir.mkdir(exist_ok=True)
    # Prefer wrangler dry-run bundle (no upload)
    import subprocess

    cmd = [
        "npx",
        "wrangler",
        "deploy",
        "--dry-run",
        "--outdir",
        str(out_dir),
        "--name",
        SCRIPT,
    ]
    env = os.environ.copy()
    # Force offline-ish: no proxy needed for dry-run bundle
    env.pop("HTTPS_PROXY", None)
    env.pop("HTTP_PROXY", None)
    env.pop("NODE_OPTIONS", None)
    print("bundling worker...", flush=True)
    r = subprocess.run(cmd, cwd=str(ROOT), env=env, capture_output=True, text=True)
    print(r.stdout[-2000:] if r.stdout else "", flush=True)
    if r.returncode != 0:
        print(r.stderr[-3000:], file=sys.stderr)
        # fallback esbuild
        print("wrangler dry-run failed, trying esbuild...", flush=True)
        entry = ROOT / "src" / "index.ts"
        outfile = out_dir / "worker.js"
        r2 = subprocess.run(
            [
                "npx",
                "esbuild",
                str(entry),
                "--bundle",
                "--format=esm",
                "--platform=browser",
                "--conditions=worker",
                "--outfile=" + str(outfile),
            ],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
        )
        if r2.returncode != 0:
            print(r2.stderr, file=sys.stderr)
            raise SystemExit("bundle failed")
        print(r2.stdout, flush=True)
        return outfile

    # wrangler writes index.js / worker.js depending on version
    for name in ("index.js", "worker.js", "main.js"):
        p = out_dir / name
        if p.exists():
            return p
    # any js
    js = list(out_dir.glob("*.js"))
    if not js:
        raise SystemExit(f"no js in {out_dir}: {list(out_dir.iterdir())}")
    return js[0]


def file_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def collect_assets(dist: Path) -> list[tuple[str, Path, bytes, str]]:
    items = []
    for p in dist.rglob("*"):
        if not p.is_file():
            continue
        rel = p.relative_to(dist).as_posix()
        data = p.read_bytes()
        items.append((rel, p, data, file_hash(data)))
    return items


def put_secret(name: str, value: str):
    status, parsed = api_json(
        "PUT",
        f"/client/v4/accounts/{ACCOUNT}/workers/scripts/{SCRIPT}/secrets",
        {"name": name, "text": value, "type": "secret_text"},
    )
    ok = isinstance(parsed, dict) and parsed.get("success")
    print(f"secret {name}: status={status} ok={ok}", flush=True)
    if not ok:
        print(parsed, flush=True)
    return ok


def main():
    if not TOKEN:
        raise SystemExit("CLOUDFLARE_API_TOKEN required")

    # 1) secrets from .dev.vars
    secrets = load_dev_vars(ROOT / ".dev.vars")
    want = ["CPA_BASE_URL", "CPA_MANAGEMENT_KEY", "DASHBOARD_PASSWORD"]
    for k in want:
        if k not in secrets or not secrets[k]:
            print(f"WARN missing {k} in .dev.vars", flush=True)

    # 2) bundle
    worker_js = bundle_worker()
    worker_src = worker_js.read_text()
    print(f"worker bundle: {worker_js} ({len(worker_src)} bytes)", flush=True)

    # 3) assets
    dist = ROOT / "web" / "dist"
    if not (dist / "index.html").exists():
        raise SystemExit("web/dist missing — run npm run build:web")
    assets = collect_assets(dist)
    print(f"assets: {len(assets)} files", flush=True)

    # 4) Try modern assets upload session; if fails, deploy script-only with ASSETS omitted via module worker embedding fallback
    # Cloudflare Workers static assets upload flow:
    # POST /accounts/{account_id}/workers/scripts/{script_name}/assets-upload-session
    manifest = {("/" + rel if not rel.startswith("/") else rel): {"hash": h, "size": len(data)} for rel, _, data, h in assets}
    # paths without leading slash sometimes required
    manifest2 = {rel: {"hash": h, "size": len(data)} for rel, _, data, h in assets}

    status, session = api_json(
        "POST",
        f"/client/v4/accounts/{ACCOUNT}/workers/scripts/{SCRIPT}/assets-upload-session",
        {"manifest": manifest2},
    )
    print(f"assets-upload-session: {status}", flush=True)
    print(json.dumps(session)[:800], flush=True)

    completion_jwt = None
    if isinstance(session, dict) and session.get("success"):
        result = session.get("result") or {}
        completion_jwt = result.get("jwt")
        buckets = result.get("buckets") or []
        # buckets: list of lists of hashes to upload
        hash_to_data = {h: data for _, _, data, h in assets}
        hash_to_rel = {h: rel for rel, _, _, h in assets}
        for bi, bucket in enumerate(buckets):
            # multipart upload
            boundary = f"----cpa{int(time.time())}{bi}"
            parts = []
            for file_hash_item in bucket:
                data = hash_to_data[file_hash_item]
                rel = hash_to_rel[file_hash_item]
                ctype = mimetypes.guess_type(rel)[0] or "application/octet-stream"
                parts.append(
                    f"--{boundary}\r\n"
                    f'Content-Disposition: form-data; name="{file_hash_item}"; filename="{rel}"\r\n'
                    f"Content-Type: {ctype}\r\n\r\n".encode()
                    + data
                    + b"\r\n"
                )
            parts.append(f"--{boundary}--\r\n".encode())
            body = b"".join(parts)
            # Upload URL uses jwt as bearer
            upload_jwt = result.get("jwt")
            status_u, body_u = api(
                "POST",
                f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/workers/assets/upload?base64=false",
                data=body,
                headers={
                    "Authorization": f"Bearer {upload_jwt}",
                    "Content-Type": f"multipart/form-data; boundary={boundary}",
                },
            )
            print(f"upload bucket {bi}: {status_u} {body_u[:200]!r}", flush=True)
            try:
                uj = json.loads(body_u.decode())
                if uj.get("result", {}).get("jwt"):
                    completion_jwt = uj["result"]["jwt"]
            except Exception:
                pass
    else:
        print("assets session failed — will deploy worker module only (no static assets binding content)", flush=True)

    # 5) metadata for worker
    # bindings: D1, ASSETS, vars
    metadata = {
        "main_module": "index.js",
        "compatibility_date": "2025-07-01",
        "compatibility_flags": ["nodejs_compat"],
        "bindings": [
            {"type": "d1", "name": "DB", "id": DB_ID},
            {"type": "plain_text", "name": "TZ", "text": "Asia/Shanghai"},
            {"type": "plain_text", "name": "PULL_MIN_INTERVAL_SEC", "text": "10"},
            {"type": "plain_text", "name": "USAGE_QUEUE_BATCH_SIZE", "text": "200"},
            {"type": "plain_text", "name": "USAGE_QUEUE_MAX_ROUNDS", "text": "10"},
        ],
        "triggers": {"crons": ["* * * * *"]},
    }
    if completion_jwt:
        metadata["assets"] = {
            "jwt": completion_jwt,
            "config": {"not_found_handling": "single-page-application"},
        }
        # ASSETS binding is implicit with assets config in newer API; some docs use binding name
        metadata["bindings"].append({"type": "assets", "name": "ASSETS"})

    # multipart deploy
    boundary = "----WorkerDeployBoundary7MA4YWxk"
    parts = []
    meta_json = json.dumps(metadata)
    parts.append(
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"metadata\"; filename=\"metadata.json\"\r\nContent-Type: application/json\r\n\r\n{meta_json}\r\n".encode()
    )
    parts.append(
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"index.js\"; filename=\"index.js\"\r\nContent-Type: application/javascript+module\r\n\r\n".encode()
        + worker_src.encode()
        + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())
    body = b"".join(parts)

    status, raw = api(
        "PUT",
        f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/workers/scripts/{SCRIPT}",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        timeout=300,
    )
    print(f"deploy script: {status}", flush=True)
    try:
        parsed = json.loads(raw.decode())
        print(json.dumps(parsed)[:2000], flush=True)
        if not parsed.get("success"):
            raise SystemExit("deploy failed")
    except SystemExit:
        raise
    except Exception:
        print(raw[:2000], flush=True)
        raise SystemExit("deploy parse failed")

    # 6) subdomain enable
    status, parsed = api_json(
        "POST",
        f"/client/v4/accounts/{ACCOUNT}/workers/scripts/{SCRIPT}/subdomain",
        {"enabled": True},
    )
    print(f"subdomain: {status} {parsed}", flush=True)

    # 7) secrets (after script exists)
    for k in want:
        if k in secrets and secrets[k]:
            put_secret(k, secrets[k])

    # 8) routes / workers.dev URL
    status, parsed = api_json("GET", f"/client/v4/accounts/{ACCOUNT}/workers/subdomain")
    print(f"workers subdomain info: {status} {parsed}", flush=True)

    print("DONE", flush=True)


if __name__ == "__main__":
    main()
