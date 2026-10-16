# DevWeft project integration

This repository can use the self-hosted DevWeft MCP server for tracked tasks and test evidence. Follow the repository's own contribution and security instructions as well.

1. For work tracked in DevWeft, call `harness_start` to create a task or `harness_status` to resume one. Follow the current task phase and allowed transitions.
2. Use configured checks and test runners. Do not assume remote services or optional integrations are enabled.
3. A remote runner may need a source patch when it cannot access this workspace. Send one only when the user requested testing through that configured runner; inspect it first and include only the intended changes. Exclude credentials, private data, generated files, and unrelated work.
4. Use shared knowledge tools only when configured. Record concise, reusable findings without secrets or private source content.
5. Do not create commits or push changes unless requested.
