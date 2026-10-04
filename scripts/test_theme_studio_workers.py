"""Offline deployment-contract checks; no gcloud or network calls."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("workers", Path(__file__).with_name("theme-studio-workers.py"))
workers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(workers)


class WorkerDeployment(unittest.TestCase):
    def fixture(self):
        return {"status": {"latestReadyRevisionName": "web-prod-123"}, "spec": {"template": {
            "metadata": {"annotations": {"run.googleapis.com/cloudsql-instances": "project:region:db", "run.googleapis.com/client-name": "gcloud"}},
            "spec": {"serviceAccountName": "runtime@project.iam.gserviceaccount.com", "containers": [{"env": [
                {"name": "DB_NAME", "value": "storemink"}, {"name": "DB_POOL_MAX", "value": "5"},
                {"name": "CRON_SECRET", "valueFrom": {"secretKeyRef": {"name": "cron", "key": "latest"}}},
                {"name": "DB_ADMIN_PASSWORD", "value": "must-not-copy"}, {"name": "PAYMENT_CRED_KEY", "value": "must-not-copy"},
                {"name": "THEME_STUDIO_PROVIDER", "value": "vertex-gemini"},
            ]}]},
        }}}

    def test_isolated_capacity_and_exact_build_binding(self):
        plan = workers.topology("storemink-web-prod")
        for worker in plan:
            result = workers.worker_spec(self.fixture(), worker, "registry/web@sha256:abc")
            template = result["spec"]["template"]
            env = {e["name"]: e for e in template["spec"]["containers"][0]["env"]}
            self.assertEqual(env["THEME_STUDIO_BUILD_ID"]["value"], "web-prod-123")
            self.assertEqual(env["DB_POOL_MAX"]["value"], "1")
            self.assertNotIn("DB_ADMIN_PASSWORD", env)
            self.assertNotIn("PAYMENT_CRED_KEY", env)
            self.assertIn("valueFrom", env["CRON_SECRET"])
            self.assertEqual(template["spec"]["containerConcurrency"], 1)
            self.assertEqual(template["spec"]["containers"][0]["resources"]["limits"]["memory"], "2Gi")
            self.assertEqual(template["metadata"]["annotations"]["run.googleapis.com/cloudsql-instances"], "project:region:db")

    def test_honours_an_explicit_web_build_override(self):
        web = self.fixture()
        web["spec"]["template"]["spec"]["containers"][0]["env"].append({"name": "THEME_STUDIO_BUILD_ID", "value": "release-xyz"})
        result = workers.worker_spec(web, workers.topology("storemink-web-dev")[0], "registry/web@sha256:abc")
        env = {e["name"]: e for e in result["spec"]["template"]["spec"]["containers"][0]["env"]}
        self.assertEqual(env["THEME_STUDIO_BUILD_ID"]["value"], "release-xyz")

    def test_independent_jobs_and_oidc_do_not_overwrite_the_application_secret(self):
        for worker in workers.topology("storemink-web-prod"):
            self.assertEqual(len(set(worker["jobs"])), 2)
            flags = workers.scheduler_flags(worker, "https://worker.run.app", "runtime@project", "dummy", True)
            self.assertEqual(flags["--oidc-token-audience"], "https://worker.run.app")
            self.assertEqual(flags["--update-headers"], {"X-Theme-Studio-Secret": "dummy"})
            self.assertIn("Authorization", flags["--remove-headers"])
            self.assertEqual(flags["--max-retry-attempts"], 0)

    def test_environment_names_cannot_cross_wire_the_schedules(self):
        prod = workers.topology("storemink-web-prod")
        dev = workers.topology("storemink-web-dev")
        self.assertTrue(set(j for p in prod for j in p["jobs"]).isdisjoint(j for p in dev for j in p["jobs"]))
        with self.assertRaises(ValueError):
            workers.topology("unknown")

    def test_rejects_mutable_image_tags(self):
        with self.assertRaises(ValueError):
            workers.worker_spec(self.fixture(), workers.topology("storemink-web-prod")[0], "registry/web:prod")

    def test_routing_cannot_overcommit_the_database(self):
        web = self.fixture()
        web["spec"]["template"]["metadata"]["annotations"]["autoscaling.knative.dev/maxScale"] = "4"
        with self.assertRaises(RuntimeError):
            workers.require_connection_budget([web, web], 25)
        with self.assertRaises(RuntimeError):
            workers.require_connection_budget([web, web], 60)
        self.assertEqual(workers.require_connection_budget([web, web], 120), 48)

    def test_routing_rejects_a_stale_worker_build(self):
        web = self.fixture()
        worker = workers.topology("storemink-web-prod")[0]
        service = workers.worker_spec(web, worker, "registry/web@sha256:abc")
        service["status"] = {"latestReadyRevisionName": "worker-123", "traffic": [{"revisionName": "worker-123", "percent": 100}]}
        workers.require_worker_binding(service, web, worker, "registry/web@sha256:abc")
        with self.assertRaises(RuntimeError):
            workers.require_worker_binding(service, web, worker, "registry/web@sha256:new")

    def test_routing_rejects_overprovisioned_or_unready_workers(self):
        web = self.fixture()
        worker = workers.topology("storemink-web-prod")[0]
        service = workers.worker_spec(web, worker, "registry/web@sha256:abc")
        service["status"] = {"latestReadyRevisionName": "worker-123", "traffic": [{"revisionName": "worker-123", "percent": 100}]}
        service["spec"]["template"]["metadata"]["annotations"]["autoscaling.knative.dev/maxScale"] = "10"
        with self.assertRaises(RuntimeError):
            workers.require_worker_binding(service, web, worker, "registry/web@sha256:abc")
        service["spec"]["template"]["metadata"]["annotations"]["autoscaling.knative.dev/maxScale"] = "2"
        service["status"]["latestCreatedRevisionName"] = "worker-pending"
        with self.assertRaises(RuntimeError):
            workers.require_worker_binding(service, web, worker, "registry/web@sha256:abc")

    def test_invalid_second_worker_cannot_partially_route_the_first(self):
        web = self.fixture()
        web["status"]["traffic"] = [{"revisionName": "web-prod-123", "percent": 100}]
        web["spec"]["template"]["metadata"]["annotations"]["autoscaling.knative.dev/maxScale"] = "4"
        calls = []

        def run(command, **_kwargs):
            calls.append(command)
            operation = command[1:4]
            if operation == ["run", "services", "describe"]:
                name = command[4]
                if name.startswith("storemink-web-"):
                    value = web
                else:
                    worker = next(w for w in workers.topology("storemink-web-prod") if w["service"] == name)
                    image = "registry/web@sha256:abc" if worker["role"] == "generation" else "registry/web@sha256:stale"
                    value = workers.worker_spec(web, worker, image)
                    value["status"] = {"latestReadyRevisionName": "worker-123", "url": "https://worker.run.app", "traffic": [{"revisionName": "worker-123", "percent": 100}]}
            elif operation == ["run", "revisions", "describe"]:
                value = {"status": {"imageDigest": "registry/web@sha256:abc"}}
            elif operation == ["run", "services", "get-iam-policy"]:
                value = {"bindings": []}
            else:
                self.fail("No schedule or secret command should run after invalid preflight")
            return workers.subprocess.CompletedProcess(command, 0, workers.json.dumps(value), "")

        with patch("sys.argv", ["workers", "--web=storemink-web-prod", "--project=dummy", "--route-schedulers", "--max-db-connections=120"]), patch.object(workers.subprocess, "run", run):
            with self.assertRaises(RuntimeError):
                workers.main()
        self.assertFalse(any(command[1] in {"scheduler", "secrets"} for command in calls))


if __name__ == "__main__":
    unittest.main()
