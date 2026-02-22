from fastapi import FastAPI

app = FastAPI()

@app.get("/")
async def root():
    return {"message": "Hello World"}

@app.post("/chat")
async def chat(text: str):
    return {"message": "Chat received"}

# health check
@app.get("/health")
async def health():
    return {"message": "Health check"}
