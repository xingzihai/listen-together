#!/bin/bash
# ListenTogether 启动脚本（带进程管理，防僵尸）

cd /root/.openclaw/workspace/github-projects/listen-together

# Fixed JWT secret so tokens survive restarts
export JWT_SECRET="lt-s3cr3t-k8y-2026-xzh-permanent"

# 杀掉旧的子进程（不杀start.sh自身，避免误杀）
pkill -f '^\./listen-together$' 2>/dev/null
# 注意：不能用 './listen-together' 模糊匹配，会误杀 listen-together-demo
pkill -f 'frpc.*25995194' 2>/dev/null
sleep 1

# 启动Go服务
./listen-together > /tmp/listen-together.log 2>&1 &
LT_PID=$!
echo "ListenTogether started on :8080 (PID $LT_PID)"

# 启动SakuraFrp穿透
sleep 1
frpc -f 6k7fkea9qyimx6a36ob9pith1nblhmgf:25995194 > /tmp/frpc.log 2>&1 &
FRPC_PID=$!
echo "SakuraFrp tunnel started: frp-fan.com:45956 (PID $FRPC_PID)"

# 退出时清理子进程
trap "kill $LT_PID $FRPC_PID 2>/dev/null; wait" EXIT

# 持续wait，作为父进程回收子进程，防止僵尸
wait
