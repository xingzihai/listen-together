#!/bin/bash
# ListenTogether 启动脚本

cd /root/.openclaw/workspace/github-projects/listen-together

# Fixed JWT secret so tokens survive restarts
export JWT_SECRET="lt-s3cr3t-k8y-2026-xzh-permanent"

# 杀掉旧进程
pkill -f './listen-together' 2>/dev/null
pkill -f 'frpc.*25995194' 2>/dev/null
sleep 1

# 启动Go服务
nohup ./listen-together > /tmp/listen-together.log 2>&1 &
echo "ListenTogether started on :8080"

# 启动SakuraFrp穿透
sleep 1
nohup frpc -f 6k7fkea9qyimx6a36ob9pith1nblhmgf:25995194 > /tmp/frpc.log 2>&1 &
echo "SakuraFrp tunnel started: frp-bar.com:45956"
