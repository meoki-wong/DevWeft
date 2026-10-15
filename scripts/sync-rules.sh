#!/bin/bash
# sync-rules.sh — 从服务端拉取 RULES_MANIFEST，生成通用项目规则文件
#
# 单一真源：服务端 docs 表 RULES_MANIFEST（update_doc 修改即生效）。
# 本脚本把规则同步到：
#   1. AGENTS.md 的硬规则段（RULES_MANIFEST_START/END 标记内）
#   2. .awp-rules-canon（纯规则文本，供本地一致性检查使用）
#
# 用法：./scripts/sync-rules.sh [mcp-url] [project-root]
#   mcp-url      默认 http://127.0.0.1:8787
#   project-root 默认当前目录（要写入规则文件的项目根）
#
# 验收：服务端 update_doc 改一条规则 → 本地跑 L0 即发现漂移 → 运行本脚本后三处一致。

set -euo pipefail

MCP_URL="${1:-http://127.0.0.1:8787}"
ROOT="${2:-$(pwd)}"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== 同步硬规则（单一真源 RULES_MANIFEST）==="
echo "  服务端: $MCP_URL"
echo "  目标项目: $ROOT"

MANIFEST=$(curl -s --max-time 5 "$MCP_URL/api/rules-manifest" 2>/dev/null)
if [ -z "$MANIFEST" ] || ! echo "$MANIFEST" | grep -q '"rules"'; then
  echo "  ⚠ 无法从 $MCP_URL 拉取 RULES_MANIFEST（服务端不可达？）。"
  echo "    请检查服务端地址与仓库规则配置后重试。"
  exit 1
fi

# 提取 rules 数组为纯文本（每行一条，保持编号）
RULES=$(echo "$MANIFEST" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    rules = d.get("rules", [])
except Exception:
    rules = []
print("\n".join(rules))
')

if [ -z "$RULES" ]; then
  echo "  ⚠ RULES_MANIFEST 为空"
  exit 1
fi

RULE_COUNT=$(echo "$RULES" | grep -c . || true)
echo "  拉取到 $RULE_COUNT 条规则"

# 1：更新 AGENTS.md 硬规则段（标记内替换，无标记则追加）
AGENTS="$ROOT/AGENTS.md"
START="<!-- RULES_MANIFEST_START -->"
END="<!-- RULES_MANIFEST_END -->"
BLOCK=$(printf '%s\n\n%s\n\n%s\n' "$START" "$RULES" "$END")
if [ -f "$AGENTS" ]; then
  if grep -q "$START" "$AGENTS" && grep -q "$END" "$AGENTS"; then
    # 用 python 就地替换标记块（兼容 macOS/BSD sed 差异）
    python3 - "$AGENTS" <<PY
import sys, io
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
start = "$START"
end = "$END"
a = s.index(start); b = s.index(end) + len(end)
s = s[:a] + '''$BLOCK''' + s[b:]
open(p, 'w', encoding='utf-8').write(s)
PY
  else
    printf '\n\n## 硬规则（单一真源自动同步）\n\n%s\n' "$BLOCK" >> "$AGENTS"
  fi
  echo "  ✓ AGENTS.md 硬规则段已同步"
else
  echo "  （AGENTS.md 不存在，跳过；如需要可先创建）"
fi

# 2：写入纯规则文本 marker（verify.sh L0 比对内容 hash）
printf '%s\n' "$RULES" > "$ROOT/.awp-rules-canon"
echo "  ✓ .awp-rules-canon（L0 hash 比对基准）"

echo ""
echo "✅ 规则同步完成。下次有人改 RULES_MANIFEST 后，本地检查规则一致性 会提示漂移。"
