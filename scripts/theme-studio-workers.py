#!/usr/bin/env python3
"""Deploy isolated Studio workers from the serving web revision.

Cloud Build uses --deploy. After the first deploy, --route-schedulers moves the
two existing schedules and adds one independent peer each. Secret values stay
in memory/0600 flag files, never in logs or shell arguments. No action is taken
without an explicit flag; --plan prints only non-secret topology.
"""
import argparse
import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile


def topology(web):
    if web not in ("storemink-web-prod", "storemink-web-dev"):
        raise ValueError("Only the production and dev web services have Studio workers")
    env = web.rsplit("-", 1)[1]
    suffix = "" if env == "prod" else "-dev"
    return [
        {"service": f"storemink-theme-studio-model-{env}", "role": "generation", "path": "runs", "deadline": 1200,
         "jobs": [f"storemink-theme-studio-runs{suffix}", f"storemink-theme-studio-runs-peer{suffix}"]},
        {"service": f"storemink-theme-studio-qa-{env}", "role": "qa", "path": "qa", "deadline": 300,
         "jobs": [f"storemink-theme-studio-qa{suffix}", f"storemink-theme-studio-qa-peer{suffix}"]},
    ]


def worker_spec(web, worker, image_digest):
    template = web["spec"]["template"]
    serving = web["status"]["latestReadyRevisionName"]
    if not image_digest or "@sha256:" not in image_digest:
        raise ValueError("Workers must use the serving web image digest")
    container = template["spec"]["containers"][0]
    allowed = {"CRON_SECRET", "NEXT_PUBLIC_ROOT_DOMAIN", "NEXT_PUBLIC_APP_URL", "GCP_PROJECT_ID", "DOMAIN_ENV"}
    env = [copy.deepcopy(e) for e in container.get("env", []) if e["name"] in allowed or e["name"].startswith(("DB_", "THEME_STUDIO_"))]
    env = [e for e in env if e["name"] not in {"DB_ADMIN_PASSWORD", "DB_ADMIN_USER", "THEME_STUDIO_WORKER_ONLY", "THEME_STUDIO_WORKER_ROLE", "DB_POOL_MAX"}]
    # Honour the web's explicit build override; a worker's K_REVISION would
    # otherwise invalidate every browser capture, even for the identical image.
    bound_build = next((e.get("value") for e in env if e["name"] == "THEME_STUDIO_BUILD_ID"), None) or serving
    env = [e for e in env if e["name"] != "THEME_STUDIO_BUILD_ID"]
    env += [{"name": k, "value": v} for k, v in {
        "THEME_STUDIO_WORKER_ONLY": "true", "THEME_STUDIO_WORKER_ROLE": worker["role"],
        "THEME_STUDIO_BUILD_ID": bound_build, "DB_POOL_MAX": "1",
        "NODE_OPTIONS": "--max-old-space-size=768", "UV_THREADPOOL_SIZE": "2", "MALLOC_ARENA_MAX": "2",
    }.items()]
    annotations = {"autoscaling.knative.dev/minScale": "0", "autoscaling.knative.dev/maxScale": "2"}
    for k, v in template.get("metadata", {}).get("annotations", {}).items():
        if k in {"run.googleapis.com/cloudsql-instances", "run.googleapis.com/vpc-access-connector", "run.googleapis.com/vpc-access-egress", "run.googleapis.com/network-interfaces"}:
            annotations[k] = v
    return {"apiVersion": "serving.knative.dev/v1", "kind": "Service", "metadata": {"name": worker["service"]},
            "spec": {"template": {"metadata": {"annotations": annotations}, "spec": {
                "serviceAccountName": template["spec"]["serviceAccountName"], "containerConcurrency": 1,
                "timeoutSeconds": worker["deadline"], "containers": [{"image": image_digest,
                    "ports": [{"containerPort": 8080}], "env": env,
                    "resources": {"limits": {"cpu": "2", "memory": "2Gi"}}}],
            }}, "traffic": [{"latestRevision": True, "percent": 100}]}}


def scheduler_flags(worker, url, account, secret, updating=False):
    return {**({"--remove-headers": ["Authorization", "authorization"]} if updating else {}), "--schedule": "* * * * *", "--time-zone": "UTC", "--http-method": "POST",
            "--uri": url + "/api/internal/theme-studio/" + worker["path"],
            "--oidc-service-account-email": account, "--oidc-token-audience": url,
            "--attempt-deadline": str(worker["deadline"]) + "s", "--max-retry-attempts": 0,
            "--update-headers" if updating else "--headers": {"X-Theme-Studio-Secret": secret}}


def require_worker_binding(service, web, worker, image):
    expected_template = worker_spec(web, worker, image)["spec"]["template"]
    actual_template = service["spec"]["template"]
    expected = expected_template["spec"]
    actual = actual_template["spec"]
    env = {e["name"]: e.get("value") for e in actual["containers"][0].get("env", [])}
    wanted = {e["name"]: e.get("value") for e in expected["containers"][0]["env"]}
    if actual["containers"][0]["image"] != image or any(env.get(k) != wanted[k] for k in ("THEME_STUDIO_BUILD_ID", "THEME_STUDIO_WORKER_ONLY", "THEME_STUDIO_WORKER_ROLE", "DB_POOL_MAX")):
        raise RuntimeError("Worker image/build/role does not match the serving web revision; deploy workers first")
    if (any(actual.get(k) != expected[k] for k in ("containerConcurrency", "timeoutSeconds", "serviceAccountName"))
            or actual["containers"][0].get("resources") != expected["containers"][0]["resources"]
            or any(actual_template.get("metadata", {}).get("annotations", {}).get(k) != v
                   for k, v in expected_template["metadata"]["annotations"].items())):
        raise RuntimeError("Worker resources, capacity or network binding differs from the validated topology")
    require_serving_revision(service)


def require_serving_revision(service):
    ready = service["status"].get("latestReadyRevisionName")
    created = service["status"].get("latestCreatedRevisionName", ready)
    traffic = service["status"].get("traffic", [])
    if not ready or ready != created or len(traffic) != 1 or traffic[0].get("percent") != 100 or traffic[0].get("revisionName") != ready:
        raise RuntimeError("Finish the service rollout with one fully serving revision before binding workers or routing schedules")
    return ready


def require_connection_budget(web_services, maximum):
    # Revision-level maxScale can admit old and new revision pools during a
    # rollout. Budget both environments, double the steady pool ceiling for
    # overlap, then leave five connections for administration and other jobs.
    ceiling = 8  # two roles × two instances × one pool connection × two envs
    for web in web_services:
        template = web["spec"]["template"]
        env = {e["name"]: e.get("value") for e in template["spec"]["containers"][0].get("env", [])}
        ceiling += int(template["metadata"]["annotations"]["autoscaling.knative.dev/maxScale"]) * int(env["DB_POOL_MAX"])
    if maximum < ceiling * 2 + 5:
        raise RuntimeError(f"Routing refused: web + worker pools require {ceiling} steady connections, {ceiling * 2} during revision overlap plus 5 spare; verify SQL capacity or lower configured pool/instance limits")
    return ceiling


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--web", required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--region", default="asia-south1")
    parser.add_argument("--deploy", action="store_true")
    parser.add_argument("--route-schedulers", action="store_true")
    parser.add_argument("--plan", action="store_true")
    parser.add_argument("--max-db-connections", type=int, help="Verified SHOW max_connections value, required before first scheduler routing")
    args = parser.parse_args()
    workers = topology(args.web)
    if args.plan or not (args.deploy or args.route_schedulers):
        print(json.dumps({"workers": workers, "memoryEach": "2Gi", "concurrencyEach": 1, "maxInstancesEach": 2, "dbConnectionsPerInstance": 1}, indent=2))
        return

    def gcloud(*command, allow_missing=False):
        result = subprocess.run(["gcloud", *command, "--project=" + args.project, "--quiet"], capture_output=True, text=True,
                                env={**os.environ, "CLOUDSDK_CORE_LOG_HTTP": "false"})
        if result.returncode:
            if allow_missing and ("NOT_FOUND" in result.stderr or "does not exist" in result.stderr):
                return None
            # Provider CLI errors may repeat header values. Do not print them.
            raise RuntimeError("gcloud failed during " + " ".join(command[:3]) + "; inspect IAM/configuration without logging secrets")
        return result.stdout

    web = json.loads(gcloud("run", "services", "describe", args.web, "--region=" + args.region, "--format=json"))
    revision = require_serving_revision(web)
    detail = json.loads(gcloud("run", "revisions", "describe", revision, "--region=" + args.region, "--format=json"))
    image = detail["status"]["imageDigest"]
    account = web["spec"]["template"]["spec"]["serviceAccountName"]
    if args.route_schedulers:
        if not args.max_db_connections:
            raise RuntimeError("Verify SHOW max_connections and supply --max-db-connections before routing")
        peer_name = "storemink-web-dev" if args.web == "storemink-web-prod" else "storemink-web-prod"
        peer_web = json.loads(gcloud("run", "services", "describe", peer_name, "--region=" + args.region, "--format=json"))
        require_serving_revision(peer_web)
        require_connection_budget([web, peer_web], args.max_db_connections)
    with tempfile.TemporaryDirectory(prefix="theme-studio-workers-") as tmp:
        services = {}
        # Deploy and validate BOTH roles before moving any schedule. A stale
        # second service must not leave the first role partially activated.
        for worker in workers:
            if args.deploy:
                file = Path(tmp) / "worker.json"
                file.write_text(json.dumps(worker_spec(web, worker, image)))
                file.chmod(0o600)
                gcloud("run", "services", "replace", str(file), "--region=" + args.region)
                gcloud("run", "services", "add-iam-policy-binding", worker["service"], "--region=" + args.region,
                       "--member=serviceAccount:" + account, "--role=roles/run.invoker")
            policy = json.loads(gcloud("run", "services", "get-iam-policy", worker["service"], "--region=" + args.region, "--format=json"))
            if any(member in {"allUsers", "allAuthenticatedUsers"} for binding in policy.get("bindings", []) for member in binding.get("members", [])):
                raise RuntimeError("Studio workers must be private; remove public IAM access before routing schedules")
            if args.route_schedulers:
                service = json.loads(gcloud("run", "services", "describe", worker["service"], "--region=" + args.region, "--format=json"))
                require_worker_binding(service, web, worker, image)
                services[worker["service"]] = service
            else:
                print("Deployed private worker " + worker["service"] + " bound to " + revision)
        current = json.loads(gcloud("run", "services", "describe", args.web, "--region=" + args.region, "--format=json"))
        if require_serving_revision(current) != revision:
            raise RuntimeError("Web changed during worker rollout; rerun to bind workers to the current revision")
        if args.route_schedulers:
            secret_env = next(e for e in web["spec"]["template"]["spec"]["containers"][0]["env"] if e["name"] == "CRON_SECRET")
            ref = secret_env.get("valueFrom", {}).get("secretKeyRef")
            secret = gcloud("secrets", "versions", "access", ref["key"], "--secret=" + ref["name"]).strip() if ref else secret_env["value"]
            if not secret:
                raise RuntimeError("An empty worker secret cannot authenticate schedules")
            for worker in workers:
                service = services[worker["service"]]
                for job in worker["jobs"]:
                    old = gcloud("scheduler", "jobs", "describe", job, "--location=" + args.region, "--format=json", allow_missing=True)
                    # JSON is YAML-compatible. A 0600 flags file keeps the shared
                    # secret out of command arguments and Cloud Build output.
                    flags = Path(tmp) / "scheduler-flags.json"
                    flags.write_text(json.dumps(scheduler_flags(worker, service["status"]["url"], account, secret, bool(old))))
                    flags.chmod(0o600)
                    gcloud("scheduler", "jobs", "update" if old else "create", "http", job, "--location=" + args.region, "--flags-file=" + str(flags))
                print("Routed independent schedules for " + worker["service"])


if __name__ == "__main__":
    main()
