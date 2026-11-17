"""The model and the embeddings: Gemini through LangChain's Google integration.

Nothing else in the service imports langchain_google_genai. Tests inject
fakes that implement the same two LangChain base classes.
"""

from langchain_core.embeddings import Embeddings
from langchain_core.language_models import BaseChatModel
from langchain_google_genai import ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings

from .config import Settings


class UpstreamModelError(Exception):
    """The model provider failed (rate limit, outage, bad key). Our answer is 503, not an agent_runs row."""


def require_key(settings: Settings) -> str:
    if not settings.google_api_key:
        raise ValueError("GOOGLE_API_KEY is not set (agent/.env or the environment)")
    return settings.google_api_key


def build_chat_model(settings: Settings) -> BaseChatModel:
    # temperature 0: the same question should get the same answer. max_retries 1:
    # one quick retry on a 429, then we answer 503 ourselves rather than queue
    # behind the free tier's limits.
    return ChatGoogleGenerativeAI(
        model=settings.model,
        api_key=require_key(settings),  # SecretStr is accepted at run time
        temperature=0,
        max_retries=1,
        timeout=30,
    )


def build_embeddings(settings: Settings) -> Embeddings:
    return GoogleGenerativeAIEmbeddings(
        model=settings.embedding_model,
        google_api_key=require_key(settings),
        output_dimensionality=settings.embedding_dimensions,
    )
