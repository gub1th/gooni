# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is Gooni, a conversational AI system built with FastAPI that implements memory-based chat functionality. The system stores user interactions and creates retrievable memories using OpenAI embeddings for context-aware responses.

## Architecture

### Core Components

- **FastAPI Application** (`app/main.py`): REST API with endpoints for chat, interactions, and memory management
- **Orchestrator** (`app/services/orchestrator.py`): Main business logic coordinator that handles the chat flow
- **Memory Service** (`app/services/memory_service.py`): Vector-based memory storage and retrieval using cosine similarity
- **Interaction Service** (`app/services/interaction_service.py`): Manages conversation history
- **LLM Client** (`app/llm/client.py`): OpenAI integration for chat responses and embeddings
- **Database Models** (`app/db/`): SQLAlchemy models for Interactions and Memories

### Chat Flow

1. User sends message via `/chat` endpoint
2. Orchestrator creates user interaction record
3. Memory Service searches for relevant memories using vector similarity
4. LLM Client generates response with memory context
5. Orchestrator saves assistant response and extracts new memories

### Memory System

- Memories are extracted from conversations based on keywords ("remember", "important", "prefer", etc.)
- Each memory has an embedding generated via OpenAI's `text-embedding-3-small` model
- Vector similarity search retrieves relevant memories for context

## Development Commands

### Environment Setup
```bash
# Create and activate virtual environment
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Set up environment variables
cp .env.example .env
# Edit .env to add your OPENAI_API_KEY
```

### Running the Application
```bash
# Activate virtual environment first
source venv/bin/activate

# Run development server
uvicorn app.main:app --reload

# The API will be available at http://localhost:8000
# Interactive docs at http://localhost:8000/docs
```

### Database
- Uses SQLite by default (`sqlite:///./db/gooni.db`)
- Tables are auto-created on startup via `Base.metadata.create_all()`
- Can be configured via `DATABASE_URL` environment variable

## API Endpoints

- `POST /chat`: Send message and get AI response with memory context
- `GET /interactions`: Retrieve conversation history
- `GET /memories`: Retrieve stored memories
- `POST /memories`: Manually create a memory
- `GET /health`: Health check endpoint

## Environment Variables

- `OPENAI_API_KEY`: Required for LLM and embedding functionality
- `DATABASE_URL`: Optional, defaults to SQLite (see `.env.example`)

## Code Patterns

- Services use singleton pattern (instantiated at module level)
- Database sessions managed via FastAPI dependency injection
- Error handling with try/catch blocks that return user-friendly messages
- JSON serialization for complex data types (embeddings, metadata)