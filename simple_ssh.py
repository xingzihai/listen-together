import paramiko
import sys

host = '107.172.234.183'
username = 'root'
password = 'wlLz9bmS96NUR7M2p6'

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

try:
    print("Connecting...")
    client.connect(host, username=username, password=password, timeout=30, banner_timeout=30)
    print("Connected!")
    
    # Test connection
    stdin, stdout, stderr = client.exec_command('echo "SSH OK"', timeout=10)
    print(stdout.read().decode())
    
    # Check if server is running
    stdin, stdout, stderr = client.exec_command('ps aux | grep listen-together | grep -v grep', timeout=10)
    processes = stdout.read().decode()
    print(f"Processes: {processes}")
    
    # Test API
    stdin, stdout, stderr = client.exec_command('curl -k https://localhost:8443/api/debug/status 2>/dev/null', timeout=10)
    status = stdout.read().decode()
    print(f"Status API: {status}")
    
except Exception as e:
    print(f"Error: {e}")
    sys.exit(1)
finally:
    client.close()