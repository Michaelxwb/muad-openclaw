# Kubernetes Contract Validation (2026-07-12)

## Environment

- Context: `orbstack`
- Kubernetes: `v1.34.8+orb1`
- Namespace: `muad`
- Worker image: `muad-openclaw:multi-user-20260712`
- Worker image digest: `sha256:d9ef134dd0527b4d0f278bafbc5669ed22934d50a86815458a53944f9d478adc`
- Storage class: `local-path`

The integration workload used a unique `contract-k8s-*` Pod ID. It did not modify `66667` or any existing workload, and all Deployment, Pod, Secret and PVC resources were removed after the test.

## Repeatable Integration Test

```bash
cd console/backend
MUAD_K8S_TEST_IMAGE=muad-openclaw:multi-user-20260712 \
  go test -tags=integration ./internal/driver \
  -run TestK8sIntegration_SecretRuntimeAndRetainedPVC -v
```

Result: passed in 55.41 seconds.

The test verifies the following real-cluster behavior:

- creates a single-replica `Recreate` Deployment, per-Pod env Secret, service-token Secret and 1 GiB state PVC;
- initContainer copies the token to the runtime `emptyDir` with `0400` and `1000:1000` ownership;
- the main container mounts `/run/secrets/muad` read-only and does not expose the token in env;
- updating the Kubernetes Secret does not mutate the already-copied running token;
- a rollout reruns the initContainer and changes the mounted token digest;
- Runtime DTO generation 8 passes prepare/validate/commit, foreground Gateway `SIGUSR1`, and `muad.runtime.health` verification;
- a full Deployment rollout preserves generation 8 health;
- deleting with retain marks `muad/state-retained=true` and removes Deployment/Secrets;
- implicit same-name reuse returns `ErrRetainedState`;
- explicit adopt clears the retained annotation and starts a healthy workload;
- deleting state removes the PVC; final label query returns no contract resources.

## Failure And Recovery Coverage

The cluster test is combined with deterministic failure-injection tests:

```bash
cd console/backend
go test ./internal/runtimeapply ./test \
  -run 'Test(CoordinatorRecoversPendingPodsOnStartup|CoordinatorRetriesStaleCompletionWithoutOverwritingLatest|UserCleanup|K8s)'
```

Covered outcomes:

- candidate validation failure does not replace current config;
- restart/health failure restores the previous generation;
- stale completion cannot overwrite a newer desired generation;
- Console startup recovers pending work with bounded retries;
- offline Human User cleanup remains `deleting` and retries later;
- service-token rotation invalidates the old internal API token, and start failure restores the old Secret/token pair;
- Kubernetes manifest, Secret volume, initContainer identity, PVC retain/delete and adopt behavior have fake-client regression coverage.

## Diagnostics

For a failed rerun, inspect only the unique contract label:

```bash
kubectl get pods,pvc,secrets,deployments -n muad -l 'muad-pod=<contract-pod-id>' -o wide
kubectl describe pod -n muad -l 'muad-pod=<contract-pod-id>'
kubectl logs -n muad -l 'muad-pod=<contract-pod-id>' -c prepare-service-token
kubectl logs -n muad -l 'muad-pod=<contract-pod-id>' -c openclaw --tail=200
```
