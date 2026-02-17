#!/bin/bash
# ListenTogether 启动脚本

# 启动Go服务
cd /root/.openclaw/workspace/github-projects/listen-together
nohup ./listen-together > /tmp/listen-together.log 2>&1 &
echo "ListenTogether started on :8080"

# 启动SakuraFrp穿透
sleep 1
nohup frpc -f 6k7fkea9qyimx6a36ob9pith1nblhmgf:25995194 > /tmp/frpc.log 2>&1 &
echo "SakuraFrp tunnel started: frp-bar.com:45956"
