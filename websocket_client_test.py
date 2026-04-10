"""
ListenTogether WebSocket 自动化测试客户端

模拟真实客户端连接 WebSocket，测试同步逻辑
"""

import asyncio
import websockets
import json
import time
import ssl

SERVER_URL = "wss://107.172.234.183:8443/ws"
ROOM_CODE = "AUTOTEST"

# SSL context (ignore cert validation for test server)
ssl_context = ssl.create_default_context()
ssl_context.check_hostname = False
ssl_context.verify_mode = ssl.CERT_NONE

class TestClient:
    def __init__(self, name):
        self.name = name
        self.ws = None
        self.client_id = None
        self.connected = False
        self.clock_offset = 0  # Client clock offset from server
        self.rtt_samples = []
        
    async def connect(self):
        """Connect to WebSocket"""
        print(f"[{self.name}] Connecting to {SERVER_URL}...")
        
        # Note: Need to send auth token in query params or headers
        # For now, use test mode (bypass auth)
        
        try:
            self.ws = await websockets.connect(
                SERVER_URL,
                ssl=ssl_context,
                extra_headers={"Origin": "https://107.172.234.183:8443"}
            )
            self.connected = True
            print(f"[{self.name}] Connected!")
            return True
        except Exception as e:
            print(f"[{self.name}] Connection failed: {e}")
            return False
    
    async def clock_sync(self, rounds=5):
        """NTP-style clock synchronization"""
        print(f"[{self.name}] Starting clock sync ({rounds} rounds)...")
        
        self.rtt_samples = []
        
        for i in range(rounds):
            client_time = time.time() * 1000
            
            # Send ping
            await self.ws.send(json.dumps({
                "type": "ping",
                "clientTime": client_time
            }))
            
            # Receive pong
            response = await self.ws.recv()
            data = json.loads(response)
            
            if data.get("type") == "pong":
                server_time = data.get("serverTime", 0)
                returned_client_time = data.get("clientTime", client_time)
                
                # Calculate RTT and offset
                rtt = (time.time() * 1000 - returned_client_time)
                offset = server_time - (returned_client_time + rtt / 2)
                
                self.rtt_samples.append({
                    "rtt": rtt,
                    "offset": offset,
                    "server_time": server_time
                })
                
                print(f"[{self.name}] Round {i+1}: RTT={rtt:.2f}ms, offset={offset:.2f}ms")
        
        # Use median RTT for offset calculation
        if self.rtt_samples:
            sorted_by_rtt = sorted(self.rtt_samples, key=lambda x: x["rtt"])
            best = sorted_by_rtt[len(sorted_by_rtt) // 2]
            self.clock_offset = best["offset"]
            print(f"[{self.name}] Clock sync complete: offset={self.clock_offset:.2f}ms")
    
    async def join_room(self, room_code):
        """Join test room"""
        await self.ws.send(json.dumps({
            "type": "joinRoom",
            "roomCode": room_code,
            "clientTime": time.time() * 1000
        }))
        
        response = await self.ws.recv()
        data = json.loads(response)
        
        if data.get("type") == "roomJoined":
            self.client_id = data.get("clientID", "")
            print(f"[{self.name}] Joined room {room_code}, clientID={self.client_id}")
            return True
        else:
            print(f"[{self.name}] Failed to join room: {data}")
            return False
    
    async def simulate_playback(self, duration_sec=30):
        """Simulate playback and report drift"""
        print(f"[{self.name}] Starting playback simulation for {duration_sec}s...")
        
        start_time = time.time()
        
        # Monitor syncTick messages
        while time.time() - start_time < duration_sec:
            try:
                # Wait for message with timeout
                response = await asyncio.wait_for(self.ws.recv(), timeout=2.0)
                data = json.loads(response)
                
                if data.get("type") == "syncTick":
                    server_pos = data.get("position", 0)
                    server_time = data.get("serverTime", 0)
                    
                    # Calculate expected client position
                    elapsed = time.time() - start_time
                    client_pos = elapsed  # Simulated position
                    
                    # Get server position from server time
                    current_server_time = time.time() * 1000 + self.clock_offset
                    server_elapsed = (current_server_time - server_time) / 1000
                    
                    # Calculate drift
                    drift_ms = (client_pos - server_pos) * 1000
                    
                    print(f"[{self.name}] syncTick: serverPos={server_pos:.2f}s clientPos={client_pos:.2f}s drift={drift_ms:.2f}ms")
                
            except asyncio.TimeoutError:
                # No message received, continue
                pass
    
    async def close(self):
        """Close connection"""
        if self.ws:
            await self.ws.close()
            print(f"[{self.name}] Connection closed")

async def main():
    """Test sync with simulated clients"""
    
    # Note: This requires authentication token
    # For full automation, we need to:
    # 1. Get auth token via HTTP login API
    # 2. Pass token in WebSocket connection
    
    print("=== ListenTogether WebSocket Automated Test ===")
    print("\nNote: This test requires authentication.")
    print("For full automation, need to implement auth token flow first.")
    
    # TODO: Implement auth flow
    # 1. POST /api/auth/login to get JWT token
    # 2. Pass token in WebSocket query params
    
    print("\nFor now, testing with existing browser session:")
    print("1. Open browser and login")
    print("2. Get JWT token from browser cookies")
    print("3. Use token in this script")
    
    # Alternative: Create test endpoint that bypasses auth for automation
    print("\nAlternative approach: Add /ws-test endpoint for automated testing")

if __name__ == '__main__':
    asyncio.run(main())