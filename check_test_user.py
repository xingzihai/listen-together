import paramiko
import json

host = '107.172.234.183'
username = 'root'
password = 'wlLz9bmS96NUR7M2p6'

def ssh_cmd(cmd, timeout=30):
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(host, username=username, password=password, timeout=30)
        stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
        return stdout.read().decode(), stderr.read().decode()
    finally:
        client.close()

# Check database
print("Checking database for test user...")
out, err = ssh_cmd("cd /root/listen-together && sqlite3 data/listen-together.db 'SELECT id, username, role FROM users LIMIT 5;'")
print(f"Users: {out}")

# Check if there's an owner account
out, err = ssh_cmd("cd /root/listen-together && sqlite3 data/listen-together.db 'SELECT id, username, role FROM users WHERE role=\"owner\";'")
print(f"Owner: {out}")

# Try login API with default credentials
print("\nTesting login API...")
out, err = ssh_cmd("curl -sk -X POST https://localhost:8443/api/auth/login -H 'Content-Type: application/json' -d '{" +
    '"username": "admin", "password": "admin123"' + "}'")
print(f"Login result: {out}")

# Try with OWNER credentials (from env or config)
out, err = ssh_cmd("cat /root/listen-together/.env 2>/dev/null || echo 'No .env'")
print(f"Env: {out}")