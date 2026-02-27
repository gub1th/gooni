from dotenv import load_dotenv

load_dotenv()

import itertools
import os
import queue
import random
import sys
import tempfile
import threading
import time
import traceback

import numpy as np
import questionary
import sounddevice as sd
import soundfile as sf
from pynput import keyboard

from app.db.database import SessionLocal
from app.llm.client import llm_client
from app.services.orchestrator import Orchestrator
from app.services.profile_memory import profile_memory_service
from app.services.audio.audio_output_service import audio_output_service

THINKING_PHRASES = [
    "Thinking", "Pondering", "Gallivanting", "Musing", "Cogitating",
    "Ruminating", "Deliberating", "Contemplating", "Noodling", "Percolating",
]
SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

_recording = threading.Event()
_voice_queue = queue.Queue()
_held_keys = set()
_tts_enabled = True


# ── Voice recording worker ─────────────────────────────────────────────────

def recording_worker():
    """Background thread: waits for toggle, records, transcribes, queues transcript."""
    while True:
        _recording.wait()  # block until Ctrl+Shift+Space pressed

        frames = []
        def callback(indata, *_):
            frames.append(indata.copy())

        sys.stdout.write("\n🎙 Recording… (Ctrl+Shift+Space to stop)\nYou: ")
        sys.stdout.flush()

        with sd.InputStream(samplerate=16000, channels=1, dtype="int16", callback=callback):
            while _recording.is_set():
                time.sleep(0.05)

        if not frames:
            continue

        audio = np.concatenate(frames, axis=0)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            path = tmp.name
        sf.write(path, audio, 16000)
        try:
            transcript = llm_client.transcribe(path)
            if transcript.strip():
                _voice_queue.put(transcript)
        except Exception as e:
            print(f"\n[voice] transcription error: {e}")
        finally:
            os.unlink(path)


# ── Input: typed or voice ──────────────────────────────────────────────────

def get_input(prompt) -> str:
    """Return next message from either keyboard typing or voice queue."""
    sys.stdout.write(prompt)
    sys.stdout.flush()

    typed = [None]
    stdin_done = threading.Event()

    def read_stdin():
        typed[0] = sys.stdin.readline().rstrip("\n")
        stdin_done.set()

    threading.Thread(target=read_stdin, daemon=True).start()

    while True:
        if stdin_done.is_set():
            return typed[0]
        try:
            transcript = _voice_queue.get_nowait()
            sys.stdout.write(f"{transcript}\n")
            sys.stdout.flush()
            return transcript
        except queue.Empty:
            time.sleep(0.05)


# ── Spinner ────────────────────────────────────────────────────────────────

def run_with_spinner(fn):
    result = [None]
    error = [None]
    done = threading.Event()

    def target():
        try:
            result[0] = fn()
        except Exception as e:
            error[0] = e
        finally:
            done.set()

    threading.Thread(target=target).start()

    phrase = random.choice(THINKING_PHRASES)
    spinner = itertools.cycle(SPINNER_FRAMES)
    while not done.is_set():
        sys.stdout.write(f"\r✳ {phrase}… {next(spinner)}")
        sys.stdout.flush()
        time.sleep(0.08)

    sys.stdout.write("\r" + " " * (len(phrase) + 10) + "\r")
    sys.stdout.flush()
    return result[0], error[0]


# ── Profile ────────────────────────────────────────────────────────────────

def handle_profile_interactive(db):
    memories = profile_memory_service.get_all_active(db)
    if not memories:
        print("\nNo profile memories yet.\n")
        return

    choices = [
        questionary.Choice(
            title=f"[{m.memory_type.value}] {m.key}: {m.value}  (confidence: {m.confidence:.1f})",
            value=m.key,
        )
        for m in memories
    ]
    to_delete = questionary.checkbox(
        f"Profile Memory ({len(memories)} entries) — space to select, enter to delete, ctrl+c to cancel:",
        choices=choices,
    ).ask()

    if not to_delete:
        print()
        return
    for key in to_delete:
        profile_memory_service.delete_by_key(key, db)
    noun = "memory" if len(to_delete) == 1 else "memories"
    print(f"Deleted {len(to_delete)} profile {noun}.\n")


# ── Message handler ────────────────────────────────────────────────────────

def handle_message(message, session_cost, session_tokens, session_interactions):
    def chat_fn():
        db = SessionLocal()
        try:
            return Orchestrator.handle_chat(message, db)
        finally:
            db.close()

    (content, usage), err = run_with_spinner(chat_fn)

    if err:
        print(f"Error: {err}")
        with open("error.log", "a") as f:
            f.write(f"\n--- Error at {__import__('datetime').datetime.now()} ---\n")
            f.write(traceback.format_exc())
        return session_cost, session_tokens, session_interactions

    if usage is None:
        print(f"\n{content}\n")
    else:
        session_cost += usage["total_cost"]
        session_tokens += usage["total_tokens"]
        session_interactions += 1

        print(f"Assistant: {content}")

        mem = usage.get("memory", {})
        parts = []
        if mem.get("profile_updated"):
            n = mem["profile_updated"]
            parts.append(f"{n} profile {'memory' if n == 1 else 'memories'} updated")
        if mem.get("episodic_added"):
            parts.append(f"{mem['episodic_added']} episodic stored")
        if parts:
            print(f"[memory] {' · '.join(parts)}")

        tools_used = usage.get("tools_used", [])
        if tools_used:
            print(f"[tools] {', '.join(tools_used)}")

        print(f"💰 This: ${usage['total_cost']:.6f} | Tokens: {usage['total_tokens']} (in:{usage['input_tokens']} out:{usage['output_tokens']})")
        print(f"📊 Session: ${session_cost:.6f} | {session_tokens} tokens | {session_interactions} interactions\n")

        if _tts_enabled:
            try:
                audio_output_service.speak(content)
            except Exception as e:
                print(f"[voice] TTS error: {e}")

    return session_cost, session_tokens, session_interactions


# ── Main ───────────────────────────────────────────────────────────────────

def main():
    session_cost = 0.0
    session_tokens = 0
    session_interactions = 0

    # Key listener for Ctrl+Shift+Space toggle
    def on_press(key):
        global _tts_enabled
        _held_keys.add(key)
        ctrl = keyboard.Key.ctrl_l in _held_keys or keyboard.Key.ctrl_r in _held_keys
        shift = keyboard.Key.shift in _held_keys or keyboard.Key.shift_l in _held_keys or keyboard.Key.shift_r in _held_keys
        if ctrl and shift and key == keyboard.Key.space:
            if _recording.is_set():
                _recording.clear()
            else:
                _recording.set()
        try:
            char = key.char
        except AttributeError:
            char = None
        if ctrl and shift and char and char.lower() == "t":
            _tts_enabled = not _tts_enabled
            status = "on" if _tts_enabled else "off"
            sys.stdout.write(f"\n[TTS {status}]\n")
            sys.stdout.flush()

    def on_release(key):
        _held_keys.discard(key)

    keyboard.Listener(on_press=on_press, on_release=on_release, daemon=True).start()
    threading.Thread(target=recording_worker, daemon=True).start()

    print("🤖 Gooni CLI - Building Jarvis's Brain")
    print("Type or press Ctrl+Shift+Space to speak")
    print("Ctrl+Shift+T to toggle TTS (currently on)")
    print("Commands: /profile  /episodic\n")

    while True:
        message = get_input("You: ")

        if message.lower() in ["exit", "quit"]:
            print("\n🎯 Session Summary:")
            print(f"   💰 Total Cost: ${session_cost:.6f}")
            print(f"   🪙 Total Tokens: {session_tokens}")
            print(f"   💬 Interactions: {session_interactions}")
            print("   🧠 Thanks for building Jarvis with me!")
            break

        if message.strip().lower() == "/profile":
            db = SessionLocal()
            try:
                handle_profile_interactive(db)
            finally:
                db.close()
            continue

        session_cost, session_tokens, session_interactions = handle_message(
            message, session_cost, session_tokens, session_interactions
        )


if __name__ == "__main__":
    main()
