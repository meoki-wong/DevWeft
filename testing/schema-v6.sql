-- testing schema v6: signing_keys.purpose 增加 image_manifest（§9.2 镜像签名）。
-- 重建表以放宽 CHECK；migrate.js 通过 sqlite_master 检查保证只执行一次。

CREATE TABLE signing_keys_v6 (
  key_id              TEXT PRIMARY KEY,
  purpose             TEXT NOT NULL CHECK(purpose IN ('runspec','workspace_attestation','image_manifest')),
  algorithm           TEXT NOT NULL CHECK(algorithm='Ed25519'),
  public_key_pem      TEXT NOT NULL,
  secret_ref          TEXT,
  status              TEXT NOT NULL CHECK(status IN ('active','verify_only','revoked')),
  not_before          TEXT NOT NULL,
  not_after           TEXT NOT NULL,
  created_at          TEXT NOT NULL
);

INSERT INTO signing_keys_v6
  SELECT key_id, purpose, algorithm, public_key_pem, secret_ref, status, not_before, not_after, created_at
  FROM signing_keys;

DROP TABLE signing_keys;

ALTER TABLE signing_keys_v6 RENAME TO signing_keys;
