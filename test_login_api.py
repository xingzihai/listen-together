import paramiko
import json

host = '107.172.234.183'
username_ssh = 'root'
password_ssh = 'wlLz9bmS96NUR7M2p6'

def ssh_cmd(cmd, timeout=30):
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(host, username=username_ssh, password=password_ssh, timeout=30)
        stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
        return stdout.read().decode(), stderr.read().decode()
    finally:
        client.close()

# Login and capture cookies/token
print("=== Testing login API ===")

# Use curl with verbose to see headers
cmd = """curl -sk -v -X POST https://localhost:8443/api/auth/login \
 -H 'Content-Type: application/json' \
 -d '{"username": "admin", "password": "admin123"}' \
 -c /tmp/cookies.txt \
 2>&1"""

out, err = ssh_cmd(cmd, timeout=15)
print(out)

# Extract token from cookies
print("\n=== Checking cookies ===")
out, err = ssh_cmd("cat /tmp/cookies.txt")
print(out)

# Also try using the token directly
print("\n=== Testing /api/auth/me with cookies ===")
cmd = """curl -sk -b /tmp/cookies.txt https://localhost:8443/api/auth/me"""
out, err = ssh_cmd(cmd)
print(f"Me: {out}")

# Now test WebSocket with token
print("\n=== WebSocket connection test ===")
# Need to pass token via query param or cookie
# Try with cookie
cmd = """curl -sk -b /tmp/cookies.txt \
 -H 'Connection: Upgrade' \
 -H 'Upgrade: websocket' \
 -H 'Sec-WebSocket-Version: 13' \
 -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
 https://localhost:8443/ws"""
out, err = ssh_cmd(cmd, timeout=10)
print(f"WS attempt: {out[:200] if len(out) > 200 else out}")
print(f"WS error: {err}")