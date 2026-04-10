"""
ListenTogether 真实 WebSocket 自动化测试客户端

流程：
1. HTTP 登录获取 JWT token
2. WebSocket 连接（携带 token）
3. Clock sync (ping/pong)
4. 加入测试房间
5. 监控 syncTick + 计算真实 drift
"""

import asyncio
import websockets
import json
import time
import ssl
import requests

SERVER_URL = "wss://107.172.234.183:8443/ws"
HTTP_URL = "https://107.172.234.183:8443"

# SSL context (ignore cert validation for test)
ssl_context = ssl.create_default_context()
ssl_context.check_hostname = False
ssl_context.verify_mode = ssl.CERT_NONE

class RealTestClient:
    def __init__(self, name):
        self.name = name
        self.ws = None
        self.token = None
        self.client_id = None
        self.clock_offset = 0  # ms
        self.rtt_samples = []
        self.drift_samples = []
        
    def login(self):
        """Login via HTTP API to get JWT token"""
        print(f"[{self.name}] Logging in...")
        
        # Login
        resp = requests.post(
            f"{HTTP_URL}/api/auth/login",
            json={"username": "admin", "password": "admin123"},
            verify=False
        )
        
        if resp.status_code != 200:
            print(f"[{self.name}] Login failed: {resp.text}")
            return False
        
        # Extract token from cookies
        cookies = resp.cookies
        if 'token' in cookies:
            self.token = cookies['token']
            print(f"[{self.name}] Token obtained: {self.token[:50]}...")
            return True
        else:
            print(f"[{self.name}] No token in response")
            return False
    
    async def connect(self):
        """Connect WebSocket with token"""
        print(f"[{self.name}] Connecting to WebSocket...")
        
        # Pass token in cookie header
        headers = {
            "Cookie": f"token={self.token}",
            "Origin": HTTP_URL
        }
        
        try:
            # websockets 10.x+ uses additional_headers
            self.ws = await websockets.connect(
                SERVER_URL,
                ssl=ssl_context,
                additional_headers=headers
            )
            print(f"[{self.name}] WebSocket connected!")
            return True
        except TypeError:
            # Try old API (extra_headers)
            try:
                self.ws = await websockets.connect(
                    SERVER_URL,
                    ssl=ssl_context,
                    extra_headers=headers
                )
                print(f"[{self.name}] WebSocket connected!")
                return True
            except Exception as e2:
                print(f"[{self.name}] Connection failed: {e2}")
                return False
        except Exception as e:
            print(f"[{self.name}] Connection failed: {e}")
            return False
    
    async def clock_sync(self, rounds=5):
        """NTP-style clock synchronization"""
        print(f"[{self.name}] Starting clock sync ({rounds} rounds)...")
        
        self.rtt_samples = []
        
        for i in range(rounds):
            client_time = int(time.time() * 1000)
            
            # Send ping
            await self.ws.send(json.dumps({
                "type": "ping",
                "clientTime": client_time
            }))
            
            # Receive pong
            try:
                response = await asyncio.wait_for(self.ws.recv(), timeout=2.0)
                data = json.loads(response)
                
                if data.get("type") == "pong":
                    server_time = data.get("serverTime", 0)
                    returned_client_time = data.get("clientTime", client_time)
                    
                    # Calculate RTT and offset
                    now = int(time.time() * 1000)
                    rtt = now - returned_client_time
                    offset = server_time - (returned_client_time + rtt // 2)
                    
                    self.rtt_samples.append({
                        "rtt": rtt,
                        "offset": offset
                    })
                    
                    print(f"[{self.name}] Round {i+1}: RTT={rtt}ms, offset={offset}ms")
            except asyncio.TimeoutError:
                print(f"[{self.name}] Round {i+1}: timeout")
        
        # Use minimum RTT sample for offset
        if self.rtt_samples:
            best = min(self.rtt_samples, key=lambda x: x["rtt"])
            self.clock_offset = best["offset"]
            print(f"[{self.name}] Clock sync done: offset={self.clock_offset}ms (RTT={best['rtt']}ms)")
    
    async def create_room(self, room_code="TEST01"):
        """Create test room"""
        print(f"[{self.name}] Creating room {room_code}...")
        
        await self.ws.send(json.dumps({
            "type": "create",
            "clientTime": int(time.time() * 1000)
        }))
        
        try:
            response = await asyncio.wait_for(self.ws.recv(), timeout=5.0)
            data = json.loads(response)
            
            if data.get("type") == "roomCreated" or (data.get("type") == "created" and data.get("success")):
                self.client_id = data.get("clientID", "")
                room_code = data.get("roomCode", "")
                print(f"[{self.name}] Room created: {room_code}, clientID={self.client_id}")
                return room_code
            else:
                print(f"[{self.name}] Create failed: {data}")
                return None
        except asyncio.TimeoutError:
            print(f"[{self.name}] Create timeout")
            return None
    
    async def join_room(self, room_code):
        """Join existing room"""
        print(f"[{self.name}] Joining room {room_code}...")
        
        await self.ws.send(json.dumps({
            "type": "join",
            "RoomCode": room_code,  # Use correct field name
            "clientTime": int(time.time() * 1000)
        }))
        
        try:
            response = await asyncio.wait_for(self.ws.recv(), timeout=5.0)
            data = json.loads(response)
            
            if data.get("type") == "roomJoined" or data.get("type") == "joined":
                self.client_id = data.get("clientID", "")
                room_code = data.get("roomCode", "") or data.get("RoomCode", "")
                print(f"[{self.name}] Joined room {room_code}, clientID={self.client_id}")
                return True
            else:
                print(f"[{self.name}] Join failed: {data}")
                return False
        except asyncio.TimeoutError:
            print(f"[{self.name}] Join timeout")
            return False
    
    async def simulate_playback(self, duration_sec=30):
        """Simulate playback and monitor syncTick"""
        print(f"[{self.name}] Monitoring syncTick for {duration_sec}s...")
        
        start_time = time.time()
        self.drift_samples = []
        
        # Start simulated playback position
        client_playback_start = time.time()
        
        while time.time() - start_time < duration_sec:
            try:
                # Wait for syncTick with timeout
                response = await asyncio.wait_for(self.ws.recv(), timeout=2.0)
                data = json.loads(response)
                
                if data.get("type") == "syncTick":
                    server_pos = data.get("position", 0.0)
                    server_time = data.get("serverTime", 0)
                    
                    # Calculate client position
                    # client_pos = elapsed time since our playback started
                    elapsed = time.time() - client_playback_start
                    client_pos = elapsed
                    
                    # Calculate drift (client vs server)
                    drift_ms = (client_pos - server_pos) * 1000
                    
                    # Apply clock offset correction
                    corrected_drift = drift_ms - self.clock_offset
                    
                    self.drift_samples.append(abs(corrected_drift))
                    
                    elapsed_sec = int(time.time() - start_time)
                    print(f"[{self.name}] [{elapsed_sec}s] serverPos={server_pos:.2f}s clientPos={client_pos:.2f}s drift={corrected_drift:.1f}ms")
                
                elif data.get("type") == "error":
                    print(f"[{self.name}] Error: {data.get('error')}")
                
            except asyncio.TimeoutError:
                # No syncTick received, continue
                pass
        
        # Summary
        if self.drift_samples:
            max_drift = max(self.drift_samples)
            avg_drift = sum(self.drift_samples) / len(self.drift_samples)
            print(f"\n[{self.name}] === Summary ===")
            print(f"Max drift: {max_drift:.1f}ms")
            print(f"Average drift: {avg_drift:.1f}ms")
            print(f"Samples: {len(self.drift_samples)}")
            
            if max_drift < 30:
                print("PASS: Drift within 30ms target")
            elif max_drift < 100:
                print("WARNING: Drift exceeds 30ms")
            else:
                print("FAIL: Drift > 100ms")
    
    async def close(self):
        """Close connection"""
        if self.ws:
            await self.ws.close()
            print(f"[{self.name}] Connection closed")

async def main():
    """Run real WebSocket sync test"""
    
    print("=== ListenTogether Real WebSocket Test ===")
    
    # Step 0: Trigger auto-play on server (creates AUTOTEST room with playback)
    print("\n0. Trigger server auto-play")
    resp = requests.post(f"{HTTP_URL}/api/debug/auto-play", verify=False)
    print(f"Auto-play: {resp.text}")
    
    await asyncio.sleep(2)  # Wait for playback to start
    
    print("\n1. Login via HTTP")
    
    client = RealTestClient("TestClient")
    
    # Step 1: Login
    if not client.login():
        print("Login failed, aborting")
        return
    
    print("\n2. Connect WebSocket")
    
    # Step 2: WebSocket connect
    if not await client.connect():
        print("WebSocket connect failed, aborting")
        return
    
    print("\n3. Clock sync (NTP-style)")
    
    # Step 3: Clock sync
    await client.clock_sync(rounds=5)
    
    print("\n4. Join AUTOTEST room (auto-play)")
    
    # Step 4: Join the auto-play room
    if not await client.join_room("AUTOTEST"):
        print("Join failed, trying to monitor anyway...")
    
    print(f"\n5. Monitor syncTick for 30s")
    await client.simulate_playback(30)
    
    # Cleanup
    await client.close()

if __name__ == '__main__':
    asyncio.run(main())