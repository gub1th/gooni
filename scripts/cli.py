from dotenv import load_dotenv

load_dotenv()

import itertools
import os
import random
import sys
import threading
import traceback

from app.db.database import SessionLocal, engine
from app.db.models import Base
from app.services.memory_service import memory_service
from app.services.orchestrator import Orchestrator

Base.metadata.create_all(bind=engine)

THINKING_PHRASES = [
    "Thinking", "Pondering", "Gallivanting", "Musing", "Cogitating",
    "Ruminating", "Deliberating", "Contemplating", "Noodling", "Percolating",
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


def handle_message(message, session_cost, session_tokens, session_interactions):
    def chat_fn():
        db = SessionLocal()
        try:
            return Orchestrator.handle_chat(message, db, source="cli")
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
        session_cost += usage.get("total_cost", 0)
        session_tokens += usage.get("total_tokens", 0)
        session_interactions += 1

        print(f"Assistant: {content}")

        mem = usage.get("memory", {})
        parts = []
        if mem.get("memories_saved"):
            parts.append(f"{mem['memories_saved']} memories")
        if mem.get("note_saved"):
            parts.append("note logged")
        if mem.get("goal_created"):
            parts.append(f"goal created: {mem['goal_created']}")
        if parts:
            print(f"[memory] {' · '.join(parts)}")

        tools_used = usage.get("tools_used", [])
        if tools_used:
            print(f"[tools] {', '.join(tools_used)}")

        print(
            f"💰 This: ${usage.get('total_cost', 0):.6f} | "
            f"Tokens: {usage.get('total_tokens', 0)} "
            f"(in:{usage.get('input_tokens', 0)} out:{usage.get('output_tokens', 0)})"
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
    print("Commands: /memory  /goals  /goal <name>\n")

    while True:
        try:
            message = input("You: ")
        except (EOFError, KeyboardInterrupt):
            break

        if message.lower() in ["exit", "quit"]:
            print(f"\nSession: ${session_cost:.6f} | {session_tokens} tokens | {session_interactions} interactions")
            break

        session_cost, session_tokens, session_interactions = handle_message(
            message, session_cost, session_tokens, session_interactions
        )


if __name__ == "__main__":
    main()
