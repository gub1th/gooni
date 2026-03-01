from dotenv import load_dotenv

load_dotenv()

import itertools
import os
import random
import sys
import threading
import traceback

import questionary

from app.db.database import SessionLocal
from app.services.orchestrator import Orchestrator
from app.services.profile_memory_service import profile_memory_service


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
        import time; time.sleep(0.08)

    sys.stdout.write("\r" + " " * (len(phrase) + 10) + "\r")
    sys.stdout.flush()
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

    if not to_delete:
        print()
        return
    for key in to_delete:
        profile_memory_service.delete_by_key(key, db)
    noun = "memory" if len(to_delete) == 1 else "memories"
    print(f"Deleted {len(to_delete)} profile {noun}.\n")


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

        print(
            f"💰 This: ${usage['total_cost']:.6f} | Tokens: {usage['total_tokens']} (in:{usage['input_tokens']} out:{usage['output_tokens']})"
        )
        print(
            f"📊 Session: ${session_cost:.6f} | {session_tokens} tokens | {session_interactions} interactions\n"
        )

    return session_cost, session_tokens, session_interactions


def main():
    session_cost = 0.0
    session_tokens = 0
    session_interactions = 0

    print("Gooni CLI")
    print("Commands: /profile  /episodic  /goals\n")

    while True:
        try:
            message = input("You: ")
        except (EOFError, KeyboardInterrupt):
            break

        if message.lower() in ["exit", "quit"]:
            print(f"\nSession: ${session_cost:.6f} | {session_tokens} tokens | {session_interactions} interactions")
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
