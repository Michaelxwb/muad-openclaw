Runtime file E2E runs against two dedicated Consoles containing the candidate code, their actual SQLite databases, and real Workers. The coding phase registers these tests and compiles them with `-run '^$'`; `cf-task-verify-e2e` performs execution afterwards. Missing settings fail a scenario instead of marking it skipped or verified.

Provide these settings through the test environment; credentials are never stored in fixtures:

| Setting | Fixture |
|---|---|
| `MUAD_E2E_K8S_CONSOLE_URL`, `MUAD_E2E_K8S_ADMIN_TOKEN` | Candidate Kubernetes Console and its admin access |
| `MUAD_E2E_DOCKER_CONSOLE_URL`, `MUAD_E2E_DOCKER_ADMIN_TOKEN` | Candidate Docker Console and its admin access |
| `MUAD_E2E_K8S_NAMESPACE` | Dedicated namespace with a `muad-e2e-` prefix; kubeconfig or in-cluster credentials must address this cluster |
| `MUAD_E2E_DOCKER_NETWORK` | Candidate Console's Worker network |
| `MUAD_E2E_K8S_DB`, `MUAD_E2E_DOCKER_DB` | Existing SQLite files mounted from the respective test Consoles; used only to seed owned legacy fixtures through the real repo |
| `MUAD_E2E_K8S_CONSOLE_NAME`, `MUAD_E2E_DOCKER_CONSOLE_NAME` | Dedicated Deployment/container names with a `muad-e2e-` prefix, for abrupt process death and recovery |
| `MUAD_E2E_FILE_IMAGE`, `MUAD_E2E_NEXT_FILE_IMAGE` | Two immutable candidate Worker images supporting file input |
| `MUAD_E2E_LEGACY_IMAGE` | Previously working Worker image with env input; ordinary candidate Console creation still uses the new file image |
| `MUAD_E2E_UNHEALTHY_IMAGE` | Pullable test image that fails Worker health; distinguishes actual failed health from missing image infrastructure |
| `MUAD_E2E_CHANNELS_JSON` | Valid `{ "channels": [...], "channelConfigs": {...} }` for the test accounts, including wecom for the identity fixture |
| `MUAD_E2E_MODEL_PROVIDER`, `MUAD_E2E_MODEL_URL`, `MUAD_E2E_MODEL_KEY`, `MUAD_E2E_MODEL_NAME` | Tool-capable fixture model accessible from Workers; private Skill and long-task tests execute real agent tools |
| `MUAD_E2E_DELIVERY_USER_IDS` | JSON array of dedicated test IM recipient IDs; required by the real long-task completion/delivery scenario |

For Docker, run the test client on the Linux daemon host with the same persisted `/var/lib/muad-console/runtime-secrets` directory visible to the test Console and client. This is needed to inspect actual startup files and preserve their runtime UID/GID. Kubernetes Console must have its ordinary public-Skill PVC configured; uploaded traditional fixtures are synchronized through the real Console, not a substitute syncer.

Tests own uniquely named `e2e-runtime-*` Pods and their users/models. Runtime cleanup removes these Workers and their test state, then the API detaches/deletes the fixture users and model records. The >128 KiB test also uploads a uniquely named traditional public Skill; remove that asset from the disposable test Console after the suite or reset the dedicated test data. No E2E command belongs in a production release smoke test.

Commands are registered per scenario in the task acceptance manifest. Shared contracts explicitly run both drivers. For compile-only validation:

```sh
go test -tags=e2e,integration ./test -run '^$'
go vet -tags=e2e,integration ./test
```
