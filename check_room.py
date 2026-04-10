import paramiko

host = '107.172.234.183'
username = 'root'
password = 'wlLz9bmS96NUR7M2p6'

def ssh_cmd(cmd):
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(host, username=username, password=password, timeout=30)
        stdin, stdout, stderr = client.exec_command(cmd, timeout=30)
        return stdout.read().decode()
    finally:
        client.close()

# Trigger auto-play
print("=== Trigger auto-play ===")
print(ssh_cmd("curl -sk https://localhost:8443/api/debug/auto-play"))

# Check room status
print("\n=== Check AUTOTEST room ===")
print(ssh_cmd("curl -sk https://localhost:8443/api/debug/status"))

# Check logs
print("\n=== Server logs ===")
print(ssh_cmd("tail -30 /tmp/listen-together.log"))