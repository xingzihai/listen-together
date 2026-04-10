import paramiko
import json
import time
import sys

host = '107.172.234.183'
username = 'root'
password = 'wlLz9bmS96NUR7M2p6'

def ssh_command(cmd, timeout=10):
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

def get_status():
    out, err = ssh_command('curl -sk https://localhost:8443/api/debug/status')
    if out:
        try:
            # Extract JSON from curl output
            lines = out.strip().split('\n')
            for line in lines:
                if line.startswith('{'):
                    return json.loads(line)
        except:
            pass
    return {}

def trigger_auto_play():
    out, err = ssh_command('curl -sk https://localhost:8443/api/debug/auto-play')
    print(f"[auto-play] {out.strip()}")

def stop_auto_play():
    out, err = ssh_command('curl -sk https://localhost:8443/api/debug/auto-stop')
    print(f"[auto-stop] {out.strip()}")

def monitor_loop(duration_sec=60):
    """Monitor drift for duration_sec seconds"""
    print(f"\n=== Monitoring drift for {duration_sec} seconds ===\n")
    
    start_time = time.time()
    max_drift = 0
    drift_samples = []
    
    while time.time() - start_time < duration_sec:
        status = get_status()
        
        if status:
            server_pos = status.get('serverPos', 0.0)
            client_pos = status.get('clientPos', 0.0)
            expected_pos = status.get('expectedPos', 0.0)
            drift_ms = status.get('drift', 0)
            
            # Update max
            if abs(drift_ms) > max_drift:
                max_drift = abs(drift_ms)
            
            drift_samples.append(abs(drift_ms))
            
            # Print status
            elapsed = int(time.time() - start_time)
            print(f"[{elapsed}s] serverPos={server_pos:.2f} clientPos={client_pos:.2f} expected={expected_pos:.2f} drift={drift_ms}ms")
        
        time.sleep(1)
    
    # Summary
    if drift_samples:
        avg_drift = sum(drift_samples) / len(drift_samples)
        print(f"\n=== Summary ===")
        print(f"Max drift: {max_drift}ms")
        print(f"Average drift: {avg_drift:.2f}ms")
        print(f"Samples: {len(drift_samples)}")
        
        # Evaluate
        if max_drift < 30:
            print("PASS: Drift within 30ms target")
        elif max_drift < 100:
            print("WARNING: Drift exceeds 30ms but < 100ms")
        else:
            print("FAIL: Drift > 100ms - needs fix")

if __name__ == '__main__':
    # Start auto-play
    trigger_auto_play()
    time.sleep(2)
    
    # Monitor
    monitor_loop(30)
    
    # Stop
    stop_auto_play()