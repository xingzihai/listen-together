import paramiko

host = '107.172.234.183'
username = 'root'
password = 'wlLz9bmS96NUR7M2p6'

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

try:
    client.connect(host, username=username, password=password, timeout=30)
    
    # Test auto-play API (check if endpoint exists)
    stdin, stdout, stderr = client.exec_command('curl -k https://localhost:8443/api/debug/auto-play 2>&1', timeout=10)
    result = stdout.read().decode()
    err = stderr.read().decode()
    print(f"auto-play result: {result}")
    if err:
        print(f"stderr: {err}")
    
    # Check logs
    stdin, stdout, stderr = client.exec_command('tail -20 /tmp/listen-together.log 2>/dev/null', timeout=10)
    logs = stdout.read().decode()
    print(f"\nLogs:\n{logs}")
    
except Exception as e:
    print(f"Error: {e}")
finally:
    client.close()