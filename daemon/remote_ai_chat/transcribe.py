"""Voice-note transcription.

Two backends behind one interface (``available()`` / ``transcribe()``):

* macOS / Apple silicon: ``mlx-whisper``. Audio is decoded with the built-in
  ``afconvert`` (or ffmpeg) into 16 kHz mono PCM and handed over as numpy.
* Windows / Linux: ``faster-whisper`` (CTranslate2 on the CPU). It decodes the
  audio itself through PyAV, so no ffmpeg binary is needed.

Both load their model on first use and keep it for the life of the process; the
first voice note therefore takes a while (~500 MB model download)."""
from __future__ import annotations

import asyncio
import logging
import shutil
import subprocess
import threading
import wave
from pathlib import Path

log = logging.getLogger("rac.transcribe")
MODEL = "mlx-community/whisper-small-mlx"     # mlx backend
FW_MODEL = "small"                              # faster-whisper backend (Systran/faster-whisper-small)

_fw_model = None
_fw_lock = threading.Lock()


def _backend() -> str | None:
    try:
        import mlx_whisper  # noqa: F401
        import numpy  # noqa: F401
        if shutil.which("afconvert") is not None or shutil.which("ffmpeg") is not None:
            return "mlx"
    except Exception:
        pass
    try:
        import faster_whisper  # noqa: F401
        return "faster"
    except Exception:
        return None


def available() -> bool:
    return _backend() is not None


# ── mlx-whisper (macOS) ────────────────────────────────────────────────────
def _decode(src: Path):
    """→ float32 numpy array at 16 kHz mono."""
    import numpy as np
    wav = src.with_suffix(".16k.wav")
    if shutil.which("afconvert"):
        subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", str(src), str(wav)],
                       check=True, timeout=120, capture_output=True)
    else:
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-ar", "16000", "-ac", "1", str(wav)],
                       check=True, timeout=120)
    with wave.open(str(wav), "rb") as w:
        frames = w.readframes(w.getnframes())
    wav.unlink(missing_ok=True)
    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0


def _transcribe_mlx(path: Path, lang: str | None) -> dict | None:
    import mlx_whisper
    audio = _decode(path)
    kw = {"path_or_hf_repo": MODEL}
    if lang in ("en", "tr"):
        kw["language"] = lang
    out = mlx_whisper.transcribe(audio, **kw)
    text = (out.get("text") or "").strip()
    return {"text": text, "language": out.get("language")} if text else None


# ── faster-whisper (Windows / Linux) ───────────────────────────────────────
def _fw():
    global _fw_model
    with _fw_lock:
        if _fw_model is None:
            from faster_whisper import WhisperModel
            log.info("loading faster-whisper %s (first use downloads the model)", FW_MODEL)
            _fw_model = WhisperModel(FW_MODEL, device="cpu", compute_type="int8")
    return _fw_model


def _transcribe_faster(path: Path, lang: str | None) -> dict | None:
    model = _fw()
    # Let whisper detect the spoken language. `lang` is the phone's UI language,
    # and forcing it makes whisper *translate* a Turkish note into English when
    # the UI is English (detection on real speech is reliable, see smoke.py).
    segments, info = model.transcribe(str(path), language=None, beam_size=5)
    text = " ".join(s.text.strip() for s in segments).strip()
    return {"text": text, "language": getattr(info, "language", None)} if text else None


def _transcribe_sync(path: Path, lang: str | None) -> dict | None:
    backend = _backend()
    if backend == "mlx":
        return _transcribe_mlx(path, lang)
    if backend == "faster":
        return _transcribe_faster(path, lang)
    return None


async def transcribe(path: Path, lang: str | None = None) -> dict | None:
    if not available():
        return None
    # The very first call may have to download the model; give it longer.
    timeout = 240 if (_backend() == "mlx" or _fw_model is not None) else 900
    try:
        return await asyncio.wait_for(asyncio.to_thread(_transcribe_sync, path, lang), timeout=timeout)
    except Exception as exc:
        log.warning("transcription failed: %s", exc)
        return None
