import paramiko
import sys

def run_ssh_command(host, username, password, command):
    """Run SSH command and return output"""
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    
    try:
        client.connect(host, username=username, password=password, timeout=30)
        stdin, stdout, stderr = client.exec_command(command, timeout=60)
        output = stdout.read().decode('utf-8')
        error = stderr.read().decode('utf-8')
        return output, error
    except Exception as e:
        return '', str(e)
    finally:
        client.close()

if __name__ == '__main__':
    host = '107.172.234.183'
    username = 'root'
    password = 'wlLz9bmS96NUR7M2p6'
    
    if len(sys.argv) > 1:
        command = ' '.join(sys.argv[1:])
    else:
        command = 'echo "Connection OK"'
    
    output, error = run_ssh_command(host, username, password, command)
    print(output, end='')
    if error:
        print(error, file=sys.stderr, end='')