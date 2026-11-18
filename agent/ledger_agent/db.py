"""The database side of the fence.

Every read happens inside `client_scope`: one READ ONLY transaction on a
pooled connection, with the client id set for that transaction only, through
a bind parameter. Postgres' row-level security then filters every row to that
client, whatever SQL runs inside the scope.
"""

from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass

import psycopg
from psycopg.rows import DictRow, dict_row
from psycopg_pool import ConnectionPool

MAX_CLIENT_ID_LENGTH = 255


@dataclass(frozen=True)
class ClientContext:
    """Who the assistant is acting for.

    Built ONLY from the request (the X-Client-Id header, a stand-in for
    authentication). It is the first argument of every tool and never one of
    the arguments a model may fill in, so a model cannot ask for someone
    else's data by naming them.
    """

    client_id: str

    @classmethod
    def from_header(cls, value: str | None) -> "ClientContext":
        if value is None or not (1 <= len(value) <= MAX_CLIENT_ID_LENGTH):
            raise ValueError("X-Client-Id header is required (1-255 characters)")
        return cls(client_id=value)


def _configure(conn: psycopg.Connection[DictRow]) -> None:
    # Belt and braces with the grants: this connection can never write, even
    # if a grant were ever too wide.
    conn.read_only = True


def create_pool(database_url: str, size: int = 4) -> ConnectionPool[psycopg.Connection[DictRow]]:
    return ConnectionPool(
        conninfo=database_url,
        min_size=1,
        max_size=size,
        kwargs={"row_factory": dict_row},
        configure=_configure,
        open=True,
    )


@contextmanager
def client_scope(
    pool: ConnectionPool[psycopg.Connection[DictRow]],
    ctx: ClientContext,
    read_only: bool = True,
) -> Iterator[psycopg.Connection[DictRow]]:
    """One request's worth of reads, as one client.

    BEGIN READ ONLY; SELECT set_config('app.client_id', %s, true); ... COMMIT.
    The third argument `true` makes the setting LOCAL: it ends with the
    transaction, so the next borrower of this pooled connection starts with
    no client id and therefore sees nothing.

    read_only=False exists for exactly one caller: writing the audit row to
    agent_runs (step 7b). The grants still allow nothing else, and row-level
    security still binds the row to this client.
    """
    with pool.connection() as conn:
        if not read_only:
            conn.read_only = False
        try:
            with conn.transaction():
                # A bind parameter, never string-built SQL: the id is data to Postgres,
                # whatever quotes, semicolons or keywords it contains.
                conn.execute("SELECT set_config('app.client_id', %s, true)", (ctx.client_id,))
                yield conn
        finally:
            if not read_only:
                conn.read_only = True
