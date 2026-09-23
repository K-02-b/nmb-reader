#!/bin/sh
# 首次部署 / 重建索引用：建表 + 建管理员 + 把关系库里的内容推到检索引擎。
# 由 compose 的 init 服务调用：docker compose --profile init run --rm init
#
# 可反复执行。--reset 会先清空检索引擎里已有的索引再全量重建，避免残留旧文档。
set -e

echo "== 1/2 建表 + 管理员 =="
python scripts/init_db.py ${INIT_ARGS:-}

echo "== 2/2 重建检索索引（等检索引擎就绪，最多重试 20 次）=="
i=0
until python scripts/build_index.py --reset; do
  i=$((i + 1))
  if [ "$i" -ge 20 ]; then
    echo "✗ 索引重建失败：检索引擎不可用。阅读功能不受影响（搜索会退化为 LIKE），" >&2
    echo "  修好后单独重跑：docker compose --profile init run --rm init python scripts/build_index.py --reset" >&2
    exit 1
  fi
  echo "  …检索服务还没就绪，3 秒后重试（$i/20）"
  sleep 3
done
echo "✓ 初始化完成"
