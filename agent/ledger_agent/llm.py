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
    # No temperature: gemini-3.5-flash-lite uses fixed sampling defaults and
    # ignores it (the first real run warned on every call). So answers are NOT
    # repeatable word for word; what keeps them honest is verify.py, not the
    # sampling. max_retries 1: one quick retry on a 429, then we answer 503
    # ourselves rather than queue behind the free tier's limits.
    return ChatGoogleGenerativeAI(
        model=settings.model,
        api_key=require_key(settings),  # SecretStr is accepted at run time
        max_retries=1,
        timeout=30,
    )


def build_embeddings(settings: Settings) -> Embeddings:
    # langchain-google-genai 4.5.0 sends a task_type (RETRIEVAL_DOCUMENT /
    # RETRIEVAL_QUERY) with every request. gemini-embedding-2 does not support
    # task_type: measured on 2026-11-18, the same text under two task types gave
    # bit-identical vectors, so it is silently ignored, not rejected. The task is
    # carried where Google documents it for this model: in the text itself
    # (rag.document_text / rag.query_text).
    return GoogleGenerativeAIEmbeddings(
        model=settings.embedding_model,
        google_api_key=require_key(settings),
        output_dimensionality=settings.embedding_dimensions,
    )
