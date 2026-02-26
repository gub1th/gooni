import numpy as np
import sounddevice as sd

from ...llm.client import llm_client

# OpenAI PCM format: 24kHz, 16-bit, mono
PCM_SAMPLE_RATE = 24000


class AudioOutputService:
    def speak(self, text: str) -> None:
        """Synthesize text to speech and play through speakers."""
        pcm_bytes = llm_client.synthesize(text)
        audio = np.frombuffer(pcm_bytes, dtype=np.int16)
        sd.play(audio, samplerate=PCM_SAMPLE_RATE)
        sd.wait()


audio_output_service = AudioOutputService()
