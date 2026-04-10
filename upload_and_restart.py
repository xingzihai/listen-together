import paramiko
import os
import sys

host = '107.172.234.183'
username = 'root'
password = 'wlLz9bmS96NUR7M2p6'

def upload_file(local_path, remote_path):
    """Upload file via SSH/SFTP"""
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    
    try:
        client.connect(host, username=username, password=password, timeout=30)
        sftp = client.open_sftp()
        sftp.put(local_path, remote_path)
        sftp.close()
        return True, "Upload OK"
    except Exception as e:
        return False, str(e)
    finally:
        client.close()

def run_ssh_command(command):
    """Run SSH command and return output"""
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    
    try:
        client.connect(host, username=username, password=password, timeout=30)
        stdin, stdout, stderr = client.exec_command(command, timeout=120)
        output = stdout.read().decode('utf-8')
        error = stderr.read().decode('utf-8')
        return output, error
    except Exception as e:
        return '', str(e)
    finally:
        client.close()

if __name__ == '__main__':
    # Upload main.go
    local_main = 'D:/autoclaw_workspace/listen-together/main.go'
    remote_main = '/root/listen-together/main.go'
    
    print("Uploading main.go...")
    ok, msg = upload_file(local_main, remote_main)
    if not ok:
        print(f"Upload failed: {msg}")
        sys.exit(1)
    print("Upload OK")
    
    # Stop server, rebuild, restart
    print("Stopping server...")
    run_ssh_command("pkill -f listen-together")
    
    print("Rebuilding...")
    out, err = run_ssh_command("cd /root/listen-together && go build -o listen-together .")
    if err and 'error' in err.lower():
        print(f"Build error: {err}")
        sys.exit(1)
    print("Build OK")
    
    print("Restarting server...")
    run_ssh_command("cd /root/listen-together && nohup ./listen-together > /tmp/listen-together.log 2>&1 &")
    
    # Wait and check
    import time
    time.sleep(3)
    out, err = run_ssh_command("tail -10 /tmp/listen-together.log")
    print("Server logs:")
    print(out)
    
    # Test auto-play API
    print("\nTesting auto-play API...")
    out, err = run_ssh_command("curl -k https://localhost:8443/api/debug/auto-play")
    print(out)
    if err:
        print(f"Error: {err}")