# OpenAI API Pricing (per 1,000 tokens).
# Source-of-truth lives at https://openai.com/api/pricing — keep this table
# in rough sync but treat the OpenAI Admin /v1/organization/costs endpoint
# as the authoritative number for billing UI.

MODEL_PRICING = {
    # GPT-5.x family (premium)
    "gpt-5.4":                {"input": 0.00125, "output": 0.01},
    "gpt-5.4-mini":           {"input": 0.00025, "output": 0.002},
    "gpt-5.4-nano":           {"input": 0.00005, "output": 0.0004},
    "gpt-5.2":                {"input": 0.00125, "output": 0.01},
    "gpt-5.1":                {"input": 0.00125, "output": 0.01},
    "gpt-5.1-codex":          {"input": 0.00125, "output": 0.01},
    "gpt-5.1-codex-mini":     {"input": 0.00025, "output": 0.002},
    "gpt-5":                  {"input": 0.00125, "output": 0.01},
    "gpt-5-codex":            {"input": 0.00125, "output": 0.01},
    "gpt-5-chat-latest":      {"input": 0.00125, "output": 0.01},
    "gpt-5-mini":             {"input": 0.00025, "output": 0.002},
    "gpt-5-nano":             {"input": 0.00005, "output": 0.0004},

    # GPT-4.1 family
    "gpt-4.1":                {"input": 0.002,   "output": 0.008},
    "gpt-4.1-mini":           {"input": 0.0004,  "output": 0.0016},
    "gpt-4.1-nano":           {"input": 0.0001,  "output": 0.0004},

    # Reasoning (o-series)
    "o1":                     {"input": 0.015,   "output": 0.06},
    "o1-mini":                {"input": 0.0011,  "output": 0.0044},
    "o3":                     {"input": 0.002,   "output": 0.008},
    "o3-mini":                {"input": 0.0011,  "output": 0.0044},
    "o4-mini":                {"input": 0.0011,  "output": 0.0044},
    "codex-mini-latest":      {"input": 0.00025, "output": 0.002},

    # GPT-4o models
    "gpt-4o":                 {"input": 0.005,   "output": 0.015},
    "gpt-4o-2024-08-06":      {"input": 0.0025,  "output": 0.01},
    "gpt-4o-mini":            {"input": 0.00015, "output": 0.0006},
    "gpt-4o-mini-2024-07-18": {"input": 0.00015, "output": 0.0006},

    # GPT-4 Turbo
    "gpt-4-turbo":            {"input": 0.01,    "output": 0.03},
    "gpt-4-turbo-2024-04-09": {"input": 0.01,    "output": 0.03},
    "gpt-4-1106-preview":     {"input": 0.01,    "output": 0.03},
    "gpt-4-0125-preview":     {"input": 0.01,    "output": 0.03},

    # GPT-4
    "gpt-4":                  {"input": 0.03,    "output": 0.06},
    "gpt-4-0613":             {"input": 0.03,    "output": 0.06},

    # GPT-3.5 Turbo
    "gpt-3.5-turbo":          {"input": 0.0015,  "output": 0.002},
    "gpt-3.5-turbo-0125":     {"input": 0.0005,  "output": 0.0015},
    "gpt-3.5-turbo-1106":     {"input": 0.001,   "output": 0.002},
}

# Embedding model pricing
EMBEDDING_PRICING = {
    "text-embedding-3-small": 0.00002,
    "text-embedding-3-large": 0.00013,
    "text-embedding-ada-002": 0.0001
}

def get_model_pricing(model_name: str) -> dict:
    """Get pricing for a specific model"""
    return MODEL_PRICING.get(model_name, {"input": 0, "output": 0})

def get_embedding_pricing(model_name: str) -> float:
    """Get pricing for a specific embedding model"""
    return EMBEDDING_PRICING.get(model_name, 0)

def calculate_chat_cost(model_name: str, input_tokens: int, output_tokens: int) -> dict:
    """Calculate cost for chat completion"""
    pricing = get_model_pricing(model_name)
    input_cost = (input_tokens / 1000) * pricing["input"]
    output_cost = (output_tokens / 1000) * pricing["output"]
    total_cost = input_cost + output_cost

    return {
        "input_cost": input_cost,
        "output_cost": output_cost,
        "total_cost": total_cost
    }

def calculate_embedding_cost(model_name: str, tokens: int) -> float:
    """Calculate cost for embedding"""
    pricing = get_embedding_pricing(model_name)
    return (tokens / 1000) * pricing


class UsageTracker:
    def __init__(self, model: str):
        self.model = model
        self.prompt_tokens = 0
        self.completion_tokens = 0

    def add(self, usage) -> None:
        self.prompt_tokens += usage.prompt_tokens
        self.completion_tokens += usage.completion_tokens

    def finalize(self, tools_used: list = None) -> dict:
        costs = calculate_chat_cost(self.model, self.prompt_tokens, self.completion_tokens)
        return {
            "input_tokens": self.prompt_tokens,
            "output_tokens": self.completion_tokens,
            "total_tokens": self.prompt_tokens + self.completion_tokens,
            **costs,
            "tools_used": tools_used or [],
        }