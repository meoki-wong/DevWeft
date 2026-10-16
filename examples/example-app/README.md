# DevWeft example app

This dependency-free Node.js app is a safe sample repository for validating DevWeft. It includes deterministic unit tests, a small HTTP API, and two static pages used by optional browser smoke lanes.

```sh
npm test
npm start
```

The API exposes `GET /health` and `GET /api/greeting?name=Ada`. The `build:web` and `build:admin` scripts create the corresponding static pages under `dist/`. No external credentials or service are required.
