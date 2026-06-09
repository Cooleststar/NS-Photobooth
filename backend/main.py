"""
Photobooth pose detection backend.
  ws://localhost:9090/       -> rosbridge (sends pose data to frontend)
  ws://localhost:9090/video  -> receives camera frames from browser
"""
import asyncio
import json
import logging
import cv2
import numpy as np
import mediapipe as mp
import websockets

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

# MediaPipe pose detector (CPU, no GPU needed)
_mp = mp.solutions.pose
detector = _mp.Pose(
    static_image_mode=False,
    model_complexity=1,
    enable_segmentation=False,
    min_detection_confidence=0.5,
    min_tracking_confidence=0.5,
)

rosbridge_clients: set = set()
clients_lock = asyncio.Lock()

# The frontend (roslib/nice-ros) looks up a topic's message type via the
# /rosapi/topic_type service before it will subscribe to it. Without a reply
# here, getTopicType() never resolves and subscribeTopic() silently never
# subscribes, so pose data never reaches the frontend even though the backend
# is broadcasting it correctly.
TOPIC_TYPES = {
    "/pose_out": "nice_ros_msgs/WholeBodyArray",
    "/rect_out": "visualization_msgs/ImageMarkerArray",
}


async def handle_service_call(ws, msg: dict):
    service = msg.get("service")
    call_id = msg.get("id")
    args = msg.get("args") or {}

    if service == "/rosapi/topic_type":
        values = {"type": TOPIC_TYPES.get(args.get("topic"), "std_msgs/String")}
    elif service == "/rosapi/service_type":
        values = {"type": "rosapi/TopicType"}
    else:
        return

    await ws.send(json.dumps({
        "op": "service_response",
        "id": call_id,
        "service": service,
        "values": values,
        "result": True,
    }))


async def broadcast(topic: str, msg: dict):
    payload = json.dumps({"op": "publish", "topic": topic, "msg": msg})
    async with clients_lock:
        dead = set()
        for ws in rosbridge_clients:
            try:
                await ws.send(payload)
            except Exception:
                dead.add(ws)
        rosbridge_clients.difference_update(dead)


async def handle_rosbridge(ws):
    log.info("Rosbridge client connected")
    async with clients_lock:
        rosbridge_clients.add(ws)
    try:
        async for message in ws:
            log.info(f"Rosbridge msg: {str(message)[:120]}")
            try:
                msg = json.loads(message)
            except (json.JSONDecodeError, TypeError):
                continue
            if msg.get("op") == "call_service":
                await handle_service_call(ws, msg)
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        async with clients_lock:
            rosbridge_clients.discard(ws)
        log.info("Rosbridge client disconnected")


async def handle_video(ws):
    log.info("Video feed connected")
    frame_count = 0
    pose_count = 0
    try:
        async for message in ws:
            if not isinstance(message, bytes):
                continue
            frame_count += 1
            arr = np.frombuffer(message, np.uint8)
            frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
            if frame is None:
                continue

            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            results = detector.process(rgb)

            if frame_count % 30 == 0:
                log.info(f"Frames: {frame_count}, Poses: {pose_count}")

            if not results.pose_landmarks:
                continue

            pose_count += 1
            lm = results.pose_landmarks.landmark
            await broadcast("/pose_out", {
                "poses": [{
                    "x": [l.x for l in lm],
                    "y": [l.y for l in lm],
                    "z": [l.z for l in lm],
                    "scores": [l.visibility for l in lm],
                    "track": {"id": 0},
                }]
            })
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        log.info("Video feed disconnected")


async def handler(ws, path):
    if path == "/video":
        await handle_video(ws)
    else:
        await handle_rosbridge(ws)


async def main():
    log.info("Photobooth backend starting on port 9090...")
    async with websockets.serve(handler, "0.0.0.0", 9090):
        log.info("Ready — waiting for connections.")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
