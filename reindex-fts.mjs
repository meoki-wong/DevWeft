#!/usr/bin/env node
/**
 * reindex-fts.mjs — 一次性重建 FTS5 索引（切换 trigram 分词器后必跑一次）
 *
 * 背景：db.js 的 tokenize 从 unicode61 改为 trigram 后，已存在的 team.db 里
 * 两张 FTS 虚表仍是旧分词器（CREATE VIRTUAL TABLE IF NOT EXISTS 不会重建）。
 * 本脚本删除并重建 experiences_fts / docs_fts 及其触发器，并从基表重新灌入，
 * 使 query_docs("白屏")、distill_query("keep-alive") 等中文子串 / 连字符词命中生效。
 *
 * 用法：node reindex-fts.mjs
 * 注意：WAL 模式下直接 cp 即可备份（db.js 开启 WAL）。建议先备份 team.db。
 */
import db from './db.js'

const FTS_DDL = `
  DROP TRIGGER IF EXISTS exp_ai;
  DROP TRIGGER IF EXISTS exp_ad;
  DROP TRIGGER IF EXISTS exp_au;
  DROP TRIGGER IF EXISTS doc_ai;
  DROP TRIGGER IF EXISTS doc_ad;
  DROP TRIGGER IF EXISTS doc_au;
  DROP TABLE IF EXISTS experiences_fts;
  DROP TABLE IF EXISTS docs_fts;

  CREATE VIRTUAL TABLE experiences_fts USING fts5(
    content, module, tags, repo,
    tokenize='trigram'
  );
  CREATE TRIGGER exp_ai AFTER INSERT ON experiences BEGIN
    INSERT INTO experiences_fts(rowid, content, module, tags, repo)
    VALUES (new.rowid, new.content, COALESCE(new.module, ''), new.tags, new.repo);
  END;
  CREATE TRIGGER exp_ad AFTER DELETE ON experiences BEGIN
    DELETE FROM experiences_fts WHERE rowid = old.rowid;
  END;
  CREATE TRIGGER exp_au AFTER UPDATE ON experiences BEGIN
    DELETE FROM experiences_fts WHERE rowid = old.rowid;
    INSERT INTO experiences_fts(rowid, content, module, tags, repo)
    VALUES (new.rowid, new.content, COALESCE(new.module, ''), new.tags, new.repo);
  END;

  CREATE VIRTUAL TABLE docs_fts USING fts5(
    content, name, category, repo,
    tokenize='trigram'
  );
  CREATE TRIGGER doc_ai AFTER INSERT ON docs BEGIN
    INSERT INTO docs_fts(rowid, content, name, category, repo)
    VALUES (new.rowid, new.content, new.name, COALESCE(new.category, ''), new.repo);
  END;
  CREATE TRIGGER doc_ad AFTER DELETE ON docs BEGIN
    DELETE FROM docs_fts WHERE rowid = old.rowid;
  END;
  CREATE TRIGGER doc_au AFTER UPDATE ON docs BEGIN
    DELETE FROM docs_fts WHERE rowid = old.rowid;
    INSERT INTO docs_fts(rowid, content, name, category, repo)
    VALUES (new.rowid, new.content, new.name, COALESCE(new.category, ''), new.repo);
  END;
`

db.exec(FTS_DDL)

const expCount = db.prepare('SELECT COUNT(*) c FROM experiences').get().c
const docCount = db.prepare('SELECT COUNT(*) c FROM docs').get().c

db.prepare(`
  INSERT INTO experiences_fts(rowid, content, module, tags, repo)
  SELECT rowid, content, COALESCE(module, ''), tags, repo FROM experiences
`).run()
db.prepare(`
  INSERT INTO docs_fts(rowid, content, name, category, repo)
  SELECT rowid, content, name, COALESCE(category, ''), repo FROM docs
`).run()

console.log(`[reindex-fts] 已重建 FTS（trigram）：experiences=${expCount} 条, docs=${docCount} 条`)
