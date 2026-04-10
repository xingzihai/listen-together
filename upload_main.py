import paramiko
import os

host = '107.172.234.183'
username = 'root'
password = 'wlLz9bmS96NUR7M2p6'

def upload_file(local_path, remote_path):
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(host, username=username, password=password, timeout=30)
        sftp = client.open_sftp()
        sftp.put(local_path, remote_path)
        sftp.close()
        return True, "OK"
    except Exception as e:
        return False, str(e)
    finally:
        client.close()

def ssh_command(cmd, timeout=30):
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(host, username=username, password=password, timeout=30)
        stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
        return stdout.read().decode(), stderr.read().decode()
    except Exception as e:
        return '', str(e)
    finally:
        client.close()

# Upload main.go
print("Uploading main.go...")
ok, msg = upload_file('D:/autoclaw_workspace/listen-together/main.go', '/root/listen-together/main.go')
if ok:
    print("Upload OK")
else:
    print(f"Upload failed: {msg}")
    exit(1)

# Stop server
print("Stopping server...")
ssh_command("pkill -f listen-together")

# Rebuild
print("Rebuilding...")
out, err = ssh_command("cd /root/listen-together && go build -o listen-together .", timeout=120)
if 'error' in err.lower():
    print(f"Build error: {err}")
    exit(1)
print("Build OK")

# Restart
print("Restarting server...")
ssh_command("cd /root/listen-together && nohup ./listen-together > /tmp/listen-together.log 2>&1 &")

# Wait and test
import time
time.sleep(3)

print("\nTesting auto-play API...")
out, err = ssh_command("curl -sk https://localhost:8443/api/debug/auto-play")
print(out)

print("\nServer logs:")
out, err = ssh_command("tail -5 /tmp/listen-together.log")
print(out)