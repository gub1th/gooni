from dotenv import load_dotenv
load_dotenv()

from app.db.database import SessionLocal
from app.services.orchestrator import Orchestrator


def main():
    while True:
        message = input("You: ")
        if message.lower() in ["exit", "quit"]:
            break

        db = SessionLocal()
        try:
            response, usage = Orchestrator.handle_chat(message, db)
            print(f"Assistant: {response.content}")
            print(f"💰 Cost: ${usage['total_cost']:.6f} | Tokens: {usage['total_tokens']} (in:{usage['input_tokens']} out:{usage['output_tokens']})")
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
