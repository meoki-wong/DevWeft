# Extension contracts

DevWeft integrations are small JavaScript adapter objects. They are validated at registration time in `extensions/contracts.js`. Git uses a generic provider by default, design lookup is offline/disabled unless explicitly configured, and blob storage uses local filesystem storage or the configured standby HTTP endpoint. Runner selection follows the deployment profile: Hyper-V remains the host-worker default, while the local process backend is opt-in and is not a VM isolation boundary.

| Contract | Required methods | Built-in seam |
|---|---|---|
| `gitProvider` | `canonicalizeRemoteUrl(raw)`, `remoteUrlFingerprint(url)`, `resolveContext(db, body)` | `genericGitProvider`; inject with `mountTestingRoutes(..., { gitProvider })` |
| `designSource` | `listTools(username)`, `callTool(username, tool, args)` | `genericDesignSource` is offline/disabled; optional Lanhu adapter is off until `AWP_LANHU_MCP_URL` is set. Inject with `registerLanhuTools(server, { designSource, isConfigured })`. |
| `runnerBackend` | `runLane()` | Hyper-V and opt-in local process adapters in `runner/host-worker/worker-service.mjs`; the adapter also exposes descriptive `capabilities`. |
| `blobBackend` | `prepare(body)`, `writeUpload(uploadId, bytes)`, `contentPath(sha256)` | Local filesystem backend; standby mode wraps the HTTP upload client. Inject with `mountTestingRoutes(..., { blobBackend })`. |

The offline design example at [`examples/extensions/example-design-source.mjs`](../examples/extensions/example-design-source.mjs) can be passed to `registerLanhuTools` in tests without credentials or network access.

## Stable errors

Use `ExtensionError` or normalize foreign errors with `normalizeExtensionError(error, operation)`. Consumers can branch on these stable codes rather than provider messages:

- `EXTENSION_NOT_FOUND` — no adapter is registered for the selected id;
- `EXTENSION_INVALID` — an adapter is missing a required method or has an invalid identity;
- `EXTENSION_OPERATION_UNSUPPORTED` — the adapter intentionally does not implement this operation;
- `EXTENSION_UNAVAILABLE` — temporary network/service failure; `retryable` is true;
- `EXTENSION_CONFLICT` — duplicate adapter id;
- `EXTENSION_REJECTED` — provider rejected input or policy;
- `EXTENSION_FAILED` — other provider failure.

Do not map unavailable, unsupported, or failed provider results to a successful empty value. Capability output is descriptive and must not be used to bypass the runner's existing isolation, permission, or secret checks.

## Registering an adapter

```js
import { createExtensionRegistry } from '../extensions/contracts.js'
import { exampleDesignSource } from '../examples/extensions/example-design-source.mjs'

const providers = createExtensionRegistry()
providers.register('designSource', exampleDesignSource)
const design = providers.resolve('designSource', 'example-fixture')
```

Add a contract test for every new adapter. Test success shape, unsupported operation, invalid input, and unavailable service error mapping. Keep external SDKs in optional adapter modules rather than the core contract.
