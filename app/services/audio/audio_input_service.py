import os
import tempfile

import sounddevice as sd
import soundfile as sf

from ...llm.client import llm_client


class AudioInputService:
    def listen(self, duration_seconds=5) -> str:
        """Record from mic and return transcript string. Cleans up the wav after."""
        audio_path = self._record_audio(duration_seconds)
        try:
            return llm_client.transcribe(audio_path)
        finally:
            os.unlink(audio_path)

    def _record_audio(self, duration_seconds: int, sample_rate=16000) -> str:
        """Record from mic and save to a temp wav file. Returns file path."""
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            filename = tmp.name
        audio = sd.rec(
            int(duration_seconds * sample_rate),
            samplerate=sample_rate,
            channels=1,
            dtype="int16",
            blocking=True,
        )
        sf.write(filename, audio, sample_rate)
        return filename


audio_input_service = AudioInputService()
