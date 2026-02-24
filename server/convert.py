import subprocess
from pathlib import Path
from typing import Callable, Optional, Union


def _probe_duration_seconds(input_file: Union[str, Path]) -> Optional[float]:
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(input_file),
            ],
            capture_output=True,
            text=True,
            check=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None

    value = result.stdout.strip()
    if not value:
        return None

    try:
        return float(value)
    except ValueError:
        return None


def convert_mov_to_mp4(
    input_file: Union[str, Path],
    output_file: Union[str, Path],
    progress_callback: Optional[Callable[[Optional[float]], None]] = None,
) -> None:
    duration_seconds = _probe_duration_seconds(input_file)

    command = [
        "ffmpeg",
        "-y",
        "-i",
        str(input_file),
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "23",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-progress",
        "pipe:1",
        "-nostats",
        "-loglevel",
        "error",
        str(output_file),
    ]

    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )

    if process.stdout is not None:
        for line in process.stdout:
            line = line.strip()
            if not line or "=" not in line:
                continue
            key, value = line.split("=", 1)
            if key == "out_time_ms":
                try:
                    out_time_ms = int(value)
                except ValueError:
                    continue
                if duration_seconds:
                    percent = min(100.0, (out_time_ms / (duration_seconds * 1_000_000)) * 100)
                    if progress_callback:
                        progress_callback(percent)
                elif progress_callback:
                    progress_callback(None)

    stderr = process.stderr.read() if process.stderr is not None else ""
    return_code = process.wait()
    if return_code != 0:
        raise subprocess.CalledProcessError(return_code, command, output=stderr)

    if progress_callback:
        progress_callback(100.0)


if __name__ == "__main__":
    input_file = "input.mov"
    output_file = "output.mp4"
    convert_mov_to_mp4(input_file, output_file)
    print("Conversion complete:", output_file)
