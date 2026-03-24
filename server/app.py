import json
import os
import queue
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

from flask import Flask, Response, after_this_request, jsonify, request, send_file
from flask_cors import CORS
from werkzeug.exceptions import RequestEntityTooLarge
from dotenv import load_dotenv

from convert import convert_mov_to_mp4

MAX_UPLOAD_BYTES = 500 * 1024 * 1024
MAX_QUEUE_DEPTH = 5
JOB_TTL_SECONDS = 30 * 60
ALLOWED_VIDEO_EXTENSIONS = {".mov", ".mp4", ".m4v", ".3gp", ".webm", ".mkv", ".avi"}

_server_dir = Path(__file__).resolve().parent
_repo_dir = _server_dir.parent
load_dotenv(_server_dir / ".env")
load_dotenv(_repo_dir / ".env")

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


_debug = _env_bool("FLASK_DEBUG", False)
cors_origins_raw = os.getenv("CORS_ORIGINS", "")
cors_origins = [origin.strip() for origin in cors_origins_raw.split(",") if origin.strip()]
if cors_origins:
    CORS(app, resources={r"/api/*": {"origins": cors_origins}})
elif _debug:
    CORS(app, resources={r"/api/*": {"origins": "*"}})

jobs: Dict[str, Dict[str, Any]] = {}
queue_order: list[str] = []
job_queue: queue.Queue[str] = queue.Queue()
jobs_lock = threading.Lock()


def _is_supported_video_upload(filename: str, mimetype: str) -> bool:
    ext = Path(filename).suffix.lower()
    if ext in ALLOWED_VIDEO_EXTENSIONS:
        return True
    return mimetype.lower().startswith("video/")


def _cleanup_job(job_id: str) -> None:
    tmp_dir: Optional[str] = None
    with jobs_lock:
        job = jobs.pop(job_id, None)
        if job:
            tmp_dir = job.get("tmp_dir")
        if job_id in queue_order:
            queue_order.remove(job_id)
    if tmp_dir:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def _queue_position(job_id: str) -> Optional[int]:
    with jobs_lock:
        if job_id in queue_order:
            return queue_order.index(job_id) + 1
    return None


def _set_job_progress(job_id: str, percent: Optional[float]) -> None:
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            return
        if percent is None:
            job["progress"] = None
            return
        percent_int = max(0, min(100, int(percent)))
        current = job.get("progress")
        if current is None or percent_int > current:
            job["progress"] = percent_int


def _worker_loop() -> None:
    while True:
        job_id = job_queue.get()
        with jobs_lock:
            job = jobs.get(job_id)
            if not job:
                job_queue.task_done()
                continue
            job["status"] = "processing"
            job["message"] = "Converting with ffmpeg."
            job["started_at"] = time.time()
            if job_id in queue_order:
                queue_order.remove(job_id)

        try:
            convert_mov_to_mp4(
                job["input_path"],
                job["output_path"],
                progress_callback=lambda pct: _set_job_progress(job_id, pct),
            )
        except subprocess.CalledProcessError as exc:
            with jobs_lock:
                job = jobs.get(job_id)
                if job:
                    job["status"] = "error"
                    job["message"] = "Conversion failed."
                    job["error"] = str(exc)
        except Exception as exc:
            with jobs_lock:
                job = jobs.get(job_id)
                if job:
                    job["status"] = "error"
                    job["message"] = "Unexpected server error."
                    job["error"] = str(exc)
        else:
            with jobs_lock:
                job = jobs.get(job_id)
                if job:
                    job["status"] = "ready"
                    job["message"] = "Your MP4 is ready."
                    job["progress"] = 100
                    job["download_url"] = f"/api/download/{job_id}"
        finally:
            job_queue.task_done()


def _start_worker() -> None:
    thread = threading.Thread(target=_worker_loop, daemon=True)
    thread.start()


def _start_cleanup_worker() -> None:
    def cleanup_loop() -> None:
        while True:
            time.sleep(60)
            now = time.time()
            expired = []
            with jobs_lock:
                for job_id, job in list(jobs.items()):
                    created_at = job.get("created_at", now)
                    if job.get("status") in {"ready", "error"} and now - created_at > JOB_TTL_SECONDS:
                        expired.append(job_id)
            for job_id in expired:
                _cleanup_job(job_id)

    thread = threading.Thread(target=cleanup_loop, daemon=True)
    thread.start()


_start_worker()
_start_cleanup_worker()


@app.errorhandler(RequestEntityTooLarge)
def handle_file_too_large(_err):
    return jsonify({"error": "File too large. Max size is 500 MB."}), 413


@app.post("/api/convert")
def convert():
    if "file" not in request.files:
        return jsonify({"error": "No file uploaded."}), 400

    uploaded = request.files["file"]
    if uploaded.filename == "":
        return jsonify({"error": "Empty filename."}), 400

    if not _is_supported_video_upload(uploaded.filename, uploaded.mimetype or ""):
        return jsonify({"error": "Only video files are supported."}), 400

    with jobs_lock:
        if len(queue_order) >= MAX_QUEUE_DEPTH:
            return jsonify({"error": "Queue is full. Try again soon."}), 429

    tmp_dir = tempfile.mkdtemp(prefix="mov_to_mp4_")
    upload_ext = Path(uploaded.filename).suffix.lower()
    normalized_ext = upload_ext if upload_ext in ALLOWED_VIDEO_EXTENSIONS else ".mov"
    input_path = Path(tmp_dir) / f"input{normalized_ext}"
    output_path = Path(tmp_dir) / "output.mp4"

    try:
        uploaded.save(input_path)
    except Exception:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return jsonify({"error": "Failed to save upload."}), 500

    job_id = uuid.uuid4().hex
    download_name = f"{Path(uploaded.filename).stem}.mp4"

    with jobs_lock:
        jobs[job_id] = {
            "status": "queued",
            "message": "Queued for conversion.",
            "progress": 0,
            "error": None,
            "created_at": time.time(),
            "input_path": input_path,
            "output_path": output_path,
            "download_name": download_name,
            "tmp_dir": tmp_dir,
        }
        queue_order.append(job_id)

    job_queue.put(job_id)

    return jsonify({"job_id": job_id, "queue_position": _queue_position(job_id)})


@app.get("/api/progress/<job_id>")
def progress(job_id: str):
    def event_stream():
        last_payload: Optional[str] = None
        while True:
            with jobs_lock:
                job = jobs.get(job_id)
                if not job:
                    payload = {
                        "status": "error",
                        "message": "Job not found.",
                    }
                else:
                    queue_position = None
                    if job_id in queue_order:
                        queue_position = queue_order.index(job_id) + 1
                    payload = {
                        "status": job.get("status"),
                        "message": job.get("message"),
                        "progress": job.get("progress"),
                    }
                    if job.get("status") == "queued":
                        payload["queue_position"] = queue_position
                    if job.get("status") == "ready":
                        payload["download_url"] = job.get("download_url")
                        payload["output_name"] = job.get("download_name")
                    if job.get("status") == "error":
                        payload["error"] = job.get("error")

            encoded = json.dumps(payload)
            if encoded != last_payload:
                yield f"data: {encoded}\n\n"
                last_payload = encoded

            if payload.get("status") in {"ready", "error"}:
                break
            time.sleep(0.4)

    return Response(event_stream(), mimetype="text/event-stream")


@app.get("/api/download/<job_id>")
def download(job_id: str):
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            return jsonify({"error": "Job not found."}), 404
        if job.get("status") != "ready":
            return jsonify({"error": "Conversion not finished yet."}), 409
        output_path = job.get("output_path")
        download_name = job.get("download_name")

    @after_this_request
    def cleanup(response):
        _cleanup_job(job_id)
        return response

    return send_file(
        output_path,
        as_attachment=True,
        download_name=download_name,
        mimetype="video/mp4",
    )


if __name__ == "__main__":
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "5000"))
    app.run(host=host, port=port, debug=_debug)
