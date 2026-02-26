from dotenv import load_dotenv
load_dotenv()

import itertools
import random
import sys
import threading
import time
import traceback

import questionary
from app.db.database import SessionLocal
from app.services.orchestrator import Orchestrator
from app.services.profile_memory import profile_memory_service

THINKING_PHRASES = [
    "Thinking",
    "Pondering",
    "Gallivanting",
    "Musing",
    "Cogitating",
    "Ruminating",
    "Deliberating",
    "Contemplating",
    "Noodling",
    "Percolating",
]

SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]


def run_with_spinner(fn):
    """Run fn() in a background thread, animate a spinner in the foreground. Returns (result, error)."""
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

    thread = threading.Thread(target=target)
    thread.start()

    phrase = random.choice(THINKING_PHRASES)
    spinner = itertools.cycle(SPINNER_FRAMES)
    while not done.is_set():
        frame = next(spinner)
        sys.stdout.write(f"\r✳ {phrase}… {frame}")
        sys.stdout.flush()
        time.sleep(0.08)

    sys.stdout.write("\r" + " " * (len(phrase) + 10) + "\r")
    sys.stdout.flush()

    thread.join()
    return result[0], error[0]


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

    if to_delete is None:  # ctrl+c
        print()
        return

    if not to_delete:
        print()
        return

    for key in to_delete:
        profile_memory_service.delete_by_key(key, db)

    noun = "memory" if len(to_delete) == 1 else "memories"
    print(f"Deleted {len(to_delete)} profile {noun}.\n")


def main():
    session_cost = 0.0
    session_tokens = 0
    session_interactions = 0

    print("🤖 Gooni CLI - Building Jarvis's Brain")
    print("Type 'exit' or 'quit' to end session")
    print("Commands: /profile  /episodic\n")

    while True:
        message = input("You: ")
        if message.lower() in ["exit", "quit"]:
            print(f"\n🎯 Session Summary:")
            print(f"   💰 Total Cost: ${session_cost:.6f}")
            print(f"   🪙 Total Tokens: {session_tokens}")
            print(f"   💬 Interactions: {session_interactions}")
            print("   🧠 Thanks for building Jarvis with me!")
            break

        # /profile is handled interactively in the CLI
        if message.strip().lower() == "/profile":
            db = SessionLocal()
            try:
                handle_profile_interactive(db)
            finally:
                db.close()
            continue

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
                f.write("\n")
            continue

        if usage is None:
            # Slash commands (/episodic etc.)
            print(f"\n{content}\n")
        else:
            session_cost += usage['total_cost']
            session_tokens += usage['total_tokens']
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

            print(f"💰 This: ${usage['total_cost']:.6f} | Tokens: {usage['total_tokens']} (in:{usage['input_tokens']} out:{usage['output_tokens']})")
            print(f"📊 Session: ${session_cost:.6f} | {session_tokens} tokens | {session_interactions} interactions\n")


if __name__ == "__main__":
    main()
