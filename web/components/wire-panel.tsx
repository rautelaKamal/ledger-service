import type { WireExchange } from '@/lib/types';

/** The request and response as the web server exchanged them with the ledger API. */
export function WirePanel({ exchange }: { exchange: WireExchange }) {
  const { request, response } = exchange;
  return (
    <details className="border-t border-rule pt-3">
      <summary className="cursor-pointer text-ink-soft hover:text-ink">The request and the response, as the server sent them</summary>
      <div className="mt-3 grid gap-4 text-sm sm:grid-cols-2">
        <div>
          <p className="font-medium">
            {request.method} {request.path}
          </p>
          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            {Object.entries(request.headers).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-ink-soft">{k}</dt>
                <dd className="break-all">{v}</dd>
              </div>
            ))}
          </dl>
          <pre tabIndex={0} aria-label="Request body" className="mt-2 overflow-x-auto bg-muted p-2">{JSON.stringify(request.body, null, 2)}</pre>
        </div>
        <div>
          <p className="font-medium">
            {response.status} in {response.ms} ms
          </p>
          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            {Object.entries(response.headers).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-ink-soft">{k}</dt>
                <dd className="break-all">{v}</dd>
              </div>
            ))}
          </dl>
          <pre tabIndex={0} aria-label="Response body" className="mt-2 overflow-x-auto bg-muted p-2">{JSON.stringify(response.body, null, 2)}</pre>
        </div>
      </div>
    </details>
  );
}
