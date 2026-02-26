# Ideas

> Random thoughts, features, and improvements for Gooni/Jarvis

- The AI should be able to read, create, write to, and manage a central todo list.


# Questions I have
- Is this cost calculation correct? given the fact that we are making multiple API calls to the LLM?
- DO our embeddings not need to be in a vector store?
   - Right now they're stored as JSON strings in SQLite. Right now things are O(n), and at this scale, a vector database isn't necessary.