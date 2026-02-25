from dotenv import load_dotenv
load_dotenv()

from app.db.database import SessionLocal
from app.services.orchestrator import Orchestrator


def main():
    # Session tracking
    session_cost = 0.0
    session_tokens = 0
    session_interactions = 0

    print("🤖 Gooni CLI - Building Jarvis's Brain")
    print("Type 'exit' or 'quit' to end session\n")

    while True:
        message = input("You: ")
        if message.lower() in ["exit", "quit"]:
            print(f"\n🎯 Session Summary:")
            print(f"   💰 Total Cost: ${session_cost:.6f}")
            print(f"   🪙 Total Tokens: {session_tokens}")
            print(f"   💬 Interactions: {session_interactions}")
            print("   🧠 Thanks for building Jarvis with me!")
            break

        db = SessionLocal()
        try:
            response, usage = Orchestrator.handle_chat(message, db)

            # Update session tracking
            session_cost += usage['total_cost']
            session_tokens += usage['total_tokens']
            session_interactions += 1

            print(f"Assistant: {response.content}")
            print(f"💰 This: ${usage['total_cost']:.6f} | Tokens: {usage['total_tokens']} (in:{usage['input_tokens']} out:{usage['output_tokens']})")
            print(f"📊 Session: ${session_cost:.6f} | {session_tokens} tokens | {session_interactions} interactions\n")
        except Exception as e:
            print(f"Error: {e}")
            with open("error.log", "a") as f:
                import traceback
                f.write(f"\n--- Error at {__import__('datetime').datetime.now()} ---\n")
                f.write(traceback.format_exc())
                f.write("\n")
        finally:
            db.close()


if __name__ == "__main__":
    main()
