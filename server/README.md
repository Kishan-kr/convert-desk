# Server

This server accepts video uploads, converts them to MP4 with `ffmpeg`, streams job progress to the client, and serves the converted file for download.

## Stack

- Python
- Flask
- Flask-CORS
- `python-dotenv`
- `ffmpeg` and `ffprobe`

## What The Server Does

- Accepts a single uploaded video file at `POST /api/convert`
- Queues conversion jobs and processes them in a background worker
- Converts supported video formats to MP4 using H.264 video and AAC audio
- Streams conversion status through Server-Sent Events at `GET /api/progress/<job_id>`
- Returns the finished file at `GET /api/download/<job_id>`
- Automatically cleans up temporary files after download or after job expiry

## Limits And Behavior

- Maximum upload size: `500 MB`
- Maximum queued jobs: `5`
- Job retention after completion/error: `30 minutes`
- Supported extensions: `.mov`, `.mp4`, `.m4v`, `.3gp`, `.webm`, `.mkv`, `.avi`

## Requirements

1. Python 3.10+ is recommended.
2. `ffmpeg` and `ffprobe` must be installed and available on your `PATH`.

To verify `ffmpeg` is available:

```powershell
ffmpeg -version
ffprobe -version
```

## Install Dependencies

From the project root:

```powershell
cd server
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

## Environment Variables

The server loads environment variables from:

- `server/.env`
- repo root `.env`

Supported variables:

- `HOST`: Flask bind host. Default: `0.0.0.0`
- `PORT`: Flask port. Default: `5000`
- `FLASK_DEBUG`: Enables Flask debug mode when set to `1`, `true`, `yes`, or `on`
- `CORS_ORIGINS`: Comma-separated allowed origins for `/api/*`

Example `server/.env`:

```env
HOST=0.0.0.0
PORT=5000
FLASK_DEBUG=true
CORS_ORIGINS=http://localhost:5173
```

## Run The Server

From the `server` directory:

```powershell
.venv\Scripts\Activate.ps1
python app.py
```

The API will be available at:

```text
http://localhost:5000
```

## API Overview

### `POST /api/convert`

Uploads a video file using multipart form data with the field name `file`.

Success response:

```json
{
  "job_id": "9d7d5d0e4b4d48eab0a77f7d9f84d2aa",
  "queue_position": 1
}
```

Common errors:

- `400`: missing file, empty filename, or unsupported file type
- `413`: file larger than `500 MB`
- `429`: queue is full
- `500`: upload save failure

### `GET /api/progress/<job_id>`

Streams JSON payloads as Server-Sent Events.

Example payloads:

```json
{"status":"queued","message":"Queued for conversion.","progress":0,"queue_position":1}
```

```json
{"status":"processing","message":"Converting with ffmpeg.","progress":42}
```

```json
{"status":"ready","message":"Your MP4 is ready.","progress":100,"download_url":"/api/download/<job_id>","output_name":"video.mp4"}
```

```json
{"status":"error","message":"Conversion failed.","error":"..."}
```

### `GET /api/download/<job_id>`

Downloads the converted MP4 after the job reaches `ready`.

- Returns `404` if the job does not exist
- Returns `409` if conversion is not finished
- Removes the temporary files after a successful download response

## Running With The Vite Client

The client proxies `/api` requests to `VITE_API_URL`.

Current client default:

```text
http://localhost:8000
```

The server default is:

```text
http://localhost:5000
```

To run both together, use one of these options:

1. Set `PORT=8000` for the server.
2. Or set `VITE_API_URL=http://localhost:5000` in `client/.env`.

## Notes

- If `ffmpeg` or `ffprobe` is missing, conversion will fail at runtime.
- Progress may be indeterminate for files where duration probing is unavailable.
- CORS is only enabled when `CORS_ORIGINS` is set, or when `FLASK_DEBUG` is enabled.
